import { useState, useEffect, useCallback } from 'react'
import {
  getVirtualSummary, getVirtualClosed, getVirtualDecisions,
  getVirtualPerformance, postVirtualReload, postVirtualBackfill, postVirtualEvaluate,
} from '../api'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'

const S: Record<string, React.CSSProperties> = {
  panel:    { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' },
  hd:       { fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', fontFamily: 'var(--mono)', marginBottom: 10 },
  mono:     { fontFamily: 'var(--mono)', fontSize: '0.82rem' },
  label:    { fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase' as const, letterSpacing: '0.08em' },
  value:    { fontSize: '0.95rem', fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' },
}

function pct(v: number | null | undefined, decimals = 2) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}

function color(v: number | null | undefined) {
  if (v == null) return 'var(--text-dim)'
  return v >= 0 ? 'var(--green)' : 'var(--red)'
}

// ── Summary cards ─────────────────────────────────────────────────────────────
function SummaryCard({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={S.label}>{label}</div>
      <div style={{ ...S.value, color: valueColor ?? 'var(--text-bright)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

// ── Performance chart ─────────────────────────────────────────────────────────
function PerformanceChart() {
  const [data, setData] = useState<any[]>([])
  useEffect(() => {
    getVirtualPerformance().then(r => {
      const port = r.data.portfolio ?? []
      const bench = Object.fromEntries((r.data.benchmark ?? []).map((b: any) => [b.date, b.spy_cumulative_pct]))
      setData(port.map((p: any) => ({
        date:   p.date,
        port:   p.cumulative_return_pct ?? 0,
        spy:    bench[p.date] ?? null,
      })))
    }).catch(() => {})
  }, [])

  if (!data.length) return <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>No performance data yet</div>

  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data}>
        <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#555', fontFamily: 'monospace' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`} tick={{ fontSize: 9, fill: '#555', fontFamily: 'monospace' }} tickLine={false} axisLine={false} width={42} />
        <Tooltip formatter={(v: any, n: string) => [`${(+v).toFixed(2)}%`, n === 'port' ? 'AI Portfolio' : 'SPY']} contentStyle={{ background: '#0d1117', border: '1px solid #2a2a3a', fontSize: '0.75rem', fontFamily: 'monospace' }} />
        <ReferenceLine y={0} stroke="#2a2a3a" strokeDasharray="3 3" />
        <Legend wrapperStyle={{ fontSize: '0.65rem', fontFamily: 'monospace' }} />
        <Line type="monotone" dataKey="port" name="AI Portfolio" stroke="var(--green)" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="spy"  name="SPY"         stroke="#475569"     dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Open positions ────────────────────────────────────────────────────────────
function OpenPositions({ positions }: { positions: any[] }) {
  if (!positions.length) return (
    <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', padding: '8px 0', fontFamily: 'var(--mono)' }}>
      No open positions.
    </div>
  )
  return (
    <table>
      <thead>
        <tr><th>Ticker</th><th>Entry</th><th>Current</th><th>Return</th><th>Days</th><th>Score</th><th>Status</th></tr>
      </thead>
      <tbody>
        {positions.map(p => (
          <tr key={p.id}>
            <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{p.ticker}</td>
            <td style={S.mono}>${p.entry_price?.toFixed(2)}</td>
            <td style={S.mono}>${p.current_price?.toFixed(2)}</td>
            <td style={{ ...S.mono, color: color(p.return_pct), fontWeight: 700 }}>{pct(p.return_pct)}</td>
            <td style={S.mono}>{p.days_held}d</td>
            <td style={{ ...S.mono, color: (p.current_score ?? 0) >= 75 ? 'var(--green)' : (p.current_score ?? 0) >= 60 ? 'var(--yellow)' : 'var(--red)' }}>
              {p.current_score ?? '—'}
            </td>
            <td>
              <span style={{
                fontSize: '0.65rem', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: '0.05em',
                color: p.score_status === 'Strong' ? 'var(--green)' : p.score_status === 'Weakening' ? 'var(--red)' : 'var(--yellow)',
              }}>{p.score_status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Closed trades ─────────────────────────────────────────────────────────────
function ClosedTrades({ initialCapital }: { initialCapital: number }) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => {
    getVirtualClosed().then(r => setRows(r.data.positions ?? [])).catch(() => {})
  }, [])

  if (!rows.length) return <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>No closed trades yet.</div>

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Ticker</th><th>Shares</th><th>Invested</th>
            <th>Entry $</th><th>Exit $</th>
            <th>P&amp;L $</th><th>Trade %</th><th>Port Impact</th>
            <th>Hold</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const qty      = p.quantity ?? 0
            const invested = qty * (p.entry_price ?? 0)
            const pnlDollar = p.exit_price && p.entry_price
              ? round(qty * (p.exit_price - p.entry_price), 2) : null
            const tradePct  = p.exit_price && p.entry_price
              ? round((p.exit_price / p.entry_price - 1) * 100, 2) : null
            const portImpact = pnlDollar != null && initialCapital > 0
              ? round((pnlDollar / initialCapital) * 100, 2) : null
            const days = p.exit_date && p.entry_date
              ? Math.round((new Date(p.exit_date).getTime() - new Date(p.entry_date).getTime()) / 86400000) : null
            return (
              <tr key={p.id}>
                <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{p.ticker}</td>
                <td style={S.mono}>{qty.toFixed(2)}</td>
                <td style={S.mono}>${invested.toFixed(0)}</td>
                <td style={S.mono}>${p.entry_price?.toFixed(2)}</td>
                <td style={S.mono}>{p.exit_price ? `$${p.exit_price.toFixed(2)}` : '—'}</td>
                <td style={{ ...S.mono, color: color(pnlDollar), fontWeight: 700 }}>
                  {pnlDollar != null ? `${pnlDollar >= 0 ? '+' : ''}$${pnlDollar.toFixed(2)}` : '—'}
                </td>
                <td style={{ ...S.mono, color: color(tradePct), fontWeight: 700 }}>{pct(tradePct)}</td>
                <td style={{ ...S.mono, color: color(portImpact), fontSize: '0.72rem' }} title="P&L as % of starting $10k">
                  {portImpact != null ? `${portImpact >= 0 ? '+' : ''}${portImpact.toFixed(2)}%` : '—'}
                </td>
                <td style={S.mono}>{days != null ? `${days}d` : '—'}</td>
                <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.exit_reason ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
        <strong>Trade %</strong> = per-share return · <strong>Port Impact</strong> = how much that trade moved the $10k portfolio · A 40% trade return on a $2k position = +8% portfolio impact
      </div>
    </>
  )
}

// ── Decision Intelligence Table ───────────────────────────────────────────────
const ACTION_COLORS: Record<string, string> = {
  BUY: 'var(--green)', SELL: 'var(--red)', HOLD: 'var(--cyan)', SKIP: 'var(--yellow)',
}

function ExpandedRow({ d }: { d: any }) {
  const r = (() => { try { return JSON.parse(d.reasoning_json || '{}') } catch { return {} } })()
  return (
    <tr>
      <td colSpan={8} style={{ background: '#080d14', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

          {/* Decision summary */}
          <div>
            <div style={{ ...S.label, color: 'var(--cyan)', marginBottom: 6 }}>Decision Summary</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>
              {r.rationale || 'No explanation available.'}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              <span style={{ ...S.mono, fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                Score: <span style={{ color: 'var(--text-bright)' }}>{d.score_previous} → {d.score_current}</span>
              </span>
              <span style={{ ...S.mono, fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                Regime: <span style={{ color: 'var(--text-bright)' }}>{d.regime_entry} → {d.regime_current}</span>
              </span>
              <span style={{ ...S.mono, fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                Days held: <span style={{ color: 'var(--text-bright)' }}>{d.days_held ?? '—'}</span>
              </span>
            </div>
          </div>

          {/* Why selected / rejected */}
          <div>
            {r.why_selected?.length > 0 && (
              <>
                <div style={{ ...S.label, color: 'var(--green)', marginBottom: 4 }}>Why This</div>
                {r.why_selected.map((b: string, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 6, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.5, marginBottom: 2 }}>
                    <span style={{ color: 'var(--green)', flexShrink: 0 }}>+</span><span>{b}</span>
                  </div>
                ))}
              </>
            )}
            {r.why_rejected?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ ...S.label, color: 'var(--red)', marginBottom: 4 }}>Why Rejected / Exited</div>
                {r.why_rejected.map((b: string, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 6, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.5, marginBottom: 2 }}>
                    <span style={{ color: 'var(--red)', flexShrink: 0 }}>!</span><span>{b}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* What changed + risk signals */}
          <div>
            {r.what_changed?.length > 0 && (
              <>
                <div style={{ ...S.label, color: 'var(--yellow)', marginBottom: 4 }}>What Changed</div>
                {r.what_changed.map((b: string, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 6, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.5, marginBottom: 2 }}>
                    <span style={{ color: 'var(--yellow)', flexShrink: 0 }}>Δ</span><span>{b}</span>
                  </div>
                ))}
              </>
            )}
            {r.risk_signals?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ ...S.label, color: 'var(--red)', marginBottom: 4 }}>Risk Signals</div>
                {r.risk_signals.map((b: string, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 6, fontSize: '0.72rem', color: '#f87171', lineHeight: 1.5, marginBottom: 2 }}>
                    <span style={{ flexShrink: 0 }}>⚠</span><span>{b}</span>
                  </div>
                ))}
              </div>
            )}
            {(!r.risk_signals?.length && !r.what_changed?.length) && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>No additional signals.</div>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

function DecisionTable() {
  const [rows,       setRows]       = useState<any[]>([])
  const [expanded,   setExpanded]   = useState<Set<number>>(new Set())
  const [filterAct,  setFilterAct]  = useState('')
  const [filterTick, setFilterTick] = useState('')
  const [loading,    setLoading]    = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    getVirtualDecisions({ limit: 100, action: filterAct || undefined, ticker: filterTick.toUpperCase() || undefined })
      .then(r => { setRows(r.data.decisions ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filterAct, filterTick])

  useEffect(() => { load() }, [load])

  const toggle = (id: number) => setExpanded(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const confidenceColor = (c: string) =>
    c === 'High' ? 'var(--green)' : c === 'Low' ? 'var(--red)' : 'var(--yellow)'

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const }}>
        {['', 'BUY', 'SELL', 'HOLD', 'SKIP'].map(a => (
          <button
            key={a}
            className={`btn sm${filterAct === a ? ' primary' : ''}`}
            onClick={() => { setFilterAct(a); }}
          >{a || 'ALL'}</button>
        ))}
        <input
          placeholder="Filter ticker"
          value={filterTick}
          onChange={e => setFilterTick(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
          style={{
            background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3,
            color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.78rem',
            padding: '4px 8px', width: 100, outline: 'none',
          }}
        />
        <button className="btn sm" onClick={load}>↻</button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>Loading…</div>
      ) : !rows.length ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>
          No decisions logged yet. Run a backfill or wait for tomorrow's evaluation.
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>Date</th><th>Ticker</th><th>Action</th><th>Score Δ</th><th>Regime</th><th>Return</th><th>Confidence</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(d => (
              <>
                <tr
                  key={d.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggle(d.id)}
                >
                  <td style={S.mono}>{d.date}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{d.ticker}</td>
                  <td>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 800, fontFamily: 'var(--mono)',
                      letterSpacing: '0.08em', color: ACTION_COLORS[d.action] ?? 'var(--text-dim)',
                    }}>{d.action}</span>
                  </td>
                  <td style={{ ...S.mono, color: (d.score_current ?? 0) >= (d.score_previous ?? 0) ? 'var(--green)' : 'var(--red)' }}>
                    {d.score_previous ?? '—'} → {d.score_current ?? '—'}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    {d.regime_entry !== d.regime_current
                      ? <span style={{ color: 'var(--yellow)' }}>{d.regime_entry}→{d.regime_current}</span>
                      : d.regime_current}
                  </td>
                  <td style={{ ...S.mono, color: color(d.return_pct) }}>{pct(d.return_pct)}</td>
                  <td>
                    <span style={{ fontSize: '0.65rem', fontFamily: 'var(--mono)', color: confidenceColor(d.confidence ?? '') }}>
                      {d.confidence ?? '—'}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>
                    {expanded.has(d.id) ? '▲' : '▼'}
                  </td>
                </tr>
                {expanded.has(d.id) && <ExpandedRow key={`exp-${d.id}`} d={d} />}
              </>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function round(v: number, d: number) { return Math.round(v * 10 ** d) / 10 ** d }

// ── Main tab ──────────────────────────────────────────────────────────────────
export default function VirtualPortfolioTab() {
  const [summary, setSummary] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState('')
  const [msg,     setMsg]     = useState('')
  const [reload,  setReload]  = useState('2000')

  const loadSummary = () => {
    setLoading(true)
    getVirtualSummary()
      .then(r => { setSummary(r.data.data); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { loadSummary() }, [])

  const act = (key: string, fn: () => Promise<any>, successMsg: string) => {
    setBusy(key); setMsg('')
    fn().then(() => { setMsg(successMsg); loadSummary() })
       .catch(e => setMsg(e?.response?.data?.detail ?? 'Failed'))
       .finally(() => setBusy(''))
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-dim)', fontSize: '0.8rem' }}>
      Loading portfolio…
    </div>
  )

  const s = summary ?? {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Suspended banner */}
      {s.is_suspended && (
        <div style={{ background: '#1a0000', border: '1px solid var(--red)', borderRadius: 4, padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--mono)', letterSpacing: '0.1em' }}>⛔ STRATEGY SUSPENDED</span>
          <span style={{ fontSize: '0.78rem', color: '#f87171' }}>Portfolio cash dropped below ${s.floor_value?.toLocaleString()} floor. Reload to resume trading.</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <input
              type="number" value={reload} onChange={e => setReload(e.target.value)}
              style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.82rem', padding: '4px 8px', width: 90, outline: 'none' }}
            />
            <button className="btn sm primary" disabled={busy === 'reload'}
              onClick={() => act('reload', () => postVirtualReload(parseFloat(reload)), `Reloaded $${reload}`)}>
              {busy === 'reload' ? '…' : '+ Reload'}
            </button>
          </div>
        </div>
      )}

      {/* Section 1: Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
        <SummaryCard label="Portfolio Value"    value={`$${(s.total_value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          sub={`Started $${(s.initial_capital ?? 10000).toLocaleString()}`} />
        <SummaryCard label="Total Return"       value={pct(s.cumulative_return_pct)} valueColor={color(s.cumulative_return_pct)} />
        <SummaryCard label="Alpha vs SPY"       value={pct(s.alpha_pct)} valueColor={color(s.alpha_pct)} sub={`SPY ${pct(s.spy_cumulative_pct)}`} />
        <SummaryCard label="Cash Available"     value={`$${(s.cash ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          sub={s.is_suspended ? '⛔ Suspended' : 'Ready to deploy'} />
        <SummaryCard label="Open Positions"     value={String(s.open_positions?.length ?? 0)} sub={`of 5 max`} />
      </div>

      {/* Performance chart */}
      <div style={S.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={S.hd}>Cumulative Return vs SPY</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={() => act('backfill', postVirtualBackfill, 'Backfill complete')} disabled={!!busy}>
              {busy === 'backfill' ? '…' : '⏮ Backfill History'}
            </button>
            <button className="btn sm" onClick={() => act('eval', postVirtualEvaluate, 'Evaluation complete')} disabled={!!busy}>
              {busy === 'eval' ? '…' : '▶ Evaluate Now'}
            </button>
            <button className="btn sm" onClick={loadSummary}>↻</button>
          </div>
        </div>
        {msg && <div style={{ fontSize: '0.72rem', color: 'var(--green)', fontFamily: 'var(--mono)', marginBottom: 6 }}>{msg}</div>}
        <PerformanceChart />
      </div>

      {/* Section 2: Open positions */}
      <div style={S.panel}>
        <div style={S.hd}>Open Positions</div>
        <OpenPositions positions={s.open_positions ?? []} />
      </div>

      {/* Section 3: Closed trades */}
      <div style={S.panel}>
        <div style={S.hd}>Closed Trades</div>
        <ClosedTrades initialCapital={s.initial_capital ?? 10000} />
      </div>

      {/* Section 4: Decision Intelligence Table */}
      <div style={S.panel}>
        <div style={S.hd}>Decision Intelligence Log — click any row to expand reasoning</div>
        <DecisionTable />
      </div>

      {/* Reload wallet (not suspended) */}
      {!s.is_suspended && (
        <div style={{ ...S.panel, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ ...S.label, marginBottom: 0 }}>Add Capital</div>
          <input
            type="number" value={reload} onChange={e => setReload(e.target.value)}
            style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.82rem', padding: '4px 8px', width: 90, outline: 'none' }}
          />
          <button className="btn sm" disabled={busy === 'reload'}
            onClick={() => act('reload', () => postVirtualReload(parseFloat(reload)), `Added $${reload} to portfolio`)}>
            {busy === 'reload' ? '…' : '+ Add Cash'}
          </button>
        </div>
      )}
    </div>
  )
}
