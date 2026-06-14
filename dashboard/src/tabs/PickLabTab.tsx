import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, Cell, ScatterChart, Scatter, CartesianGrid, ZAxis } from 'recharts'
import { getPickLab, getPickLabAlerts } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Pick {
  pick_date: string; symbol: string; company: string; sector: string
  regime: string; confidence_score: number; signal_type: string; tier: string
  summary: string; thesis: string; score_breakdown: Record<string, number>
  holding_horizon: string; conviction_level: string
  entry_price: number | null; current_price: number | null
  gain_pct: number | null; vs_spy_pct: number | null
  return_30d: number | null; vs_spy_30d: number | null
  days_held: number; alert_flag: 'BULL' | 'BEAR' | null
  change_today_pct: number | null
}
interface Alert {
  symbol: string; change_pct: number; flag: 'BULL' | 'BEAR'; price: number
  pick_date: string; confidence_score: number; company: string; days_since_pick: number
}

const T = {
  bg: '#07101F', panel: '#0C1A2E', border: 'rgba(255,255,255,0.07)',
  text: '#CBD5E1', bright: '#F1F5F9', dim: '#64748B',
  green: '#22C55E', red: '#EF4444', yellow: '#F59E0B', blue: '#3B82F6',
  mono: 'var(--mono)',
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(v: number | null, decimals = 1) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}
function pctColor(v: number | null) {
  if (v == null) return T.dim
  return v > 0 ? T.green : v < 0 ? T.red : T.dim
}
function playAlert() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime
    const osc = ctx.createOscillator(); const g = ctx.createGain()
    osc.connect(g); g.connect(ctx.destination)
    osc.frequency.value = 660
    g.gain.setValueAtTime(0.25, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
    osc.start(now); osc.stop(now + 0.4)
  } catch { /* */ }
}
function browserNotify(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, silent: true })
  }
}
function requestNotifPerms() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

// ── Chart data builders ───────────────────────────────────────────────────────
function buildSignalTypeData(picks: Pick[]) {
  const map: Record<string, number[]> = {}
  picks.forEach(p => {
    if (p.vs_spy_pct == null) return
    const key = p.signal_type || 'unknown'
    if (!map[key]) map[key] = []
    map[key].push(p.vs_spy_pct)
  })
  return Object.entries(map)
    .map(([type, vals]) => ({
      type: type.replace(/_/g, ' '),
      avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10,
      count: vals.length,
      wins: vals.filter(v => v > 0).length,
    }))
    .sort((a, b) => b.avg - a.avg)
}

function buildRegimeData(picks: Pick[]) {
  const map: Record<string, number[]> = {}
  picks.forEach(p => {
    if (p.vs_spy_pct == null) return
    const key = (p.regime || 'unknown').toUpperCase()
    if (!map[key]) map[key] = []
    map[key].push(p.vs_spy_pct)
  })
  return ['BULL', 'CHOP', 'BEAR'].map(r => {
    const vals = map[r] ?? []
    return {
      regime: r,
      avg: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null,
      count: vals.length,
      wins: vals.filter(v => v > 0).length,
    }
  }).filter(d => d.count > 0)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AlertBanner({ alerts, onDismiss }: { alerts: Alert[]; onDismiss: () => void }) {
  if (!alerts.length) return null
  return (
    <div style={{
      background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
      borderRadius: 8, padding: '10px 16px', marginBottom: 14,
      display: 'flex', alignItems: 'flex-start', gap: 12,
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚡</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: T.yellow, marginBottom: 4 }}>
          {alerts.length} Past Pick{alerts.length > 1 ? 's' : ''} with Unusual Move Today
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {alerts.map(a => (
            <span key={a.symbol} style={{
              fontSize: '0.72rem', padding: '2px 8px', borderRadius: 4,
              background: a.flag === 'BULL' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color: a.flag === 'BULL' ? T.green : T.red,
              fontFamily: T.mono, fontWeight: 600,
            }}>
              {a.symbol} {a.flag === 'BULL' ? '▲' : '▼'} {pct(a.change_pct)} today
              <span style={{ color: T.dim, fontWeight: 400 }}> · {a.days_since_pick}d since pick</span>
            </span>
          ))}
        </div>
      </div>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: T.dim, cursor: 'pointer', fontSize: 14 }}>✕</button>
    </div>
  )
}

function ChartTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: T.mono }}>{title}</div>
      {sub && <div style={{ fontSize: '0.62rem', color: T.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const tooltipStyle = { background: '#0C1A2E', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, fontSize: 11 }

function SignalTypeChart({ picks }: { picks: Pick[] }) {
  const data = buildSignalTypeData(picks)
  if (!data.length) return null
  return (
    <div className="card" style={{ flex: 1 }}>
      <ChartTitle
        title="Signal Type Performance"
        sub="Avg excess return vs SPY — which signals are actually working?"
      />
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 28)}>
        <BarChart data={data} layout="vertical" barSize={14} margin={{ top: 0, right: 40, left: 60, bottom: 0 }}>
          <XAxis type="number" tick={{ fontSize: 10, fill: T.dim }} axisLine={false} tickLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v}%`} />
          <YAxis type="category" dataKey="type" tick={{ fontSize: 10, fill: T.text }} axisLine={false} tickLine={false} width={58} />
          <Tooltip contentStyle={tooltipStyle}
            formatter={(val: number, _: string, props: any) => {
              const d = props.payload
              const winRate = d.count ? Math.round(d.wins / d.count * 100) : 0
              return [`${val > 0 ? '+' : ''}${val}% avg vs SPY · ${winRate}% beat SPY · ${d.count} picks`, '']
            }} />
          <ReferenceLine x={0} stroke={T.border} />
          <Bar dataKey="avg" radius={[0, 3, 3, 0]}>
            {data.map((d, i) => <Cell key={i} fill={d.avg >= 0 ? T.green : T.red} fillOpacity={0.8} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function RegimeChart({ picks }: { picks: Pick[] }) {
  const data = buildRegimeData(picks)
  if (!data.length) return null
  const regimeColor: Record<string, string> = { BULL: T.green, BEAR: T.red, CHOP: T.yellow }
  return (
    <div className="card" style={{ flex: 1 }}>
      <ChartTitle
        title="Performance by Market Regime"
        sub="Does our model work equally well in all conditions?"
      />
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={36} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <XAxis dataKey="regime" tick={{ fontSize: 11, fill: T.dim }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: T.dim }} axisLine={false} tickLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v}%`} />
          <Tooltip contentStyle={tooltipStyle}
            formatter={(_: any, __: any, props: any) => {
              const d = props.payload
              const winRate = d.count ? Math.round(d.wins / d.count * 100) : 0
              return [`${(d.avg ?? 0) > 0 ? '+' : ''}${d.avg ?? 0}% avg vs SPY · ${winRate}% beat SPY · ${d.count} picks`, d.regime]
            }} />
          <ReferenceLine y={0} stroke={T.border} />
          <Bar dataKey="avg" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => <Cell key={i} fill={regimeColor[d.regime] ?? T.blue} fillOpacity={0.8} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p style={{ fontSize: '0.63rem', color: T.dim, marginTop: 4 }}>
        Takeaway: if CHOP bar is deeply negative, be more selective when the system flags a choppy market.
      </p>
    </div>
  )
}

function ScoreScatter({ picks, onSelect }: { picks: Pick[]; onSelect: (p: Pick) => void }) {
  const data = picks
    .filter(p => p.vs_spy_pct != null && p.confidence_score != null)
    .map(p => ({ x: p.confidence_score, y: p.vs_spy_pct, symbol: p.symbol, pick_date: p.pick_date, _pick: p }))

  if (data.length < 3) return null

  return (
    <div className="card" style={{ flex: 1 }}>
      <ChartTitle
        title="Confidence vs Actual Return"
        sub="Does higher confidence actually predict better results? Click a dot."
      />
      <ResponsiveContainer width="100%" height={180}>
        <ScatterChart margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name="Confidence" domain={['auto', 'auto']}
            tick={{ fontSize: 10, fill: T.dim }} axisLine={false} tickLine={false} unit="%" />
          <YAxis type="number" dataKey="y" name="vs SPY"
            tick={{ fontSize: 10, fill: T.dim }} axisLine={false} tickLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v}%`} />
          <ZAxis range={[30, 30]} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }}
            content={({ payload }) => {
              if (!payload?.length) return null
              const d = payload[0].payload
              return (
                <div style={{ background: '#0C1A2E', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, padding: '6px 10px', fontSize: 11 }}>
                  <div style={{ fontWeight: 700, color: T.bright, fontFamily: T.mono }}>{d.symbol}</div>
                  <div style={{ color: T.dim }}>{d.pick_date}</div>
                  <div style={{ color: T.text }}>Confidence: {d.x}%</div>
                  <div style={{ color: (d.y ?? 0) >= 0 ? T.green : T.red }}>vs SPY: {(d.y ?? 0) > 0 ? '+' : ''}{d.y}%</div>
                </div>
              )
            }}
          />
          <ReferenceLine y={0} stroke={T.border} strokeDasharray="4 4" />
          <Scatter
            data={data}
            onClick={(d: any) => onSelect(d._pick)}
            style={{ cursor: 'pointer' }}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={(d.y ?? 0) >= 0 ? T.green : T.red} fillOpacity={0.75} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <p style={{ fontSize: '0.63rem', color: T.dim, marginTop: 4 }}>
        Top-right = high confidence + beat SPY (model working). Top-left = lucky without confidence. Bottom-right = overconfident.
      </p>
    </div>
  )
}

function DetailPanel({ pick, onDeepDive }: { pick: Pick | null; onDeepDive?: (ticker: string) => void }) {
  if (!pick) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: T.dim }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ opacity: 0.3 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
        <span style={{ fontSize: '0.78rem' }}>Click a pick to see details</span>
      </div>
    )
  }

  const SKIP_KEYS = new Set(['total', 'tech_raw', 'regime_penalty', 'fundamental'])
  const scores = (Object.entries(pick.score_breakdown || {}) as [string, number][])
    .filter(([k, v]) => !SKIP_KEYS.has(k) && typeof v === 'number')

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: '14px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: T.mono, fontSize: '1rem', fontWeight: 800, color: T.bright }}>{pick.symbol}</span>
          {pick.alert_flag && (
            <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '1px 6px', borderRadius: 3,
              background: pick.alert_flag === 'BULL' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
              color: pick.alert_flag === 'BULL' ? T.green : T.red }}>
              ⚡ {pick.alert_flag}
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.72rem', color: T.dim }}>{pick.company} · {pick.sector}</div>
        <div style={{ fontSize: '0.7rem', color: T.dim, marginTop: 2 }}>
          Picked {pick.pick_date} · {pick.confidence_score}% confidence · {pick.tier}
        </div>
      </div>

      {/* Performance grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {[
          { label: 'Since Pick',  value: pct(pick.gain_pct),    color: pctColor(pick.gain_pct) },
          { label: 'vs SPY',      value: pct(pick.vs_spy_pct),  color: pctColor(pick.vs_spy_pct) },
          { label: '30-Day Return', value: pick.return_30d != null ? pct(pick.return_30d) : pick.days_held < 30 ? `${30 - pick.days_held}d left` : '—',
            color: pctColor(pick.return_30d) },
          { label: 'vs SPY 30d',  value: pct(pick.vs_spy_30d), color: pctColor(pick.vs_spy_30d) },
          { label: 'Entry',        value: pick.entry_price ? `$${pick.entry_price.toFixed(2)}` : '—', color: T.text },
          { label: 'Now',          value: pick.current_price ? `$${pick.current_price.toFixed(2)}` : '—', color: T.bright },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '7px 10px' }}>
            <div style={{ fontSize: '0.6rem', color: T.dim, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color, fontFamily: T.mono }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Today's move */}
      {pick.change_today_pct != null && (
        <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 6,
          background: (pick.change_today_pct ?? 0) >= 0 ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${(pick.change_today_pct ?? 0) >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}` }}>
          <span style={{ fontSize: '0.72rem', color: T.dim }}>Today </span>
          <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.78rem', color: pctColor(pick.change_today_pct) }}>
            {pct(pick.change_today_pct)}
          </span>
        </div>
      )}

      {/* Original thesis */}
      {pick.thesis && (
        <div style={{ marginBottom: 12 }}>
          <div className="card-title">Original Thesis</div>
          <p style={{ fontSize: '0.78rem', color: T.text, lineHeight: 1.6 }}>{pick.thesis}</p>
        </div>
      )}

      {/* Score breakdown */}
      {scores.length > 0 && (
        <div>
          <div className="card-title">Score Breakdown</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {scores.map(([key, val]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.7rem', color: T.dim, width: 90, flexShrink: 0, textTransform: 'capitalize' }}>
                  {key.replace(/_/g, ' ')}
                </span>
                <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                  <div style={{ width: `${Math.min(100, Math.max(0, Math.abs(val)))}%`, height: '100%',
                    borderRadius: 2, background: val < 0 ? T.red : val >= 60 ? T.green : val >= 30 ? T.yellow : T.red }} />
                </div>
                <span style={{ fontSize: '0.7rem', fontFamily: T.mono, fontWeight: 600, color: val < 0 ? T.red : T.text, width: 32, textAlign: 'right' }}>
                  {val}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {onDeepDive && (
        <button
          className="btn primary sm"
          style={{ width: '100%', marginTop: 14, fontSize: '0.78rem' }}
          onClick={() => onDeepDive(pick.symbol)}
        >
          → Open {pick.symbol} in Deep Dive
        </button>
      )}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: '0.62rem', color: T.dim }}>
          ⚠ Performance shown is model validation only — not actual P&L unless this was logged as a trade.
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
type SortKey = 'pick_date' | 'confidence_score' | 'gain_pct' | 'vs_spy_pct' | 'return_30d'
type FilterMode = 'all' | 'winners' | 'losers' | 'alerted' | 'high_conf'

export default function PickLabTab({ onDeepDive }: { onDeepDive?: (ticker: string) => void }) {
  const [picks,      setPicks]      = useState<Pick[]>([])
  const [alerts,     setAlerts]     = useState<Alert[]>([])
  const [alertsDismissed, setAlertsDismissed] = useState(false)
  const [loading,    setLoading]    = useState(true)
  const [selected,   setSelected]   = useState<Pick | null>(null)
  const [search,     setSearch]     = useState('')
  const [sortKey,    setSortKey]    = useState<SortKey>('pick_date')
  const [sortDir,    setSortDir]    = useState<'asc' | 'desc'>('desc')
  const [filter,     setFilter]     = useState<FilterMode>('all')
  const seenAlerts   = useRef<Set<string>>(new Set())

  const loadPicks = () => {
    setLoading(true)
    getPickLab()
      .then(r => setPicks(r.data.picks || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const loadAlerts = () => {
    getPickLabAlerts().then(r => {
      const newAlerts: Alert[] = r.data.alerts || []
      // Browser notify for new ones
      newAlerts.forEach(a => {
        const key = `${a.symbol}-${new Date().toDateString()}`
        if (!seenAlerts.current.has(key)) {
          seenAlerts.current.add(key)
          playAlert()
          browserNotify(
            `Pick Lab — ${a.flag} Signal: ${a.symbol}`,
            `${a.company} ${a.flag === 'BULL' ? '▲' : '▼'} ${a.change_pct > 0 ? '+' : ''}${a.change_pct.toFixed(1)}% today · ${a.days_since_pick}d since your pick`
          )
        }
      })
      setAlerts(newAlerts)
    }).catch(() => {})
  }

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    loadPicks()
    loadAlerts()
    const interval = setInterval(loadAlerts, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // ── Derived stats ──────────────────────────────────────────────────────────
  const withGain    = picks.filter(p => p.vs_spy_pct != null)
  const winners     = withGain.filter(p => (p.vs_spy_pct ?? 0) > 0)
  const winRate     = withGain.length ? Math.round(winners.length / withGain.length * 100) : null
  const avgVsSpy    = withGain.length ? withGain.reduce((s, p) => s + (p.vs_spy_pct ?? 0), 0) / withGain.length : null
  const bestPick    = withGain.length ? withGain.reduce((b, p) => (p.vs_spy_pct ?? -999) > (b.vs_spy_pct ?? -999) ? p : b) : null
  const worstPick   = withGain.length ? withGain.reduce((b, p) => (p.vs_spy_pct ?? 999) < (b.vs_spy_pct ?? 999) ? p : b) : null

  // ── Filtering + sorting ────────────────────────────────────────────────────
  const filtered = picks.filter(p => {
    const matchSearch = !search || p.symbol.includes(search.toUpperCase()) || p.company.toLowerCase().includes(search.toLowerCase())
    const matchFilter =
      filter === 'all'       ? true :
      filter === 'winners'   ? (p.vs_spy_pct ?? 0) > 0 :
      filter === 'losers'    ? (p.vs_spy_pct ?? 0) < 0 :
      filter === 'alerted'   ? !!p.alert_flag :
      filter === 'high_conf' ? (p.confidence_score ?? 0) >= 70 :
      true
    return matchSearch && matchFilter
  })

  const sorted = [...filtered].sort((a, b) => {
    const va = (a[sortKey] as number | null) ?? (sortKey === 'pick_date' ? a.pick_date : -Infinity)
    const vb = (b[sortKey] as number | null) ?? (sortKey === 'pick_date' ? b.pick_date : -Infinity)
    if (va < vb) return sortDir === 'asc' ? -1 : 1
    if (va > vb) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const SortHdr = ({ label, k }: { label: string; k: SortKey }) => (
    <th onClick={() => toggleSort(k)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {label} {sortKey === k ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  )

  return (
    <div style={{ background: T.bg, minHeight: '100%' }}>
      {/* ── Summary bar ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Total Picks',  value: picks.length, color: T.bright },
          { label: 'Win Rate vs SPY', value: winRate != null ? `${winRate}%` : '—', color: winRate != null ? (winRate >= 50 ? T.green : T.red) : T.dim },
          { label: 'Avg vs SPY',   value: avgVsSpy != null ? pct(avgVsSpy) : '—', color: pctColor(avgVsSpy) },
          { label: 'Best Pick',    value: bestPick ? `${bestPick.symbol} ${pct(bestPick.vs_spy_pct)}` : '—', color: T.green },
          { label: 'Worst Pick',   value: worstPick ? `${worstPick.symbol} ${pct(worstPick.vs_spy_pct)}` : '—', color: T.red },
        ].map(({ label, value, color }) => (
          <div key={label} className="card" style={{ padding: '10px 14px', margin: 0 }}>
            <div className="card-title" style={{ marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: '0.88rem', fontWeight: 700, color, fontFamily: T.mono }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Alert banner ─────────────────────────────────────────────────── */}
      {!alertsDismissed && <AlertBanner alerts={alerts} onDismiss={() => setAlertsDismissed(true)} />}

      {/* ── Main three-panel layout ───────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14 }}>

        {/* Left: pick table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ width: 160, fontFamily: T.mono }}
              placeholder="Search ticker or company…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {(['all', 'winners', 'losers', 'high_conf', 'alerted'] as FilterMode[]).map(f => (
              <button key={f} className={`btn sm${filter === f ? ' primary' : ''}`}
                onClick={() => setFilter(f)}
                style={filter === f ? {} : {}}>
                {f === 'all' ? 'All' : f === 'winners' ? '▲ Beat SPY' : f === 'losers' ? '▼ Lagged' : f === 'high_conf' ? '70%+ Conf' : `⚡ Alerted (${alerts.length})`}
              </button>
            ))}
            <button className="btn sm" onClick={loadPicks} style={{ marginLeft: 'auto' }}>↻</button>
          </div>

          {/* Table */}
          {loading ? (
            <div style={{ padding: '32px', textAlign: 'center', color: T.dim, fontSize: '0.82rem' }}>
              Loading picks… (fetching live prices takes ~10s)
            </div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 520 }}>
              <table>
                <thead>
                  <tr>
                    <th>⚡</th>
                    <SortHdr label="Date" k="pick_date" />
                    <th>Ticker</th>
                    <th>Company</th>
                    <th>Sector</th>
                    <SortHdr label="Conf" k="confidence_score" />
                    <th>Entry</th>
                    <th>Now</th>
                    <SortHdr label="Gain" k="gain_pct" />
                    <th onClick={() => toggleSort('vs_spy_pct')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                      title="Excess return vs SPY over the same period. +3% means the pick beat the S&P 500 by 3 points. Negative = the market did better than your pick.">
                      vs SPY ⓘ {sortKey === 'vs_spy_pct' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                    </th>
                    <SortHdr label="30d Ret" k="return_30d" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(p => {
                    const isSelected = selected?.symbol === p.symbol && selected?.pick_date === p.pick_date
                    return (
                      <tr key={`${p.symbol}-${p.pick_date}`}
                        onClick={() => setSelected(isSelected ? null : p)}
                        style={{ cursor: 'pointer',
                          background: isSelected ? 'rgba(59,130,246,0.08)' : undefined,
                          borderLeft: isSelected ? `2px solid ${T.blue}` : '2px solid transparent',
                        }}>
                        <td>
                          {p.alert_flag === 'BULL' && <span style={{ color: T.green, fontWeight: 700 }}>▲</span>}
                          {p.alert_flag === 'BEAR' && <span style={{ color: T.red,   fontWeight: 700 }}>▼</span>}
                        </td>
                        <td style={{ color: T.dim, fontSize: '0.75rem', fontFamily: T.mono, whiteSpace: 'nowrap' }}>{p.pick_date}</td>
                        <td style={{ fontFamily: T.mono, fontWeight: 700, color: T.bright, whiteSpace: 'nowrap' }}>
                          {p.symbol}
                          {onDeepDive && (
                            <button
                              onClick={e => { e.stopPropagation(); onDeepDive(p.symbol) }}
                              title="Open in Deep Dive"
                              style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', color: T.blue, fontSize: '0.65rem', padding: '0 2px', verticalAlign: 'middle', opacity: 0.7 }}
                            >↗</button>
                          )}
                        </td>
                        <td style={{ fontSize: '0.78rem', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.company}</td>
                        <td style={{ fontSize: '0.72rem', color: T.dim }}>{p.sector}</td>
                        <td style={{ fontFamily: T.mono, fontWeight: 600,
                          color: (p.confidence_score ?? 0) >= 70 ? T.green : (p.confidence_score ?? 0) >= 55 ? T.yellow : T.dim }}>
                          {p.confidence_score ?? '—'}
                        </td>
                        <td style={{ fontFamily: T.mono, color: T.dim }}>{p.entry_price ? `$${p.entry_price}` : '—'}</td>
                        <td style={{ fontFamily: T.mono }}>{p.current_price ? `$${p.current_price}` : '—'}</td>
                        <td style={{ fontFamily: T.mono, fontWeight: 600, color: pctColor(p.gain_pct) }}>{pct(p.gain_pct)}</td>
                        <td style={{ fontFamily: T.mono, fontWeight: 700, color: pctColor(p.vs_spy_pct) }}>{pct(p.vs_spy_pct)}</td>
                        <td style={{ fontFamily: T.mono, color: pctColor(p.return_30d) }}>
                          {p.days_held < 30 ? <span style={{ color: T.dim, fontSize: '0.7rem' }}>{30 - p.days_held}d left</span> : pct(p.return_30d)}
                        </td>
                      </tr>
                    )
                  })}
                  {sorted.length === 0 && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: T.dim, padding: '24px 0' }}>No picks match the current filter</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: '0.68rem', color: T.dim }}>
            {sorted.length} of {picks.length} picks · vs SPY column = excess return vs S&P 500 over same period
          </div>
        </div>

        {/* Right: detail panel */}
        <div className="card" style={{ minHeight: 320, padding: 0, overflow: 'hidden' }}>
          <DetailPanel pick={selected} onDeepDive={onDeepDive} />
        </div>
      </div>

      {/* ── Analysis charts ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 14, marginTop: 14, alignItems: 'flex-start' }}>
        <SignalTypeChart picks={picks} />
        <RegimeChart picks={picks} />
        <ScoreScatter picks={picks} onSelect={p => setSelected(p)} />
      </div>
    </div>
  )
}
