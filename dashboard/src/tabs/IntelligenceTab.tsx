import { useState, useEffect, useRef } from 'react'
import { getSotdFull, sotdStreamUrl, sotdTickerStreamUrl, getMarketQuotes, getSotdRepeatHits } from '../api'
import ScoreGauge from '../components/ScoreGauge'
import MiniChart from '../components/MiniChart'
import RelativeStrengthChart from '../components/RelativeStrengthChart'
import FundamentalPanel from '../components/FundamentalPanel'

// ── Pipeline streaming types ──────────────────────────────────────────────────
type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skip'
interface PipelineStep { id: string; label: string; desc: string; status: StepStatus; msg: string }

const PIPELINE_STEPS: PipelineStep[] = [
  { id: 'screener',    label: 'FinViz Screener',      desc: 'Momentum + volume filters',        status: 'pending', msg: '' },
  { id: 'market_data', label: 'Market Data',           desc: '60d OHLCV download',               status: 'pending', msg: '' },
  { id: 'indicators',  label: 'Technical Indicators', desc: 'RSI · ADX · Bollinger · Volume',   status: 'pending', msg: '' },
  { id: 'scoring',     label: 'V3 Scoring',           desc: 'Technical 70% + Fundamental 30%',  status: 'pending', msg: '' },
  { id: 'llm',         label: 'Haiku Analysis',       desc: 'Interpreting scores & rationale',  status: 'pending', msg: '' },
]

// ── Design tokens — 8px spacing system ───────────────────────────────────────
const T = {
  bg:      '#07101F',           // page canvas
  card:    '#0C1A2E',           // card surface
  cardHi:  'rgba(255,255,255,0.035)', // inset surface
  cardHi2: 'rgba(255,255,255,0.06)',  // raised surface
  border:  'rgba(255,255,255,0.07)', // used sparingly
  text:    '#CBD5E1',
  textBrt: '#F1F5F9',
  textMut: '#64748B',
  blue:    '#3B82F6',
  green:   '#22C55E',
  yellow:  '#F59E0B',
  red:     '#EF4444',
  mono:    'var(--mono)',
  // shadows for depth instead of borders
  shadow:  '0 1px 3px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.35)',
  shadowSm:'0 1px 2px rgba(0,0,0,0.6)',
}

// ── Style primitives — tight 8px grid ─────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  // No border — depth via shadow + background contrast
  panel:     { background: T.card, borderRadius: 10, padding: '14px 18px', boxShadow: T.shadow },
  sectionHd: { fontSize: 9, fontWeight: 700, color: 'rgba(148,163,184,0.5)', textTransform: 'uppercase' as const, letterSpacing: '0.22em', marginBottom: 8 },
  ticker:    { fontSize: '1.7rem', fontWeight: 800, color: T.textBrt, letterSpacing: '-0.025em', lineHeight: 1 },
  company:   { fontSize: '0.8rem', color: T.textMut, marginTop: 3 },
  bullet:    { display: 'flex', gap: 8, padding: '5px 0', borderBottom: `1px solid ${T.border}`, fontSize: '0.82rem', color: T.text, lineHeight: 1.6 },
  dot:       { color: T.green, fontWeight: 700, flexShrink: 0 },
  rdot:      { color: T.red, fontWeight: 700, flexShrink: 0 },
  divider:   { borderTop: `1px solid ${T.border}`, margin: '12px 0' },
  label:     { fontSize: '0.58rem', color: T.textMut, letterSpacing: '0.12em', textTransform: 'uppercase' as const, fontWeight: 600 },
  value:     { fontSize: '0.95rem', color: T.textBrt, fontWeight: 700 },
}

// ── Deterministic intelligence helpers ───────────────────────────────────────

function entryQuality(metrics: any): { label: string; color: string; desc: string } {
  const r10 = metrics.return_10d ?? 0
  const rsi  = metrics.rsi ?? 50
  if (r10 < 5 && rsi < 55)
    return { label: 'EARLY', color: T.green,  desc: 'Price move not yet extended — early stage entry' }
  if (r10 <= 15 && rsi <= 62)
    return { label: 'GOOD',  color: T.blue,   desc: 'Trend confirmed but not overextended' }
  if (r10 <= 25 || rsi <= 70)
    return { label: 'MODERATE', color: T.yellow, desc: `+${r10}% in 10d — trend intact, not early-stage` }
  return   { label: 'LATE', color: T.red,    desc: `+${r10}% in 10d — approaching extended territory` }
}

function momentumStage(metrics: any): { label: string; color: string; desc: string } {
  const { return_10d: r10, return_5d: r5, return_3d: r3, bb_squeeze, above_sma20 } = metrics
  if (bb_squeeze && r3 > 0)
    return { label: 'EARLY BREAKOUT', color: T.green,  desc: 'Bollinger squeeze just triggered — earliest valid entry point' }
  if (r10 < 8 && above_sma20 && r5 > 0)
    return { label: 'DEVELOPING',     color: T.blue,   desc: 'Momentum building — structure forming, low extension risk' }
  if (r10 >= 8 && r10 <= 22 && above_sma20 && r3 > -2)
    return { label: 'MID-TREND',      color: T.blue,   desc: 'Established trend — still valid, moderate extension' }
  if (r10 > 22 && r3 >= 0)
    return { label: 'LATE STAGE',     color: T.yellow, desc: `Extended +${r10}% in 10d — late entry, elevated reversal risk` }
  if (r10 > 12 && r3 < -1)
    return { label: 'PULLBACK',       color: T.yellow, desc: '3-day weakness in extended trend — watch SMA20 as support' }
  return   { label: 'MID-TREND',      color: T.blue,   desc: 'Established trend continuation' }
}

function riskProfile(metrics: any, stage: any): { label: string; color: string } {
  const { return_10d, rsi, adx, vol_ratio } = metrics
  const stageLabel = stage?.label ?? ''
  if (return_10d > 20 || rsi > 68 || stageLabel.includes('LATE'))
    return { label: 'ELEVATED', color: T.red }
  if (return_10d > 10 || rsi > 60 || adx < 18 || vol_ratio < 1.2)
    return { label: 'MODERATE', color: T.yellow }
  return { label: 'CONTROLLED', color: T.green }
}

function decisionStatus(tier: string, entry: any, risk: any): { text: string; color: string } {
  if (tier === 'Stock of the Day') {
    if (entry?.label === 'EARLY') return { text: 'Active signal — early entry, not extended', color: T.green }
    if (entry?.label === 'GOOD')  return { text: 'Buyable — confirmed trend, not overextended', color: T.green }
    if (risk?.label === 'ELEVATED') return { text: 'Caution — extended move, consider waiting for pullback', color: T.yellow }
    return { text: 'At threshold — size conservatively', color: T.yellow }
  }
  if (tier === 'Watchlist Candidate') return { text: 'Watchlist only — monitor for score improvement', color: T.yellow }
  return { text: 'No conviction setup today — monitoring mode only', color: T.textMut }
}

function whyNotBuyNow(metrics: any, stage: any, tier: string): string[] {
  const { return_10d, return_3d, rsi, vol_ratio, adx } = metrics
  const reasons: string[] = []
  if (return_10d > 20)
    reasons.push(`10-day gain already +${return_10d}% — entry is late-stage with elevated reversal risk`)
  else if (return_10d > 15)
    reasons.push(`+${return_10d}% over 10 days — trend is extended; a pullback toward SMA20 may offer better risk/reward`)
  if (rsi > 68)
    reasons.push(`RSI at ${rsi.toFixed(0)} — approaching overbought territory, short-term pullback possible`)
  else if (rsi > 62)
    reasons.push(`RSI at ${rsi.toFixed(0)} — elevated momentum, not ideal for a fresh entry without a dip`)
  if (return_3d < -1.5 && return_10d > 8)
    reasons.push(`3-day pullback (${return_3d > 0 ? '+' : ''}${return_3d}%) within an extended trend — wait for stabilization before committing`)
  if (vol_ratio < 1.2 && return_10d > 5)
    reasons.push(`Volume ratio ${vol_ratio}× — the move lacks strong institutional participation, reducing reliability`)
  if (adx < 18)
    reasons.push(`ADX ${adx.toFixed(0)} — trend directional strength is weak; this may be a range-bound move, not a sustained trend`)
  if (tier === 'Watchlist Candidate')
    reasons.push(`Score below the conviction threshold — a stronger setup may emerge; patience is rewarded here`)
  return reasons
}

function allocationSuggestion(convictionLevel: string | undefined, tier: string, tradeQuality: string | undefined): { pct: string; note: string; color: string } {
  if (tier === 'Best Available') return { pct: '0–2%', note: 'No conviction setup — limit order only, do not chase', color: T.textMut }
  if (convictionLevel === 'HIGH' || tradeQuality === 'A') return { pct: '6–8%', note: 'High conviction — full position within your 8% single-stock cap', color: T.green }
  if (convictionLevel === 'MODERATE' || tradeQuality === 'B') return { pct: '3–5%', note: 'Moderate conviction — initial half position, add on confirmation', color: T.blue }
  return { pct: '1–3%', note: 'Low conviction — exploratory size only, set a tight stop', color: T.yellow }
}

function vixContext(vix: number): { label: string; color: string; regime: string; meaning: string } {
  if (vix < 15)
    return { label: 'LOW',       color: T.green,  regime: 'Risk-On',  meaning: 'Low fear. Momentum strategies historically outperform. Trend signals are more reliable.' }
  if (vix < 20)
    return { label: 'NORMAL',    color: T.blue,   regime: 'Balanced', meaning: 'Normal conditions. Momentum setups carry standard risk/reward.' }
  if (vix < 25)
    return { label: 'ELEVATED',  color: T.yellow, regime: 'Cautious', meaning: 'Elevated fear. Increased false signals — use tighter stops and smaller sizing.' }
  return   { label: 'HIGH FEAR', color: T.red,    regime: 'Defensive',meaning: 'High fear environment. Momentum setups have reduced reliability.' }
}

function signalImpact(regime: string, signalType: string): string {
  const type = (signalType || 'momentum').toLowerCase()
  if (type === 'reversal') {
    if (regime === 'BULL') return 'Reversal in BULL regime: pullback setups have higher success rate — the primary trend broadly supports recovery.'
    return 'Reversal in BEAR/CHOP: lower probability setup — requires strong volume confirmation before entry.'
  }
  if (regime === 'BULL')  return 'Momentum in BULL regime: highest historical success rate. Regime multiplier applied at full weight.'
  if (regime === 'CHOP')  return 'Momentum in CHOP regime: score threshold raised to 85 to filter noise. This pick cleared the higher bar.'
  return 'Momentum in BEAR regime: regime multiplier reduces scoring. Probability of continuation is lower — position sizing should reflect this.'
}

function accelerationLabel(r3: number, r5: number, r10: number): { label: string; color: string; note: string } {
  const d10 = r10 / 10, d5 = r5 / 5, d3 = r3 / 3
  if (r3 < -0.5 && r10 > 10)
    return { label: 'PULLING BACK',  color: T.yellow, note: '3d weakness within uptrend — possible consolidation before continuation' }
  if (d3 > d5 && d5 > d10 && d3 > 0)
    return { label: 'ACCELERATING',  color: T.green,  note: 'Each shorter period outpacing the longer — momentum building' }
  if (d3 < d5 && d5 < d10)
    return { label: 'DECELERATING',  color: T.yellow, note: 'Recent pace slowing vs 10d average — watch for trend change' }
  if (d5 > d10 + 0.3)
    return { label: 'STRENGTHENING', color: T.green,  note: '5d pace outrunning 10d average — recent acceleration' }
  return { label: 'STEADY', color: T.blue, note: 'Consistent pace across timeframes' }
}

function invalidationConditions(metrics: any): string[] {
  const { rsi, vol_ratio, above_sma20, return_10d, adx } = metrics
  const rsiFloor = Math.max(38, Math.round(rsi - 14))
  const conds = [
    `RSI drops below ${rsiFloor} (currently ${rsi.toFixed(1)})`,
    above_sma20 ? 'Price breaks below the 20-day SMA' : 'Price fails to reclaim 20-day SMA within 3 sessions',
    `Volume ratio falls below 1.2× (currently ${vol_ratio.toFixed(2)}×)`,
  ]
  if (return_10d > 15) conds.push('3-day loss exceeding 4% from current price (momentum exhaustion)')
  if (adx < 20) conds.push('ADX drops further — weak trend already flagged (currently ' + adx.toFixed(1) + ')')
  return conds
}

function whyWon(sotdScore: any, runners: any[]): { advantage: string[]; weakness: string[] } | null {
  if (!runners.length) return null
  const top = runners[0]
  const topBd = top.score_breakdown
  const sBd   = sotdScore
  if (!topBd) return null
  const advantages: string[] = []
  const weaknesses: string[] = []
  const diff = (k: string) => (sBd[k] ?? 0) - (topBd[k] ?? 0)
  for (const [k, label] of [['momentum','Momentum'],['volume','Volume'],['setup','Setup'],['conviction','Conviction']] as const) {
    const d = diff(k)
    if (d >= 3)  advantages.push(`${label} +${d} vs ${top.ticker}`)
    if (d <= -3) weaknesses.push(`${label} ${d} vs ${top.ticker}`)
  }
  return { advantage: advantages.slice(0,3), weakness: weaknesses.slice(0,2) }
}

function chartExplanation(metrics: any, ticker: string): string[] {
  const { rsi, adx, vol_ratio, above_sma20, return_10d, return_5d, return_3d, bb_squeeze } = metrics
  const lines: string[] = []
  if (above_sma20) {
    if (return_10d > 15) lines.push(`${ticker} is trading well above its 20-day moving average, up ${return_10d}% in 10 days — extended but trend is intact.`)
    else lines.push(`${ticker} is above its 20-day moving average, confirming an active uptrend.`)
  } else {
    lines.push(`${ticker} is currently below its 20-day moving average — trend structure is not yet confirmed.`)
  }
  const d3 = return_3d / 3, d5 = return_5d / 5, d10 = return_10d / 10
  if (bb_squeeze) {
    lines.push(`The Bollinger Bands were compressed before this move — breakout is early-stage, historically higher follow-through probability.`)
  } else if (d3 > d5 && d5 > d10 && d3 > 0) {
    lines.push(`Momentum is accelerating: each shorter window outpacing the prior, suggesting buyers are stepping in with increasing urgency.`)
  } else if (d3 < d5 && d5 < d10 && return_10d > 8) {
    lines.push(`The 3-day pace (+${return_3d}%) is slowing vs the 10-day move (+${return_10d}%) — momentum is decelerating, watch for a pause.`)
  } else if (return_3d < -1 && return_10d > 10) {
    lines.push(`A 3-day pullback (${return_3d}%) within a +${return_10d}% 10-day uptrend — could be normal consolidation or early warning of exhaustion.`)
  } else {
    lines.push(`Consistent momentum: +${return_3d}% (3d) / +${return_5d}% (5d) / +${return_10d}% (10d).`)
  }
  if (vol_ratio >= 2.0) lines.push(`Volume is ${vol_ratio}× average — strong institutional participation. High-volume moves are more sustainable.`)
  else if (vol_ratio >= 1.5) lines.push(`Volume is running ${vol_ratio}× above average — above-average participation supports the move.`)
  else lines.push(`Volume is near normal (${vol_ratio}×) — no strong confirmation from volume; watch for a surge to validate.`)
  if (rsi > 70) lines.push(`RSI at ${rsi.toFixed(0)} is overbought — not a sell signal, but expect potential resistance or a brief pullback before continuation.`)
  else if (rsi > 60) lines.push(`RSI at ${rsi.toFixed(0)} shows strong momentum without being overbought — room to run before hitting resistance.`)
  else if (rsi < 45) lines.push(`RSI at ${rsi.toFixed(0)} is weak — price may be stabilizing but momentum not yet confirmed.`)
  else lines.push(`RSI at ${rsi.toFixed(0)} is neutral-to-positive — no overbought concern.`)
  if (adx >= 30) lines.push(`ADX ${adx.toFixed(0)} indicates a strong directional trend — not a choppy range-bound move.`)
  else if (adx >= 20) lines.push(`ADX ${adx.toFixed(0)} confirms a developing trend — not yet strong, but directional bias is present.`)
  else lines.push(`ADX ${adx.toFixed(0)} is weak — the directional component is not strongly established yet.`)
  return lines
}

function similarSetups(candidates: any[], sotdTicker: string, sotdTags: string[]) {
  return candidates
    .filter(c => c.passed_filter && c.ticker !== sotdTicker && c.score >= 35 && c.tags?.some((t: string) => sotdTags.includes(t)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
}

// ── UI atoms ──────────────────────────────────────────────────────────────────

function Pill({ label, color, xs }: { label: string; color: string; xs?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: xs ? '1px 6px' : '2px 8px',
      borderRadius: 4,
      fontSize: xs ? 9 : 10,
      fontWeight: 700,
      letterSpacing: '0.07em',
      textTransform: 'uppercase' as const,
      background: `${color}16`,
      color,
      lineHeight: 1.5,
    }}>
      {label}
    </span>
  )
}

// legacy alias kept for backward compatibility in JSX
function IntelBadge({ label, color, size = 'sm' }: { label: string; color: string; size?: 'sm' | 'xs' }) {
  return <Pill label={label} color={color} xs={size === 'xs'} />
}

function MetricCell({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' as const, color: T.textMut, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '0.92rem', fontWeight: 700, color: color ?? T.textBrt, fontFamily: T.mono, letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  )
}

// ── Pipeline view ─────────────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done')    return <span style={{ color: T.green }}>✓</span>
  if (status === 'error')   return <span style={{ color: T.red }}>✗</span>
  if (status === 'skip')    return <span style={{ color: T.textMut }}>—</span>
  if (status === 'running') return <span style={{ color: T.blue, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
  return <span style={{ color: T.border }}>○</span>
}

function PipelineView({ steps, elapsed }: { steps: PipelineStep[]; elapsed: number }) {
  return (
    <div style={{ ...S.panel, maxWidth: 520 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ ...S.sectionHd, marginBottom: 0 }}>Running Pipeline</div>
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.textMut }}>{elapsed}s</span>
      </div>
      {steps.map((step, i) => (
        <div key={step.id} style={{
          display: 'flex', gap: 12, padding: '9px 0',
          borderBottom: i < steps.length - 1 ? `1px solid ${T.border}` : 'none',
          opacity: step.status === 'pending' ? 0.28 : 1,
          transition: 'opacity 0.3s',
        }}>
          <div style={{ width: 16, flexShrink: 0, paddingTop: 2, fontSize: 12 }}><StepIcon status={step.status} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: step.status === 'error' ? T.red : T.textBrt, marginBottom: 2 }}>{step.label}</div>
            <div style={{ fontSize: '0.72rem', color: step.msg ? (step.status === 'error' ? T.red : step.status === 'done' ? T.green : T.blue) : T.textMut }}>
              {step.msg || step.desc}
            </div>
          </div>
        </div>
      ))}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ── Score breakdown ───────────────────────────────────────────────────────────

function ScoreBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const rows = [
    { key: 'momentum',   label: 'Momentum',   max: 25 },
    { key: 'volume',     label: 'Volume',     max: 20 },
    { key: 'setup',      label: 'Setup',      max: 19 },
    { key: 'market',     label: 'Market',     max: 15 },
    { key: 'conviction', label: 'Conviction', max: 10 },
  ]
  const techComp = breakdown?.tech_component
  const fundComp = breakdown?.fund_component
  const hasV3 = techComp != null && fundComp != null
  return (
    <div>
      {rows.map(r => {
        const val = breakdown?.[r.key] ?? 0
        const pct = Math.min(val / r.max * 100, 100)
        return (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ width: 68, fontSize: 10, color: T.textMut, fontWeight: 500 }}>{r.label}</span>
            <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: `linear-gradient(90deg,${T.blue},#60A5FA)`, transition: 'width 600ms ease' }} />
            </div>
            <span style={{ width: 32, textAlign: 'right', fontSize: 10, fontFamily: T.mono, fontWeight: 700, color: T.textBrt }}>{val}/{r.max}</span>
          </div>
        )
      })}
      {(breakdown?.penalty ?? 0) !== 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ width: 68, fontSize: 10, color: T.red, fontWeight: 500 }}>Penalty</span>
          <div style={{ flex: 1, height: 4, background: `${T.red}20`, borderRadius: 2 }}>
            <div style={{ width: '100%', height: '100%', borderRadius: 2, background: T.red }} />
          </div>
          <span style={{ width: 32, textAlign: 'right', fontSize: 10, fontFamily: T.mono, fontWeight: 700, color: T.red }}>{breakdown.penalty}</span>
        </div>
      )}
      {hasV3 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={{ ...S.sectionHd, marginBottom: 6 }}>V3 Blend</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, background: `${T.blue}0d`, borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${T.blue}` }}>
              <div style={{ fontSize: 9, color: T.textMut, textTransform: 'uppercase' as const, letterSpacing: '0.1em', fontWeight: 600 }}>Technical 70%</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: T.mono, color: T.blue, marginTop: 3 }}>{techComp}<span style={{ fontSize: '0.6rem', color: T.textMut, marginLeft: 2 }}>/62</span></div>
            </div>
            <div style={{ flex: 1, background: `${T.green}0d`, borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${T.green}` }}>
              <div style={{ fontSize: 9, color: T.textMut, textTransform: 'uppercase' as const, letterSpacing: '0.1em', fontWeight: 600 }}>Fundamental 30%</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: T.mono, color: T.green, marginTop: 3 }}>{fundComp}<span style={{ fontSize: '0.6rem', color: T.textMut, marginLeft: 2 }}>/30</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sector bar ────────────────────────────────────────────────────────────────

function SectorBar({ name, val }: { name: string; val: number }) {
  const color = val >= 0 ? T.green : T.red
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${T.border}` }}>
      <span style={{ width: 124, fontSize: 10, color: T.text, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
        <div style={{ width: `${Math.min(Math.abs(val) / 16 * 100, 100)}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 500ms ease' }} />
      </div>
      <span style={{ width: 44, textAlign: 'right', fontSize: 10, fontFamily: T.mono, fontWeight: 600, color }}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span>
    </div>
  )
}

// ── Other considered table ────────────────────────────────────────────────────

function OtherConsideredTable({ candidates, otherConsidered, sotdTicker }: {
  candidates: any[]; otherConsidered: any[]; sotdTicker: string
}) {
  const llmMap: Record<string, string> = {}
  for (const o of otherConsidered) llmMap[o.ticker] = o.why_not_the_others ?? o.reason_not_selected

  const rows = candidates
    .filter(c => c.passed_filter && c.ticker !== sotdTicker && (c.score ?? 0) >= 30)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10)

  if (!rows.length) return <p style={{ padding: '10px 0', fontSize: '0.8rem', color: T.textMut }}>No other candidates this session.</p>

  const signalColor = (t: string) => t === 'breakout' ? T.blue : t === 'reversal' ? T.yellow : T.green

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            {['Ticker','Score','Signal','Why Not Selected','RSI','Vol'].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 9, fontWeight: 700, color: T.textMut, textTransform: 'uppercase' as const, letterSpacing: '0.1em', background: T.cardHi }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c: any) => {
            const score = c.score ?? 0
            const tags: string[] = c.tags ?? []
            const signalType = tags.includes('breakout') ? 'breakout' : tags.includes('reversal') ? 'reversal' : 'momentum'
            const reason = llmMap[c.ticker] || (score >= 65 ? 'Score in watchlist range (65–79)' : 'Score below 65 threshold')
            return (
              <tr key={c.ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
                <td style={{ padding: '8px 10px', fontFamily: T.mono, fontWeight: 700, color: T.textBrt, fontSize: '0.82rem' }}>{c.ticker}</td>
                <td style={{ padding: '8px 10px', fontFamily: T.mono, color: score >= 65 ? T.yellow : T.textMut, fontWeight: 700 }}>{score}</td>
                <td style={{ padding: '8px 10px' }}>
                  <Pill label={signalType} color={signalColor(signalType)} xs />
                </td>
                <td style={{ padding: '8px 10px', fontSize: '0.78rem', color: T.text, maxWidth: 380, lineHeight: 1.5 }}>{reason}</td>
                <td style={{ padding: '8px 10px', fontFamily: T.mono, color: T.textMut, fontSize: '0.78rem' }}>{c.metrics?.rsi ?? '—'}</td>
                <td style={{ padding: '8px 10px', fontFamily: T.mono, color: T.textMut, fontSize: '0.78rem' }}>{c.metrics?.vol_ratio ?? '—'}×</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

// ── Algorithm Info Modal ──────────────────────────────────────────────────────

function AlgorithmInfoModal({ data, onClose, onGoToConfig }: {
  data: any; onClose: () => void; onGoToConfig: () => void
}) {
  const sotd   = data?.stock_of_the_day
  const ticker = sotd?.ticker ?? '—'
  const bd     = sotd?.score_breakdown ?? {}
  const fd     = sotd?.fundamental_data ?? {}
  const mkt    = data?.market_context ?? {}
  const regime = mkt.regime ?? 'CHOP'

  const techTotal  = bd.tech_component  ?? 0
  const fundTotal  = bd.fund_component  ?? 0
  const scoreTotal = bd.total           ?? sotd?.confidence_score ?? 0

  const row = (label: string, pts: number | string, max: number | string, note: string) => (
    <tr key={label} style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={{ padding: '5px 8px', color: T.text, fontSize: '0.78rem' }}>{label}</td>
      <td style={{ padding: '5px 8px', fontFamily: T.mono, fontWeight: 700, color: T.textBrt, textAlign: 'right' }}>{pts}</td>
      <td style={{ padding: '5px 8px', color: T.textMut, fontSize: '0.72rem', textAlign: 'right' }}>/{max}</td>
      <td style={{ padding: '5px 8px', color: T.textMut, fontSize: '0.72rem' }}>{note}</td>
    </tr>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      overflowY: 'auto', padding: '24px 16px',
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: T.card, borderRadius: 12, width: '100%', maxWidth: 780,
        boxShadow: '0 24px 80px rgba(0,0,0,0.7)', border: `1px solid ${T.border}`,
        padding: '28px 32px',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: T.textBrt, marginBottom: 4 }}>
              How the Stock of the Day is Picked
            </div>
            <div style={{ fontSize: '0.78rem', color: T.textMut }}>
              Full pipeline walkthrough · Using today's pick as the live example
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textMut, fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Pipeline overview */}
        <div style={{ background: T.cardHi, borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.textMut, marginBottom: 10 }}>
            5-Step Pipeline · Runs Daily at 7:30 AM + 3 Intraday Refreshes
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {[
              { n: '1', label: 'FinViz Screener', sub: 'Universe filter' },
              { n: '2', label: 'yfinance OHLCV', sub: '60-day price data' },
              { n: '3', label: 'V3 Scorer', sub: 'Tech 70% + Fund 30%' },
              { n: '4', label: 'Haiku LLM', sub: '6-dimension analysis' },
              { n: '5', label: 'Pick + Cache', sub: 'DB + Telegram alert' },
            ].map(s => (
              <div key={s.n} style={{ background: T.cardHi2, borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontFamily: T.mono, fontWeight: 800, color: T.blue, fontSize: '0.9rem' }}>{s.n}</div>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: T.textBrt, marginTop: 2 }}>{s.label}</div>
                <div style={{ fontSize: '0.6rem', color: T.textMut, marginTop: 2 }}>{s.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Step 1 — FinViz */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: T.blue, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Step 1 · Universe Screener — FinViz API
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.7 }}>
            Every morning the pipeline asks <strong style={{ color: T.textBrt }}>FinViz</strong> for stocks that pass a momentum pre-filter: price &gt; $10, average daily volume &gt; 1M shares, mid-cap or larger. This typically returns 30–50 candidates. Any stock already in your Fidelity portfolio is excluded before scoring begins.
          </div>
          {data?.universe_filters && (
            <div style={{ marginTop: 8, background: T.cardHi, borderRadius: 6, padding: '8px 12px', fontSize: '0.72rem', fontFamily: T.mono, color: T.textMut }}>
              Today's filters: min price ${data.universe_filters.min_price} · min vol {(data.universe_filters.min_avg_volume/1000000).toFixed(1)}M/day · market cap {data.universe_filters.market_cap}
            </div>
          )}
        </div>

        {/* Step 2 — yfinance */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: T.blue, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Step 2 · Market Data — yfinance (60-day OHLCV) + Finnhub Fundamentals
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.7 }}>
            For every screened candidate, <strong style={{ color: T.textBrt }}>yfinance</strong> downloads 60 days of daily Open/High/Low/Close/Volume. The pipeline also downloads <strong style={{ color: T.textBrt }}>SPY</strong> and <strong style={{ color: T.textBrt }}>11 sector ETFs</strong> (XLK, XLF, XLE…) for relative performance context. Fundamental data (revenue growth, margins, EPS growth) comes from <strong style={{ color: T.textBrt }}>Finnhub</strong> with a 30-day cache, falling back to yfinance.info for cache misses.
          </div>
        </div>

        {/* Step 3 — Scoring */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: T.blue, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
            Step 3 · V3 Composite Score (0–100) — Live Example: {ticker}
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.7, marginBottom: 10 }}>
            Each candidate receives a <strong style={{ color: T.textBrt }}>V3 blended score</strong>: <strong style={{ color: T.green }}>Technical (70%)</strong> + <strong style={{ color: T.yellow }}>Fundamental (30%)</strong>. The technical sub-score is itself built from five components shown below.
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${T.border}` }}>
                <th style={{ padding: '6px 8px', textAlign: 'left',  fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: T.textMut }}>Component</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: T.textMut }}>{ticker}</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: T.textMut }}>Max</th>
                <th style={{ padding: '6px 8px', textAlign: 'left',  fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: T.textMut }}>What it measures</th>
              </tr>
            </thead>
            <tbody>
              {row('Momentum', bd.momentum ?? '—', 25, '10-day price return vs regime (BULL 1×, CHOP 0.85×, BEAR 0.65×)')}
              {row('Volume', bd.volume ?? '—', 20, 'Volume ratio vs 20-day avg (≥2× = 20 pts, ≥1.5× = 15 pts, ≥1.2× = 8 pts)')}
              {row('Setup Quality', bd.setup ?? '—', 19, 'BB squeeze > RSI recovery > above SMA20 > none; sector multiplier applied')}
              {row('Market Relative', bd.market ?? '—', 15, 'Outperformance vs SPY 10d (≥+5% = 15 pts, ≥+2% = 11 pts, etc.)')}
              {row('Trend Conviction', bd.conviction ?? '—', 10, 'ADX strength (≥30 = 10 pts, ≥20 = 7 pts, <20 = 3 pts)')}
              {row('Penalty', bd.penalty ?? 0, 0, 'Overextended 3d move, low volume breakout, adverse regime')}
              <tr style={{ borderTop: `2px solid ${T.border}` }}>
                <td style={{ padding: '6px 8px', fontWeight: 700, color: T.textBrt, fontSize: '0.78rem' }}>Technical Sub-score</td>
                <td style={{ padding: '6px 8px', fontFamily: T.mono, fontWeight: 800, color: T.green, textAlign: 'right' }}>{bd.tech_raw ?? techTotal}</td>
                <td style={{ padding: '6px 8px', color: T.textMut, textAlign: 'right', fontSize: '0.72rem' }}>/100</td>
                <td style={{ padding: '6px 8px', fontSize: '0.72rem', color: T.textMut }}>Raw score before 70% weight</td>
              </tr>
              <tr style={{ background: `${T.green}08` }}>
                <td style={{ padding: '6px 8px', fontWeight: 700, color: T.green, fontSize: '0.78rem' }}>Technical Component (70%)</td>
                <td style={{ padding: '6px 8px', fontFamily: T.mono, fontWeight: 800, color: T.green, textAlign: 'right' }}>{techTotal}</td>
                <td style={{ padding: '6px 8px', color: T.textMut, textAlign: 'right', fontSize: '0.72rem' }}>/70</td>
                <td style={{ padding: '6px 8px', fontSize: '0.72rem', color: T.textMut }}>tech_raw × 0.70</td>
              </tr>
              <tr style={{ background: `${T.yellow}08` }}>
                <td style={{ padding: '6px 8px', fontWeight: 700, color: T.yellow, fontSize: '0.78rem' }}>Fundamental Component (30%)</td>
                <td style={{ padding: '6px 8px', fontFamily: T.mono, fontWeight: 800, color: T.yellow, textAlign: 'right' }}>{fundTotal}</td>
                <td style={{ padding: '6px 8px', color: T.textMut, textAlign: 'right', fontSize: '0.72rem' }}>/30</td>
                <td style={{ padding: '6px 8px', fontSize: '0.72rem', color: T.textMut }}>Rev growth (12) + Margin (10) + EPS growth (8)</td>
              </tr>
              <tr style={{ background: `${T.blue}10`, borderTop: `2px solid ${T.blue}40` }}>
                <td style={{ padding: '8px 8px', fontWeight: 800, color: T.textBrt, fontSize: '0.85rem' }}>Final V3 Score</td>
                <td style={{ padding: '8px 8px', fontFamily: T.mono, fontWeight: 900, color: T.blue, textAlign: 'right', fontSize: '1.05rem' }}>{scoreTotal}</td>
                <td style={{ padding: '8px 8px', color: T.textMut, textAlign: 'right', fontSize: '0.72rem' }}>/100</td>
                <td style={{ padding: '8px 8px', fontSize: '0.72rem', color: T.textMut }}>
                  Tier: ≥80 = Stock of the Day · 65–79 = Watchlist · &lt;65 = Best Available
                  {regime === 'CHOP' ? ' · CHOP regime raises threshold to 85' : ''}
                </td>
              </tr>
            </tbody>
          </table>

          {fd.has_data && (
            <div style={{ background: `${T.yellow}0a`, borderRadius: 6, padding: '8px 12px', fontSize: '0.72rem', color: T.textMut }}>
              <strong style={{ color: T.yellow }}>Fundamentals for {ticker}: </strong>
              Revenue growth {fd.revenue_growth != null ? `${fd.revenue_growth.toFixed(1)}%` : 'N/A'} ·
              Net margin {fd.net_margin != null ? `${fd.net_margin.toFixed(1)}%` : 'N/A'} ·
              EPS growth {fd.eps_growth != null ? `${fd.eps_growth.toFixed(1)}%` : 'N/A'} ·
              Source: {fd.source ?? 'unknown'}
            </div>
          )}
        </div>

        {/* Step 4 — LLM */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: T.blue, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Step 4 · Haiku LLM Analysis — claude-haiku-4-5
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.7 }}>
            The top-scoring candidates (score ≥65, up to 8 stocks) are passed to <strong style={{ color: T.textBrt }}>Claude Haiku</strong> acting as an institutional analyst. The LLM does <em>not</em> re-score — it reasons across 6 dimensions:
          </div>
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              ['Technical Quality', 'Is the trend healthy or overextended? Volume confirming?'],
              ['Fundamental Validation', 'Does business quality support the move? Revenue, margin, FCF.'],
              ['Regime Alignment', `Does the setup fit the current ${regime} regime?`],
              ['Risk vs Reward', 'Is upside asymmetric? Is the setup crowded or exhausted?'],
              ['Narrative Durability', 'Can this move continue? Earnings revisions, institutional flow?'],
              ['Long-Horizon Suitability', 'Optimised for 2–12 week holds — not day trades.'],
            ].map(([title, desc]) => (
              <div key={title} style={{ background: T.cardHi, borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: T.textBrt, marginBottom: 3 }}>{title}</div>
                <div style={{ fontSize: '0.67rem', color: T.textMut, lineHeight: 1.5 }}>{desc}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: '0.78rem', color: T.textMut, lineHeight: 1.6 }}>
            The LLM outputs a structured JSON: ticker, confidence score (0–100), tier, conviction level (HIGH/MODERATE/SPECULATIVE), trade quality (A/B/C), holding horizon (2–12 weeks), rationale bullets, and risk flags. It is explicitly instructed to cite actual metric values — never invent data.
          </div>
          {sotd && (
            <div style={{ marginTop: 10, background: `${T.blue}08`, borderRadius: 6, padding: '10px 12px', borderLeft: `3px solid ${T.blue}` }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: T.blue, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Haiku's verdict on {ticker} today
              </div>
              <div style={{ fontSize: '0.77rem', color: T.text, lineHeight: 1.6 }}>
                Confidence {sotd.confidence_score}/100 · {sotd.tier} · Conviction: {sotd.conviction_level} · Quality: {sotd.trade_quality} · Hold: {sotd.holding_horizon}
              </div>
              {sotd.summary && (
                <div style={{ fontSize: '0.75rem', color: T.textMut, marginTop: 6, lineHeight: 1.6, fontStyle: 'italic' }}>
                  "{sotd.summary}"
                </div>
              )}
            </div>
          )}
        </div>

        {/* APIs summary */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: T.blue, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
            Data Sources Used in Every Run
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { api: 'FinViz',       role: 'Universe screener',       detail: 'Momentum + volume + cap filters. Returns ~30–50 candidates.' },
              { api: 'yfinance',     role: 'Price history + OHLCV',   detail: '60-day daily bars for all candidates, SPY, VIX, 11 sector ETFs.' },
              { api: 'Finnhub',      role: 'Fundamental data',        detail: 'Revenue growth, net margin, EPS growth (30-day cache).' },
              { api: 'yfinance.info',role: 'Fundamental fallback',    detail: 'Used when Finnhub cache misses or data is unavailable.' },
              { api: 'Anthropic API',role: 'Haiku LLM reasoning',     detail: 'claude-haiku-4-5 · ~$0.003/run · logs to analysis_log table.' },
              { api: 'SnapTrade',    role: 'Portfolio exclusions',    detail: 'Live Fidelity sync every 30 min — excludes owned tickers.' },
            ].map(s => (
              <div key={s.api} style={{ background: T.cardHi, borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ fontFamily: T.mono, fontWeight: 700, color: T.textBrt, fontSize: '0.75rem', marginBottom: 3 }}>{s.api}</div>
                <div style={{ fontSize: '0.67rem', fontWeight: 600, color: T.blue, marginBottom: 3 }}>{s.role}</div>
                <div style={{ fontSize: '0.65rem', color: T.textMut, lineHeight: 1.5 }}>{s.detail}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
          <button
            onClick={onGoToConfig}
            style={{ background: `${T.blue}18`, border: `1px solid ${T.blue}40`, color: T.blue, borderRadius: 6, padding: '7px 16px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}
          >
            ⚙ Tweak Parameters → Config & Scheduler
          </button>
          <button onClick={onClose} className="btn sm">Close</button>
        </div>
      </div>
    </div>
  )
}

export default function IntelligenceTab({ onGoToConfig, prefillTicker, prefillSeq }: {
  onGoToConfig?: () => void
  prefillTicker?: string
  prefillSeq?: number
}) {
  const [data,        setData]        = useState<any>(null)
  const [streaming,   setStreaming]   = useState(false)
  const [steps,       setSteps]       = useState<PipelineStep[]>(PIPELINE_STEPS.map(s => ({ ...s })))
  const [elapsed,     setElapsed]     = useState(0)
  const [streamErr,   setStreamErr]   = useState('')
  const [liveQuote,   setLiveQuote]   = useState<{ price: number | null; change_pct: number | null; ytd_pct: number | null } | null>(null)
  const [repeatHits,  setRepeatHits]  = useState<any[]>([])
  const [showInfo,    setShowInfo]    = useState(false)
  const [reviewMode,  setReviewMode]  = useState(false)
  const esRef      = useRef<EventSource | null>(null)
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const quoteTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const updateStep = (id: string, status: StepStatus, msg: string) =>
    setSteps(prev => prev.map(s => s.id === id ? { ...s, status, msg } : s))

  const startStream = (forceRefresh = true, tickerOverride?: string) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setStreaming(true); setStreamErr(''); setData(null)
    setSteps(PIPELINE_STEPS.map(s => ({ ...s }))); setElapsed(0)
    const start = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    const url = tickerOverride ? sotdTickerStreamUrl(tickerOverride) : sotdStreamUrl(forceRefresh)
    const es = new EventSource(url)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        const { step, status, msg } = event
        if (step === 'cached') { setData(event.data); setStreaming(false); es.close(); return }
        if (step === 'complete') {
          setData(event.data)
          updateStep('llm', 'done', event.data?.stock_of_the_day ? `${event.data.stock_of_the_day.tier}: ${event.data.stock_of_the_day.ticker}` : 'Done')
          setStreaming(false); es.close()
          if (timerRef.current) clearInterval(timerRef.current); return
        }
        if (step === 'error') { setStreamErr(msg ?? 'Pipeline failed'); setStreaming(false); es.close(); if (timerRef.current) clearInterval(timerRef.current); return }
        const sid = ({ screener: 'screener', market_data: 'market_data', indicators: 'indicators', scoring: 'scoring', llm: 'llm' } as any)[step]
        if (sid) updateStep(sid, status as StepStatus, msg ?? '')
        if (status === 'running') {
          const order = ['screener', 'market_data', 'indicators', 'scoring', 'llm']
          order.slice(0, order.indexOf(sid)).forEach(id =>
            setSteps(prev => prev.map(s => s.id === id && s.status === 'pending' ? { ...s, status: 'skip' } : s))
          )
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => { setStreamErr('Connection to pipeline lost'); setStreaming(false); es.close(); if (timerRef.current) clearInterval(timerRef.current) }
  }

  useEffect(() => {
    getSotdFull(false)
      .then(r => { const d = r.data.data; if (d?.stock_of_the_day) setData(d); else startStream(true) })
      .catch(() => startStream(true))
    getSotdRepeatHits()
      .then(r => setRepeatHits(r.data.repeat_hits ?? []))
      .catch(() => {})
    return () => { if (esRef.current) esRef.current.close(); if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  useEffect(() => {
    if (prefillTicker && prefillSeq && prefillSeq > 0) {
      setReviewMode(true)
      startStream(true, prefillTicker)
    }
  }, [prefillSeq])

  useEffect(() => {
    const ticker = data?.stock_of_the_day?.ticker
    if (!ticker) return
    const fetch = () => {
      getMarketQuotes(ticker)
        .then(r => { const q = r.data.quotes?.[ticker]; if (q) setLiveQuote(q) })
        .catch(() => {})
    }
    fetch()
    quoteTimer.current = setInterval(fetch, 60_000)
    return () => { if (quoteTimer.current) clearInterval(quoteTimer.current) }
  }, [data?.stock_of_the_day?.ticker])

  if (streaming) return (
    <div style={{ background: T.bg, minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 48, gap: 14 }}>
      <PipelineView steps={steps} elapsed={elapsed} />
      <p style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono }}>Screener ~30s · Market data ~10s · Haiku ~5s</p>
    </div>
  )

  if (streamErr && !data) return (
    <div style={{ background: T.bg, minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 48, gap: 12 }}>
      <PipelineView steps={steps} elapsed={elapsed} />
      <div style={{ color: T.red, fontSize: '0.82rem', fontFamily: T.mono, background: `${T.red}0e`, padding: '10px 16px', border: `1px solid ${T.red}30`, borderRadius: 8 }}>{streamErr}</div>
      <button className="btn sm primary" onClick={() => startStream(true)}>↻ Retry</button>
    </div>
  )

  if (!data) return (
    <div style={{ background: T.bg, minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
      <button className="btn sm primary" onClick={() => startStream(true)}>▶ Run Pipeline</button>
    </div>
  )

  // ── Derived intelligence ─────────────────────────────────────────────────────
  const mkt        = data.market_context ?? {}
  const sotd       = data.stock_of_the_day
  const allC       = data.all_candidates ?? []
  const regimeClass = (mkt.regime ?? 'CHOP').toLowerCase()

  const metrics    = sotd?.metrics ?? {}
  const bd         = sotd?.score_breakdown ?? {}
  const entry      = sotd ? entryQuality(metrics) : null
  const stage      = sotd ? momentumStage(metrics) : null
  const risk       = sotd ? riskProfile(metrics, stage) : null
  const status     = sotd ? decisionStatus(sotd.tier ?? '', entry, risk) : null
  const vix        = sotd ? vixContext(mkt.vix ?? 18) : null
  const accel      = sotd ? accelerationLabel(metrics.return_3d ?? 0, metrics.return_5d ?? 0, metrics.return_10d ?? 0) : null
  const invals     = sotd ? invalidationConditions(metrics) : []
  const runners    = allC.filter((c: any) => c.passed_filter && c.ticker !== sotd?.ticker).sort((a: any, b: any) => b.score - a.score)
  const won        = sotd ? whyWon(bd, runners) : null
  const similar    = sotd ? similarSetups(allC, sotd.ticker, sotd.tags ?? []) : []
  const chartDesc  = sotd ? chartExplanation(metrics, sotd.ticker) : []
  const whyNotBuy  = sotd ? whyNotBuyNow(metrics, stage, sotd.tier ?? '') : []
  const allocation = sotd ? allocationSuggestion(sotd.conviction_level, sotd.tier ?? '', sotd.trade_quality) : null
  const convThreshold = data.conviction_threshold ?? 65
  const isLowConviction = sotd && (sotd.confidence_score ?? 0) < convThreshold
  const entryZone  = metrics.price && metrics.above_sma20
    ? { low: +(metrics.price * 0.99).toFixed(2), high: +(metrics.price * 1.005).toFixed(2) }
    : null

  const tqColor  = sotd?.trade_quality === 'A' ? T.green : sotd?.trade_quality === 'B' ? T.blue : T.yellow
  const cvColor  = sotd?.conviction_level === 'HIGH' ? T.green : sotd?.conviction_level === 'MODERATE' ? T.blue : T.yellow
  const accentL  = sotd?.confidence_score >= 85 ? T.green : sotd?.confidence_score >= 70 ? T.blue : T.textMut

  // compact inline badge for market context
  const mktBadge = (text: string, regime: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 5,
    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
    background: regime === 'bull' ? `${T.green}16` : regime === 'bear' ? `${T.red}16` : `${T.yellow}16`,
    color: regime === 'bull' ? T.green : regime === 'bear' ? T.red : T.yellow,
  })

  // ── Layout ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: T.bg, minHeight: '100%', padding: '14px 18px' }}>

      {/* Review mode banner */}
      {reviewMode && data?._ticker_review_mode && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
          background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 8, padding: '8px 14px',
        }}>
          <span style={{ fontSize: '0.75rem', color: '#93C5FD' }}>
            Reviewing <strong style={{ fontFamily: 'var(--mono)', color: '#F1F5F9' }}>{data._reviewed_ticker}</strong> — live analysis on today's data, not a historical replay
          </span>
          <button
            className="btn sm"
            style={{ marginLeft: 'auto', fontSize: '0.72rem' }}
            onClick={() => {
              setReviewMode(false)
              getSotdFull(false)
                .then(r => { const d = r.data.data; if (d?.stock_of_the_day) setData(d); else startStream(false) })
                .catch(() => startStream(false))
            }}
          >
            ← Today's Pick
          </button>
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono }}>
          {data.generated_at ? `Generated ${data.generated_at.slice(0, 16).replace('T', ' ')} UTC` : ''}
        </span>
        <button
          className="btn sm"
          onClick={() => setShowInfo(true)}
          title="How this pick was made"
          style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', color: T.blue }}
        >
          ⓘ How it works
        </button>
        <button className="btn sm" onClick={() => startStream(true)}>↻ Refresh</button>
      </div>

      {showInfo && (
        <AlgorithmInfoModal
          data={data}
          onClose={() => setShowInfo(false)}
          onGoToConfig={() => { setShowInfo(false); onGoToConfig?.() }}
        />
      )}

      {/* Repeat suppression banner */}
      {data.repeat_suppressed && (
        <div style={{ background: `rgba(59,130,246,0.07)`, borderLeft: `3px solid ${T.blue}`, borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: T.blue }}>↻ Universe Expanded</span>
            <span style={{ fontSize: 9, color: T.blue, opacity: 0.6, fontFamily: T.mono }}>{data.repeat_suppressed.ticker} · score {data.repeat_suppressed.score}</span>
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.6 }}>
            <strong style={{ color: T.blue }}>{data.repeat_suppressed.ticker}</strong> scored #1 again today but was already picked in the previous session. The agent expanded to the next best candidate. {data.repeat_suppressed.ticker} is being tracked as a recurring high-scorer — check the Repeat Hits log for stocks worth a closer look.
          </div>
        </div>
      )}

      {/* Low conviction banner */}
      {isLowConviction && (
        <div style={{ background: `${T.yellow}0a`, borderLeft: `3px solid ${T.yellow}`, borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: T.yellow }}>⚠ No High-Conviction Setup Today</span>
            <span style={{ fontSize: 9, color: T.yellow, opacity: 0.55, fontFamily: T.mono }}>Score {sotd?.confidence_score ?? '—'} / threshold {convThreshold}</span>
          </div>
          <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.6 }}>
            The top candidate does not meet the minimum conviction threshold. This is a <strong style={{ color: T.yellow }}>watching position only</strong> — not a trade signal. No trade is a valid decision.
          </div>
        </div>
      )}

      {/* ── ❶ HERO CARD ────────────────────────────────────────────────────────── */}
      {sotd && (
        <div style={{ ...S.panel, marginBottom: 8, borderLeft: `3px solid ${accentL}`, paddingTop: 14, paddingBottom: 14 }}>

          {/* Identity row — tight */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 12 }}>
            <ScoreGauge score={sotd.confidence_score} size={88} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Ticker + badges on one line */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const, marginBottom: 4 }}>
                <span style={S.ticker}>{sotd.ticker}</span>
                <Pill label={(sotd.signal_type ?? 'MOMENTUM').toUpperCase()} color={T.blue} />
                <Pill label={sotd.tier ?? 'Best Available'} color={sotd.tier === 'Stock of the Day' ? T.green : sotd.tier === 'Watchlist Candidate' ? T.yellow : T.textMut} />
                {sotd.conviction_level && <Pill label={sotd.conviction_level} color={cvColor} />}
                {sotd.trade_quality && <Pill label={`${sotd.trade_quality}-Grade`} color={tqColor} />}
                {sotd.holding_horizon && <Pill label={sotd.holding_horizon} color={T.textMut} xs />}
              </div>
              {/* Company + live price on same line */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <span style={S.company}>{sotd.company_name}</span>
                {liveQuote?.price != null && (
                  <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ fontSize: '1rem', fontWeight: 700, fontFamily: T.mono, color: T.textBrt }}>${liveQuote.price.toFixed(2)}</span>
                    {liveQuote.change_pct != null && (
                      <span style={{ fontSize: '0.78rem', fontFamily: T.mono, fontWeight: 700, color: liveQuote.change_pct >= 0 ? T.green : T.red }}>
                        {liveQuote.change_pct >= 0 ? '+' : ''}{liveQuote.change_pct.toFixed(2)}%
                      </span>
                    )}
                    <span style={{ fontSize: 9, color: T.textMut, fontFamily: T.mono, letterSpacing: '0.06em' }}>LIVE</span>
                    {liveQuote.ytd_pct != null && (
                      <span style={{ fontSize: '0.72rem', fontFamily: T.mono, fontWeight: 700, color: liveQuote.ytd_pct >= 0 ? T.green : T.red }}>
                        YTD {liveQuote.ytd_pct >= 0 ? '+' : ''}{liveQuote.ytd_pct.toFixed(1)}%
                      </span>
                    )}
                  </span>
                )}
                {metrics.price && <span style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono }}>pick @ ${metrics.price.toFixed(2)}</span>}
                {sotd.sector && <span style={{ fontSize: 10, color: T.textMut }}>{sotd.sector}</span>}
              </div>
            </div>
          </div>

          {/* Trade Decision Summary — no border cells, surface contrast only */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ ...S.sectionHd, marginBottom: 6 }}>Trade Decision Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
              {[
                { label: 'Quality',    value: sotd.trade_quality ? `${sotd.trade_quality}-Grade` : '—', color: tqColor },
                { label: 'Conviction', value: sotd.conviction_level ?? '—', color: cvColor },
                { label: 'Horizon',    value: sotd.holding_horizon ?? '—', color: T.textBrt },
                { label: 'Setup',      value: (sotd.signal_type ?? 'Momentum').toUpperCase(), color: T.blue },
                { label: 'Risk',       value: risk?.label ?? '—', color: risk?.color ?? T.textMut },
              ].map(cell => (
                <div key={cell.label} style={{ background: T.cardHi, padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ fontSize: 9, color: T.textMut, letterSpacing: '0.1em', textTransform: 'uppercase' as const, fontWeight: 600, marginBottom: 4 }}>{cell.label}</div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 800, fontFamily: T.mono, color: cell.color }}>{cell.value}</div>
                </div>
              ))}
            </div>
            {/* Status — inline accent bar, no heavy border */}
            {status && (
              <div style={{ marginTop: 4, background: `${status.color}0b`, borderLeft: `2px solid ${status.color}`, borderRadius: '0 6px 6px 0', padding: '6px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: T.textMut, letterSpacing: '0.12em', textTransform: 'uppercase' as const, fontWeight: 700, flexShrink: 0 }}>Status</span>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: status.color }}>{status.text}</span>
              </div>
            )}
          </div>

          {/* Suggested Exposure — single dense line */}
          {allocation && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: `${allocation.color}0b`, borderRadius: 6, borderLeft: `2px solid ${allocation.color}` }}>
              <span style={{ fontSize: 9, color: T.textMut, letterSpacing: '0.12em', textTransform: 'uppercase' as const, fontWeight: 700, flexShrink: 0 }}>Suggested Exposure</span>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, fontFamily: T.mono, color: allocation.color, flexShrink: 0, letterSpacing: '-0.02em' }}>{allocation.pct}</span>
              <span style={{ fontSize: '0.75rem', color: T.textMut, lineHeight: 1.4 }}>{allocation.note}</span>
            </div>
          )}
        </div>
      )}

      {/* ── TWO-COLUMN GRID ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 8, alignItems: 'start' }}>

        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* ❷ Secondary analysis */}
          {sotd && (
            <div style={S.panel}>
              {entry && stage && accel && (
                <>
                  {/* Stage badges */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' as const }}>
                    <div>
                      <div style={{ ...S.label, marginBottom: 4 }}>Entry Quality</div>
                      <Pill label={entry.label} color={entry.color} />
                    </div>
                    <div>
                      <div style={{ ...S.label, marginBottom: 4 }}>Momentum Stage</div>
                      <Pill label={stage.label} color={stage.color} />
                    </div>
                    <div>
                      <div style={{ ...S.label, marginBottom: 4 }}>Trend</div>
                      <Pill label={accel.label} color={accel.color} xs />
                    </div>
                  </div>

                  {/* Metrics strip */}
                  <div style={{ background: T.cardHi, borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                      <MetricCell label="RSI" value={metrics.rsi} color={metrics.rsi > 65 ? T.yellow : metrics.rsi < 45 ? T.blue : undefined} />
                      <MetricCell label="ADX" value={metrics.adx} color={metrics.adx >= 25 ? T.green : T.textMut} />
                      <MetricCell label="Vol" value={`${metrics.vol_ratio}×`} color={metrics.vol_ratio >= 2 ? T.green : metrics.vol_ratio >= 1.5 ? T.blue : undefined} />
                      <MetricCell label="10d" value={`${metrics.return_10d > 0 ? '+' : ''}${metrics.return_10d}%`} color={metrics.return_10d > 0 ? T.green : T.red} />
                      <MetricCell label="5d"  value={`${metrics.return_5d > 0 ? '+' : ''}${metrics.return_5d}%`}  color={metrics.return_5d > 0 ? T.green : T.red} />
                      <MetricCell label="3d"  value={`${metrics.return_3d > 0 ? '+' : ''}${metrics.return_3d}%`}  color={metrics.return_3d > 0 ? T.green : T.yellow} />
                    </div>
                  </div>
                  <div style={S.divider} />
                </>
              )}

              {/* LLM summary — optimised for readability */}
              <div style={{ fontSize: '0.82rem', color: T.text, lineHeight: 1.72, marginBottom: 14, padding: '10px 14px', background: `${T.blue}09`, borderRadius: 8, borderLeft: `2px solid ${T.blue}50` }}>
                {sotd.summary}
              </div>

              {/* Why This Stock */}
              {sotd.why_this_stock ? (
                <>
                  <div style={S.sectionHd}>Why This Stock</div>
                  {Array.isArray(sotd.why_this_stock) ? (
                    <div style={{ marginBottom: 12 }}>
                      {sotd.why_this_stock.map((d: string, i: number) => (
                        <div key={i} style={{ ...S.bullet, borderBottom: i < sotd.why_this_stock.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                          <span style={S.dot}>✓</span><span>{d}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: T.text, lineHeight: 1.7, marginBottom: 12, padding: '10px 12px', background: `${T.blue}09`, borderRadius: 8, borderLeft: `2px solid ${T.blue}50` }}>
                      {sotd.why_this_stock}
                    </div>
                  )}
                  {(sotd.technical_strengths ?? []).length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ ...S.label, color: T.blue, marginBottom: 6 }}>Technical Strengths</div>
                      {sotd.technical_strengths.map((d: string, i: number) => (
                        <div key={i} style={{ ...S.bullet, borderBottom: i < sotd.technical_strengths.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                          <span style={S.dot}>+</span><span>{d}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={S.sectionHd}>Why Selected</div>
                  <div style={{ marginBottom: 12 }}>
                    {(sotd.key_drivers ?? []).map((d: string, i: number) => (
                      <div key={i} style={{ ...S.bullet, borderBottom: i < (sotd.key_drivers ?? []).length - 1 ? `1px solid ${T.border}` : 'none' }}>
                        <span style={S.dot}>✓</span><span>{d}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* vs runner-up */}
              {won && won.advantage.length > 0 && (
                <div style={{ background: `${T.green}09`, borderRadius: 8, padding: '8px 12px', marginBottom: 12, borderLeft: `2px solid ${T.green}50` }}>
                  <div style={{ ...S.label, color: T.green, marginBottom: 4 }}>Why {sotd.ticker} over {runners[0]?.ticker}</div>
                  {won.advantage.map((a, i) => <div key={i} style={{ fontSize: '0.78rem', color: T.text, padding: '1px 0' }}>+ {a}</div>)}
                  {won.weakness.map((w, i) => <div key={i} style={{ fontSize: '0.78rem', color: T.textMut, padding: '1px 0' }}>− {w}</div>)}
                </div>
              )}

              {/* Fundamental Strengths */}
              {(sotd.fundamental_strengths ?? []).length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={S.sectionHd}>Fundamental Strengths</div>
                  <div style={{ background: `${T.green}09`, borderRadius: 8, padding: '10px 12px', borderLeft: `2px solid ${T.green}50` }}>
                    {sotd.fundamental_strengths.map((f: string, i: number) => (
                      <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: '0.8rem', color: T.text, lineHeight: 1.55, borderBottom: i < sotd.fundamental_strengths.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                        <span style={{ color: T.green, flexShrink: 0 }}>▪</span><span>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Why You May Wait */}
              {whyNotBuy.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ ...S.sectionHd, color: T.yellow }}>Why You May Wait</div>
                  <div style={{ background: `${T.yellow}09`, borderRadius: 8, padding: '10px 12px', borderLeft: `2px solid ${T.yellow}50` }}>
                    {whyNotBuy.map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: '0.8rem', color: T.text, lineHeight: 1.55, borderBottom: i < whyNotBuy.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                        <span style={{ color: T.yellow, flexShrink: 0 }}>•</span><span>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Risk Factors */}
              <div style={S.sectionHd}>Risk Factors</div>
              <div style={{ marginBottom: 12 }}>
                {(sotd.risk_factors ?? []).map((r: string, i: number) => (
                  <div key={i} style={{ ...S.bullet, borderBottom: i < (sotd.risk_factors ?? []).length - 1 ? `1px solid ${T.border}` : 'none' }}>
                    <span style={S.rdot}>!</span><span>{r}</span>
                  </div>
                ))}
              </div>

              {/* Ideal Entry / Avoid If */}
              {(sotd.ideal_entry_profile || sotd.avoid_if) && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const }}>
                  {sotd.ideal_entry_profile && (
                    <div style={{ flex: 1, minWidth: 180, background: `${T.green}09`, borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${T.green}50` }}>
                      <div style={{ ...S.label, color: T.green, marginBottom: 4 }}>Ideal Entry Profile</div>
                      <div style={{ fontSize: '0.78rem', color: T.text, lineHeight: 1.55 }}>{sotd.ideal_entry_profile}</div>
                    </div>
                  )}
                  {sotd.avoid_if && (
                    <div style={{ flex: 1, minWidth: 180, background: `${T.red}09`, borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${T.red}50` }}>
                      <div style={{ ...S.label, color: T.red, marginBottom: 4 }}>Avoid If</div>
                      <div style={{ fontSize: '0.78rem', color: T.text, lineHeight: 1.55 }}>{sotd.avoid_if}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Invalidation */}
              {((sotd.invalidation_conditions ?? []).length > 0 || invals.length > 0) && (
                <>
                  <div style={{ ...S.sectionHd, color: T.red }}>Invalidation Conditions</div>
                  <div style={{ background: `${T.red}09`, borderRadius: 8, padding: '10px 12px', borderLeft: `2px solid ${T.red}50`, marginBottom: 12 }}>
                    {((sotd.invalidation_conditions ?? []).length > 0 ? sotd.invalidation_conditions : invals).map((c: string, i: number) => {
                      const list = (sotd.invalidation_conditions ?? []).length > 0 ? sotd.invalidation_conditions : invals
                      return (
                        <div key={i} style={{ fontSize: '0.8rem', color: T.text, padding: '3px 0', borderBottom: i < list.length - 1 ? `1px solid ${T.border}` : 'none', lineHeight: 1.55 }}>
                          <span style={{ color: T.red, marginRight: 6 }}>✗</span>{c}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Final Verdict */}
              {sotd.final_verdict && (
                <div style={{ background: `${T.blue}0d`, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' as const, color: T.blue }}>Final Verdict</span>
                    {sotd.conviction_level && <Pill label={sotd.conviction_level} color={cvColor} xs />}
                    {sotd.trade_quality && <Pill label={`${sotd.trade_quality}-Grade`} color={tqColor} xs />}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: T.textBrt, lineHeight: 1.72 }}>{sotd.final_verdict}</div>
                  {sotd.holding_horizon && (
                    <div style={{ marginTop: 8, fontSize: 10, color: T.textMut, fontFamily: T.mono }}>
                      Holding Horizon: <span style={{ color: T.blue }}>{sotd.holding_horizon}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ❸ Chart */}
          {sotd && (
            <div style={S.panel}>
              <div style={S.sectionHd}>30-Day Price Action — {sotd.ticker}</div>
              <MiniChart symbol={sotd.ticker} days={30} height={160} entryZone={entryZone} />
              {chartDesc.length > 0 && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
                  <div style={{ ...S.sectionHd, marginBottom: 8 }}>Reading the Chart</div>
                  {chartDesc.map((line, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: '0.78rem', color: T.text, lineHeight: 1.6, borderBottom: i < chartDesc.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                      <span style={{ color: T.blue, flexShrink: 0 }}>›</span><span>{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ❹ Relative strength */}
          {sotd && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Relative Strength vs SPY — 30 Days</div>
              <RelativeStrengthChart symbol={sotd.ticker} days={30} height={140} />
              <div style={{ marginTop: 8, fontSize: 10, color: T.textMut, lineHeight: 1.55 }}>
                Both normalized to 0% at the start of the period. Alpha = {sotd.ticker} return minus SPY return over 30 days.
              </div>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Market Context */}
          <div style={S.panel}>
            <div style={{ fontSize: '0.88rem', fontWeight: 700, color: T.textBrt, marginBottom: 10, letterSpacing: '-0.01em' }}>Market Context</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const, marginBottom: 12 }}>
              <span style={mktBadge(mkt.regime ?? '—', regimeClass)}>{mkt.regime ?? '—'} Regime</span>
              <span style={mktBadge(`VIX ${mkt.vix ?? '—'}`, vix && mkt.vix < 20 ? 'bull' : mkt.vix < 25 ? 'chop' : 'bear')}>VIX {mkt.vix ?? '—'}</span>
              <span style={mktBadge('SPY', (mkt.spy_10d ?? 0) >= 0 ? 'bull' : 'bear')}>SPY {(mkt.spy_10d ?? 0) >= 0 ? '+' : ''}{(mkt.spy_10d ?? 0).toFixed(1)}%</span>
            </div>
            {vix && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <span style={S.label}>Volatility:</span>
                  <Pill label={`${vix.label} — ${vix.regime}`} color={vix.color} xs />
                </div>
                <div style={{ fontSize: '0.78rem', color: T.text, lineHeight: 1.65 }}>{vix.meaning}</div>
              </div>
            )}
            {sotd && (
              <div style={{ background: T.cardHi, borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${regimeClass === 'bull' ? T.green : regimeClass === 'bear' ? T.red : T.yellow}` }}>
                <div style={{ ...S.label, marginBottom: 5 }}>{sotd.regime_fit ? 'Regime Fit' : 'Impact on This Signal'}</div>
                <div style={{ fontSize: '0.78rem', color: T.text, lineHeight: 1.6 }}>
                  {sotd.regime_fit ?? signalImpact(mkt.regime ?? 'CHOP', sotd.signal_type ?? 'momentum')}
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 10, color: T.textMut, fontFamily: T.mono }}>Threshold: ≥{mkt.sotd_threshold ?? 80}</div>
          </div>

          {/* Score Breakdown */}
          {bd && bd.total && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Score Breakdown — {sotd?.ticker}</div>
              <ScoreBreakdown breakdown={bd} />
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.08em' }}>TOTAL</span>
                <span style={{ fontSize: '1.15rem', fontWeight: 800, fontFamily: T.mono, color: T.blue, letterSpacing: '-0.02em' }}>{bd.total ?? sotd?.confidence_score}</span>
              </div>
            </div>
          )}

          {/* Similar Setups */}
          {similar.length > 0 && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Similar Setups</div>
              <div style={{ fontSize: 10, color: T.textMut, marginBottom: 8 }}>Same signal pattern, different stock</div>
              {similar.map((c: any) => {
                const tags: string[] = c.tags ?? []
                return (
                  <div key={c.ticker} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.textBrt, width: 48, fontSize: '0.85rem' }}>{c.ticker}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: T.textMut, marginBottom: 3 }}>{c.sector}</div>
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const }}>
                        {tags.slice(0, 2).map((t: string) => <Pill key={t} label={t.replace('_', ' ')} color={T.blue} xs />)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: T.mono, fontWeight: 700, color: c.score >= 65 ? T.yellow : T.textMut, fontSize: '0.85rem' }}>{c.score}</div>
                      <div style={{ fontSize: 9, color: T.textMut }}>score</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Sector performance */}
          <div style={S.panel}>
            <div style={S.sectionHd}>Sector Performance (10d)</div>
            {(mkt.sector_performance ?? []).map((s: any) => (
              <SectorBar key={s.name} name={s.name} val={s.return_10d} />
            ))}
          </div>
        </div>
      </div>

      {/* ── FUNDAMENTAL INTELLIGENCE ── */}
      {sotd?.ticker && (
        // CSS variable overrides cascade to all var(--x) references inside FundamentalPanel
        <div style={{
          marginTop: 8,
          '--panel':       '#0C1A2E',
          '--panel-hi':    '#0C1A2E',
          '--panel-inset': 'rgba(255,255,255,0.035)',
          '--card-bg':     '#0C1A2E',
          '--border':      'rgba(255,255,255,0.07)',
          '--border-hi':   'rgba(255,255,255,0.12)',
          '--text':        '#CBD5E1',
          '--text-bright': '#F1F5F9',
          '--text-dim':    '#64748B',
          '--green':       '#22C55E',
          '--green-bg':    'rgba(34,197,94,0.1)',
          '--red':         '#EF4444',
          '--red-bg':      'rgba(239,68,68,0.1)',
          '--yellow':      '#F59E0B',
          '--yellow-bg':   'rgba(245,158,11,0.1)',
          '--cyan':        '#3B82F6',
          '--cyan-bg':     'rgba(59,130,246,0.1)',
          '--warn-bg':     'rgba(245,158,11,0.08)',
          '--warn-border': 'rgba(245,158,11,0.2)',
          '--warn-text':   '#F59E0B',
          '--info-bg':     'rgba(59,130,246,0.08)',
          '--info-border': 'rgba(59,130,246,0.2)',
        } as React.CSSProperties}>
          <FundamentalPanel
            symbol={sotd.ticker}
            autoLoad={true}
            signalType={sotd.signal_type || 'MOMENTUM'}
            confidenceScore={sotd.confidence_score}
            regime={mkt.regime}
          />
        </div>
      )}

      {/* ── OTHER CONSIDERED ── */}
      <div style={{ ...S.panel, marginTop: 8 }}>
        <div style={S.sectionHd}>
          Other Considered — {allC.filter((c: any) => c.passed_filter && c.ticker !== sotd?.ticker).length} candidates passed filters
        </div>
        <OtherConsideredTable candidates={allC} otherConsidered={data.other_considered ?? []} sotdTicker={sotd?.ticker ?? ''} />
      </div>

      {/* ── REPEAT HITS LOG ── */}
      {repeatHits.length > 0 && (
        <div style={{ ...S.panel, marginTop: 8 }}>
          <div style={{ ...S.sectionHd, marginBottom: 4 }}>Recurring High-Scorers</div>
          <div style={{ fontSize: '0.75rem', color: T.textMut, marginBottom: 10 }}>
            Stocks that scored #1 multiple sessions but were skipped to avoid repetition — worth a closer look.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
            {repeatHits.map((h: any) => (
              <div key={h.ticker} style={{ background: T.cardHi, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: T.mono, fontWeight: 800, fontSize: '1rem', color: T.textBrt }}>{h.ticker}</span>
                  <span style={{ background: `${T.blue}20`, color: T.blue, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>
                    {h.total_hits}× suppressed
                  </span>
                </div>
                <div style={{ fontSize: 10, color: T.textMut }}>Best score: <span style={{ color: T.text }}>{h.best_score}</span></div>
                <div style={{ fontSize: 10, color: T.textMut }}>Last: <span style={{ color: T.text, fontFamily: T.mono }}>{h.last_seen}</span></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
