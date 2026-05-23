import { useState, useEffect, useRef, ReactNode } from 'react'
import {
  getStrategies, getStrategyRuns, getStrategyRun,
  getStrategyResults, startStrategyRun, cancelStrategyRun, promoteStrategy,
} from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StrategyConfig {
  id: number
  name: string
  description: string
  buy_threshold: number
  stop_loss_pct: number
  profit_target_pct: number
  min_hold_days: number
  max_hold_days: number
  max_positions: number
  allocation_pct: number
  regime_filter: string
}

interface StrategyRun {
  run_id: string
  job_type: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  progress: number
  current_step: string | null
  created_at: string
  completed_at: string | null
  error: string | null
}

interface StrategyMetrics {
  total_return_pct: number
  cagr_pct: number
  volatility_pct: number
  sharpe: number
  max_drawdown_pct: number
  win_rate_pct: number
  profit_factor: number
  avg_trade_return_pct: number
  trade_frequency: number
  total_trades: number
  initial_capital: number
  final_value: number
}

interface Trade {
  action: 'BUY' | 'SELL'
  ticker: string
  date: string
  price: number
  quantity: number
  return_pct?: number
  days_held?: number
  exit_reason?: string
  entry_price?: number
  entry_regime?: string
  exit_regime?: string
  score?: number
}

interface StrategyResult {
  id: number
  run_id: string
  strategy_name: string
  params_json: any
  metrics_json: StrategyMetrics
  regime_breakdown_json: any
  trades_json: Trade[] | null
  composite_score: number
  rank: number
}

// ── Help Modal ────────────────────────────────────────────────────────────────

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: '#13182a', border: '1px solid #2a3050',
        borderRadius: 4, maxWidth: 680, width: '90%', maxHeight: '85vh',
        overflowY: 'auto', padding: 28,
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: '1rem', fontWeight: 700, color: '#00d084' }}>STRATEGY LAB — GUIDE</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        <Section title="What is Strategy Lab?">
          Strategy Lab lets you test trading strategies against real historical market data (2–3 years of actual prices) or
          synthetic data (mathematically generated scenarios) — before using them with real money.
          Instead of trusting gut feeling, you get hard numbers: returns, risk, win rate, and how each strategy behaves
          in bull markets, bear markets, and choppy sideways conditions.
        </Section>

        <Section title="Step 1 — Pick your strategies">
          Select one or more strategies from the list. Each has a different trading philosophy:
          <ul style={{ margin: '8px 0 0 16px', lineHeight: 1.8 }}>
            <li><b>Default</b> — Balanced: buy when score ≥ 80, stop -8%, target +15%</li>
            <li><b>High Conviction</b> — Fewer trades, only the strongest setups (score ≥ 85)</li>
            <li><b>Trend Follower</b> — Enter earlier (score ≥ 70), hold longer (up to 120 days)</li>
            <li><b>Conservative</b> — Tight stops (-5%), quick profits (+10%), BULL markets only</li>
            <li><b>Aggressive Growth</b> — Wide stops (-12%), high targets (+25%), more active</li>
            <li><b>Regime Selective</b> — Same as Default but sits in cash during BEAR / CHOP</li>
            <li><b>Moon Shot</b> — Targets +50% gains with wide stops. High risk, high reward.</li>
          </ul>
        </Section>

        <Section title="Step 2 — Configure the run">
          <ul style={{ margin: '8px 0 0 16px', lineHeight: 1.8 }}>
            <li><b>Time Range</b>: How far back to test (1Y, 2Y, or 3Y of real market data)</li>
            <li><b>Sweep Parameters</b>: When ON, automatically tests ±5 variations of each strategy's buy threshold, stop loss, and profit target — 27 combinations per strategy. Slower but finds optimal settings.</li>
            <li><b>Data Source</b>: Historical = real yfinance prices. Simulated = mathematically generated scenarios for stress testing.</li>
          </ul>
        </Section>

        <Section title="Step 3 — Run and wait">
          Click <b>Run Strategy Test</b>. The job runs in the background — you can navigate away.
          Come back and check Active Jobs for progress. A 1-year backtest of all 7 strategies takes ~2–4 minutes.
          With parameter sweep enabled, expect 5–10 minutes.
        </Section>

        <Section title="Step 4 — Read the results">
          Results are ranked by <b>Composite Score</b> — a weighted blend of 5 metrics:
          <ul style={{ margin: '8px 0 0 16px', lineHeight: 1.8 }}>
            <li><b>Sharpe Ratio (30%)</b> — Return per unit of risk. Higher = better. Above 1.0 is good, above 2.0 is excellent.</li>
            <li><b>Total Return (20%)</b> — Raw profit/loss over the test period.</li>
            <li><b>Max Drawdown (20%)</b> — Largest peak-to-trough decline. Lower = better. A strategy that drops -40% before recovering is riskier than one that drops -10%.</li>
            <li><b>Profit Factor (15%)</b> — Total gains ÷ total losses. Above 1.5 = solid. Below 1.0 = losing strategy.</li>
            <li><b>Win Rate (15%)</b> — % of trades that closed profitably.</li>
          </ul>
          <div style={{ marginTop: 8, padding: 8, background: '#1a2030', borderRadius: 3, fontSize: '0.75rem', color: '#8892a4' }}>
            Do not pick the strategy with the highest return alone — a strategy that made 40% but had a -35% drawdown is dangerous.
            The composite score penalizes high-risk strategies even if their returns look attractive.
          </div>
        </Section>

        <Section title="Step 5 — Promote the winner to live">
          When you find a strategy you trust, click <b>Promote to Live</b> on that row.
          This updates your live AI Portfolio tab to use those exact parameters for all future buy/sell decisions.
          Existing open positions are not affected immediately — they'll be evaluated against the new rules at 4:15 PM.
        </Section>

        <Section title="Regime breakdown — the real insight">
          Expand any result row to see <b>Regime Breakdown</b>: how that strategy performed specifically during
          BULL markets, BEAR markets, and CHOP (sideways) periods.
          This answers the real question: "does this strategy actually work when conditions are bad?"
          A strategy with great overall returns but -20% in bear conditions is fragile.
        </Section>

        <Section title="Frequently asked questions">
          <div style={{ lineHeight: 1.8 }}>
            <b>Q: Why is my run showing 0 trades?</b><br />
            The buy threshold may be too high for the time period selected. Try lowering the threshold or enabling sweep params.<br /><br />
            <b>Q: The backtest shows +30% — will I really get that live?</b><br />
            Backtests are optimistic — they assume perfect execution at closing prices.
            Live results will differ due to gaps, slippage, and the fact that you're trading real money.
            Use backtests to compare strategies relative to each other, not as profit forecasts.<br /><br />
            <b>Q: How is the universe selected?</b><br />
            The backtest runs on a fixed list of ~80 US stocks across all 11 sectors (tech, healthcare, financials, etc.).
            This avoids survivorship bias from dynamic screeners.<br /><br />
            <b>Q: What does "parameter sweep" actually do?</b><br />
            For each strategy, it runs 27 variants: buy threshold ± 5, stop loss ± 2%, profit target ± 5%.
            Then ranks all variants together. This finds the sweet spot within each strategy's philosophy.
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: '#00d084', fontSize: '0.72rem', fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: '0.82rem', color: '#c8cdd8', lineHeight: 1.75 }}>{children}</div>
    </div>
  )
}

// ── Sweep info modal ──────────────────────────────────────────────────────────

function SweepInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
      onClick={onClose}>
      <div style={{ background: '#1a1f2e', border: '1px solid #3a4060', borderRadius: 6,
        maxWidth: 520, width: '90%', padding: 24 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#00ff88' }}>What is Parameter Sweep?</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        <p style={{ fontSize: '0.83rem', color: '#c8cdd8', lineHeight: 1.7, marginBottom: 14 }}>
          Each strategy has a fixed <b style={{ color: '#fff' }}>buy threshold</b>, <b style={{ color: '#fff' }}>stop loss</b>,
          and <b style={{ color: '#fff' }}>profit target</b>. The sweep automatically tests small variations around
          those numbers to find the optimal setting for that strategy.
        </p>

        <div style={{ background: '#11151f', border: '1px solid #2a3050', borderRadius: 4, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: '0.72rem', color: '#00ff88', letterSpacing: '0.06em', marginBottom: 10 }}>EXAMPLE — High Conviction (buy≥85, stop -8%, target +20%)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: '0.73rem', color: '#8892a4', fontFamily: 'monospace' }}>
            <span style={{ color: '#fff' }}>Buy threshold</span>
            <span style={{ color: '#fff' }}>Stop loss</span>
            <span style={{ color: '#fff' }}>Target</span>
            {[80, 85, 90].map(b =>
              [-10, -8, -6].map(s =>
                [15, 20, 25].map(t => (
                  <>{b} {s}% +{t}%</>
                ))
              )
            ).flat().slice(0, 9).map((v, i) => (
              <span key={i} style={{ color: i === 4 ? '#00ff88' : '#8892a4' }}>
                {[80,85,90][Math.floor(i/3)]} / {[-10,-8,-6][i%3]}% / +{[15,20,25][i%3]}%
              </span>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: '0.72rem', color: '#8892a4' }}>
            … and so on — <b style={{ color: '#fff' }}>27 combinations</b> per strategy.
            Each is run as a full backtest. The best variant per strategy rises to the top of the results table.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: '0.78rem' }}>
          <div style={{ background: '#11151f', borderRadius: 4, padding: 10 }}>
            <div style={{ color: '#00ff88', marginBottom: 4, fontWeight: 600 }}>✓ Sweep ON</div>
            <div style={{ color: '#c8cdd8' }}>Finds optimal params. Good for final decision before going live. Takes 5–10 min.</div>
          </div>
          <div style={{ background: '#11151f', borderRadius: 4, padding: 10 }}>
            <div style={{ color: '#e8a838', marginBottom: 4, fontWeight: 600 }}>✗ Sweep OFF</div>
            <div style={{ color: '#c8cdd8' }}>Runs base params only. Good for quick comparison across strategies. Takes 2–4 min.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Metric badge ──────────────────────────────────────────────────────────────

function MetBadge({ label, value, good }: { label: string; value: string; good: boolean | null }) {
  const color = good === null ? '#c8cdd8' : good ? '#00d084' : '#ff4757'
  return (
    <div style={{ textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: '0.65rem', color: '#8892a4', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '0.8rem', fontFamily: 'var(--mono)', color, fontWeight: 600 }}>{value}</div>
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 4, background: '#2a3050', borderRadius: 2, overflow: 'hidden', width: 120 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: '#00d084', transition: 'width 0.4s' }} />
    </div>
  )
}

// ── Regime breakdown row ──────────────────────────────────────────────────────

function RegimeBreakdown({ data }: { data: any }) {
  if (!data || Object.keys(data).length === 0) return null
  return (
    <div style={{ padding: '8px 12px', background: '#1a2030', borderTop: '1px solid #2a3050' }}>
      <div style={{ fontSize: '0.65rem', color: '#8892a4', marginBottom: 6, letterSpacing: '0.06em' }}>REGIME BREAKDOWN</div>
      <div style={{ display: 'flex', gap: 24 }}>
        {(['BULL', 'BEAR', 'CHOP'] as const).map(r => {
          const d = data[r]
          if (!d) return null
          const col = r === 'BULL' ? '#00d084' : r === 'BEAR' ? '#ff4757' : '#a0a8be'
          return (
            <div key={r}>
              <span style={{ color: col, fontSize: '0.7rem', fontWeight: 700 }}>{r}</span>
              <div style={{ fontSize: '0.72rem', color: '#c8cdd8', marginTop: 2 }}>
                {d.trades} trades · win {d.win_rate_pct?.toFixed(0)}% · avg {d.avg_return_pct >= 0 ? '+' : ''}{d.avg_return_pct?.toFixed(1)}%
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Trade log panel ──────────────────────────────────────────────────────────

function TradeLog({ trades }: { trades: Trade[] }) {
  if (!trades || trades.length === 0) {
    return (
      <div style={{ padding: '10px 12px', background: '#11151f', fontSize: '0.78rem', color: '#8892a4' }}>
        No trades recorded for this strategy in the tested period.
      </div>
    )
  }
  const sells = trades.filter(t => t.action === 'SELL')
  const buys  = trades.filter(t => t.action === 'BUY')
  const wins  = sells.filter(t => (t.return_pct ?? 0) > 0).length
  return (
    <div style={{ background: '#11151f', borderTop: '1px solid #2a3050' }}>
      <div style={{ padding: '8px 12px', display: 'flex', gap: 20, borderBottom: '1px solid #1a2030', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.68rem', color: '#8892a4', fontFamily: 'var(--mono)' }}>
          {buys.length} <span style={{ color: '#00d084' }}>BUYS</span>
          {'  '}·{'  '}
          {sells.length} <span style={{ color: '#c8cdd8' }}>SELLS</span>
          {'  '}·{'  '}
          {wins}/{sells.length} <span style={{ color: wins/sells.length >= 0.55 ? '#00d084' : '#e8a838' }}>WINNERS</span>
        </span>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.73rem' }}>
          <thead>
            <tr style={{ background: '#0d1117', position: 'sticky', top: 0 }}>
              {['DATE', 'TICKER', 'ACTION', 'PRICE', 'RETURN', 'DAYS', 'REGIME', 'EXIT REASON'].map(h => (
                <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: '#8892a4',
                  fontFamily: 'var(--mono)', fontSize: '0.62rem', letterSpacing: '0.07em',
                  borderBottom: '1px solid #2a3050', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const isBuy  = t.action === 'BUY'
              const retCol = t.return_pct == null ? '#8892a4'
                : t.return_pct > 0 ? '#00d084' : '#ff4757'
              return (
                <tr key={i} style={{ borderBottom: '1px solid #1a2030',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                  <td style={{ padding: '5px 10px', color: '#8892a4', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
                    {t.date}
                  </td>
                  <td style={{ padding: '5px 10px', color: '#ffffff', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                    {t.ticker}
                  </td>
                  <td style={{ padding: '5px 10px', fontFamily: 'var(--mono)', fontWeight: 700,
                    color: isBuy ? '#00d084' : '#94a3b8' }}>
                    {t.action}
                  </td>
                  <td style={{ padding: '5px 10px', color: '#c8cdd8', fontFamily: 'var(--mono)' }}>
                    ${t.price?.toFixed(2) ?? '—'}
                  </td>
                  <td style={{ padding: '5px 10px', fontFamily: 'var(--mono)', fontWeight: 600, color: retCol }}>
                    {t.return_pct != null ? `${t.return_pct >= 0 ? '+' : ''}${t.return_pct.toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ padding: '5px 10px', color: '#8892a4', fontFamily: 'var(--mono)' }}>
                    {t.days_held ?? '—'}
                  </td>
                  <td style={{ padding: '5px 10px', fontFamily: 'var(--mono)',
                    color: t.entry_regime === 'BULL' ? '#00d084' : t.entry_regime === 'BEAR' ? '#ff4757' : '#a0a8be' }}>
                    {t.entry_regime ?? '—'}
                  </td>
                  <td style={{ padding: '5px 10px', color: '#6b7280', fontSize: '0.68rem' }}>
                    {t.exit_reason?.replace(/_/g, ' ') ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function StrategyLabTab() {
  const [strategies, setStrategies]       = useState<StrategyConfig[]>([])
  const [runs, setRuns]                   = useState<StrategyRun[]>([])
  const [selectedIds, setSelectedIds]     = useState<number[]>([1, 2, 3, 4, 5, 6, 7])
  const [showSweepInfo, setShowSweepInfo] = useState(false)
  const [jobType, setJobType]             = useState<'backtest' | 'simulation'>('backtest')
  const [timeRange, setTimeRange]         = useState<'3m' | '6m' | '1y' | '2y' | '3y'>('1y')
  const [tradeRowId, setTradeRowId]       = useState<number | null>(null)
  const [sweepParams, setSweepParams]     = useState(false)
  const [simDays, setSimDays]             = useState(30)
  const [simRegime, setSimRegime]         = useState('BULL')
  const [simVol, setSimVol]               = useState('MEDIUM')
  const [seed, setSeed]                   = useState(42)
  const [initialCapital, setInitialCapital] = useState(10000)
  const [allocationMode, setAllocationMode] = useState<'full' | 'pct'>('pct')
  const [allocationPct, setAllocationPct]   = useState(20)
  const [launching, setLaunching]         = useState(false)
  const [activeRunId, setActiveRunId]     = useState<string | null>(null)
  const [results, setResults]             = useState<StrategyResult[]>([])
  const [expandedRows, setExpandedRows]   = useState<Set<number>>(new Set())
  const [showHelp, setShowHelp]           = useState(false)
  const [promoting, setPromoting]         = useState<string | null>(null)
  const [promoted, setPromoted]           = useState<string | null>(null)
  const [sortCol, setSortCol]             = useState<string>('rank')
  const [sortAsc, setSortAsc]             = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const endDateStr = new Date().toISOString().slice(0, 10)
  const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const startDateMap = { '3m': ago(90), '6m': ago(180), '1y': ago(365), '2y': ago(730), '3y': ago(1095) }

  useEffect(() => {
    getStrategies().then(r => setStrategies(r.data.strategies || [])).catch(() => {})
    getStrategyRuns().then(r => setRuns(r.data.runs || [])).catch(() => {})
  }, [])

  // Poll active run
  useEffect(() => {
    if (!activeRunId) return
    pollRef.current = setInterval(async () => {
      try {
        const r = await getStrategyRun(activeRunId)
        const run = r.data.run as StrategyRun
        setRuns(prev => prev.map(x => x.run_id === activeRunId ? run : x))
        if (run.status === 'COMPLETED') {
          clearInterval(pollRef.current!)
          const res = await getStrategyResults(activeRunId)
          setResults(res.data.results || [])
        } else if (run.status === 'FAILED') {
          clearInterval(pollRef.current!)
        }
      } catch {}
    }, 2500)
    return () => clearInterval(pollRef.current!)
  }, [activeRunId])

  const toggleStrategy = (id: number) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const handleRun = async () => {
    if (selectedIds.length === 0) return
    setLaunching(true)
    setResults([])
    setExpandedRows(new Set())
    setPromoted(null)
    try {
      const body: any = {
        job_type:         jobType,
        strategy_ids:     selectedIds,
        sweep_params:     sweepParams,
        seed,
        start_date:       startDateMap[timeRange],
        end_date:         endDateStr,
        simulation_days:  simDays,
        market_regime:    simRegime,
        volatility_level: simVol,
        initial_capital:  initialCapital,
        allocation_pct:   allocationMode === 'full' ? 100 : allocationPct,
        max_positions_override: allocationMode === 'full' ? 1 : undefined,
      }
      const r = await startStrategyRun(body)
      const runId = r.data.run_id as string
      setActiveRunId(runId)
      const run: StrategyRun = { run_id: runId, job_type: jobType, status: 'PENDING',
        progress: 0, current_step: 'Queued', created_at: new Date().toISOString(),
        completed_at: null, error: null }
      setRuns(prev => [run, ...prev])
    } catch (e: any) {
      alert(`Failed to start run: ${e?.response?.data?.detail || e.message}`)
    } finally {
      setLaunching(false)
    }
  }

  const handleLoadResults = async (runId: string) => {
    setActiveRunId(runId)
    try {
      const r = await getStrategyResults(runId)
      setResults(r.data.results || [])
    } catch {}
  }

  const handleCancel = async (runId: string) => {
    await cancelStrategyRun(runId).catch(() => {})
    setRuns(prev => prev.map(x => x.run_id === runId ? { ...x, status: 'FAILED', error: 'Cancelled' } : x))
  }

  const handlePromote = async (runId: string, stratName: string) => {
    if (!confirm(`Promote "${stratName}" to your live AI Portfolio? This changes future buy/sell rules immediately.`)) return
    setPromoting(stratName)
    try {
      await promoteStrategy(runId, stratName)
      setPromoted(stratName)
      alert(`✅ "${stratName}" is now your live strategy.\nThe AI Portfolio tab will use these parameters from the next evaluation.`)
    } catch (e: any) {
      alert(`Promotion failed: ${e?.response?.data?.detail || e.message}`)
    } finally {
      setPromoting(null)
    }
  }

  const toggleExpand = (id: number) =>
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(a => !a)
    else { setSortCol(col); setSortAsc(false) }
  }

  const sortedResults = [...results].sort((a, b) => {
    const m = (r: StrategyResult) => r.metrics_json
    let va: number, vb: number
    switch (sortCol) {
      case 'rank':          va = a.rank;                         vb = b.rank;                        break
      case 'score':         va = a.composite_score;              vb = b.composite_score;              break
      case 'return':        va = m(a)?.total_return_pct ?? 0;    vb = m(b)?.total_return_pct ?? 0;    break
      case 'sharpe':        va = m(a)?.sharpe ?? 0;              vb = m(b)?.sharpe ?? 0;              break
      case 'drawdown':      va = m(a)?.max_drawdown_pct ?? 0;    vb = m(b)?.max_drawdown_pct ?? 0;    break
      case 'winrate':       va = m(a)?.win_rate_pct ?? 0;        vb = m(b)?.win_rate_pct ?? 0;        break
      case 'trades':        va = m(a)?.total_trades ?? 0;        vb = m(b)?.total_trades ?? 0;        break
      default:              va = a.rank;                         vb = b.rank;
    }
    return sortAsc ? va - vb : vb - va
  })

  const activeRun = runs.find(r => r.run_id === activeRunId)
  const isRunning = activeRun?.status === 'RUNNING' || activeRun?.status === 'PENDING'

  const thStyle: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'left', fontSize: '0.65rem',
    color: '#a0a8be', borderBottom: '1px solid #2a3050',
    cursor: 'pointer', whiteSpace: 'nowrap', letterSpacing: '0.06em',
  }
  const tdStyle: React.CSSProperties = {
    padding: '8px 10px', fontSize: '0.78rem', fontFamily: 'var(--mono)',
    borderBottom: '1px solid #2a3050', whiteSpace: 'nowrap',
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showSweepInfo && <SweepInfoModal onClose={() => setShowSweepInfo(false)} />}

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: '1rem', fontWeight: 700, color: '#00d084' }}>STRATEGY LAB</span>
          <span style={{ fontSize: '0.72rem', color: '#8892a4', marginLeft: 10 }}>
            Backtest and compare strategies — find what works before going live
          </span>
        </div>
        <button
          onClick={() => setShowHelp(true)}
          style={{ background: '#1a2030', border: '1px solid #2a3050',
            color: '#00d084', padding: '4px 12px', borderRadius: 3,
            fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600 }}>
          ? HELP
        </button>
      </div>

      {/* ── Run Panel ── */}
      <div style={{ background: '#13182a', border: '1px solid #2a3050', borderRadius: 6, padding: 20 }}>
        <div style={{ fontSize: '0.72rem', color: '#a0a8be', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 16 }}>RUN CONFIGURATION</div>

        {/* Strategy cards */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: '0.72rem', color: '#a0a8be', fontWeight: 600, letterSpacing: '0.06em' }}>
              SELECT STRATEGIES TO TEST
            </span>
            <span style={{ fontSize: '0.7rem', color: selectedIds.length === 0 ? '#e05050' : '#00ff88' }}>
              {selectedIds.length === 0 ? '⚠ Select at least one' : `${selectedIds.length} selected`}
            </span>
            <button onClick={() => setSelectedIds(strategies.map(s => s.id))}
              style={{ marginLeft: 4, background: 'none', border: '1px solid #3a4060', color: '#8892a4',
                padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
              Select All
            </button>
            <button onClick={() => setSelectedIds([])}
              style={{ background: 'none', border: '1px solid #3a4060', color: '#8892a4',
                padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
              Clear
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {strategies.map(s => {
              const selected = selectedIds.includes(s.id)
              const regimeBadge = s.regime_filter === 'BULL' ? { label: 'BULL ONLY', color: '#00ff88' } : { label: 'ALL REGIMES', color: '#8892a4' }
              return (
                <div key={s.id} onClick={() => toggleStrategy(s.id)}
                  style={{
                    cursor: 'pointer',
                    background: selected ? 'rgba(0,255,136,0.07)' : '#11151f',
                    border: `2px solid ${selected ? '#00ff88' : '#2a3050'}`,
                    borderRadius: 6,
                    padding: '12px 14px',
                    transition: 'border-color 0.15s, background 0.15s',
                    position: 'relative',
                  }}>
                  {/* Checkbox indicator */}
                  <div style={{ position: 'absolute', top: 10, right: 10,
                    width: 18, height: 18, borderRadius: 3,
                    background: selected ? '#00ff88' : 'transparent',
                    border: `2px solid ${selected ? '#00ff88' : '#3a4060'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selected && <span style={{ color: '#000', fontSize: '0.7rem', fontWeight: 900, lineHeight: 1 }}>✓</span>}
                  </div>

                  {/* Strategy name */}
                  <div style={{ fontSize: '0.85rem', fontWeight: 700,
                    color: selected ? '#ffffff' : '#c8cdd8',
                    marginBottom: 5, paddingRight: 24,
                    letterSpacing: '0.01em' }}>
                    {s.name.replace(/_/g, ' ')}
                  </div>

                  {/* Description */}
                  <div style={{ fontSize: '0.7rem', color: '#8892a4', lineHeight: 1.4, marginBottom: 10 }}>
                    {s.description.split('—')[1]?.trim() || s.description}
                  </div>

                  {/* Key params */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <span style={{ fontSize: '0.68rem', padding: '2px 6px', borderRadius: 3,
                      background: '#1e2540', color: '#a0c4ff', border: '1px solid #2a3a6a' }}>
                      Buy ≥{s.buy_threshold}
                    </span>
                    <span style={{ fontSize: '0.68rem', padding: '2px 6px', borderRadius: 3,
                      background: '#251520', color: '#ff8080', border: '1px solid #5a2030' }}>
                      Stop {s.stop_loss_pct}%
                    </span>
                    <span style={{ fontSize: '0.68rem', padding: '2px 6px', borderRadius: 3,
                      background: '#152520', color: '#80ff80', border: '1px solid #205a30' }}>
                      Target +{s.profit_target_pct}%
                    </span>
                    <span style={{ fontSize: '0.68rem', padding: '2px 6px', borderRadius: 3,
                      background: '#1e1e2a', color: regimeBadge.color, border: `1px solid ${regimeBadge.color}44` }}>
                      {regimeBadge.label}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
          {/* Data source */}
          <div>
            <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>DATA SOURCE</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['backtest', 'simulation'] as const).map(t => (
                <button key={t} onClick={() => setJobType(t)}
                  style={{ padding: '6px 14px', borderRadius: 4, fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
                    background: jobType === t ? '#00ff88' : '#1a2030',
                    color: jobType === t ? '#000' : '#c8cdd8',
                    border: `1px solid ${jobType === t ? '#00ff88' : '#3a4060'}` }}>
                  {t === 'backtest' ? '📈 Historical' : '🔬 Simulated'}
                </button>
              ))}
            </div>
          </div>

          {/* Time range (historical only) */}
          {jobType === 'backtest' && (
            <div>
              <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>TIME RANGE</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['3m', '6m', '1y', '2y', '3y'] as const).map(t => (
                  <button key={t} onClick={() => setTimeRange(t)}
                    style={{ padding: '6px 14px', borderRadius: 4, fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
                      background: timeRange === t ? '#00d084' : '#1a2030',
                      color: timeRange === t ? '#000' : '#c8cdd8',
                      border: `1px solid ${timeRange === t ? '#00d084' : '#3a4060'}` }}>
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
              {(timeRange === '3m' || timeRange === '6m') && (
                <div style={{ marginTop: 5, fontSize: '0.67rem', color: '#e8a838' }}>
                  ⚠ Short range — strategies with 30+ day min hold may show fewer completed trades
                </div>
              )}
            </div>
          )}

          {/* Simulation controls */}
          {jobType === 'simulation' && (
            <>
              <div>
                <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>DAYS</div>
                <select value={simDays} onChange={e => setSimDays(+e.target.value)}
                  style={{ background: '#1a2030', border: '1px solid #3a4060', color: '#c8cdd8', padding: '6px 8px', borderRadius: 4, fontSize: '0.78rem' }}>
                  {[30, 60, 90, 180].map(d => <option key={d} value={d}>{d} days</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>REGIME</div>
                <select value={simRegime} onChange={e => setSimRegime(e.target.value)}
                  style={{ background: '#1a2030', border: '1px solid #3a4060', color: '#c8cdd8', padding: '6px 8px', borderRadius: 4, fontSize: '0.78rem' }}>
                  {['BULL', 'BEAR', 'CHOP'].map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>VOLATILITY</div>
                <select value={simVol} onChange={e => setSimVol(e.target.value)}
                  style={{ background: '#1a2030', border: '1px solid #3a4060', color: '#c8cdd8', padding: '6px 8px', borderRadius: 4, fontSize: '0.78rem' }}>
                  {['LOW', 'MEDIUM', 'HIGH'].map(v => <option key={v}>{v}</option>)}
                </select>
              </div>
            </>
          )}

          {/* Starting Capital */}
          <div>
            <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>STARTING CAPITAL ($)</div>
            <input type="number" value={initialCapital} onChange={e => setInitialCapital(+e.target.value)} min={100} step={1000}
              style={{ width: 100, background: '#1a2030', border: '1px solid #3a4060',
                color: '#c8cdd8', padding: '6px 8px', borderRadius: 4, fontSize: '0.78rem' }} />
          </div>

          {/* Allocation per trade */}
          <div>
            <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>ALLOCATION PER TRADE</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {(['full', 'pct'] as const).map(mode => (
                <button key={mode} onClick={() => setAllocationMode(mode)}
                  style={{ padding: '4px 10px', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600,
                    cursor: 'pointer', border: `1px solid ${allocationMode === mode ? '#00d084' : '#3a4060'}`,
                    background: allocationMode === mode ? '#00d08422' : '#1a2030',
                    color: allocationMode === mode ? '#00d084' : '#8892a4' }}>
                  {mode === 'full' ? 'ALL IN' : 'CUSTOM %'}
                </button>
              ))}
              {allocationMode === 'pct' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="number" value={allocationPct} onChange={e => setAllocationPct(Math.min(100, Math.max(1, +e.target.value)))}
                    min={1} max={100}
                    style={{ width: 52, background: '#1a2030', border: '1px solid #3a4060',
                      color: '#c8cdd8', padding: '4px 6px', borderRadius: 4, fontSize: '0.78rem' }} />
                  <span style={{ fontSize: '0.75rem', color: '#8892a4' }}>%</span>
                  <span style={{ fontSize: '0.68rem', color: '#5a6480', marginLeft: 2 }}>
                    = ${Math.round(initialCapital * allocationPct / 100).toLocaleString()}/trade
                  </span>
                </div>
              )}
              {allocationMode === 'full' && (
                <span style={{ fontSize: '0.68rem', color: '#5a6480' }}>
                  ${initialCapital.toLocaleString()} · 1 position at a time
                </span>
              )}
            </div>
          </div>

          {/* Seed */}
          <div>
            <div style={{ fontSize: '0.68rem', color: '#a0a8be', fontWeight: 600, marginBottom: 6 }}>SEED</div>
            <input type="number" value={seed} onChange={e => setSeed(+e.target.value)} min={1}
              style={{ width: 72, background: '#1a2030', border: '1px solid #3a4060',
                color: '#c8cdd8', padding: '6px 8px', borderRadius: 4, fontSize: '0.78rem' }} />
          </div>

          {/* Sweep toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontSize: '0.78rem', color: sweepParams ? '#ffffff' : '#8892a4', userSelect: 'none' }}>
              <input type="checkbox" checked={sweepParams} onChange={e => setSweepParams(e.target.checked)}
                style={{ accentColor: '#00ff88', cursor: 'pointer', width: 15, height: 15 }} />
              <span>Parameter Sweep</span>
            </label>
            <button onClick={() => setShowSweepInfo(true)}
              title="What is parameter sweep?"
              style={{ width: 18, height: 18, borderRadius: '50%', background: '#2a3050',
                border: '1px solid #3a4060', color: '#a0a8be', fontSize: '0.65rem', fontWeight: 700,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, lineHeight: 1 }}>
              ?
            </button>
            {sweepParams && (
              <span style={{ fontSize: '0.68rem', color: '#e8a838', background: '#2a2010',
                border: '1px solid #5a4010', borderRadius: 3, padding: '2px 6px' }}>
                27 variants/strategy — slower
              </span>
            )}
          </div>

          {/* Run button */}
          <button onClick={handleRun} disabled={launching || isRunning || selectedIds.length === 0}
            style={{
              marginLeft: 'auto', padding: '8px 20px', borderRadius: 3, fontSize: '0.8rem',
              fontWeight: 700, cursor: (launching || isRunning) ? 'not-allowed' : 'pointer',
              background: (launching || isRunning) ? '#3a4060' : '#00d084',
              color: '#000', border: 'none', letterSpacing: '0.05em',
            }}>
            {launching ? 'LAUNCHING…' : isRunning ? 'RUNNING…' : '▶ RUN STRATEGY TEST'}
          </button>
        </div>
      </div>

      {/* ── Active Jobs ── */}
      {runs.length > 0 && (
        <div style={{ background: '#13182a', border: '1px solid #2a3050', borderRadius: 4, padding: 16 }}>
          <div style={{ fontSize: '0.7rem', color: '#a0a8be', letterSpacing: '0.07em', marginBottom: 10 }}>RECENT RUNS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {runs.slice(0, 8).map(r => {
              const statusColor = r.status === 'COMPLETED' ? '#00d084' : r.status === 'FAILED' ? '#ff4757' : '#00d084'
              return (
                <div key={r.run_id} style={{ display: 'flex', alignItems: 'center', gap: 12,
                  background: r.run_id === activeRunId ? '#1a2030' : 'transparent',
                  padding: '6px 8px', borderRadius: 3, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: '#8892a4' }}>#{r.run_id}</span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor }}>{r.status}</span>
                  {(r.status === 'RUNNING' || r.status === 'PENDING') && (
                    <ProgressBar pct={r.progress} />
                  )}
                  <span style={{ fontSize: '0.7rem', color: '#c8cdd8', flex: 1 }}>{r.current_step || ''}</span>
                  {r.status === 'COMPLETED' && (
                    <button onClick={() => handleLoadResults(r.run_id)}
                      style={{ background: 'none', border: '1px solid #00d084', color: '#00d084',
                        padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
                      VIEW
                    </button>
                  )}
                  {(r.status === 'RUNNING' || r.status === 'PENDING') && (
                    <button onClick={() => handleCancel(r.run_id)}
                      style={{ background: 'none', border: '1px solid #ff4757', color: '#ff4757',
                        padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
                      CANCEL
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Results table ── */}
      {sortedResults.length > 0 && (
        <div style={{ background: '#13182a', border: '1px solid #2a3050', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3050',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: '#a0a8be', letterSpacing: '0.07em' }}>
              RESULTS — {sortedResults.length} STRATEGIES RANKED
              {sweepParams && <span style={{ color: '#00d084', marginLeft: 6 }}>(parameter sweep)</span>}
            </span>
            {promoted && (
              <span style={{ fontSize: '0.72rem', color: '#00d084' }}>✓ {promoted} promoted to live</span>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#1a2030' }}>
                  {[
                    ['#',        'rank'],
                    ['STRATEGY', 'strategy'],
                    ['SCORE',    'score'],
                    ['RETURN',   'return'],
                    ['SHARPE',   'sharpe'],
                    ['DRAWDOWN', 'drawdown'],
                    ['WIN RATE', 'winrate'],
                    ['TRADES',   'trades'],
                    ['REGIME',   null],
                    ['',         null],
                  ].map(([label, col]) => (
                    <th key={label as string} style={thStyle}
                      onClick={() => col && handleSort(col as string)}>
                      {label}{col && (sortCol === col ? (sortAsc ? ' ↑' : ' ↓') : '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedResults.map(r => {
                  const m = r.metrics_json || {} as StrategyMetrics
                  const isExpanded = expandedRows.has(r.id)
                  const ret = m.total_return_pct ?? 0
                  const dd  = m.max_drawdown_pct ?? 0
                  const sh  = m.sharpe ?? 0

                  return (
                    <>
                      <tr key={r.id} style={{ borderBottom: isExpanded ? 'none' : '1px solid #2a3050',
                        background: r.rank === 1 ? 'rgba(0,208,132,0.05)' : 'transparent' }}>
                        <td style={{ ...tdStyle, color: r.rank === 1 ? '#00d084' : '#8892a4' }}>
                          {r.rank === 1 ? '🏆' : r.rank}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'inherit', color: '#c8cdd8', fontWeight: 600 }}>
                          {r.strategy_name.replace(/_/g, ' ')}
                        </td>
                        <td style={{ ...tdStyle, color: '#00d084' }}>{(r.composite_score * 100).toFixed(1)}</td>
                        <td style={{ ...tdStyle, color: ret >= 0 ? '#00d084' : '#ff4757' }}>
                          {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%
                        </td>
                        <td style={{ ...tdStyle, color: sh >= 1.5 ? '#00d084' : sh >= 0.8 ? '#c8cdd8' : '#ff4757' }}>
                          {sh.toFixed(2)}
                        </td>
                        <td style={{ ...tdStyle, color: dd > 20 ? '#ff4757' : dd > 10 ? '#c8cdd8' : '#00d084' }}>
                          -{dd.toFixed(1)}%
                        </td>
                        <td style={{ ...tdStyle, color: (m.win_rate_pct ?? 0) >= 55 ? '#00d084' : '#a0a8be' }}>
                          {(m.win_rate_pct ?? 0).toFixed(0)}%
                        </td>
                        <td style={{ ...tdStyle, color: '#a0a8be' }}>{m.total_trades ?? 0}</td>
                        <td style={{ ...tdStyle }}>
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button onClick={() => toggleExpand(r.id)}
                              style={{ background: 'none', border: '1px solid #3a4060',
                                color: isExpanded ? '#00d084' : '#a0a8be',
                                padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
                              {isExpanded ? '▲ DETAIL' : '▼ DETAIL'}
                            </button>
                            <button onClick={() => setTradeRowId(tradeRowId === r.id ? null : r.id)}
                              style={{ background: 'none', border: '1px solid #3a4060',
                                color: tradeRowId === r.id ? '#00d084' : '#a0a8be',
                                padding: '2px 8px', borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer' }}>
                              {tradeRowId === r.id ? '▲ TRADES' : '▼ TRADES'}
                            </button>
                          </div>
                        </td>
                        <td style={{ ...tdStyle }}>
                          <button
                            onClick={() => handlePromote(r.run_id, r.strategy_name)}
                            disabled={promoting === r.strategy_name}
                            style={{
                              background: promoted === r.strategy_name ? '#00d084' : '#00d084',
                              color: '#000', border: 'none', padding: '4px 10px',
                              borderRadius: 3, fontSize: '0.68rem', cursor: 'pointer',
                              fontWeight: 700, whiteSpace: 'nowrap',
                              opacity: promoting === r.strategy_name ? 0.6 : 1,
                            }}>
                            {promoted === r.strategy_name ? '✓ LIVE' : '▶ PROMOTE'}
                          </button>
                        </td>
                      </tr>
                      {tradeRowId === r.id && (
                        <tr key={`${r.id}-trades`}>
                          <td colSpan={10} style={{ padding: 0, borderBottom: '1px solid #2a3050' }}>
                            <TradeLog trades={r.trades_json ?? []} />
                          </td>
                        </tr>
                      )}
                      {isExpanded && (
                        <tr key={`${r.id}-expand`}>
                          <td colSpan={10} style={{ padding: 0, borderBottom: '1px solid #2a3050' }}>
                            <RegimeBreakdown data={r.regime_breakdown_json} />
                            <div style={{ padding: '8px 12px', background: '#1a2030',
                              display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                              <MetBadge label="CAGR" value={`${m.cagr_pct >= 0 ? '+' : ''}${m.cagr_pct?.toFixed(1)}%`} good={m.cagr_pct >= 0} />
                              <MetBadge label="VOLATILITY" value={`${m.volatility_pct?.toFixed(1)}%`} good={null} />
                              <MetBadge label="PROFIT FACTOR" value={(m.profit_factor ?? 0).toFixed(2)} good={(m.profit_factor ?? 0) >= 1.5} />
                              <MetBadge label="AVG TRADE" value={`${m.avg_trade_return_pct >= 0 ? '+' : ''}${m.avg_trade_return_pct?.toFixed(1)}%`} good={m.avg_trade_return_pct >= 0} />
                              <MetBadge label="TRADE/MONTH" value={(m.trade_frequency ?? 0).toFixed(1)} good={null} />
                              <MetBadge label="FINAL VALUE" value={`$${(m.final_value ?? 0).toFixed(0)}`} good={m.final_value > m.initial_capital} />
                              <div style={{ fontSize: '0.68rem', color: '#8892a4', alignSelf: 'center' }}>
                                Regime: <b style={{ color: r.params_json?.regime_filter === 'BULL' ? '#00d084' : '#c8cdd8' }}>
                                  {r.params_json?.regime_filter || 'ALL'}
                                </b>
                                &nbsp;· Buy ≥{r.params_json?.buy_threshold}
                                &nbsp;· Stop {r.params_json?.stop_loss_pct}%
                                &nbsp;· Target +{r.params_json?.profit_target_pct}%
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Comparison note */}
          <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3050',
            fontSize: '0.7rem', color: '#8892a4' }}>
            Ranked by composite score: 30% Sharpe · 20% Return · 20% Drawdown (inverted) · 15% Profit Factor · 15% Win Rate.
            Click column headers to sort. Expand rows for regime breakdown. Click Promote to apply to live AI Portfolio.
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {sortedResults.length === 0 && !isRunning && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#8892a4', fontSize: '0.8rem' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>⚗️</div>
          Select strategies above and click <b style={{ color: '#00d084' }}>Run Strategy Test</b> to start.
          <br />
          <span style={{ fontSize: '0.72rem' }}>First run downloads price data (~30s). Subsequent runs use the cache.</span>
        </div>
      )}
    </div>
  )
}
