import { useEffect, useRef, useState } from 'react'
import { getAlphaLeaderboard, getAlphaRadar, getAlphaDna, postAlphaDnaAnalyze, getAlphaThesis } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────
interface LeaderEntry {
  ticker: string; company: string; sector: string; theme_tag: string
  gain_pct: number; start_price: number; current_price: number; radar_flag: null | string
}
interface Leaderboard {
  period: string; period_label: string; start_date: string
  gainers: LeaderEntry[]; losers: LeaderEntry[]; watch: LeaderEntry[]
  total_computed: number; _cached?: boolean
}
interface RadarSignal { key: string; match: boolean | 'partial'; label: string }
interface RadarCandidate {
  ticker: string; company: string; sector: string; theme_tag: string
  readiness: number; signals: RadarSignal[]; signals_matched: number; signals_total: number
  price: number; rsi: number; bb_width: number; vol_trend: number
  above_sma20: boolean; range_pct: number; return_10d: number
}
interface RadarResult {
  reference_ticker: string; reference_state: any; period: string
  candidates: RadarCandidate[]; total_above_threshold: number; _cached?: boolean
}
interface DnaResult {
  ticker: string; company: string; sector: string; theme_tag: string; period: string
  period_start: string; gain_pct: number; start_price: number; current_price: number
  state_at_start: any; state_today: any; weekly_returns: number[]
  inflection_date: string | null; catalyst_tags: string[]; analysis_text: string | null
  _cached?: boolean
}
interface Theme {
  name: string; confidence: number; status: 'confirmed' | 'forming' | 'early'
  summary: string; source_breakdown: any; sectors: string[]; example_stocks: string[]
}
interface ThesisResult {
  themes: Theme[]; events_analyzed: number; sector_context: string[]
  generated_at: string; _cached?: boolean
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg: '#07101F', panel: '#0C1A2E', border: 'rgba(255,255,255,0.07)',
  text: '#CBD5E1', bright: '#F1F5F9', dim: '#64748B',
  green: '#22C55E', red: '#EF4444', yellow: '#F59E0B', blue: '#3B82F6',
  purple: '#A855F7', mono: 'var(--mono)',
  cardBg: 'rgba(255,255,255,0.025)',
}

type Period = 'ytd' | 'q1' | 'q2' | 'q3' | 'q4' | '90d' | '30d'
type Board  = 'winners' | 'watch' | 'losers'
type RightPanel = 'radar' | 'thesis'

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(v: number | null | undefined, d = 1) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
}
function pctColor(v: number | null | undefined) {
  if (v == null) return T.dim
  return v > 0 ? T.green : v < 0 ? T.red : T.dim
}
function readinessColor(r: number) {
  return r >= 80 ? T.green : r >= 60 ? T.yellow : T.dim
}
function themeStatusColor(s: string) {
  return s === 'confirmed' ? T.green : s === 'forming' ? T.yellow : T.dim
}
function themeStatusDot(s: string) {
  return s === 'confirmed' ? '●' : s === 'forming' ? '○' : '◌'
}

const PERIODS: { id: Period; label: string }[] = [
  { id: 'ytd', label: 'YTD' }, { id: 'q1', label: 'Q1' }, { id: 'q2', label: 'Q2' },
  { id: 'q3', label: 'Q3' }, { id: 'q4', label: 'Q4' }, { id: '90d', label: '90D' }, { id: '30d', label: '30D' },
]

// ── Sub-components ────────────────────────────────────────────────────────────

function GainBar({ pct: g }: { pct: number }) {
  const w = Math.min(100, Math.abs(g) / 5)  // scale: 5% = 1%width
  return (
    <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 2, width: '100%' }}>
      <div style={{ width: `${w}%`, height: '100%', borderRadius: 2, background: g >= 0 ? T.green : T.red, opacity: 0.7 }} />
    </div>
  )
}

function SignalPill({ sig }: { sig: RadarSignal }) {
  const color = sig.match === true ? T.green : sig.match === 'partial' ? T.yellow : T.dim
  const symbol = sig.match === true ? '✓' : sig.match === 'partial' ? '~' : '✗'
  return (
    <span title={sig.label} style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      fontSize: '0.6rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: `${color}14`, color, fontFamily: T.mono,
      border: `1px solid ${color}30`, cursor: 'default',
    }}>
      {symbol} {sig.key}
    </span>
  )
}

function MiniSparkline({ values }: { values: number[] }) {
  if (!values.length) return null
  const max = Math.max(...values.map(Math.abs), 1)
  const barW = Math.max(4, Math.floor(100 / values.length) - 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 28 }}>
      {values.map((v, i) => {
        const h = Math.max(2, Math.abs(v) / max * 26)
        return (
          <div key={i} title={`${pct(v)}`} style={{
            width: barW, height: h, borderRadius: 1,
            background: v >= 0 ? T.green : T.red, opacity: 0.75,
            alignSelf: 'flex-end', flexShrink: 0,
          }} />
        )
      })}
    </div>
  )
}

// ── Left panel: Leaderboard ───────────────────────────────────────────────────

function LeaderBoard({
  board, data, loading, selected, onSelect, onPeriodChange, period,
}: {
  board: Board; data: Leaderboard | null; loading: boolean
  selected: LeaderEntry | null; onSelect: (e: LeaderEntry) => void
  onPeriodChange: (p: Period) => void; period: Period
}) {
  const [tab, setTab] = useState<Board>('winners')
  const entries = !data ? [] :
    tab === 'winners' ? data.gainers :
    tab === 'losers'  ? data.losers  :
    data.watch

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Period selector */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
        {PERIODS.map(p => (
          <button key={p.id} className={`btn sm${period === p.id ? ' primary' : ''}`}
            onClick={() => onPeriodChange(p.id)} style={{ fontSize: '0.65rem', padding: '2px 7px' }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
        {(['winners', 'watch', 'losers'] as Board[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '6px 0', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: tab === t ? T.bright : T.dim,
              borderBottom: tab === t ? `2px solid ${T.blue}` : '2px solid transparent',
            }}>
            {t === 'winners' ? '▲ Winners' : t === 'losers' ? '▼ Losers' : '⟷ Watch'}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: T.dim, fontSize: '0.78rem' }}>
            Fetching {data?.total_computed ?? '—'} tickers… (~15s)
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: T.dim, fontSize: '0.78rem' }}>No data</div>
        ) : (
          entries.map((e, i) => {
            const isSelected = selected?.ticker === e.ticker
            return (
              <div key={e.ticker} onClick={() => onSelect(e)}
                style={{
                  padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${T.border}`,
                  background: isSelected ? 'rgba(59,130,246,0.08)' : undefined,
                  borderLeft: isSelected ? `2px solid ${T.blue}` : '2px solid transparent',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: T.dim, fontSize: '0.62rem', width: 16, fontFamily: T.mono }}>{i+1}</span>
                    <span style={{ fontFamily: T.mono, fontWeight: 800, color: T.bright, fontSize: '0.82rem' }}>{e.ticker}</span>
                    <span style={{
                      fontSize: '0.55rem', padding: '1px 5px', borderRadius: 3, fontWeight: 600,
                      background: 'rgba(255,255,255,0.05)', color: T.dim,
                    }}>{e.theme_tag}</span>
                  </div>
                  <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.82rem', color: pctColor(e.gain_pct) }}>
                    {pct(e.gain_pct)}
                  </span>
                </div>
                <div style={{ fontSize: '0.62rem', color: T.dim, marginLeft: 22, marginTop: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                  {e.company}
                </div>
                <GainBar pct={e.gain_pct} />
              </div>
            )
          })
        )}
      </div>

      {/* Footer */}
      {data && (
        <div style={{ padding: '6px 12px', borderTop: `1px solid ${T.border}`, fontSize: '0.62rem', color: T.dim }}>
          {data.total_computed} tickers · from {data.start_date}
          {data._cached && <span style={{ marginLeft: 8, color: T.blue }}>cached</span>}
        </div>
      )}
    </div>
  )
}

// ── Center panel: Breakout DNA ────────────────────────────────────────────────

function DnaPanel({
  entry, period, onOpenDashboard,
}: {
  entry: LeaderEntry | null; period: Period; onOpenDashboard?: (ticker: string) => void
}) {
  const [dna, setDna]         = useState<DnaResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const prevTicker = useRef<string | null>(null)

  useEffect(() => {
    if (!entry) return
    if (entry.ticker === prevTicker.current) return
    prevTicker.current = entry.ticker
    setDna(null); setLoading(true)
    getAlphaDna(entry.ticker, period)
      .then(r => setDna(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [entry?.ticker, period])

  const runAnalysis = async () => {
    if (!entry || !dna) return
    setAnalyzing(true)
    try {
      const r = await postAlphaDnaAnalyze(entry.ticker, period)
      setDna(r.data)
    } catch {}
    setAnalyzing(false)
  }

  if (!entry) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 8, color: T.dim }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} style={{ opacity: 0.3 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.893.384a2.25 2.25 0 011.357 2.059V19.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 19.5v-1.607a2.25 2.25 0 011.357-2.059l.893-.384a2.25 2.25 0 001.357-2.059V8.818m5.143-5.714a24.302 24.302 0 00-4.5 0"/>
      </svg>
      <span style={{ fontSize: '0.78rem' }}>Select a stock to see Breakout DNA</span>
    </div>
  )

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: '14px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontFamily: T.mono, fontSize: '1.1rem', fontWeight: 800, color: T.bright }}>{entry.ticker}</span>
          <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.9rem', color: pctColor(entry.gain_pct) }}>
            {pct(entry.gain_pct)}
          </span>
          {dna?.catalyst_tags?.map(tag => (
            <span key={tag} style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: 3, fontWeight: 600,
              background: 'rgba(168,85,247,0.12)', color: T.purple, border: '1px solid rgba(168,85,247,0.25)' }}>
              {tag}
            </span>
          ))}
        </div>
        <div style={{ fontSize: '0.72rem', color: T.dim }}>{entry.company} · {entry.sector}</div>
      </div>

      {loading && <div style={{ color: T.dim, fontSize: '0.78rem' }}>Loading DNA…</div>}

      {dna && !loading && (
        <>
          {/* Weekly return sparkline */}
          {dna.weekly_returns?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.6rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6, fontFamily: T.mono }}>
                PRICE STORY ({dna.period_label ?? dna.period?.toUpperCase()})
              </div>
              <MiniSparkline values={dna.weekly_returns} />
              {dna.inflection_date && (
                <div style={{ fontSize: '0.62rem', color: T.yellow, marginTop: 4 }}>
                  ▲ Inflection: {dna.inflection_date}
                </div>
              )}
            </div>
          )}

          {/* Before / After snapshot */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: '0.6rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, fontFamily: T.mono }}>
              TECHNICAL SNAPSHOT
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', color: T.dim, fontWeight: 600, padding: '3px 0', width: '40%' }}>Signal</th>
                  <th style={{ textAlign: 'right', color: T.yellow, fontWeight: 700, padding: '3px 6px' }}>At {dna.period_start?.slice(5)}</th>
                  <th style={{ textAlign: 'right', color: T.bright, fontWeight: 700, padding: '3px 0' }}>Today</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'RSI',
                    v0: dna.state_at_start?.rsi?.toFixed(0),
                    v1: dna.state_today?.rsi?.toFixed(0) },
                  { label: 'BB Width',
                    v0: dna.state_at_start?.bb_width?.toFixed(3),
                    v1: dna.state_today?.bb_width?.toFixed(3) },
                  { label: 'Vol Trend',
                    v0: dna.state_at_start?.vol_trend != null ? `${dna.state_at_start.vol_trend.toFixed(2)}×` : '—',
                    v1: dna.state_today?.vol_trend != null ? `${dna.state_today.vol_trend.toFixed(2)}×` : '—' },
                  { label: 'vs SMA20',
                    v0: dna.state_at_start ? (dna.state_at_start.above_sma20 ? 'Above' : 'Below') : '—',
                    v1: dna.state_today ? (dna.state_today.above_sma20 ? 'Above' : 'Below') : '—' },
                  { label: '52w Range',
                    v0: dna.state_at_start?.range_pct != null ? `${Math.round(dna.state_at_start.range_pct * 100)}%` : '—',
                    v1: dna.state_today?.range_pct != null ? `${Math.round(dna.state_today.range_pct * 100)}%` : '—' },
                ].map(row => (
                  <tr key={row.label} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: '5px 0', color: T.dim }}>{row.label}</td>
                    <td style={{ textAlign: 'right', padding: '5px 6px', fontFamily: T.mono, color: T.yellow }}>{row.v0 ?? '—'}</td>
                    <td style={{ textAlign: 'right', fontFamily: T.mono, color: T.bright }}>{row.v1 ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Price */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 14 }}>
            {[
              { label: 'Entry', value: dna.start_price ? `$${dna.start_price.toFixed(2)}` : '—', color: T.dim },
              { label: 'Today', value: dna.current_price ? `$${dna.current_price.toFixed(2)}` : '—', color: T.bright },
              { label: 'Gain', value: pct(dna.gain_pct), color: pctColor(dna.gain_pct) },
            ].map(c => (
              <div key={c.label} style={{ background: T.cardBg, borderRadius: 6, padding: '6px 8px' }}>
                <div style={{ fontSize: '0.58rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>{c.label}</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: T.mono, color: c.color }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Analysis text */}
          {dna.analysis_text ? (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.6rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6, fontFamily: T.mono }}>WHY IT RAN</div>
              <p style={{ fontSize: '0.76rem', color: T.text, lineHeight: 1.65, margin: 0 }}>{dna.analysis_text}</p>
            </div>
          ) : (
            <button
              className="btn sm"
              style={{ width: '100%', marginBottom: 14, fontSize: '0.72rem' }}
              onClick={runAnalysis}
              disabled={analyzing}
            >
              {analyzing ? '⟳ Analyzing…' : '▶ Why it Ran — Sonnet ~$0.03'}
            </button>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {onOpenDashboard && (
              <button className="btn primary sm" style={{ flex: 1, fontSize: '0.72rem' }}
                onClick={() => onOpenDashboard(entry.ticker)}>
                → Open in Dashboard
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Right panel: Radar ────────────────────────────────────────────────────────

function RadarPanel({
  refEntry, period, onSelect,
}: {
  refEntry: LeaderEntry | null; period: Period; onSelect: (ticker: string) => void
}) {
  const [radar, setRadar]     = useState<RadarResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<RadarCandidate | null>(null)
  const prevKey = useRef<string | null>(null)

  useEffect(() => {
    const ref = refEntry?.ticker ?? 'SPY'
    const key = `${ref}:${period}`
    if (key === prevKey.current) return
    prevKey.current = key
    setRadar(null); setLoading(true); setSelected(null)
    getAlphaRadar(ref, period)
      .then(r => setRadar(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [refEntry?.ticker, period])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: T.mono }}>
          EARLY RADAR
        </div>
        <div style={{ fontSize: '0.68rem', color: T.dim, marginTop: 2 }}>
          {refEntry
            ? <>Stocks matching <span style={{ fontFamily: T.mono, color: T.yellow }}>{refEntry.ticker}</span>'s setup at period start</>
            : 'Select a winner to find early-stage matches'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 16, color: T.dim, fontSize: '0.78rem', textAlign: 'center' }}>Scanning {120}+ tickers…</div>}
        {!loading && radar && radar.candidates.length === 0 && (
          <div style={{ padding: 16, color: T.dim, fontSize: '0.78rem', textAlign: 'center' }}>No strong matches found</div>
        )}
        {!loading && radar?.candidates.map(c => {
          const isSelected = selected?.ticker === c.ticker
          return (
            <div key={c.ticker}
              onClick={() => { setSelected(isSelected ? null : c); onSelect(c.ticker) }}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${T.border}`,
                background: isSelected ? 'rgba(59,130,246,0.07)' : undefined,
                borderLeft: isSelected ? `2px solid ${T.blue}` : '2px solid transparent',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: T.mono, fontWeight: 800, color: T.bright, fontSize: '0.82rem' }}>{c.ticker}</span>
                  <span style={{ fontSize: '0.62rem', color: T.dim }}>{c.company?.split(' ').slice(0,3).join(' ')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.78rem', color: readinessColor(c.readiness) }}>
                    {c.readiness}/100
                  </span>
                  <span style={{ fontSize: '0.6rem', color: T.dim }}>{c.signals_matched}/{c.signals_total}</span>
                </div>
              </div>
              {/* Readiness bar */}
              <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginBottom: 5 }}>
                <div style={{ width: `${c.readiness}%`, height: '100%', borderRadius: 2,
                  background: readinessColor(c.readiness), opacity: 0.8 }} />
              </div>
              {/* Signal pills */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {c.signals.map(s => <SignalPill key={s.key} sig={s} />)}
              </div>
              {/* Reference comparison if selected */}
              {isSelected && radar.reference_state && (
                <div style={{ marginTop: 8, padding: '6px 8px', background: T.cardBg, borderRadius: 6, fontSize: '0.68rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: 4, color: T.dim }}>
                    <span />
                    <span style={{ color: T.yellow, fontWeight: 600 }}>Ref ({radar.reference_ticker}) at start</span>
                    <span style={{ color: T.bright, fontWeight: 600 }}>{c.ticker} today</span>
                    {[
                      ['RSI', radar.reference_state.rsi?.toFixed(0), c.rsi?.toFixed(0)],
                      ['BB Width', radar.reference_state.bb_width?.toFixed(3), c.bb_width?.toFixed(3)],
                      ['Vol Trend', `${radar.reference_state.vol_trend?.toFixed(2)}×`, `${c.vol_trend?.toFixed(2)}×`],
                    ].map(([label, v0, v1]) => (
                      <>
                        <span key={label} style={{ color: T.dim }}>{label}</span>
                        <span style={{ fontFamily: T.mono, color: T.yellow }}>{v0 ?? '—'}</span>
                        <span style={{ fontFamily: T.mono, color: T.bright }}>{v1 ?? '—'}</span>
                      </>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {radar && (
        <div style={{ padding: '6px 12px', borderTop: `1px solid ${T.border}`, fontSize: '0.62rem', color: T.dim }}>
          {radar.total_above_threshold} candidates above threshold · {radar._cached ? 'cached' : 'live'}
        </div>
      )}
    </div>
  )
}

// ── Right panel: Thesis ───────────────────────────────────────────────────────

function ThesisPanel({ onFilterRadar }: { onFilterRadar: (theme: Theme) => void }) {
  const [thesis, setThesis]   = useState<ThesisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    getAlphaThesis()
      .then(r => setThesis(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: T.mono }}>
            EMERGING THEMES
          </div>
          {thesis && (
            <div style={{ fontSize: '0.62rem', color: T.dim, marginTop: 1 }}>
              {thesis.events_analyzed} events analyzed · GDELT + sector ETFs
            </div>
          )}
        </div>
        <button className="btn sm" onClick={load} disabled={loading} style={{ fontSize: '0.65rem' }}>
          {loading ? '⟳' : '↻ Scan'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 20, color: T.dim, fontSize: '0.78rem', textAlign: 'center' }}>Analyzing signals via Haiku…</div>}
        {!loading && thesis?.themes?.length === 0 && (
          <div style={{ padding: 20, color: T.dim, fontSize: '0.78rem', textAlign: 'center' }}>
            No themes detected. Run the GDELT sync to populate events.
          </div>
        )}
        {!loading && thesis?.themes?.map((theme, i) => {
          const isOpen = expanded === theme.name
          return (
            <div key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
              <div onClick={() => setExpanded(isOpen ? null : theme.name)}
                style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.8rem', color: themeStatusColor(theme.status), flexShrink: 0, marginTop: 1 }}>
                  {themeStatusDot(theme.status)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontWeight: 700, color: T.bright, fontSize: '0.78rem' }}>{theme.name}</span>
                    <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.72rem', color: themeStatusColor(theme.status), flexShrink: 0 }}>
                      {theme.confidence}%
                    </span>
                  </div>
                  {/* Confidence bar */}
                  <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 4 }}>
                    <div style={{ width: `${theme.confidence}%`, height: '100%', borderRadius: 2,
                      background: themeStatusColor(theme.status), opacity: 0.7 }} />
                  </div>
                  {/* Evidence sources */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {theme.source_breakdown?.gdelt > 0 && (
                      <span style={{ fontSize: '0.58rem', color: T.dim }}>GDELT {theme.source_breakdown.gdelt}</span>
                    )}
                    {theme.source_breakdown?.rss > 0 && (
                      <span style={{ fontSize: '0.58rem', color: T.dim }}>RSS {theme.source_breakdown.rss}</span>
                    )}
                    {theme.source_breakdown?.sector_etf && (
                      <span style={{ fontSize: '0.58rem', color: T.dim }}>ETF ✓</span>
                    )}
                  </div>
                </div>
              </div>

              {isOpen && (
                <div style={{ padding: '0 12px 12px 30px' }}>
                  <p style={{ fontSize: '0.74rem', color: T.text, lineHeight: 1.6, margin: '0 0 8px' }}>{theme.summary}</p>
                  {/* Example stocks */}
                  {theme.example_stocks?.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <span style={{ fontSize: '0.6rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        Stocks in orbit:{' '}
                      </span>
                      {theme.example_stocks.map(t => (
                        <span key={t} style={{ fontFamily: T.mono, fontWeight: 700, fontSize: '0.72rem',
                          color: T.blue, marginRight: 6 }}>{t}</span>
                      ))}
                    </div>
                  )}
                  {/* Sectors */}
                  {theme.sectors?.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <span style={{ fontSize: '0.6rem', color: T.dim }}>Sectors: </span>
                      <span style={{ fontSize: '0.68rem', color: T.dim }}>{theme.sectors.join(' · ')}</span>
                    </div>
                  )}
                  <button className="btn sm" onClick={() => onFilterRadar(theme)}
                    style={{ fontSize: '0.65rem', width: '100%' }}>
                    → Find Radar matches for this theme
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {thesis?.sector_context?.length > 0 && (
        <div style={{ padding: '6px 12px', borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: '0.58rem', color: T.dim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>SECTOR CONTEXT (3M)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {thesis.sector_context.slice(0, 6).map((s, i) => (
              <span key={i} style={{ fontFamily: T.mono, fontSize: '0.58rem', color: T.dim }}>{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlphaLabTab({ onOpenDashboard }: { onOpenDashboard?: (ticker: string) => void }) {
  const [period, setPeriod]         = useState<Period>('ytd')
  const [board, setBoard]           = useState<Board>('winners')
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null)
  const [lbLoading, setLbLoading]   = useState(false)
  const [selected, setSelected]     = useState<LeaderEntry | null>(null)
  const [rightPanel, setRightPanel] = useState<RightPanel>('radar')
  const [radarTicker, setRadarTicker] = useState<string | null>(null)
  const prevPeriod = useRef<string | null>(null)

  const loadLeaderboard = (p: Period) => {
    setLbLoading(true)
    getAlphaLeaderboard(p, 20)
      .then(r => setLeaderboard(r.data))
      .catch(() => {})
      .finally(() => setLbLoading(false))
  }

  useEffect(() => {
    if (period !== prevPeriod.current) {
      prevPeriod.current = period
      loadLeaderboard(period)
    }
  }, [period])

  useEffect(() => { loadLeaderboard('ytd') }, [])

  const handleFilterByTheme = (theme: Theme) => {
    setRightPanel('radar')
    // Pick the first example stock from theme as reference if in leaderboard
    const match = leaderboard?.gainers.find(e => theme.example_stocks?.includes(e.ticker))
    if (match) setSelected(match)
  }

  return (
    <div style={{ background: T.bg, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', borderBottom: `1px solid ${T.border}`,
        background: T.panel, flexShrink: 0,
      }}>
        <div>
          <span style={{ fontWeight: 800, color: T.bright, fontSize: '0.9rem', letterSpacing: '0.05em', fontFamily: T.mono }}>
            ALPHA LAB
          </span>
          <span style={{ marginLeft: 10, fontSize: '0.68rem', color: T.dim }}>
            Breakout Intelligence — leaderboard · radar · thesis
          </span>
        </div>
        <button className="btn sm" onClick={() => loadLeaderboard(period)} style={{ fontSize: '0.65rem' }}>
          ↻ Refresh
        </button>
      </div>

      {/* ── Three-column layout ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 300px', flex: 1, overflow: 'hidden' }}>

        {/* Col 1: Leaderboard */}
        <div style={{ borderRight: `1px solid ${T.border}`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <LeaderBoard
            board={board} data={leaderboard} loading={lbLoading}
            selected={selected} onSelect={e => { setSelected(e); setRadarTicker(null) }}
            onPeriodChange={p => { setPeriod(p) }} period={period}
          />
        </div>

        {/* Col 2: DNA panel */}
        <div style={{ borderRight: `1px solid ${T.border}`, overflow: 'hidden' }}>
          <DnaPanel entry={selected} period={period} onOpenDashboard={onOpenDashboard} />
        </div>

        {/* Col 3: Radar / Thesis */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab toggle */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {(['radar', 'thesis'] as RightPanel[]).map(t => (
              <button key={t} onClick={() => setRightPanel(t)}
                style={{
                  flex: 1, padding: '7px 0', border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: rightPanel === t ? T.bright : T.dim,
                  borderBottom: rightPanel === t ? `2px solid ${T.blue}` : '2px solid transparent',
                }}>
                {t === 'radar' ? '⟳ Radar' : '◉ Thesis'}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            {rightPanel === 'radar' ? (
              <RadarPanel
                refEntry={selected}
                period={period}
                onSelect={t => setRadarTicker(t)}
              />
            ) : (
              <ThesisPanel onFilterRadar={handleFilterByTheme} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
