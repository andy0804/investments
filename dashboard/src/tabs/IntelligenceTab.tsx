import { useState, useEffect, useRef } from 'react'
import { getSotdFull, sotdStreamUrl, getMarketQuotes } from '../api'
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

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  panel:     { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '16px 18px' },
  sectionHd: { fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', fontFamily: 'var(--mono)', marginBottom: 10 },
  ticker:    { fontSize: '1.8rem', fontWeight: 800, color: 'var(--text-bright)', fontFamily: 'var(--mono)', letterSpacing: '0.04em' },
  company:   { fontSize: '0.88rem', color: 'var(--text)', marginTop: 3 },
  bullet:    { display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.55 },
  dot:       { color: 'var(--cyan)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)' },
  rdot:      { color: 'var(--red)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)' },
  divider:   { borderTop: '1px solid var(--border)', margin: '14px 0' },
  label:     { fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', textTransform: 'uppercase' as const },
  value:     { fontSize: '0.92rem', color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontWeight: 600 },
}

// ── Deterministic intelligence helpers ───────────────────────────────────────

function entryQuality(metrics: any): { label: string; color: string; desc: string } {
  const r10 = metrics.return_10d ?? 0
  const rsi  = metrics.rsi ?? 50
  if (r10 < 5 && rsi < 55)
    return { label: 'EARLY', color: 'var(--green)',  desc: 'Price move not yet extended — early stage entry' }
  if (r10 <= 15 && rsi <= 62)
    return { label: 'GOOD',  color: 'var(--cyan)',   desc: 'Trend confirmed but not overextended' }
  if (r10 <= 25 || rsi <= 70)
    return { label: 'MODERATE', color: 'var(--yellow)', desc: `+${r10}% in 10d — trend intact, not early-stage` }
  return   { label: 'LATE', color: 'var(--red)',    desc: `+${r10}% in 10d — approaching extended territory` }
}

function momentumStage(metrics: any): { label: string; color: string; desc: string } {
  const { return_10d: r10, return_5d: r5, return_3d: r3, bb_squeeze, above_sma20 } = metrics
  if (bb_squeeze && r3 > 0)
    return { label: 'EARLY BREAKOUT',    color: 'var(--green)',  desc: 'Bollinger squeeze just triggered — earliest valid entry point' }
  if (r10 < 8 && above_sma20 && r5 > 0)
    return { label: 'DEVELOPING',        color: 'var(--cyan)',   desc: 'Momentum building — structure forming, low extension risk' }
  if (r10 >= 8 && r10 <= 22 && above_sma20 && r3 > -2)
    return { label: 'MID-TREND',         color: 'var(--cyan)',   desc: 'Established trend — still valid, moderate extension' }
  if (r10 > 22 && r3 >= 0)
    return { label: 'LATE STAGE',        color: 'var(--yellow)', desc: `Extended +${r10}% in 10d — late entry, elevated reversal risk` }
  if (r10 > 12 && r3 < -1)
    return { label: 'PULLBACK',          color: 'var(--yellow)', desc: '3-day weakness in extended trend — watch SMA20 as support' }
  return   { label: 'MID-TREND',         color: 'var(--cyan)',   desc: 'Established trend continuation' }
}

function riskProfile(metrics: any, stage: any): { label: string; color: string } {
  const { return_10d, rsi, adx, vol_ratio } = metrics
  const stageLabel = stage?.label ?? ''
  if (return_10d > 20 || rsi > 68 || stageLabel.includes('LATE'))
    return { label: 'ELEVATED', color: 'var(--red)' }
  if (return_10d > 10 || rsi > 60 || adx < 18 || vol_ratio < 1.2)
    return { label: 'MODERATE', color: 'var(--yellow)' }
  return { label: 'CONTROLLED', color: 'var(--green)' }
}

function decisionStatus(tier: string, entry: any, risk: any): { text: string; color: string } {
  if (tier === 'Stock of the Day') {
    if (entry?.label === 'EARLY') return { text: 'Active signal — early entry, not extended', color: 'var(--green)' }
    if (entry?.label === 'GOOD')  return { text: 'Buyable — confirmed trend, not overextended', color: 'var(--green)' }
    if (risk?.label === 'ELEVATED') return { text: 'Caution — extended move, consider waiting for pullback', color: 'var(--yellow)' }
    return { text: 'At threshold — size conservatively', color: 'var(--yellow)' }
  }
  if (tier === 'Watchlist Candidate') return { text: 'Watchlist only — monitor for score improvement', color: 'var(--yellow)' }
  return { text: 'No conviction setup today — monitoring mode only', color: 'var(--text-dim)' }
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
  if (tier === 'Best Available') return { pct: '0–2%', note: 'No conviction setup — limit order only, do not chase', color: 'var(--text-dim)' }
  if (convictionLevel === 'HIGH' || tradeQuality === 'A') return { pct: '6–8%', note: 'High conviction — full position within your 8% single-stock cap', color: 'var(--green)' }
  if (convictionLevel === 'MODERATE' || tradeQuality === 'B') return { pct: '3–5%', note: 'Moderate conviction — initial half position, add on confirmation', color: 'var(--cyan)' }
  return { pct: '1–3%', note: 'Low conviction — exploratory size only, set a tight stop', color: 'var(--yellow)' }
}

function vixContext(vix: number): { label: string; color: string; regime: string; meaning: string } {
  if (vix < 15)
    return { label: 'LOW',       color: 'var(--green)',  regime: 'Risk-On',    meaning: 'Low fear. Momentum strategies historically outperform. Trend signals are more reliable.' }
  if (vix < 20)
    return { label: 'NORMAL',    color: 'var(--cyan)',   regime: 'Balanced',   meaning: 'Normal conditions. Momentum setups carry standard risk/reward.' }
  if (vix < 25)
    return { label: 'ELEVATED',  color: 'var(--yellow)', regime: 'Cautious',   meaning: 'Elevated fear. Increased false signals — use tighter stops and smaller sizing.' }
  return   { label: 'HIGH FEAR', color: 'var(--red)',    regime: 'Defensive',  meaning: 'High fear environment. Momentum setups have reduced reliability.' }
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
    return { label: 'PULLING BACK', color: 'var(--yellow)', note: '3d weakness within uptrend — possible consolidation before continuation' }
  if (d3 > d5 && d5 > d10 && d3 > 0)
    return { label: 'ACCELERATING', color: 'var(--green)', note: 'Each shorter period outpacing the longer — momentum building' }
  if (d3 < d5 && d5 < d10)
    return { label: 'DECELERATING', color: 'var(--yellow)', note: 'Recent pace slowing vs 10d average — watch for trend change' }
  if (d5 > d10 + 0.3)
    return { label: 'STRENGTHENING', color: 'var(--green)', note: '5d pace outrunning 10d average — recent acceleration' }
  return { label: 'STEADY', color: 'var(--cyan)', note: 'Consistent pace across timeframes' }
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

// ── Reusable UI atoms ─────────────────────────────────────────────────────────

function IntelBadge({ label, color, size = 'sm' }: { label: string; color: string; size?: 'sm' | 'xs' }) {
  const sz = size === 'xs' ? '0.58rem' : '0.65rem'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 2,
      fontSize: sz, fontWeight: 700, fontFamily: 'var(--mono)',
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: color + '1a', color, border: `1px solid ${color}55`,
    }}>
      {label}
    </span>
  )
}

function MetricCell({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={S.label}>{label}</div>
      <div style={{ ...S.value, color: color ?? 'var(--text-bright)', marginTop: 2 }}>{value}</div>
    </div>
  )
}

// ── Pipeline view ─────────────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done')    return <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>✓</span>
  if (status === 'error')   return <span style={{ color: 'var(--red)',   fontFamily: 'var(--mono)' }}>✗</span>
  if (status === 'skip')    return <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>—</span>
  if (status === 'running') return <span style={{ color: 'var(--cyan)', fontFamily: 'var(--mono)', display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
  return <span style={{ color: 'var(--border-hi)', fontFamily: 'var(--mono)' }}>○</span>
}

function PipelineView({ steps, elapsed }: { steps: PipelineStep[]; elapsed: number }) {
  return (
    <div style={{ ...S.panel, maxWidth: 560 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ ...S.sectionHd, marginBottom: 0 }}>Running Pipeline</div>
        <span style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{elapsed}s</span>
      </div>
      {steps.map((step, i) => (
        <div key={step.id} style={{
          display: 'flex', gap: 14, padding: '10px 0',
          borderBottom: i < steps.length - 1 ? '1px solid var(--border)' : 'none',
          opacity: step.status === 'pending' ? 0.35 : 1,
          transition: 'opacity 0.3s',
        }}>
          <div style={{ width: 18, flexShrink: 0, paddingTop: 2 }}><StepIcon status={step.status} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: step.status === 'error' ? 'var(--red)' : 'var(--text-bright)', marginBottom: 2 }}>
              {step.label}
            </div>
            <div style={{ fontSize: '0.72rem', color: step.msg ? (step.status === 'error' ? 'var(--red)' : step.status === 'done' ? 'var(--green)' : 'var(--cyan)') : 'var(--text-dim)' }}>
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
        return (
          <div key={r.key} className="comp-bar-row">
            <span className="comp-bar-name">{r.label}</span>
            <div className="comp-bar-track">
              <div className="comp-bar-fill" style={{ width: `${Math.min(val / r.max * 100, 100)}%` }} />
            </div>
            <span className="comp-bar-val">{val}/{r.max}</span>
          </div>
        )
      })}
      {(breakdown?.penalty ?? 0) !== 0 && (
        <div className="comp-bar-row">
          <span className="comp-bar-name" style={{ color: 'var(--red)' }}>Penalty</span>
          <div className="comp-bar-track"><div className="comp-bar-fill" style={{ width: '100%', background: 'var(--red)' }} /></div>
          <span className="comp-bar-val" style={{ color: 'var(--red)' }}>{breakdown.penalty}</span>
        </div>
      )}
      {hasV3 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>V3 Blend</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, background: 'var(--panel-inset)', borderRadius: 3, padding: '7px 10px', borderLeft: '2px solid var(--cyan)' }}>
              <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Technical 70%</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--cyan)', marginTop: 2 }}>{techComp}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginLeft: 2 }}>/62</span></div>
            </div>
            <div style={{ flex: 1, background: 'var(--panel-inset)', borderRadius: 3, padding: '7px 10px', borderLeft: '2px solid var(--green)' }}>
              <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fundamental 30%</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--green)', marginTop: 2 }}>{fundComp}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginLeft: 2 }}>/30</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sector bar ────────────────────────────────────────────────────────────────

function SectorBar({ name, val }: { name: string; val: number }) {
  const color = val >= 0 ? 'var(--green)' : 'var(--red)'
  return (
    <div className="sector-bar-row">
      <span className="sector-bar-name">{name}</span>
      <div className="sector-bar-track">
        <div className="sector-bar-fill" style={{ width: `${Math.min(Math.abs(val) / 16 * 100, 100)}%`, background: color }} />
      </div>
      <span className="sector-bar-val" style={{ color }}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span>
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

  if (!rows.length) return <p className="neutral" style={{ padding: '12px 0', fontSize: '0.8rem' }}>No other candidates this session.</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Ticker</th><th>Score</th><th>Signal</th><th>Why Not Selected</th><th>RSI</th><th>Vol</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c: any) => {
          const score = c.score ?? 0
          const tags: string[] = c.tags ?? []
          const signalType = tags.includes('breakout') ? 'breakout' : tags.includes('reversal') ? 'reversal' : 'momentum'
          const reason = llmMap[c.ticker] || (score >= 65 ? 'Score in watchlist range (65–79)' : 'Score below 65 threshold')
          return (
            <tr key={c.ticker}>
              <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)', fontSize: '0.85rem' }}>{c.ticker}</td>
              <td style={{ fontFamily: 'var(--mono)', color: score >= 65 ? 'var(--yellow)' : 'var(--text-dim)', fontWeight: 600 }}>{score}</td>
              <td><span className={`badge ${signalType}`}>{signalType}</span></td>
              <td style={{ fontSize: '0.78rem', color: 'var(--text)', maxWidth: 380 }}>{reason}</td>
              <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.78rem' }}>{c.metrics?.rsi ?? '—'}</td>
              <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.78rem' }}>{c.metrics?.vol_ratio ?? '—'}×</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function IntelligenceTab() {
  const [data,      setData]      = useState<any>(null)
  const [streaming, setStreaming] = useState(false)
  const [steps,     setSteps]     = useState<PipelineStep[]>(PIPELINE_STEPS.map(s => ({ ...s })))
  const [elapsed,   setElapsed]   = useState(0)
  const [streamErr, setStreamErr] = useState('')
  const [liveQuote, setLiveQuote] = useState<{ price: number | null; change_pct: number | null } | null>(null)
  const esRef      = useRef<EventSource | null>(null)
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const quoteTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const updateStep = (id: string, status: StepStatus, msg: string) =>
    setSteps(prev => prev.map(s => s.id === id ? { ...s, status, msg } : s))

  const startStream = (forceRefresh = true) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setStreaming(true); setStreamErr('')
    setSteps(PIPELINE_STEPS.map(s => ({ ...s }))); setElapsed(0)

    const start = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)

    const es = new EventSource(sotdStreamUrl(forceRefresh))
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
    return () => { if (esRef.current) esRef.current.close(); if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40, gap: 16 }}>
      <PipelineView steps={steps} elapsed={elapsed} />
      <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>Screener ~30s · Market data ~10s · Haiku ~5s</p>
    </div>
  )

  if (streamErr && !data) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40, gap: 12 }}>
      <PipelineView steps={steps} elapsed={elapsed} />
      <div style={{ color: 'var(--red)', fontSize: '0.82rem', fontFamily: 'var(--mono)', background: 'var(--panel)', padding: '10px 16px', border: '1px solid var(--red)', borderRadius: 4 }}>{streamErr}</div>
      <button className="btn sm primary" onClick={() => startStream(true)}>↻ Retry</button>
    </div>
  )

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
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

  // Visual tier for conviction/quality colors
  const tqColor  = sotd?.trade_quality === 'A' ? 'var(--green)' : sotd?.trade_quality === 'B' ? 'var(--cyan)' : 'var(--yellow)'
  const cvColor  = sotd?.conviction_level === 'HIGH' ? 'var(--green)' : sotd?.conviction_level === 'MODERATE' ? 'var(--cyan)' : 'var(--yellow)'

  return (
    <div>
      {/* Action row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12, gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          {data.generated_at ? `Generated ${data.generated_at.slice(0, 16).replace('T', ' ')} UTC` : ''}
        </span>
        <button className="btn sm" onClick={() => startStream(true)}>↻ Refresh</button>
      </div>

      {/* No high-conviction banner */}
      {isLowConviction && (
        <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 6, padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--warn-text)', letterSpacing: '0.1em' }}>
              ⚠ NO HIGH-CONVICTION SETUP TODAY
            </span>
            <span style={{ fontSize: '0.68rem', color: 'var(--warn-text)', fontFamily: 'var(--mono)', opacity: 0.6 }}>
              Score {sotd?.confidence_score ?? '—'} / threshold {convThreshold}
            </span>
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--warn-text)', lineHeight: 1.55 }}>
            The top candidate does not meet the minimum conviction threshold. This is a <strong style={{ color: 'var(--yellow)' }}>watching position only</strong> — not a trade signal. No trade is a valid decision.
          </div>
        </div>
      )}

      {/* ── ❶ PRIMARY DECISION PANEL ─────────────────────────────────────────── */}
      {sotd && (
        <div style={{
          ...S.panel,
          marginBottom: 12,
          borderColor: sotd.confidence_score >= 85 ? '#86efac' : sotd.confidence_score >= 70 ? '#bfdbfe' : 'var(--border)',
          borderLeftWidth: 3,
          borderLeftColor: sotd.confidence_score >= 85 ? 'var(--green)' : sotd.confidence_score >= 70 ? 'var(--cyan)' : 'var(--text-dim)',
        }}>
          {/* Stock identity: gauge + ticker + badges */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 16 }}>
            <ScoreGauge score={sotd.confidence_score} size={110} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={S.ticker}>{sotd.ticker}</span>
                <span className={`badge ${(sotd.signal_type ?? 'momentum').toLowerCase()}`}>
                  {(sotd.signal_type ?? 'MOMENTUM').toUpperCase()}
                </span>
                <span className={`badge ${sotd.tier === 'Stock of the Day' ? 'sotd' : sotd.tier === 'Watchlist Candidate' ? 'watchlist' : 'best-available'}`}>
                  {sotd.tier ?? 'Best Available'}
                </span>
                {sotd.conviction_level && (
                  <IntelBadge label={sotd.conviction_level} color={cvColor} />
                )}
                {sotd.trade_quality && (
                  <span style={{ fontSize: '0.65rem', fontWeight: 800, fontFamily: 'var(--mono)', color: tqColor, border: `1px solid ${tqColor}88`, padding: '1px 7px', borderRadius: 2 }}>
                    {sotd.trade_quality}-GRADE
                  </span>
                )}
                {sotd.holding_horizon && (
                  <IntelBadge label={sotd.holding_horizon} color="var(--text-dim)" size="xs" />
                )}
              </div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 }}>
                <div style={S.company}>{sotd.company_name}</div>
                {liveQuote?.price != null && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text-bright)' }}>
                      ${liveQuote.price.toFixed(2)}
                    </span>
                    {liveQuote.change_pct != null && (
                      <span style={{ fontSize: '0.8rem', fontFamily: 'var(--mono)', fontWeight: 600, color: liveQuote.change_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {liveQuote.change_pct >= 0 ? '+' : ''}{liveQuote.change_pct.toFixed(2)}%
                      </span>
                    )}
                    <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>LIVE</span>
                  </div>
                )}
                {metrics.price && (
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    pick @ ${metrics.price.toFixed(2)}
                  </span>
                )}
              </div>
              {sotd.sector && <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{sotd.sector}</div>}
            </div>
          </div>

          {/* Trade Decision Summary grid */}
          <div style={{ marginBottom: 0 }}>
            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8 }}>
              Trade Decision Summary
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 1,
              background: 'var(--border)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              overflow: 'hidden',
              marginBottom: 1,
            }}>
              {[
                { label: 'Quality', value: sotd.trade_quality ? `${sotd.trade_quality}-Grade` : '—', color: tqColor },
                { label: 'Conviction', value: sotd.conviction_level ?? '—', color: cvColor },
                { label: 'Horizon', value: sotd.holding_horizon ?? '—', color: 'var(--text-bright)' },
                { label: 'Setup', value: (sotd.signal_type ?? 'Momentum').toUpperCase(), color: 'var(--cyan)' },
                { label: 'Risk', value: risk?.label ?? '—', color: risk?.color ?? 'var(--text-dim)' },
              ].map(cell => (
                <div key={cell.label} style={{ background: 'var(--panel-inset)', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5 }}>{cell.label}</div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, fontFamily: 'var(--mono)', color: cell.color, lineHeight: 1.2 }}>{cell.value}</div>
                </div>
              ))}
            </div>
            {/* Status bar — full width below the grid */}
            {status && (
              <div style={{ background: 'var(--panel-inset)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 3px 3px', padding: '8px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0 }}>Status</span>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--mono)', color: status.color }}>{status.text}</span>
              </div>
            )}
          </div>

          {/* Capital allocation strip */}
          {allocation && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 14, padding: '9px 14px', background: 'var(--info-bg)', borderRadius: 4, border: '1px solid var(--info-border)' }}>
              <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0 }}>Suggested Exposure</span>
              <span style={{ fontSize: '1.05rem', fontWeight: 800, fontFamily: 'var(--mono)', color: allocation.color, flexShrink: 0 }}>{allocation.pct}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', lineHeight: 1.4 }}>{allocation.note}</span>
            </div>
          )}
        </div>
      )}

      <div className="intel-grid">

        {/* ── LEFT COLUMN ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ❷ Secondary: entry stage + metrics + summary + why this stock + why not buy now + risks */}
          {sotd && (
            <div style={S.panel}>

              {/* Entry quality + Momentum stage + Metrics row */}
              {entry && stage && accel && (
                <>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ ...S.label, marginBottom: 3 }}>Entry Quality</div>
                      <IntelBadge label={entry.label} color={entry.color} />
                    </div>
                    <div>
                      <div style={{ ...S.label, marginBottom: 3 }}>Momentum Stage</div>
                      <IntelBadge label={stage.label} color={stage.color} />
                    </div>
                    <div>
                      <div style={{ ...S.label, marginBottom: 3 }}>Trend</div>
                      <IntelBadge label={accel.label} color={accel.color} size="xs" />
                    </div>
                  </div>

                  <div style={{ background: 'var(--panel-inset)', borderRadius: 3, padding: '10px 12px', marginBottom: 14 }}>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                      <MetricCell label="RSI" value={metrics.rsi} color={metrics.rsi > 65 ? 'var(--yellow)' : metrics.rsi < 45 ? 'var(--cyan)' : undefined} />
                      <MetricCell label="ADX" value={metrics.adx} color={metrics.adx >= 25 ? 'var(--green)' : 'var(--text-dim)'} />
                      <MetricCell label="Vol" value={`${metrics.vol_ratio}×`} color={metrics.vol_ratio >= 2 ? 'var(--green)' : metrics.vol_ratio >= 1.5 ? 'var(--cyan)' : undefined} />
                      <MetricCell label="10d" value={`${metrics.return_10d > 0 ? '+' : ''}${metrics.return_10d}%`} color={metrics.return_10d > 0 ? 'var(--green)' : 'var(--red)'} />
                      <MetricCell label="5d"  value={`${metrics.return_5d > 0 ? '+' : ''}${metrics.return_5d}%`}  color={metrics.return_5d > 0 ? 'var(--green)' : 'var(--red)'} />
                      <MetricCell label="3d"  value={`${metrics.return_3d > 0 ? '+' : ''}${metrics.return_3d}%`}  color={metrics.return_3d > 0 ? 'var(--green)' : 'var(--yellow)'} />
                    </div>
                  </div>
                  <div style={S.divider} />
                </>
              )}

              {/* LLM summary */}
              <div style={{ fontSize: '0.87rem', color: 'var(--text)', lineHeight: 1.7, marginBottom: 16, padding: '12px 14px', background: 'var(--panel-inset)', borderRadius: 4, borderLeft: '3px solid var(--cyan)' }}>
                {sotd.summary}
              </div>

              {/* Why This Stock — V3 primary, key_drivers fallback */}
              {sotd.why_this_stock ? (
                <>
                  <div style={S.sectionHd}>Why This Stock</div>
                  {Array.isArray(sotd.why_this_stock) ? (
                    <div style={{ marginBottom: 14 }}>
                      {sotd.why_this_stock.map((d: string, i: number) => (
                        <div key={i} style={{ ...S.bullet, borderBottom: i < sotd.why_this_stock.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <span style={S.dot}>✓</span><span>{d}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.84rem', color: 'var(--text)', lineHeight: 1.65, marginBottom: 14, padding: '10px 12px', background: 'var(--panel-inset)', borderRadius: 3, borderLeft: '2px solid var(--cyan)' }}>
                      {sotd.why_this_stock}
                    </div>
                  )}
                  {(sotd.technical_strengths ?? []).length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ ...S.label, color: 'var(--cyan)', marginBottom: 6 }}>Technical Strengths</div>
                      {sotd.technical_strengths.map((d: string, i: number) => (
                        <div key={i} style={{ ...S.bullet, borderBottom: i < sotd.technical_strengths.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <span style={S.dot}>+</span><span>{d}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={S.sectionHd}>Why Selected</div>
                  <div style={{ marginBottom: 14 }}>
                    {(sotd.key_drivers ?? []).map((d: string, i: number) => (
                      <div key={i} style={{ ...S.bullet, borderBottom: i < (sotd.key_drivers ?? []).length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <span style={S.dot}>✓</span><span>{d}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Why it won vs runner-up */}
              {won && won.advantage.length > 0 && (
                <div style={{ background: 'var(--panel-inset)', borderRadius: 3, padding: '8px 12px', marginBottom: 14, borderLeft: '2px solid var(--green)' }}>
                  <div style={{ ...S.label, color: 'var(--green)', marginBottom: 4 }}>Why {sotd.ticker} over {runners[0]?.ticker}</div>
                  {won.advantage.map((a, i) => <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text)', padding: '1px 0' }}>+ {a}</div>)}
                  {won.weakness.map((w, i) => <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text-dim)', padding: '1px 0' }}>− {w}</div>)}
                </div>
              )}

              {/* Fundamental Strengths */}
              {(sotd.fundamental_strengths ?? []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={S.sectionHd}>Fundamental Strengths</div>
                  <div style={{ background: 'var(--panel-inset)', borderRadius: 3, padding: '10px 12px', borderLeft: '2px solid var(--green)' }}>
                    {sotd.fundamental_strengths.map((f: string, i: number) => (
                      <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.5, borderBottom: i < sotd.fundamental_strengths.length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)', flexShrink: 0 }}>▪</span><span>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Why You May Wait ── high-contrast counterpoint */}
              {whyNotBuy.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ ...S.sectionHd, color: 'var(--yellow)' }}>Why You May Wait</div>
                  <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 4, padding: '10px 12px' }}>
                    {whyNotBuy.map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: '0.8rem', color: 'var(--warn-text)', lineHeight: 1.55, borderBottom: i < whyNotBuy.length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <span style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)', flexShrink: 0 }}>•</span>
                        <span>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Risk Factors */}
              <div style={S.sectionHd}>Risk Factors</div>
              <div style={{ marginBottom: 14 }}>
                {(sotd.risk_factors ?? []).map((r: string, i: number) => (
                  <div key={i} style={{ ...S.bullet, borderBottom: i < (sotd.risk_factors ?? []).length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <span style={S.rdot}>!</span><span>{r}</span>
                  </div>
                ))}
              </div>

              {/* Ideal Entry / Avoid If */}
              {(sotd.ideal_entry_profile || sotd.avoid_if) && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                  {sotd.ideal_entry_profile && (
                    <div style={{ flex: 1, minWidth: 200, background: 'var(--panel-inset)', borderRadius: 3, padding: '8px 10px', borderLeft: '2px solid var(--green)' }}>
                      <div style={{ ...S.label, color: 'var(--green)', marginBottom: 4 }}>Ideal Entry Profile</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>{sotd.ideal_entry_profile}</div>
                    </div>
                  )}
                  {sotd.avoid_if && (
                    <div style={{ flex: 1, minWidth: 200, background: 'var(--panel-inset)', borderRadius: 3, padding: '8px 10px', borderLeft: '2px solid var(--red)' }}>
                      <div style={{ ...S.label, color: 'var(--red)', marginBottom: 4 }}>Avoid If</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>{sotd.avoid_if}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Invalidation Conditions — LLM preferred, computed fallback */}
              {((sotd.invalidation_conditions ?? []).length > 0 || invals.length > 0) && (
                <>
                  <div style={{ ...S.sectionHd, color: 'var(--red)' }}>Invalidation Conditions</div>
                  <div style={{ background: 'var(--panel-inset)', borderRadius: 3, padding: '10px 12px', borderLeft: '2px solid var(--red)', marginBottom: 14 }}>
                    {((sotd.invalidation_conditions ?? []).length > 0 ? sotd.invalidation_conditions : invals).map((c: string, i: number) => {
                      const list = (sotd.invalidation_conditions ?? []).length > 0 ? sotd.invalidation_conditions : invals
                      return (
                        <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text)', padding: '3px 0', borderBottom: i < list.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <span style={{ color: 'var(--red)', marginRight: 6, fontFamily: 'var(--mono)' }}>✗</span>{c}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Final Verdict — V3 prominent conclusion */}
              {sotd.final_verdict && (
                <div style={{ background: 'linear-gradient(135deg, var(--info-bg) 0%, var(--blue-bg) 100%)', borderRadius: 6, padding: '14px 16px', border: '1px solid var(--info-border)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: '0.58rem', fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--cyan)' }}>Final Verdict</span>
                    {sotd.conviction_level && <IntelBadge label={sotd.conviction_level} color={cvColor} size="xs" />}
                    {sotd.trade_quality && <IntelBadge label={`${sotd.trade_quality}-Grade`} color={tqColor} size="xs" />}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-bright)', lineHeight: 1.7 }}>{sotd.final_verdict}</div>
                  {sotd.holding_horizon && (
                    <div style={{ marginTop: 8, fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                      Holding Horizon: <span style={{ color: 'var(--cyan)' }}>{sotd.holding_horizon}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ❸ 30-day price chart */}
          {sotd && (
            <div style={S.panel}>
              <div style={S.sectionHd}>30-Day Price Action — {sotd.ticker}</div>
              <MiniChart symbol={sotd.ticker} days={30} height={170} entryZone={entryZone} />
              {chartDesc.length > 0 && (
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ ...S.sectionHd, marginBottom: 8 }}>Reading the Chart</div>
                  {chartDesc.map((line, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6, borderBottom: i < chartDesc.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ color: 'var(--cyan)', fontFamily: 'var(--mono)', flexShrink: 0, marginTop: 1 }}>›</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ❹ Relative strength vs SPY */}
          {sotd && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Relative Strength vs SPY — 30 Days</div>
              <RelativeStrengthChart symbol={sotd.ticker} days={30} height={150} />
              <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Both normalized to 0% at the start of the period. Alpha = {sotd.ticker} return minus SPY return over 30 days.
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT SIDEBAR ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Market Context */}
          <div style={S.panel}>
            <div style={S.sectionHd}>Market Context</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <span className={`hbadge ${regimeClass}`}>{mkt.regime ?? '—'} REGIME</span>
              <span className={`hbadge ${vix && mkt.vix < 20 ? 'bull' : mkt.vix < 25 ? 'chop' : 'bear'}`}>VIX {mkt.vix ?? '—'}</span>
              <span className={`hbadge ${(mkt.spy_10d ?? 0) >= 0 ? 'bull' : 'bear'}`}>
                SPY {(mkt.spy_10d ?? 0) >= 0 ? '+' : ''}{(mkt.spy_10d ?? 0).toFixed(1)}%
              </span>
            </div>
            {vix && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span style={S.label}>Volatility:</span>
                  <IntelBadge label={`${vix.label} — ${vix.regime}`} color={vix.color} size="xs" />
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>{vix.meaning}</div>
              </div>
            )}
            {sotd && (
              <div style={{ background: 'var(--panel-inset)', borderRadius: 3, padding: '8px 10px', borderLeft: `2px solid ${regimeClass === 'bull' ? 'var(--green)' : regimeClass === 'bear' ? 'var(--red)' : 'var(--yellow)'}` }}>
                <div style={{ ...S.label, marginBottom: 4 }}>
                  {sotd.regime_fit ? 'Regime Fit' : 'Impact on This Signal'}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>
                  {sotd.regime_fit ?? signalImpact(mkt.regime ?? 'CHOP', sotd.signal_type ?? 'momentum')}
                </div>
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
              Threshold: ≥{mkt.sotd_threshold ?? 80}
            </div>
          </div>

          {/* Score Breakdown */}
          {bd && bd.total && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Score Breakdown — {sotd?.ticker}</div>
              <ScoreBreakdown breakdown={bd} />
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>TOTAL SCORE</span>
                <span style={{ fontSize: '1rem', fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--cyan)' }}>{bd.total ?? sotd?.confidence_score}</span>
              </div>
            </div>
          )}

          {/* Similar Setups */}
          {similar.length > 0 && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Similar Setups</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: 10 }}>Same signal pattern, different stock</div>
              {similar.map((c: any) => {
                const tags: string[] = c.tags ?? []
                return (
                  <div key={c.ticker} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)', width: 56, fontSize: '0.88rem' }}>{c.ticker}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{c.sector}</div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                        {tags.slice(0, 2).map((t: string) => <span key={t} className={`badge ${t.replace('_', '-')}`} style={{ fontSize: '0.58rem' }}>{t.replace('_', ' ')}</span>)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: c.score >= 65 ? 'var(--yellow)' : 'var(--text-dim)', fontSize: '0.88rem' }}>{c.score}</div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>score</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Sector heatmap */}
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
        <div style={{ marginTop: 12 }}>
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
      <div style={{ ...S.panel, marginTop: 12 }}>
        <div style={S.sectionHd}>
          Other Considered — {allC.filter((c: any) => c.passed_filter && c.ticker !== sotd?.ticker).length} candidates passed filters
        </div>
        <OtherConsideredTable candidates={allC} otherConsidered={data.other_considered ?? []} sotdTicker={sotd?.ticker ?? ''} />
      </div>
    </div>
  )
}
