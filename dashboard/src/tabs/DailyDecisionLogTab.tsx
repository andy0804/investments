import { useState, useEffect, useCallback, useRef } from 'react'
import { getDailyDecisions, removeCooldown, updateCooldown } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SotdInfo {
  symbol: string
  regime: string
  score: number | null
  tier: string | null
  reasoning: string | null
  market_context: { vix: number | null; spy_10d: number | null; regime: string | null }
}

interface Candidate {
  ticker: string
  company?: string
  sector?: string
  score?: number
  passed_filter: boolean
  filter_reason?: string
  metrics?: {
    rsi?: number
    adx?: number
    vol_ratio?: number
    return_10d?: number
    above_sma20?: boolean
    bb_squeeze?: boolean
  }
  tags?: string[]
}

interface PickRecap {
  total_evaluated: number
  win_rate: number | null
  best_pick: { ticker: string; pick_date: string; alpha_14d: number; return_14d: number } | null
  worst_pick: { ticker: string; pick_date: string; alpha_14d: number; return_14d: number } | null
}

interface CooldownItem {
  ticker: string
  reason: string
  alpha_14d: number | null
  times_blocked: number
  blocked_at: string
  unblock_after: string
}

interface Decision {
  time: string
  ticker: string
  action: string
  score: number | null
  score_prev: number | null
  regime: string
  return_pct: number | null
  days_held: number | null
  confidence: string
  rationale: string
  why_selected: string[]
  why_rejected: string[]
  risk_signals: string[]
}

interface AiCall {
  job_name: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ran_at: string
}

interface JobHealth {
  job: string
  success: number
  error: number
}

interface DailyData {
  date: string
  sotd: SotdInfo | null
  all_candidates: Candidate[]
  pick_recap: PickRecap
  cooldown: CooldownItem[]
  decisions: Decision[]
  ai_calls: AiCall[]
  job_health: JobHealth[]
  total_ai_cost: number
  available_dates: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function fmtTime(iso: string) {
  return iso?.slice(11, 16) || ''
}

function pct(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}

function isToday(d: string) {
  return d === todayStr()
}

// ── Small components ──────────────────────────────────────────────────────────

function Tag({ children, color }: { children: React.ReactNode; color?: string }) {
  const c = color ?? 'var(--text-dim)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: '0.62rem', fontWeight: 700, fontFamily: 'var(--mono)',
      color: c, background: c + '18', border: `1px solid ${c}33`,
      borderRadius: 4, padding: '1px 6px',
    }}>
      {children}
    </span>
  )
}

function RegimeBadge({ regime }: { regime: string }) {
  const map: Record<string, string> = { BULL: 'var(--green)', BEAR: 'var(--red)', CHOP: 'var(--yellow)' }
  const c = map[regime] || 'var(--text-dim)'
  return <Tag color={c}>{regime}</Tag>
}

function RefreshCountdown({ nextAt }: { nextAt: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, nextAt - Date.now()))
  useEffect(() => {
    const id = setInterval(() => setRemaining(Math.max(0, nextAt - Date.now())), 1000)
    return () => clearInterval(id)
  }, [nextAt])
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  return (
    <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
      next refresh in {mins}:{secs.toString().padStart(2, '0')}
    </span>
  )
}

// ── Candidates table ──────────────────────────────────────────────────────────

function CandidatesTable({ candidates }: { candidates: Candidate[] }) {
  const [showFiltered, setShowFiltered] = useState(false)
  const passed   = candidates.filter(c => c.passed_filter)
  const filtered = candidates.filter(c => !c.passed_filter)
  const visible  = showFiltered ? candidates : passed

  if (candidates.length === 0) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
        No pipeline candidates recorded for this date.
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {passed.length} passed · {filtered.length} filtered out
        </div>
        <button
          onClick={() => setShowFiltered(s => !s)}
          style={{ fontSize: '0.65rem', fontFamily: 'var(--mono)', background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-dim)' }}>
          {showFiltered ? 'Hide filtered' : 'Show filtered'}
        </button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              {['#', 'Ticker', 'Company', 'Score', 'RSI', 'Vol Ratio', '10d Ret', 'Tags', 'Status'].map(h => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((c, i) => (
              <tr key={c.ticker} style={{ opacity: c.passed_filter ? 1 : 0.55 }}>
                <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.72rem' }}>{i + 1}</td>
                <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{c.ticker}</td>
                <td style={{ fontSize: '0.75rem', color: 'var(--text-dim)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.company || '—'}</td>
                <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: (c.score ?? 0) >= 80 ? 'var(--green)' : (c.score ?? 0) >= 65 ? 'var(--yellow)' : 'var(--text-dim)' }}>
                  {c.score ?? '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', color: c.metrics?.rsi != null && c.metrics.rsi > 70 ? 'var(--red)' : c.metrics?.rsi != null && c.metrics.rsi < 35 ? 'var(--green)' : 'var(--text)' }}>
                  {c.metrics?.rsi?.toFixed(0) ?? '—'}
                </td>
                <td style={{ fontFamily: 'var(--mono)', color: (c.metrics?.vol_ratio ?? 0) >= 1.5 ? 'var(--cyan)' : 'var(--text)' }}>
                  {c.metrics?.vol_ratio?.toFixed(1) ?? '—'}x
                </td>
                <td style={{ fontFamily: 'var(--mono)', color: (c.metrics?.return_10d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {c.metrics?.return_10d != null ? pct(c.metrics.return_10d) : '—'}
                </td>
                <td style={{ maxWidth: 140 }}>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {(c.tags ?? []).slice(0, 3).map(t => (
                      <Tag key={t} color="var(--cyan)">{t}</Tag>
                    ))}
                  </div>
                </td>
                <td>
                  {c.passed_filter ? (
                    <Tag color="var(--green)">PASS</Tag>
                  ) : (
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }} title={c.filter_reason}>
                      FILTERED
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export default function DailyDecisionLogTab() {
  const [date,      setDate]      = useState(todayStr())
  const [data,      setData]      = useState<DailyData | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [expanded,  setExpanded]  = useState<number | null>(null)
  const [nextRefAt, setNextRefAt] = useState(Date.now() + REFRESH_INTERVAL_MS)
  const [removingCooldown, setRemovingCooldown] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback((d: string) => {
    setLoading(true)
    setExpanded(null)
    getDailyDecisions(d)
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(date) }, [date, load])

  // Hourly auto-refresh, but only for today
  useEffect(() => {
    if (!isToday(date)) return
    const next = Date.now() + REFRESH_INTERVAL_MS
    setNextRefAt(next)
    timerRef.current = setInterval(() => {
      load(date)
      setNextRefAt(Date.now() + REFRESH_INTERVAL_MS)
    }, REFRESH_INTERVAL_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [date, load])

  const availDates = data?.available_dates ?? []
  const idx        = availDates.indexOf(date)
  const prevDate   = availDates[idx + 1] ?? null
  const nextDate   = availDates[idx - 1] ?? null

  const handleRemoveCooldown = async (ticker: string) => {
    setRemovingCooldown(ticker)
    await removeCooldown(ticker)
    load(date)
    setRemovingCooldown(null)
  }

  const s = data

  return (
    <div>
      {/* ── Header bar ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-bright)', letterSpacing: '0.02em' }}>Daily Log</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>
            Everything the agent analyzed and decided
            {isToday(date) && <span style={{ marginLeft: 8 }}><RefreshCountdown nextAt={nextRefAt} /></span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn sm" disabled={!prevDate} onClick={() => prevDate && setDate(prevDate)}>← Prev</button>
          <input
            type="date" value={date} max={todayStr()}
            onChange={e => setDate(e.target.value)}
            style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-bright)', borderRadius: 5, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: '0.78rem' }}
          />
          <button className="btn sm" disabled={!nextDate} onClick={() => nextDate && setDate(nextDate)}>Next →</button>
          <button className="btn sm" onClick={() => setDate(todayStr())}>Today</button>
          <button className="btn sm" onClick={() => load(date)}>↻</button>
        </div>
      </div>

      {loading && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>Loading…</div>
      )}

      {!loading && s && (
        <>
          {/* ── SOTD Hero ── */}
          {s.sotd ? (
            <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--cyan)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 900, fontFamily: 'var(--mono)', color: 'var(--text-bright)' }}>
                  {s.sotd.symbol}
                </div>
                {s.sotd.score != null && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontWeight: 800, fontSize: '1rem',
                    color: s.sotd.score >= 80 ? 'var(--green)' : s.sotd.score >= 65 ? 'var(--yellow)' : 'var(--text-dim)',
                  }}>
                    {s.sotd.score}
                  </div>
                )}
                {s.sotd.tier && <Tag color="var(--cyan)">{s.sotd.tier}</Tag>}
                <RegimeBadge regime={s.sotd.regime} />
                {s.sotd.market_context.vix != null && <Tag>VIX {s.sotd.market_context.vix.toFixed(1)}</Tag>}
                {s.sotd.market_context.spy_10d != null && (
                  <Tag color={(s.sotd.market_context.spy_10d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}>
                    SPY {pct(s.sotd.market_context.spy_10d)}
                  </Tag>
                )}
              </div>
              {s.sotd.reasoning && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.65 }}>
                  {s.sotd.reasoning}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '18px 16px', marginBottom: 14, background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center' }}>
              No Stock of the Day recorded for {date}.
            </div>
          )}

          {/* ── Pick History Recap ── */}
          {s.pick_recap && (s.pick_recap.total_evaluated ?? 0) > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-title" style={{ marginBottom: 10 }}>All-Time Pick Performance</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 7, padding: '12px 16px', minWidth: 120 }}>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Win Rate</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 800, fontFamily: 'var(--mono)', color: (s.pick_recap.win_rate ?? 0) >= 0.5 ? 'var(--green)' : 'var(--red)' }}>
                    {s.pick_recap.win_rate != null ? `${Math.round(s.pick_recap.win_rate * 100)}%` : '—'}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 3 }}>{s.pick_recap.total_evaluated} evaluated</div>
                </div>

                {s.pick_recap.best_pick && (
                  <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 7, padding: '12px 16px', minWidth: 140 }}>
                    <div style={{ fontSize: '0.6rem', color: '#16a34a', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Best Pick</div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 900, fontSize: '1rem', color: '#15803d' }}>
                      {s.pick_recap.best_pick.ticker}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.82rem', color: '#16a34a' }}>
                      +{s.pick_recap.best_pick.alpha_14d.toFixed(1)}% alpha
                    </div>
                    <div style={{ fontSize: '0.62rem', color: '#16a34a', opacity: 0.7, marginTop: 2 }}>{s.pick_recap.best_pick.pick_date}</div>
                  </div>
                )}

                {s.pick_recap.worst_pick && (
                  <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 7, padding: '12px 16px', minWidth: 140 }}>
                    <div style={{ fontSize: '0.6rem', color: '#dc2626', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Worst Pick</div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 900, fontSize: '1rem', color: '#b91c1c' }}>
                      {s.pick_recap.worst_pick.ticker}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.82rem', color: '#dc2626' }}>
                      {s.pick_recap.worst_pick.alpha_14d.toFixed(1)}% alpha
                    </div>
                    <div style={{ fontSize: '0.62rem', color: '#dc2626', opacity: 0.7, marginTop: 2 }}>{s.pick_recap.worst_pick.pick_date}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── All Pipeline Candidates ── */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div className="card-title">Pipeline Candidates</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                {(s.all_candidates ?? []).filter(c => c.passed_filter).length} qualified · {(s.all_candidates ?? []).filter(c => !c.passed_filter).length} filtered
              </div>
            </div>
            <CandidatesTable candidates={s.all_candidates ?? []} />
          </div>

          {/* ── Universe Cooldown ── */}
          {(s.cooldown ?? []).length > 0 && (
            <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--warn-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div className="card-title">Universe Cooldown</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>
                    Stocks auto-removed for consistently failing criteria — re-qualify in 30 days
                  </div>
                </div>
                <span style={{ fontSize: '0.68rem', fontWeight: 700, fontFamily: 'var(--mono)', background: 'var(--warn-bg)', color: 'var(--warn-text)', border: '1px solid var(--warn-border)', borderRadius: 12, padding: '3px 10px' }}>
                  {s.cooldown.length} blocked
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(s.cooldown ?? []).map(item => (
                  <div key={item.ticker} style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 7, padding: '10px 14px', minWidth: 180 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--warn-text)', fontSize: '0.9rem' }}>{item.ticker}</span>
                      <button
                        disabled={removingCooldown === item.ticker}
                        onClick={() => handleRemoveCooldown(item.ticker)}
                        style={{ fontSize: '0.6rem', fontFamily: 'var(--mono)', background: 'none', border: '1px solid var(--warn-border)', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: 'var(--warn-text)' }}>
                        {removingCooldown === item.ticker ? '…' : 'unblock'}
                      </button>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--warn-text)', lineHeight: 1.4, marginBottom: 3 }}>{item.reason}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                      Unblocks: {item.unblock_after} · blocked {item.times_blocked}×
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Virtual Portfolio Decisions ── */}
          {s.decisions.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-title" style={{ marginBottom: 10 }}>Portfolio Decisions ({s.decisions.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {s.decisions.map((d, i) => (
                  <div key={i} style={{ background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
                      onClick={() => setExpanded(expanded === i ? null : i)}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-dim)', minWidth: 38 }}>{fmtTime(d.time)}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--text-bright)', minWidth: 55 }}>{d.ticker}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.75rem', color: d.action === 'BUY' ? 'var(--green)' : d.action === 'SELL' ? 'var(--red)' : 'var(--text-dim)' }}>
                        {d.action}
                      </span>
                      {d.score != null && (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                          {d.score}
                          {d.score_prev != null && d.score !== d.score_prev && (
                            <span style={{ color: d.score > d.score_prev ? 'var(--green)' : 'var(--red)', marginLeft: 4, fontSize: '0.7rem' }}>
                              ({d.score > d.score_prev ? '+' : ''}{d.score - d.score_prev})
                            </span>
                          )}
                        </span>
                      )}
                      <RegimeBadge regime={d.regime} />
                      {d.return_pct != null && (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: d.return_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {pct(d.return_pct)}
                        </span>
                      )}
                      {d.days_held != null && <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>{d.days_held}d held</span>}
                      <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-dim)' }}>{d.confidence} {expanded === i ? '▲' : '▼'}</span>
                    </div>
                    {expanded === i && (
                      <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--border)' }}>
                        {d.rationale && <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.6, marginTop: 10 }}>{d.rationale}</div>}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                          {d.why_selected.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.6rem', color: 'var(--green)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 5 }}>WHY {d.action}</div>
                              <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                                {d.why_selected.map((w, j) => <li key={j} style={{ fontSize: '0.75rem', color: 'var(--text)', marginBottom: 3 }}>{w}</li>)}
                              </ul>
                            </div>
                          )}
                          {d.why_rejected.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.6rem', color: 'var(--red)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 5 }}>CONCERNS</div>
                              <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                                {d.why_rejected.map((w, j) => <li key={j} style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: 3 }}>{w}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                        {d.risk_signals.length > 0 && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: '0.6rem', color: 'var(--yellow)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 5 }}>RISK</div>
                            <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                              {d.risk_signals.map((w, j) => <li key={j} style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: 3 }}>{w}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Scheduler Jobs ── */}
          {s.job_health.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-title" style={{ marginBottom: 10 }}>Scheduler Health</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.job_health.map((j, i) => (
                  <div key={i} style={{
                    background: j.error > 0 ? 'rgba(239,68,68,0.1)' : 'var(--panel-inset)',
                    border: `1px solid ${j.error > 0 ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                    borderRadius: 5, padding: '6px 10px', fontSize: '0.72rem',
                  }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-bright)' }}>{j.job}</span>
                    <span style={{ marginLeft: 6, color: 'var(--green)' }}>✓{j.success}</span>
                    {j.error > 0 && <span style={{ color: 'var(--red)', marginLeft: 4 }}>✗{j.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── AI Cost ── */}
          {s.ai_calls.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div className="card-title">AI Analysis Calls</div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.78rem', color: s.total_ai_cost > 0.10 ? 'var(--yellow)' : 'var(--green)' }}>
                  ${s.total_ai_cost.toFixed(4)} total
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    {['Time', 'Job', 'Model', 'In', 'Out', 'Cost'].map(h => <th key={h}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {s.ai_calls.map((c, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{fmtTime(c.ran_at)}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{c.job_name}</td>
                      <td style={{ color: c.model.includes('sonnet') ? 'var(--cyan)' : 'var(--text-dim)' }}>
                        {c.model.includes('sonnet') ? 'Sonnet' : 'Haiku'}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{c.input_tokens?.toLocaleString()}</td>
                      <td style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{c.output_tokens?.toLocaleString()}</td>
                      <td style={{ fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--text-dim)' }}>${(c.cost_usd || 0).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Empty state ── */}
          {!s.sotd && (s.all_candidates ?? []).length === 0 && s.decisions.length === 0 && s.ai_calls.length === 0 && (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem', background: 'var(--panel-inset)', borderRadius: 8, border: '1px solid var(--border)' }}>
              No agent activity recorded for {date}.
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 8, fontSize: '0.62rem', color: 'var(--text-dim)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {availDates.length} days in history · {isToday(date) ? 'auto-refreshes hourly' : date}
      </div>
    </div>
  )
}
