import { useState, useEffect, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import { getStrategyComparison, runStrategyPicks, computeStrategyOutcomes, getMarketQuotes } from '../api'

interface LiveQuote { price: number | null; change_pct: number | null; ytd_pct: number | null }

// ── Types ─────────────────────────────────────────────────────────────────────

interface StrategyStats {
  total_picks: number; evaluated: number; wins: number; losses: number
  pending: number; no_fire_days: number; win_rate: number | null
  avg_alpha_14d: number | null; avg_return_14d: number | null
}
interface StrategyPick {
  id: number; strategy_name: string; pick_date: string; ticker: string | null
  company: string | null; sector: string | null; score: number | null
  regime: string | null
  metrics?: { rsi?: number; vol_ratio?: number; return_10d?: number; adx?: number }
  entry_price: number | null; price_14d: number | null; return_14d: number | null
  alpha_14d: number | null; outcome: string | null; no_pick: number; no_pick_reason: string | null
}
interface Strategy {
  color: string; description: string; short: string
  today_pick: StrategyPick | null; picks: StrategyPick[]; stats: StrategyStats
}
interface LeaderboardRow {
  name: string; color: string; rank: number; is_leader: boolean
  total_picks: number; evaluated: number; wins: number; losses: number
  win_rate: number | null; avg_alpha_14d: number | null; no_fire_days: number
}
interface Consensus { ticker: string; agreement: number; total: number; is_strong: boolean }
interface ComparisonData {
  strategies: Record<string, Strategy>; leaderboard: LeaderboardRow[]
  consensus: Consensus | null; timeline: StrategyPick[]
  target_picks: number; strategy_names: string[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STRATEGY_INSIGHT: Record<string, string> = {
  'SOTD Default':    'Highest composite score — most consistent coverage, rarely sits out',
  'High Conviction': 'Only enters on score ≥75 — ultra-selective, high signal quality',
  'Momentum':        'Follows unusual volume surges (≥1.3× avg) — tracks institutional flow',
  'Recovery':        'Targets RSI 35–55 bounces — early recovery from oversold conditions',
  'Composite':       'Best percentile rank: score + volume + 10d momentum combined',
}

// ── Formatters ────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, d = 1) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
}
function wr(v: number | null | undefined) {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

// ── Dynamic insights builder ──────────────────────────────────────────────────

function buildInsights(data: ComparisonData) {
  const { strategies, leaderboard, consensus } = data
  const insights: { icon: string; text: string; bold: boolean }[] = []
  const hasOutcomes = leaderboard.some(r => r.evaluated > 0)

  if (consensus?.is_strong) {
    insights.push({ icon: '⚡', bold: true,
      text: `${consensus.agreement}/5 strategies agree on ${consensus.ticker} today — strongest possible consensus signal` })
  } else if (consensus) {
    insights.push({ icon: '📊', bold: false,
      text: `${consensus.agreement}/5 strategies picked ${consensus.ticker} today — moderate agreement` })
  }

  const leader = leaderboard.find(r => r.rank === 1 && r.evaluated >= 3)
  if (leader) {
    const w = leader.win_rate ?? 0
    if (w >= 0.65)
      insights.push({ icon: '🏆', bold: true,
        text: `${leader.name} is clearly leading — ${Math.round(w*100)}% win rate over ${leader.evaluated} settled picks (${leader.wins}W / ${leader.losses}L)` })
    else if (w >= 0.50)
      insights.push({ icon: '📈', bold: false,
        text: `${leader.name} leads narrowly at ${Math.round(w*100)}% — too early to declare a winner, need more settled picks` })
  } else if (!hasOutcomes) {
    insights.push({ icon: '⏳', bold: false,
      text: 'All picks are pending settlement — outcomes appear at 14 trading days. Oldest pick settles ~May 28th.' })
  }

  const withAlpha = leaderboard.filter(r => r.avg_alpha_14d != null && r.evaluated >= 2)
  if (withAlpha.length > 0) {
    const best = [...withAlpha].sort((a, b) => (b.avg_alpha_14d ?? -99) - (a.avg_alpha_14d ?? -99))[0]
    if ((best.avg_alpha_14d ?? 0) > 0.5)
      insights.push({ icon: '💰', bold: false,
        text: `${best.name} generates the best average alpha — ${best.avg_alpha_14d?.toFixed(1)}% above SPY per pick` })
  }

  const hiConv = strategies['High Conviction']
  if (hiConv) {
    const total = hiConv.stats.total_picks + hiConv.stats.no_fire_days
    if (total >= 3) {
      const fr = Math.round((hiConv.stats.total_picks / total) * 100)
      insights.push({ icon: '🎯', bold: false,
        text: `High Conviction fires only ${fr}% of days — when it picks, it's a high-quality setup worth watching` })
    }
  }

  const mom = strategies['Momentum']
  if (mom && mom.stats.evaluated >= 2) {
    const fr = mom.stats.total_picks + mom.stats.no_fire_days > 0
      ? Math.round((mom.stats.total_picks / (mom.stats.total_picks + mom.stats.no_fire_days)) * 100) : null
    if (fr != null)
      insights.push({ icon: '📦', bold: false,
        text: `Momentum fires ${fr}% of days — requires unusual volume spike to trigger, so it's selective too` })
  }

  const totalPending = leaderboard.reduce((s, r) => s + (r.total_picks - r.wins - r.losses), 0)
  if (totalPending > 5)
    insights.push({ icon: '🔄', bold: false,
      text: `${totalPending} picks are still settling — standings will shift significantly over the next 2 weeks` })

  return insights
}

// ── Why-bullet generator ──────────────────────────────────────────────────────

function getWhyBullets(name: string, pick: StrategyPick): string[] {
  const m = pick.metrics ?? {}
  const bullets: string[] = []

  switch (name) {
    case 'SOTD Default':
      bullets.push(`Ranked #1 by composite score in today's filtered universe`)
      if (pick.score != null) bullets.push(`Score ${pick.score}/100 — ${pick.score >= 75 ? 'high conviction setup' : pick.score >= 65 ? 'solid setup' : 'passed filters'}`)
      if (m.vol_ratio != null) bullets.push(`Volume ${m.vol_ratio.toFixed(1)}× average — ${m.vol_ratio >= 1.5 ? 'strong institutional interest' : m.vol_ratio >= 1.3 ? 'above-average volume' : 'normal volume'}`)
      if (m.rsi != null) bullets.push(`RSI ${m.rsi.toFixed(0)} — ${m.rsi > 65 ? 'strong trend momentum' : m.rsi < 40 ? 'oversold bounce candidate' : 'balanced momentum'}`)
      break
    case 'High Conviction':
      if (pick.score != null && pick.score >= 75) {
        bullets.push(`Score ${pick.score} clears the ≥75 threshold — true high conviction setup`)
      } else {
        bullets.push(`No candidate scored ≥75 today — this is the best available at score ${pick.score ?? '?'}`)
        bullets.push(`Treat as a regular pick, not a high-conviction signal`)
      }
      if (m.vol_ratio != null) bullets.push(`Vol ${m.vol_ratio.toFixed(1)}× — ${m.vol_ratio >= 1.3 ? 'institutional interest present' : 'normal volume'}`)
      if (m.rsi != null) bullets.push(`RSI ${m.rsi.toFixed(0)} — ${m.rsi < 60 ? 'room to run, not overbought' : 'strong momentum'}`)
      break
    case 'Momentum':
      if (m.vol_ratio != null)
        bullets.push(`Volume ${m.vol_ratio.toFixed(1)}× average — ${m.vol_ratio >= 1.3 ? 'above ≥1.3× institutional threshold' : 'fallback: highest volume available today'}`)
      bullets.push(`Highest volume surge in today's filtered universe`)
      if (m.rsi != null) bullets.push(`RSI ${m.rsi.toFixed(0)} — ${m.rsi < 60 ? 'still has upside, not extended' : 'momentum running hot'}`)
      if (m.return_10d != null) bullets.push(`10d trend: ${m.return_10d >= 0 ? '+' : ''}${m.return_10d.toFixed(1)}% — ${m.return_10d > 3 ? 'strong recent trend' : 'early move'}`)
      break
    case 'Recovery':
      if (m.rsi != null) bullets.push(`RSI ${m.rsi.toFixed(0)} is inside the 35–55 bounce zone — classic early recovery signal`)
      bullets.push(`Strategy targets stocks cooling from oversold — lower-risk entry point`)
      if (pick.score != null) bullets.push(`Score ${pick.score} is the highest among all RSI 35–55 candidates today`)
      if (m.vol_ratio != null) bullets.push(`Vol ${m.vol_ratio.toFixed(1)}× — ${m.vol_ratio >= 1.2 ? 'buyers stepping in' : 'stabilising volume'}`)
      break
    case 'Composite':
      bullets.push(`Best average percentile rank across 3 independent metrics: score, volume, 10d momentum`)
      if (pick.score != null) bullets.push(`Score: ${pick.score} — quality component`)
      if (m.vol_ratio != null) bullets.push(`Vol ${m.vol_ratio.toFixed(1)}× — momentum component`)
      if (m.return_10d != null) bullets.push(`10d return: ${m.return_10d >= 0 ? '+' : ''}${m.return_10d.toFixed(1)}% — trend component`)
      break
  }
  return bullets
}

// ── Strategy Scorecard ────────────────────────────────────────────────────────

function StrategyCard({ name, strategy, rank, isLeader, quote }: {
  name: string; strategy: Strategy; rank: number; isLeader: boolean; quote?: LiveQuote
}) {
  const { stats, picks, today_pick, color, short } = strategy
  const evaluated = picks.filter(p => p.outcome != null && p.alpha_14d != null)
  const topPicks  = [...evaluated].sort((a, b) => (b.alpha_14d ?? 0) - (a.alpha_14d ?? 0)).slice(0, 3)
  const worstPick = [...evaluated].sort((a, b) => (a.alpha_14d ?? 0) - (b.alpha_14d ?? 0))[0]
  const hasPick   = today_pick && !today_pick.no_pick && today_pick.ticker
  const total     = stats.total_picks + stats.no_fire_days
  const fireRate  = total > 0 ? Math.round((stats.total_picks / total) * 100) : null

  return (
    <div style={{
      background: 'var(--panel)',
      border: `1px solid ${isLeader ? color + '55' : 'var(--border)'}`,
      borderLeft: `4px solid ${color}`,
      borderRadius: 8,
      padding: '14px 16px',
      boxShadow: isLeader ? `0 0 0 1px ${color}20, 0 4px 20px ${color}18` : undefined,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontSize: '0.88rem', fontWeight: 800, color: 'var(--text-bright)' }}>{name}</span>
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', lineHeight: 1.4 }}>
            {STRATEGY_INSIGHT[name]}
          </div>
        </div>
        <div style={{
          fontSize: '0.65rem', fontWeight: 800, fontFamily: 'var(--mono)',
          color: isLeader ? '#fff' : 'var(--text-dim)',
          background: isLeader ? color : 'var(--panel-inset)',
          border: `1px solid ${isLeader ? color : 'var(--border)'}`,
          borderRadius: 4, padding: '3px 9px', flexShrink: 0, marginLeft: 8,
          whiteSpace: 'nowrap',
        }}>
          {isLeader ? '👑 LEADING' : `#${rank}`}
        </div>
      </div>

      {/* Record row */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', paddingTop: 8, borderTop: '1px solid var(--border)', marginBottom: 10 }}>
        {stats.evaluated > 0 ? (
          <>
            <div>
              <span style={{
                fontSize: '1.35rem', fontWeight: 900, fontFamily: 'var(--mono)',
                color: (stats.win_rate ?? 0) >= 0.6 ? 'var(--green)' : (stats.win_rate ?? 0) >= 0.4 ? 'var(--yellow)' : 'var(--red)',
              }}>{wr(stats.win_rate)}</span>
              <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginLeft: 6, fontFamily: 'var(--mono)' }}>
                {stats.wins}W / {stats.losses}L
              </span>
            </div>
            {stats.avg_alpha_14d != null && (
              <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 12 }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>AVG α vs SPY</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: 'var(--mono)', color: (stats.avg_alpha_14d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {pct(stats.avg_alpha_14d)}
                </div>
              </div>
            )}
            {fireRate != null && (
              <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 12 }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>FIRES</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{fireRate}%</div>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
            {stats.pending > 0
              ? `${stats.pending} pick${stats.pending > 1 ? 's' : ''} pending${fireRate != null ? ` · fires ${fireRate}% of days` : ''}`
              : fireRate != null ? `Fires ${fireRate}% of days` : 'No picks recorded yet'}
          </div>
        )}
      </div>

      {/* Pick examples */}
      {topPicks.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 5 }}>
            TOP PICKS  ·  entry → exit  ·  alpha vs SPY
          </div>
          {topPicks.map((p, i) => (
            <div key={p.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '5px 0',
              borderBottom: i < topPicks.length - 1 ? '1px dashed var(--border)' : undefined,
            }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 900, fontSize: '0.82rem', color: 'var(--text-bright)', minWidth: 44 }}>{p.ticker}</span>
                <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                  {p.company}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
                {p.entry_price != null && (
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    ${p.entry_price.toFixed(0)}
                    {p.price_14d != null && ` → $${p.price_14d.toFixed(0)}`}
                  </span>
                )}
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: '0.72rem', fontWeight: 700,
                  color: (p.alpha_14d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
                }}>{pct(p.alpha_14d)} α</span>
                <span style={{
                  fontSize: '0.55rem', fontWeight: 700, fontFamily: 'var(--mono)',
                  color: p.outcome === 'win' ? 'var(--green)' : 'var(--red)',
                  border: `1px solid ${p.outcome === 'win' ? 'var(--green)' : 'var(--red)'}44`,
                  borderRadius: 3, padding: '0 4px',
                }}>{(p.outcome ?? '').toUpperCase()}</span>
              </div>
            </div>
          ))}
          {worstPick && worstPick.alpha_14d != null && (worstPick.alpha_14d ?? 0) < -1 && !topPicks.find(p => p.id === worstPick.id) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 5, opacity: 0.65 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--text-dim)', minWidth: 44 }}>{worstPick.ticker}</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>worst</span>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--red)' }}>{pct(worstPick.alpha_14d)} α</span>
            </div>
          )}
        </div>
      )}

      {topPicks.length === 0 && stats.pending > 0 && (
        <div style={{ marginBottom: 10, padding: '6px 10px', background: 'var(--panel-inset)', borderRadius: 5, fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          {stats.pending} picks settling over the next 2 weeks — check back then
        </div>
      )}

      {/* Today */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 6 }}>TODAY'S PICK</div>
        {hasPick ? (
          <>
            {/* Ticker + company + live price row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 900, fontSize: '1rem', color }}>{today_pick!.ticker}</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginLeft: 8 }}>{today_pick!.company?.slice(0, 22)}</span>
              </div>
              {/* Live price + YTD */}
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                {quote?.price != null
                  ? <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: '0.9rem', color: 'var(--text-bright)' }}>${quote.price.toFixed(2)}</div>
                  : <div style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>—</div>
                }
                {quote?.ytd_pct != null && (
                  <div style={{ fontSize: '0.62rem', fontFamily: 'var(--mono)', fontWeight: 700, color: quote.ytd_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    YTD {quote.ytd_pct >= 0 ? '+' : ''}{quote.ytd_pct.toFixed(1)}%
                  </div>
                )}
                {quote?.change_pct != null && (
                  <div style={{ fontSize: '0.58rem', fontFamily: 'var(--mono)', color: quote.change_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {quote.change_pct >= 0 ? '+' : ''}{quote.change_pct.toFixed(2)}% today
                  </div>
                )}
              </div>
            </div>

            {/* Signal tags */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {today_pick!.score != null && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', fontWeight: 700, color: (today_pick!.score >= 75 ? 'var(--green)' : 'var(--yellow)'), background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>
                  {today_pick!.score}pts
                </span>
              )}
              {today_pick!.metrics?.rsi != null && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', color: 'var(--text-dim)', background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>
                  RSI {today_pick!.metrics.rsi.toFixed(0)}
                </span>
              )}
              {today_pick!.metrics?.vol_ratio != null && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', color: today_pick!.metrics.vol_ratio >= 1.3 ? 'var(--cyan)' : 'var(--text-dim)', background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>
                  {today_pick!.metrics.vol_ratio.toFixed(1)}x vol
                </span>
              )}
              {today_pick!.regime && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', color: 'var(--text-dim)', background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>
                  {today_pick!.regime}
                </span>
              )}
            </div>

            {/* Why bullets */}
            <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 7 }}>
              <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 5 }}>WHY THIS PICK</div>
              <ul style={{ margin: 0, padding: '0 0 0 14px', listStyle: 'disc' }}>
                {getWhyBullets(name, today_pick!).map((b, i) => (
                  <li key={i} style={{ fontSize: '0.68rem', color: 'var(--text)', lineHeight: 1.6, marginBottom: 1 }}>{b}</li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
            {today_pick?.no_pick_reason ?? 'No pick today'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function BestBetTab() {
  const [data,       setData]       = useState<ComparisonData | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [running,    setRunning]    = useState(false)
  const [computing,  setComputing]  = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [activeTab,  setActiveTab]  = useState<'overview' | 'history'>('overview')
  const [histFilter, setHistFilter] = useState<string | null>(null)
  const [quotes,     setQuotes]     = useState<Record<string, LiveQuote>>({})

  const load = () => {
    setLoading(true)
    getStrategyComparison()
      .then(r => {
        setData(r.data)
        setError(null)
        // Fetch live quotes for all today's picks
        const tickers = Object.values(r.data.strategies as Record<string, Strategy>)
          .map(s => s.today_pick?.ticker)
          .filter((t): t is string => !!t && !t.includes('^'))
        if (tickers.length > 0) {
          getMarketQuotes([...new Set(tickers)].join(','))
            .then(qr => setQuotes(qr.data.quotes ?? {}))
            .catch(() => {})
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  // Cumulative alpha line chart data
  const alphaData = useMemo(() => {
    if (!data) return []
    const evaluated = data.timeline.filter(p => p.outcome != null && p.alpha_14d != null)
      .sort((a, b) => a.pick_date.localeCompare(b.pick_date))
    const dateSet = [...new Set(evaluated.map(p => p.pick_date.slice(0, 10)))].sort()
    const cumulative: Record<string, number> = {}
    data.strategy_names.forEach(n => { cumulative[n] = 0 })

    return dateSet.map(date => {
      const row: any = { date }
      evaluated.filter(p => p.pick_date.slice(0, 10) === date)
        .forEach(p => { cumulative[p.strategy_name] = (cumulative[p.strategy_name] || 0) + (p.alpha_14d ?? 0) })
      data.strategy_names.forEach(name => {
        row[data.strategies[name].short] = parseFloat((cumulative[name] || 0).toFixed(2))
      })
      return row
    })
  }, [data])

  // ── States ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
      Loading strategy race…
    </div>
  )
  if (error) return (
    <div style={{ padding: '40px', textAlign: 'center', background: 'var(--panel-inset)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{ color: 'var(--red)', fontSize: '0.82rem', marginBottom: 12 }}>{error}</div>
      <button className="btn sm primary" onClick={load}>↻ Retry</button>
    </div>
  )
  if (!data) return null

  const { strategies, leaderboard, consensus, timeline, target_picks, strategy_names } = data
  const leader     = leaderboard.find(r => r.rank === 1 && r.evaluated >= 3)
  const hasOutcomes = leaderboard.some(r => r.evaluated > 0)
  const insights   = buildInsights(data)

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-bright)' }}>Best Bet — Strategy Race</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>
            5 strategies compete on the same daily candidates · outcomes settle at 14 trading days
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={() => { setComputing(true); computeStrategyOutcomes().then(load).finally(() => setComputing(false)) }} disabled={computing}>
            {computing ? '…' : '↻'} Update Outcomes
          </button>
          <button className="btn sm" onClick={() => { setRunning(true); runStrategyPicks(false).then(load).finally(() => setRunning(false)) }} disabled={running}>
            {running ? '…' : '▶'} Run Today
          </button>
          <button className="btn sm primary" onClick={() => { setRunning(true); runStrategyPicks(true).then(load).finally(() => setRunning(false)) }} disabled={running}>
            {running ? '…' : '⚡'} Backfill All
          </button>
        </div>
      </div>

      {/* ── Tab switcher ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
        {(['overview', 'history'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding: '7px 18px', background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: `2px solid ${activeTab === t ? 'var(--cyan)' : 'transparent'}`,
            color: activeTab === t ? 'var(--cyan)' : 'var(--text-dim)',
            fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', fontFamily: 'var(--mono)', marginBottom: -1,
          }}>
            {t === 'overview' ? 'Overview' : `Pick History (${timeline.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          {/* ── Dynamic insights ── */}
          {insights.length > 0 && (
            <div style={{ marginBottom: 14, background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontWeight: 800, letterSpacing: '0.12em', marginBottom: 10 }}>
                LIVE INTELLIGENCE
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '0.88rem', flexShrink: 0, lineHeight: 1.3 }}>{ins.icon}</span>
                    <span style={{
                      fontSize: '0.76rem', lineHeight: 1.5,
                      color: ins.bold ? 'var(--text-bright)' : 'var(--text)',
                      fontWeight: ins.bold ? 700 : 400,
                    }}>{ins.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Consensus banner ── */}
          {consensus?.is_strong && (
            <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 7, background: 'var(--info-bg)', border: '1px solid var(--info-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--cyan)', fontWeight: 700 }}>⚡ Strong consensus today: </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text)' }}>
                  <strong style={{ fontFamily: 'var(--mono)', fontSize: '0.9rem', color: 'var(--text-bright)' }}>{consensus.ticker}</strong>
                  {' '}chosen by {consensus.agreement} of {consensus.total} strategies
                </span>
              </div>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontWeight: 700, background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px' }}>
                BEST BET TODAY
              </span>
            </div>
          )}

          {/* ── Strategy Scorecards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            {strategy_names.map(name => {
              const row    = leaderboard.find(r => r.name === name)!
              const ticker = strategies[name].today_pick?.ticker ?? ''
              return (
                <StrategyCard
                  key={name}
                  name={name}
                  strategy={strategies[name]}
                  rank={row.rank}
                  isLeader={row.is_leader}
                  quote={quotes[ticker] as LiveQuote | undefined}
                />
              )
            })}
          </div>

          {/* ── Race Results / Pending ── */}
          {hasOutcomes ? (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-title" style={{ marginBottom: 4 }}>Cumulative Alpha Race</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: 14 }}>
                Running total of alpha vs SPY per strategy — a rising line means consistently beating the market
              </div>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={alphaData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${v}%`} tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={40} />
                  <ReferenceLine y={0} stroke="#e5e7eb" strokeDasharray="4 4" />
                  <Tooltip
                    formatter={(v: any, name: any) => [`${v >= 0 ? '+' : ''}${v}%`, name]}
                    labelFormatter={l => `Date: ${l}`}
                    contentStyle={{ fontSize: '0.72rem', fontFamily: 'monospace', border: '1px solid var(--border)', borderRadius: 6 }}
                  />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'var(--text-dim)' }} />
                  {strategy_names.map(name => (
                    <Line key={name} dataKey={strategies[name].short} stroke={strategies[name].color}
                      strokeWidth={2.5} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ padding: '18px 20px', background: 'var(--panel-inset)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 14 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-bright)', marginBottom: 6 }}>
                ⏳ Race chart appears once picks settle
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 12 }}>
                Outcomes settle when picks are 14 trading days old. Oldest pick is from May 8th — first results around <strong>May 28th</strong>.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {leaderboard.map(r => (
                  <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 10px' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.color }} />
                    <span style={{ fontSize: '0.68rem', fontFamily: 'var(--mono)', color: 'var(--text-bright)', fontWeight: 700 }}>{strategies[r.name].short}</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{r.total_picks}p</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Compact standings ── */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 10 }}>Standings</div>
            <table>
              <thead>
                <tr>
                  {['', 'Strategy', 'Win Rate', 'Avg α', 'W–L', 'Pending', 'Sat Out', 'Progress to 30'].map(h => <th key={h}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {leaderboard.map(row => {
                  const color  = strategies[row.name]?.color ?? '#9ca3af'
                  const pct14  = Math.min(100, Math.round((row.evaluated / target_picks) * 100))
                  return (
                    <tr key={row.name} style={{ background: row.is_leader ? color + '08' : undefined }}>
                      <td style={{ color, fontWeight: 800, fontFamily: 'var(--mono)', width: 28 }}>
                        {row.rank === 1 && row.evaluated >= 3 ? '👑' : `#${row.rank}`}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                          <span style={{ fontWeight: row.is_leader ? 800 : 600, color: row.is_leader ? color : 'var(--text-bright)', fontSize: '0.82rem' }}>{row.name}</span>
                        </div>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: row.win_rate == null ? 'var(--text-dim)' : row.win_rate >= 0.5 ? 'var(--green)' : 'var(--red)' }}>
                        {wr(row.win_rate)}{row.evaluated > 0 && <span style={{ fontWeight: 400, fontSize: '0.62rem', color: 'var(--text-dim)', marginLeft: 4 }}>({row.evaluated})</span>}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', color: (row.avg_alpha_14d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{pct(row.avg_alpha_14d)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                        <span style={{ color: 'var(--green)' }}>{row.wins}</span>–<span style={{ color: 'var(--red)' }}>{row.losses}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{row.total_picks - row.wins - row.losses}</td>
                      <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.72rem' }}>{row.no_fire_days}d</td>
                      <td style={{ minWidth: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, height: 5, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${pct14}%`, height: '100%', background: color, borderRadius: 2 }} />
                          </div>
                          <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', minWidth: 32 }}>{row.evaluated}/{target_picks}</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
              Wilson score lower bound · standings become reliable at {target_picks} evaluated picks per strategy
            </div>
          </div>
        </>
      )}

      {/* ── History tab ── */}
      {activeTab === 'history' && (
        <div className="card">
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            <button onClick={() => setHistFilter(null)} style={{ padding: '3px 12px', fontSize: '0.65rem', fontFamily: 'var(--mono)', fontWeight: 700, borderRadius: 20, cursor: 'pointer', background: histFilter == null ? '#1e293b' : 'var(--panel-inset)', color: histFilter == null ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>All</button>
            {strategy_names.map(name => {
              const color = strategies[name].color
              return (
                <button key={name} onClick={() => setHistFilter(histFilter === name ? null : name)} style={{ padding: '3px 12px', fontSize: '0.65rem', fontFamily: 'var(--mono)', fontWeight: 700, borderRadius: 20, cursor: 'pointer', background: histFilter === name ? color : 'var(--panel-inset)', color: histFilter === name ? '#fff' : color, border: `1px solid ${color}44` }}>
                  {strategies[name].short}
                </button>
              )
            })}
          </div>

          <table>
            <thead>
              <tr>{['Date', 'Strategy', 'Ticker', 'Company', 'Score', 'RSI', 'Vol', 'Entry', '14d Exit', 'Alpha', 'Outcome'].map(h => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {timeline.filter(p => !histFilter || p.strategy_name === histFilter).map(p => {
                const color = strategies[p.strategy_name]?.color ?? '#9ca3af'
                const outcomeColor = p.outcome === 'win' ? 'var(--green)' : p.outcome === 'loss' ? 'var(--red)' : 'var(--text-dim)'
                return (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.75rem' }}>{p.pick_date.slice(0, 10)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                        <span style={{ fontSize: '0.68rem', color, fontFamily: 'var(--mono)', fontWeight: 700 }}>{strategies[p.strategy_name]?.short}</span>
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--text-bright)' }}>{p.ticker ?? '—'}</td>
                    <td style={{ fontSize: '0.72rem', color: 'var(--text-dim)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.company}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: (p.score ?? 0) >= 75 ? 'var(--green)' : (p.score ?? 0) >= 65 ? 'var(--yellow)' : 'var(--text-dim)' }}>{p.score ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{p.metrics?.rsi?.toFixed(0) ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', color: (p.metrics?.vol_ratio ?? 0) >= 1.3 ? 'var(--cyan)' : 'var(--text-dim)' }}>{p.metrics?.vol_ratio?.toFixed(1) ?? '—'}x</td>
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.72rem' }}>{p.entry_price != null ? `$${p.entry_price.toFixed(2)}` : '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.72rem' }}>{p.price_14d != null ? `$${p.price_14d.toFixed(2)}` : '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: (p.alpha_14d ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{pct(p.alpha_14d)}</td>
                    <td>
                      <span style={{ fontSize: '0.62rem', fontWeight: 700, fontFamily: 'var(--mono)', color: outcomeColor, background: outcomeColor + '18', border: `1px solid ${outcomeColor}44`, borderRadius: 4, padding: '1px 6px' }}>
                        {(p.outcome ?? 'pending').toUpperCase()}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', textAlign: 'right' }}>
        All strategies use the same daily candidate pool · no look-ahead bias · win = alpha &gt; +2% at 14 trading days
      </div>
    </div>
  )
}
