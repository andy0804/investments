import { useState, useEffect } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import {
  getSotdHistory, getPerformanceSeries, getCorrectionProposals,
  generateProposals, approveProposal, rejectProposal, computeOutcomes,
} from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SOTDPick {
  pick_date: string
  symbol: string
  company: string
  sector: string
  regime: string
  confidence_score: number | null
  signal_type: string
  summary: string
  entry_price: number | null
  current_price: number | null
  gain_pct: number | null
  days_held: number | null
}

interface WinRatePoint {
  date: string
  ticker: string
  win_rate: number
  window: number
}

interface AlphaPoint {
  date: string
  ticker: string
  alpha: number | null
  cumulative: number
  outcome: string
}

interface Proposal {
  id: number
  status: string
  trigger_reason: string
  metric_snapshot: Record<string, any>
  proposed_changes: Record<string, any>
  current_values: Record<string, any>
  generated_at: string
  resolved_at: string | null
  resolution: string | null
}

interface PerfSummary {
  total_evaluated: number
  total_pending: number
  overall_win_rate: number | null
  rolling_8pick_win_rate: number | null
  total_alpha: number
  avg_alpha_14d: number | null
  wins: number
  losses: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v: number | null, decimals = 1): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}

function winRateStr(v: number | null): string {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

// ── Small components ──────────────────────────────────────────────────────────

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 18px', minWidth: 130 }}>
      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 800, color: color ?? 'var(--text-bright)', fontFamily: 'var(--mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function OutcomeDot({ outcome }: { outcome: string | null }) {
  const color = outcome === 'win' ? 'var(--green)' : outcome === 'loss' ? 'var(--red)' : outcome === 'neutral' ? 'var(--text-dim)' : '#d1d5db'
  const label = outcome ?? 'pending'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: '0.68rem', fontWeight: 700, fontFamily: 'var(--mono)',
      color, background: color + '15', border: `1px solid ${color}44`,
      borderRadius: 4, padding: '2px 7px',
    }}>
      {label.toUpperCase()}
    </span>
  )
}

function RegimeBadge({ regime }: { regime: string }) {
  const map: Record<string, string> = { BULL: 'var(--green)', BEAR: 'var(--red)', CHOP: 'var(--yellow)' }
  const c = map[regime] || 'var(--text-dim)'
  return (
    <span style={{ color: c, background: c + '15', border: `1px solid ${c}44`, borderRadius: 4, padding: '2px 7px', fontSize: '0.68rem', fontWeight: 700, fontFamily: 'var(--mono)' }}>
      {regime}
    </span>
  )
}

// ── Custom chart tooltip ──────────────────────────────────────────────────────

function WinRateTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: '0.72rem', fontFamily: 'var(--mono)', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{d?.date} · {d?.ticker}</div>
      <div style={{ color: 'var(--cyan)', fontWeight: 700 }}>Win rate: {winRateStr(d?.win_rate)}</div>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.65rem' }}>Window: {d?.window} picks</div>
    </div>
  )
}

function AlphaTip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  const alphaPt = payload.find((p: any) => p.dataKey === 'alpha')
  const cumPt   = payload.find((p: any) => p.dataKey === 'cumulative')
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: '0.72rem', fontFamily: 'var(--mono)', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{d?.date} · {d?.ticker}</div>
      {alphaPt && <div style={{ color: (d?.alpha ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>Pick alpha: {pct(d?.alpha)}</div>}
      {cumPt    && <div style={{ color: 'var(--cyan)', fontWeight: 700 }}>Cumulative: {pct(d?.cumulative)}</div>}
      <OutcomeDot outcome={d?.outcome} />
    </div>
  )
}

// ── Correction Proposals ──────────────────────────────────────────────────────

function ProposalCard({ p, onApprove, onReject }: { p: Proposal; onApprove: () => void; onReject: () => void }) {
  const [busy, setBusy] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [showReject, setShowReject] = useState(false)

  const changes = Object.entries(p.proposed_changes || {})

  return (
    <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.65rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--warn-text)', letterSpacing: '0.1em' }}>
            ⚠ SYSTEM PROPOSAL
          </span>
          <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
            {new Date(p.generated_at).toLocaleDateString()}
          </span>
        </div>
        {p.status === 'pending' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              disabled={busy}
              onClick={async () => { setBusy(true); await approveProposal(p.id); onApprove() }}
              style={{ padding: '4px 12px', fontSize: '0.7rem', fontWeight: 700, fontFamily: 'var(--mono)', background: 'var(--green-bg)', color: 'var(--green)', border: '1px solid #86efac', borderRadius: 5, cursor: 'pointer' }}>
              ✓ Apply
            </button>
            <button
              disabled={busy}
              onClick={() => setShowReject(r => !r)}
              style={{ padding: '4px 12px', fontSize: '0.7rem', fontWeight: 700, fontFamily: 'var(--mono)', background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid #fca5a5', borderRadius: 5, cursor: 'pointer' }}>
              ✗ Reject
            </button>
          </div>
        )}
        {p.status !== 'pending' && (
          <span style={{ fontSize: '0.65rem', fontFamily: 'var(--mono)', fontWeight: 700, color: p.status === 'approved' ? 'var(--green)' : 'var(--text-dim)' }}>
            {p.status.toUpperCase()}
          </span>
        )}
      </div>

      <div style={{ fontSize: '0.82rem', color: 'var(--warn-text)', lineHeight: 1.6, marginBottom: 10 }}>
        {p.trigger_reason}
      </div>

      {changes.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {changes.map(([key, change]: [string, any]) => (
            <div key={key} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 10px' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 3 }}>{key.replace(/_/g, ' ').toUpperCase()}</div>
              <div style={{ fontSize: '0.78rem', fontFamily: 'var(--mono)', color: 'var(--text-bright)' }}>
                <span style={{ color: 'var(--red)' }}>{String(change.from)}</span>
                {' → '}
                <span style={{ color: 'var(--green)', fontWeight: 700 }}>{String(change.to)}</span>
              </div>
              {change.rationale && (
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 3, maxWidth: 280 }}>{change.rationale}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {p.metric_snapshot && Object.keys(p.metric_snapshot).length > 0 && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {Object.entries(p.metric_snapshot).filter(([k]) => !k.includes('picks')).map(([k, v]: [string, any]) => (
            typeof v === 'number' ? (
              <span key={k}>{k.replace(/_/g, ' ')}: <strong style={{ color: 'var(--text-bright)' }}>{typeof v === 'number' && v < 1 ? winRateStr(v) : v}</strong></span>
            ) : null
          ))}
        </div>
      )}

      {showReject && p.status === 'pending' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={rejectNote} onChange={e => setRejectNote(e.target.value)}
            placeholder="Optional reason…"
            style={{ flex: 1, padding: '5px 9px', borderRadius: 5, border: '1px solid var(--border)', fontSize: '0.75rem', background: 'var(--panel)', color: 'var(--text-bright)' }}
          />
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); await rejectProposal(p.id, rejectNote); onReject() }}
            style={{ padding: '5px 12px', fontSize: '0.7rem', fontWeight: 700, fontFamily: 'var(--mono)', background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid #fca5a5', borderRadius: 5, cursor: 'pointer' }}>
            Confirm reject
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function SOTDHistoryTab() {
  const [picks,       setPicks]       = useState<SOTDPick[]>([])
  const [series,      setSeries]      = useState<{ win_rate_series: WinRatePoint[]; alpha_series: AlphaPoint[]; summary: PerfSummary } | null>(null)
  const [proposals,   setProposals]   = useState<Proposal[]>([])
  const [loading,     setLoading]     = useState(true)
  const [chartLoad,   setChartLoad]   = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [expanded,    setExpanded]    = useState<string | null>(null)
  const [generating,  setGenerating]  = useState(false)
  const [computing,   setComputing]   = useState(false)
  const [activeChart, setActiveChart] = useState<'winrate' | 'alpha'>('winrate')

  const loadAll = () => {
    setLoading(true)
    setChartLoad(true)
    getSotdHistory()
      .then(r => setPicks(r.data.picks || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))

    getPerformanceSeries()
      .then(r => setSeries(r.data))
      .catch(() => {})
      .finally(() => setChartLoad(false))

    getCorrectionProposals('all')
      .then(r => setProposals(r.data.proposals || []))
      .catch(() => {})
  }

  useEffect(() => { loadAll() }, [])

  const handleGenerate = async () => {
    setGenerating(true)
    await generateProposals()
    const r = await getCorrectionProposals('all')
    setProposals(r.data.proposals || [])
    setGenerating(false)
  }

  const handleComputeOutcomes = async () => {
    setComputing(true)
    await computeOutcomes()
    await getPerformanceSeries().then(r => setSeries(r.data)).catch(() => {})
    setComputing(false)
  }

  const s = series?.summary

  // ── Summary stats from pick history ──────────────────────────────────────
  const withGain  = picks.filter(p => p.gain_pct !== null)
  const bestPick  = withGain.length ? withGain.reduce((best, p) => (p.gain_pct ?? -999) > (best.gain_pct ?? -999) ? p : best) : null
  const pendingProposals = proposals.filter(p => p.status === 'pending')

  const winRateData  = series?.win_rate_series ?? []
  const alphaData    = series?.alpha_series ?? []
  const tickInterval = Math.max(1, Math.floor((activeChart === 'winrate' ? winRateData : alphaData).length / 6))

  // ── Dynamic chart one-liners ──────────────────────────────────────────────
  const winRateInsight = (() => {
    if (!s || winRateData.length < 2) return null
    const latest  = winRateData[winRateData.length - 1]?.win_rate ?? 0
    const earlier = winRateData[Math.max(0, winRateData.length - 5)]?.win_rate ?? 0
    const trend   = latest - earlier
    const pctStr  = winRateStr(latest)
    if (latest >= 0.6 && trend >= 0)
      return `Win rate at ${pctStr} and holding — system is consistently outperforming SPY across recent picks.`
    if (latest >= 0.5 && trend > 0.1)
      return `Win rate climbing to ${pctStr} — recent picks are improving vs SPY after earlier weakness.`
    if (latest >= 0.5 && trend < -0.1)
      return `Win rate slipped to ${pctStr} — recent picks weaker, but still above the 50% break-even line.`
    if (latest < 0.4 && trend < 0)
      return `Win rate down to ${pctStr} across the last ${latest < 0.3 ? '8' : '8'} picks — system is in a losing streak vs SPY. Proposals may trigger.`
    if (latest < 0.5 && trend > 0.1)
      return `Win rate recovering (${pctStr}) — improving after a weak patch, but not yet above 50% break-even.`
    return `Win rate at ${pctStr} across the rolling 8-pick window — below the 50% threshold where picks beat SPY on average.`
  })()

  const alphaInsight = (() => {
    if (!s || alphaData.length < 2) return null
    const cum     = s.total_alpha
    const avg     = s.avg_alpha_14d ?? 0
    const n       = s.total_evaluated
    const last3   = alphaData.slice(-3).map(d => d.alpha ?? 0)
    const recent  = last3.reduce((a, b) => a + b, 0) / (last3.length || 1)
    if (cum > 10 && avg > 1)
      return `System is ahead — cumulative ${pct(cum)} across ${n} picks, averaging ${pct(avg)} alpha per pick vs SPY.`
    if (cum < -20 && recent < 0)
      return `Cumulative alpha at ${pct(cum)} — recent picks continue to lag SPY. Confirm setup quality before acting.`
    if (cum < 0 && recent > 2)
      return `Cumulative alpha still negative (${pct(cum)}) but last 3 picks are recovering (+${recent.toFixed(1)}% avg). Watch for trend reversal.`
    if (cum > 0 && recent < -3)
      return `Overall positive (${pct(cum)}) but the last 3 picks have dragged — recent momentum is fading.`
    return `Cumulative alpha of ${pct(cum)} across ${n} picks — each bar represents one pick's outperformance vs SPY at 14 days.`
  })()

  return (
    <div>
      {/* ── Action bar ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-bright)', letterSpacing: '0.02em' }}>Pick History & Performance</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>
            All SOTD picks since launch · win = outperforms SPY by &gt;2% at 14 trading days
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={handleComputeOutcomes} disabled={computing}>
            {computing ? '…' : '↻'} Update Outcomes
          </button>
          <button className="btn sm primary" onClick={handleGenerate} disabled={generating}>
            {generating ? '…' : '⚡'} Analyze & Propose
          </button>
          <button className="btn sm" onClick={loadAll}>↻ Refresh</button>
        </div>
      </div>

      {/* ── Stats strip ── */}
      {!chartLoad && s && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <StatCard label="Overall Win Rate"   value={winRateStr(s.overall_win_rate)}
            color={s.overall_win_rate != null && s.overall_win_rate >= 0.5 ? 'var(--green)' : 'var(--red)'}
            sub={`${s.wins}W · ${s.losses}L`} />
          <StatCard label="Rolling 8-Pick"     value={winRateStr(s.rolling_8pick_win_rate)}
            color={s.rolling_8pick_win_rate != null && s.rolling_8pick_win_rate >= 0.5 ? 'var(--green)' : 'var(--yellow)'}
            sub="Recent momentum" />
          <StatCard label="Cumulative Alpha"   value={pct(s.total_alpha)}
            color={s.total_alpha >= 0 ? 'var(--green)' : 'var(--red)'}
            sub="vs SPY at 14d" />
          <StatCard label="Avg Alpha / Pick"   value={pct(s.avg_alpha_14d)}
            color={(s.avg_alpha_14d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}
            sub="14-day window" />
          <StatCard label="Total Evaluated"    value={String(s.total_evaluated)}
            sub={`${s.total_pending} pending`} />
          {bestPick && (
            <StatCard label="Best Pick"  value={`${bestPick.symbol} ${pct(bestPick.gain_pct)}`} color="var(--green)" />
          )}
        </div>
      )}

      {/* ── Performance Charts ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        {/* Chart tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 14, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
          {([
            { key: 'winrate', label: 'Rolling Win Rate' },
            { key: 'alpha',   label: 'Cumulative Alpha vs SPY' },
          ] as const).map(t => (
            <button key={t.key} onClick={() => setActiveChart(t.key)}
              style={{
                padding: '7px 16px', background: 'none', border: 'none',
                borderBottom: `2px solid ${activeChart === t.key ? 'var(--cyan)' : 'transparent'}`,
                color: activeChart === t.key ? 'var(--cyan)' : 'var(--text-dim)',
                fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                cursor: 'pointer', fontFamily: 'var(--mono)', marginBottom: -1,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {chartLoad ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
            Loading performance data…
          </div>
        ) : winRateData.length === 0 ? (
          <div style={{ height: 160, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.82rem' }}>Not enough evaluated picks yet to show charts.</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>Picks need 14 trading days to settle. Click "Update Outcomes" to pull latest prices.</div>
          </div>
        ) : (
          <>
            {activeChart === 'winrate' && (
              <>
                {winRateInsight && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                    {winRateInsight}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={winRateData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} interval={tickInterval} />
                    <YAxis tickFormatter={v => `${Math.round(v * 100)}%`} domain={[0, 1]} tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={40} />
                    <ReferenceLine y={0.5} stroke="#e5e7eb" strokeDasharray="4 4" label={{ value: '50%', fill: '#9ca3af', fontSize: 9, position: 'insideRight' }} />
                    <Tooltip content={<WinRateTip />} />
                    <Line dataKey="win_rate" stroke="#2563eb" strokeWidth={2} dot={{ r: 3, fill: '#2563eb', strokeWidth: 0 }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
            {activeChart === 'alpha' && (
              <>
                {alphaInsight && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                    {alphaInsight}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={alphaData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} interval={tickInterval} />
                    <YAxis tickFormatter={v => `${v.toFixed(0)}%`} tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={40} />
                    <ReferenceLine y={0} stroke="#e5e7eb" strokeDasharray="4 4" />
                    <Tooltip content={<AlphaTip />} />
                    <Line dataKey="cumulative" stroke="#16a34a" strokeWidth={2} dot={false} name="Cumulative alpha" />
                    <Line dataKey="alpha" stroke="#93c5fd" strokeWidth={1} dot={{ r: 3, strokeWidth: 0 }} strokeDasharray="3 3" name="Pick alpha" />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'var(--text-dim)' }} />
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Correction Proposals ── */}
      {proposals.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div className="card-title">System Correction Proposals</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                Auto-generated when performance drifts · you approve before anything changes
              </div>
            </div>
            {pendingProposals.length > 0 && (
              <span style={{ fontSize: '0.68rem', fontWeight: 700, fontFamily: 'var(--mono)', background: 'var(--warn-bg)', color: 'var(--warn-text)', border: '1px solid var(--warn-border)', borderRadius: 12, padding: '3px 10px' }}>
                {pendingProposals.length} PENDING
              </span>
            )}
          </div>
          {proposals.map(p => (
            <ProposalCard key={p.id} p={p} onApprove={loadAll} onReject={loadAll} />
          ))}
        </div>
      )}

      {pendingProposals.length === 0 && !chartLoad && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: 14, padding: '8px 12px', background: 'var(--panel-inset)', borderRadius: 6, border: '1px solid var(--border)' }}>
          ✓ No pending system proposals. Click "Analyze &amp; Propose" to run the pattern check on current pick history.
        </div>
      )}

      {/* ── Pick history table ── */}
      <div className="card">
        <div className="card-title">All Picks</div>
        {loading ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>Loading pick history…</div>
        ) : error ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--red)', fontSize: '0.82rem' }}>{error}</div>
        ) : picks.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>No SOTD picks recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {['Date', 'Symbol', 'Score', 'Signal', 'Regime', 'Entry', 'Current', 'Gain', 'Days', 'Outcome'].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {picks.map(p => {
                // Match outcome from series data
                const outcomeRow = series?.alpha_series?.find(a => a.date === p.pick_date && a.ticker === p.symbol)
                const outcome = outcomeRow?.outcome ?? null
                return (
                  <>
                    <tr key={p.pick_date}
                      onClick={() => setExpanded(expanded === p.pick_date ? null : p.pick_date)}
                      style={{ cursor: 'pointer' }}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{p.pick_date}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{p.symbol}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: (p.confidence_score ?? 0) >= 80 ? 'var(--green)' : (p.confidence_score ?? 0) >= 65 ? 'var(--yellow)' : 'var(--text-dim)' }}>
                        {p.confidence_score ?? '—'}
                      </td>
                      <td style={{ fontSize: '0.75rem', color: 'var(--text-dim)', textTransform: 'capitalize' }}>{p.signal_type || '—'}</td>
                      <td><RegimeBadge regime={p.regime} /></td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p.entry_price != null ? `$${p.entry_price.toFixed(2)}` : '—'}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p.current_price != null ? `$${p.current_price.toFixed(2)}` : '—'}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: (p.gain_pct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {p.gain_pct != null ? pct(p.gain_pct) : '—'}
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>{p.days_held != null ? `${p.days_held}d` : '—'}</td>
                      <td><OutcomeDot outcome={outcome} /></td>
                    </tr>
                    {expanded === p.pick_date && p.summary && (
                      <tr key={`${p.pick_date}-exp`}>
                        <td colSpan={10} style={{ padding: '10px 14px', background: 'var(--panel-inset)', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6, maxWidth: 800 }}>
                            <span style={{ color: 'var(--yellow)', fontWeight: 700, marginRight: 8, fontFamily: 'var(--mono)' }}>WHY PICKED:</span>
                            {p.summary}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: '0.65rem', color: 'var(--text-dim)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
        Click any row to see pick rationale · Outcome = alpha vs SPY at 14 trading days
      </div>
    </div>
  )
}
