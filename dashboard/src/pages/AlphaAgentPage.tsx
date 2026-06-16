import { useEffect, useState } from 'react'
import { getAlphaStatus, getAlphaQueue, getAlphaLessons } from '../api'
import AlphaInternalNav from '../components/alpha/AlphaInternalNav'
import type { AlphaNavId } from '../components/alpha/AlphaInternalNav'
import WalletBar from '../components/alpha/shared/WalletBar'
import DecisionCenter from './alpha/DecisionCenter'
import TradeQueue from './alpha/TradeQueue'
import PortfolioView from './alpha/PortfolioView'
import TradeJournal from './alpha/TradeJournal'
import LessonsLearned from './alpha/LessonsLearned'
import MarketOverview from './alpha/MarketOverview'
import AgentMemory from './alpha/AgentMemory'
import AgentSettings from './alpha/AgentSettings'
import { PageInfoModal } from '../components/PageInfoModal'
import MarketStatusBar from '../components/alpha/MarketStatusBar'

interface Status {
  is_on: boolean
  portfolio: { cash: number; total_value: number }
  daily_cost_usd: number
  monthly_cost_usd: number
}

const ABOUT_SECTIONS = [
  {
    title: 'What It Is',
    body: 'Alpha Agent is an autonomous AI paper-trading system. It monitors a broad market universe, detects significant events, runs a 5-agent committee to build an investment case, and surfaces decisions for your approval. All trades are paper (simulated) — no real money is ever moved.',
  },
  {
    title: 'How Stock Discovery Works — Three Tiers',
    body: 'The agent does not rely on a hand-curated list. Instead it works across three independent tiers to avoid selection bias:',
    bullets: [
      'Universe (~150 stocks): the full S&P 500 filtered daily by market cap (>$5B) and volume (>1M shares). Scanned every 5 min during market hours for price/volume moves only — zero AI cost. Acts as the raw feed.',
      'Watchlist (20–30 stocks): stocks the agent has promoted from the universe after detecting a significant move (>3% price or >3× volume). These receive the full treatment — Haiku significance scoring and committee eligibility. Auto-demoted after 30 days of no committee trigger.',
      'Manual (unlimited): tickers you add yourself. Full scan, never auto-aged or removed by the agent.',
    ],
  },
  {
    title: 'Two-Pass Event Scan (every 5 min)',
    body: 'The scan runs in two passes to keep cost near zero for broad coverage:',
    bullets: [
      'Pass 1 — Universe: checks all ~150 stocks for price/volume moves in a single batch call. No Haiku, no cost. A qualifying move auto-promotes the ticker to Watchlist tier silently.',
      'Pass 2 — Watchlist + Manual: runs a Haiku significance call (~$0.001) on each event detected. Events scoring above your threshold trigger the full 5-agent committee.',
    ],
  },
  {
    title: 'The 5-Agent Committee',
    body: 'Only fires when a high-significance event is detected on a Watchlist or Manual tier stock:',
    bullets: [
      'Research Agent — EDGAR filings, Finnhub news, price history, RSS headlines → evidence brief',
      'Bull Agent — builds the strongest possible long case from that evidence',
      'Bear Agent — attacks every bull assumption, surfaces what\'s being ignored',
      'Risk Agent — reads live VIX, applies the regime gate, sizes the position by conviction',
      'Portfolio Manager — final BUY / SELL / HOLD / PASS with full rationale',
    ],
  },
  {
    title: 'Position Sizing — Conviction-Weighted',
    body: 'The Risk Agent sizes each trade based on how strongly the bull and bear agents disagree:',
    bullets: [
      'Low conviction (bull < 60%): 3% of portfolio',
      'Medium conviction (60–75%): 7% of portfolio',
      'High conviction (> 75%): 12% of portfolio',
      'If bear confidence > 70%: size reduced 30% regardless of bull score',
      'Cash floor (default 25%) is always protected and never invested',
    ],
  },
  {
    title: 'VIX Regime Gate — Automatic',
    body: 'Risk rules tighten as volatility rises. No manual input needed — VIX drives it:',
    bullets: [
      'BULL (VIX < 15): up to 75% deployed, -10% hard stop',
      'NORMAL (VIX 15–25): up to 60% deployed, -8% hard stop',
      'CAUTION (VIX 25–35): up to 35% deployed, -6% hard stop',
      'CRISIS (VIX > 35): no new positions — full capital preservation',
    ],
  },
  {
    title: 'Self-Improvement — Two Layers',
    body: 'The agent learns from every outcome through two independent feedback systems:',
    bullets: [
      'Counterfactual Engine: after each trade closes, a post-mortem runs — what went right, what was missed, what to do differently. Generates a PENDING lesson requiring your approval before it affects future runs.',
      'Self-Corrector: tracks four performance signals (consecutive stop-losses, win rate below 40%, loss/win ratio imbalance, 15%+ drawdown). When a trigger fires it proposes a specific rule change — you approve or reject it. Nothing changes without your sign-off.',
    ],
  },
  {
    title: 'Trading Style',
    body: 'Swing trading only — 5 to 21 day holding periods. A hard time stop exits any open position after 21 days regardless of P&L. The agent does not day-trade (no intraday data) and avoids multi-month holds (too few trades to generate learning signal quickly).',
  },
  {
    title: 'Cost',
    body: 'Universe scan: $0 (no AI calls). Significance check per watchlist event: ~$0.001. Full committee run: ~$0.02. Typical active day: under $0.08. You can watch real-time spend in the wallet bar at the top of every page.',
  },
]

const HOW_TO_USE_SECTIONS = [
  {
    title: 'Step 1 — Configure and Turn ON',
    body: 'Open Settings (last item in the left nav). Review the defaults: starting capital, position sizes by conviction, cash floor, hard stop, and VIX regime thresholds. Adjust anything you disagree with, then click "Turn ON". The agent begins scanning immediately.',
  },
  {
    title: 'Step 2 — Populate the Universe',
    body: 'In Settings → Watchlist, click "Screen Universe". This fetches the current S&P 500 list from Wikipedia, filters it by market cap and volume, and loads ~150 qualifying tickers into the Universe tier. This runs automatically every weekday at 6:45 AM ET, but run it manually on first setup to avoid waiting until tomorrow.',
  },
  {
    title: 'Step 3 — Seed SOTD History into Watchlist (Optional)',
    body: 'Click "Seed SOTD → Watchlist" to move past high-confidence Stock-of-the-Day picks directly into the Watchlist tier, bypassing the universe promotion step. This gives the agent a head start with stocks it already has context on. Note: these are added as context starters, not gospel — the agent evaluates them independently.',
  },
  {
    title: 'Step 4 — Add Your Own Picks (Optional)',
    body: 'Add any ticker manually and it lands in the Manual tier — full scan, full committee eligibility, never auto-removed. Use this for stocks you have personal conviction on and want the agent to watch closely regardless of whether they\'re in the S&P 500 universe.',
  },
  {
    title: 'Step 5 — Let It Run',
    body: 'During market hours (9:30–4:00 ET, Mon–Fri) the agent scans every 5 minutes. Pass 1 checks the ~150 universe stocks for big moves and promotes them silently. Pass 2 scores watchlist and manual stocks with Haiku and triggers the committee when significance is high. You don\'t need to do anything.',
  },
  {
    title: 'Step 6 — Review Committee Decisions',
    body: 'Finished committee runs appear in Decision Center. The Trade Queue badge shows how many await your approval. Read the 6 tabs (Thesis, Research, Bull vs Bear, Similar Trades, Lessons Applied, Risk Plan) and the AI Thinking sidebar. Approve to open the paper position, Reject to skip. You have no time pressure — the agent waits.',
  },
  {
    title: 'Step 7 — Monitor Positions',
    body: 'Open positions appear in Portfolio. The agent monitors stops and targets every 30 minutes. You can manually close any position at any time from the Portfolio page. When a position closes for any reason, the Counterfactual Engine runs automatically in the background.',
  },
  {
    title: 'Step 8 — Approve or Dismiss Lessons',
    body: 'After each close, a PENDING lesson appears in Lessons Learned. Read the evidence — it cites the specific trade and what the agent got wrong or right. Click Apply to activate it (immediately injected into future committee prompts) or Dismiss if it\'s too specific to that one trade.',
  },
  {
    title: 'Step 9 — Watch the Self-Corrector',
    body: 'If performance degrades — 3 consecutive stops hit, win rate under 40% over 15+ trades, losses running bigger than wins, or 15%+ portfolio drawdown — a proposal appears at the top of Settings with a specific rule change and the data behind it. Approve to apply, reject to keep existing rules. Nothing changes without your decision.',
  },
  {
    title: 'Step 10 — Weekly Review',
    body: 'Every Sunday at 9 PM ET the agent compares its paper return vs SPY for the week, calculates win rate and alpha, and writes a brief analysis of what worked and what to test next week. Find it in Agent Memory → Strategy Log. You can also trigger it manually anytime.',
  },
  {
    title: 'What to Expect — First 4 Weeks',
    body: 'Week 1: Universe populates, first Watchlist promotions appear, 0–2 committee runs per day, mostly PASS decisions. Week 2: First lessons activate, committee quality improves noticeably. Week 3: Self-corrector has enough closed trades to evaluate win rate — take any proposals seriously. Week 4: The lesson library and trade memory start compounding — this is when the agent begins to feel genuinely adaptive. The universe screen running daily is the most important background process — without it the agent has nothing to discover.',
  },
]

export default function AlphaAgentPage() {
  const [activeView, setActiveView]   = useState<AlphaNavId>('decision-center')
  const [status, setStatus]           = useState<Status | null>(null)
  const [queueCount, setQueueCount]   = useState(0)
  const [pendingLessons, setPendingLessons] = useState(0)
  const [showAbout, setShowAbout]     = useState(false)
  const [showHowTo, setShowHowTo]     = useState(false)

  const load = () => {
    getAlphaStatus().then(r => setStatus(r.data)).catch(() => {})
    getAlphaQueue().then(r => setQueueCount((r.data as unknown[]).length)).catch(() => {})
    getAlphaLessons('PENDING').then(r => setPendingLessons((r.data as unknown[]).length)).catch(() => {})
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const port = status?.portfolio
  const totalValue = port?.total_value ?? 10000
  const cash = port?.cash ?? 10000

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: '#07101F', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#081225', flexShrink: 0 }}>
        {/* Back */}
        <button
          onClick={() => { window.location.href = '/' }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '0 16px', height: 40,
            color: '#64748b', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer',
            borderRight: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#cbd5e1')}
          onMouseLeave={e => (e.currentTarget.style.color = '#64748b')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Dashboard
        </button>

        {/* Wallet bar */}
        <div style={{ flex: 1 }}>
          <WalletBar
            totalValue={totalValue}
            cash={cash}
            dailyCost={status?.daily_cost_usd ?? 0}
            monthlyCost={status?.monthly_cost_usd ?? 0}
          />
        </div>

        {/* Info buttons */}
        <div style={{ display: 'flex', gap: 8, padding: '0 16px', borderLeft: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <button
            onClick={() => setShowAbout(true)}
            title="About this agent"
            style={{
              background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)',
              color: '#818cf8', borderRadius: 6, padding: '4px 11px',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap',
            }}
          >
            ⓘ About
          </button>
          <button
            onClick={() => setShowHowTo(true)}
            title="How to use this page"
            style={{
              background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
              color: '#60a5fa', borderRadius: 6, padding: '4px 11px',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap',
            }}
          >
            ⓘ How to Use
          </button>
        </div>
      </div>

      {/* Market status bar */}
      <MarketStatusBar />

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <AlphaInternalNav
          active={activeView}
          onNavigate={setActiveView}
          queueCount={queueCount}
          pendingLessons={pendingLessons}
          isOn={status?.is_on ?? false}
        />
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {activeView === 'decision-center'  && <DecisionCenter />}
          {activeView === 'trade-queue'      && <TradeQueue />}
          {activeView === 'portfolio'        && <PortfolioView />}
          {activeView === 'trade-journal'    && <TradeJournal />}
          {activeView === 'lessons-learned'  && <LessonsLearned />}
          {activeView === 'market-overview'  && <MarketOverview />}
          {activeView === 'agent-memory'     && <AgentMemory />}
          {activeView === 'settings'         && <AgentSettings onStatusChange={load} />}
        </div>
      </div>

      {/* About modal */}
      {showAbout && (
        <PageInfoModal
          title="Alpha Agent"
          subtitle="Autonomous AI paper-trading system"
          benefit="A 5-agent AI committee monitors your watchlist 24/7, detects market events, builds full investment cases with bull/bear debate, and proposes trades for your approval — while learning from every outcome."
          sections={ABOUT_SECTIONS}
          onClose={() => setShowAbout(false)}
        />
      )}

      {/* How to Use modal */}
      {showHowTo && (
        <PageInfoModal
          title="How to Use Alpha Agent"
          subtitle="Get from zero to first trade in under 10 minutes"
          benefit="Follow these steps once and the agent runs autonomously — detecting events, running the committee, and surfacing decisions for your approval each trading day."
          sections={HOW_TO_USE_SECTIONS}
          onClose={() => setShowHowTo(false)}
        />
      )}
    </div>
  )
}
