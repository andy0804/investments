import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, Cell, CartesianGrid, Legend,
} from 'recharts'
import {
  getOptionsAccount, getOptionExpirations, getOptionChain, openOptionsPosition,
  closeOptionsPosition, getOpenPositions, getClosedPositions, triggerRevalue,
  scenarioLive, getOptionsAICommentary, getOptionsRisk, getUnderlying,
  openMultiLegPosition, getOptionsAlerts, getOptionsPerformance, getMarketStatus,
  getOptionsBenchmark,
  getAriaAccount, getAriaPositions, getAriaDecisions, getAriaScoreboard, triggerAriaExits,
  getLivePositions, getLiveClosedPositions, openLivePosition, closeLivePosition, deleteLivePosition,
  getScannerSetups, triggerScan, getScannerStatus,
} from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Account {
  cash: number; net_liq: number; initial_capital: number
  realized_pnl: number; unrealized_pnl: number
  total_pnl: number; total_return_pct: number; total_commissions: number
}

interface ChainRow {
  contractSymbol: string; strike: number
  bid: number | null; ask: number | null; mid: number | null
  lastPrice: number; volume: number; openInterest: number
  iv: number; inTheMoney: boolean
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null
  bs_price: number | null
}

interface Leg {
  id: number; ticker: string; expiry: string; strike: number
  option_type: string; action: string; quantity: number
  fill_price: number; iv_at_entry: number | null; delta_at_entry: number | null
  theta_at_entry: number | null; underlying_at_entry: number | null
  current_price: number | null; current_delta: number | null
  current_theta: number | null; current_iv: number | null; status: string
}

interface Position {
  id: number; ticker: string; strategy_label: string; status: string
  open_date: string; close_date: string | null
  total_cost: number; realized_pnl: number | null; unrealized_pnl: number | null
  last_revalued_at: string | null; legs: Leg[]
}

interface ScenarioRow {
  underlying_price: number; days_forward: number; option_price: number
  pnl: number; pnl_pct: number
}

interface Alert {
  position_id: number; ticker: string
  level: 'danger' | 'warning' | 'info'; type: string; message: string
}

interface PerfPoint { date: string; net_liq: number; unrealized: number; realized: number }

interface AriaPosition {
  id: number; user_position_id: number | null; ticker: string
  strategy_label: string; status: string; open_date: string; close_date: string | null
  expiry: string; strike: number; option_type: string; action: string; quantity: number
  fill_price: number; total_cost: number; current_price: number | null
  unrealized_pnl: number | null; realized_pnl: number | null; close_price: number | null
  entry_thesis: string; divergence_note: string; user_trade_summary: string
  confidence_score: number; exit_conditions_json: string; exit_reasoning: string | null
}

interface AriaDecision {
  id: number; position_id: number | null; user_position_id: number | null
  ticker: string; decision_type: string; decision_at: string
  reasoning: string; user_trade_summary: string | null; aria_action: string | null
  pnl_at_decision: number | null; confidence: number
}

interface Scoreboard {
  user: { net_liq: number; total_pnl: number; total_return_pct: number; realized_pnl: number; unrealized_pnl: number; trade_count: number; win_rate: number; commissions: number }
  aria: { net_liq: number; total_pnl: number; total_return_pct: number; realized_pnl: number; unrealized_pnl: number; trade_count: number; win_rate: number; commissions: number }
  leader: 'user' | 'aria' | 'tie'; edge: number
}

interface MarketStatus {
  is_open: boolean; is_weekend: boolean; is_holiday: boolean
  data_freshness: 'LIVE' | 'STALE'; reason: string; current_et: string
}

// ── Strategy presets ──────────────────────────────────────────────────────────

const STRATEGY_PRESETS = [
  {
    id: 'bull_call',
    label: 'Bull Call Spread',
    description: 'BUY a lower-strike call + SELL a higher-strike call. You profit if the stock rises above the lower strike. Max profit capped, but cheaper than buying a call outright.',
    legs: (buyStrike: number, sellStrike: number, qty: number) => [
      { option_type: 'call', action: 'BUY',  strike: buyStrike,  quantity: qty },
      { option_type: 'call', action: 'SELL', strike: sellStrike, quantity: qty },
    ],
    fields: ['buyStrike', 'sellStrike', 'qty'],
  },
  {
    id: 'bear_put',
    label: 'Bear Put Spread',
    description: 'BUY a higher-strike put + SELL a lower-strike put. You profit if the stock falls. Cheaper than buying a put outright, but capped upside.',
    legs: (buyStrike: number, sellStrike: number, qty: number) => [
      { option_type: 'put', action: 'BUY',  strike: buyStrike,  quantity: qty },
      { option_type: 'put', action: 'SELL', strike: sellStrike, quantity: qty },
    ],
    fields: ['buyStrike', 'sellStrike', 'qty'],
  },
  {
    id: 'straddle',
    label: 'Long Straddle',
    description: 'BUY a call + BUY a put at the same strike. You profit from a big move in EITHER direction. Expensive because you buy two premiums.',
    legs: (strike: number, _: number, qty: number) => [
      { option_type: 'call', action: 'BUY', strike, quantity: qty },
      { option_type: 'put',  action: 'BUY', strike, quantity: qty },
    ],
    fields: ['singleStrike', 'qty'],
  },
  {
    id: 'strangle',
    label: 'Long Strangle',
    description: 'BUY an OTM call + BUY an OTM put at different strikes. Cheaper than a straddle, but needs a bigger move to profit.',
    legs: (callStrike: number, putStrike: number, qty: number) => [
      { option_type: 'call', action: 'BUY', strike: callStrike, quantity: qty },
      { option_type: 'put',  action: 'BUY', strike: putStrike,  quantity: qty },
    ],
    fields: ['callStrike', 'putStrike', 'qty'],
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt$ = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const fmtNum = (v: number | null | undefined, d = 4) =>
  v == null ? '—' : v.toFixed(d)
const pnlClass = (v: number | null | undefined) =>
  v == null ? '' : v >= 0 ? 'positive' : 'negative'

// ── Liquidity scoring ─────────────────────────────────────────────────────────

function getLiquidityScore(row: ChainRow): 'good' | 'fair' | 'poor' {
  const bid = row.bid ?? 0
  const ask = row.ask ?? 0
  const mid = row.mid ?? (bid + ask) / 2
  const oi = row.openInterest
  // yfinance returns NaN for missing OI → backend converts to 0; treat 0 as "unknown"
  const hasOI = oi > 0
  // No active quote (market closed / illiquid OTM) — spread is meaningless, use OI only
  const hasQuote = bid > 0 || ask > 0
  if (!hasQuote) {
    if (hasOI && oi >= 500) return 'fair'
    return 'poor'
  }
  const spreadPct = mid > 0.01 ? ((ask - bid) / mid) * 100 : 100
  if (spreadPct < 5 && (!hasOI || oi > 500)) return 'good'
  if (spreadPct > 20) return 'poor'
  if (hasOI && oi < 100) return 'poor'
  return 'fair'
}

const LIQ_DOT: Record<'good' | 'fair' | 'poor', string> = {
  good: '#16a34a', fair: '#d97706', poor: '#dc2626',
}
const LIQ_TIP: Record<'good' | 'fair' | 'poor', string> = {
  good:  'Good liquidity — tight spread, healthy OI',
  fair:  'Fair liquidity — moderate spread or OI (or market closed, OI looks healthy)',
  poor:  'Poor liquidity — wide spread or low OI (or no active market quote)',
}

// ── Trade Snapshot ────────────────────────────────────────────────────────────

function TradeSnapshot({ row, side, action, qty, underlying, dte }: {
  row: ChainRow; side: 'call' | 'put'; action: 'BUY' | 'SELL'
  qty: number; underlying: number; dte: number
}) {
  const fillPrice = action === 'BUY'
    ? (row.ask ?? row.mid ?? row.lastPrice ?? 0)
    : (row.bid ?? row.mid ?? row.lastPrice ?? 0)

  // No active market — don't show misleading metrics (bid=ask=0, can't trade)
  const noMarket = fillPrice <= 0
  if (noMarket) {
    const otmPct = underlying > 0 ? Math.abs((row.strike - underlying) / underlying) * 100 : null
    return (
      <div>
        <div style={{ background: '#f9fafb', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 8 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 4 }}>
            No active market for this option
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Bid and ask are both $0.00 — no market maker is quoting this contract.{' '}
            {otmPct != null && otmPct > 20
              ? `The $${row.strike} strike is ${otmPct.toFixed(0)}% ${side === 'call' ? 'above' : 'below'} the stock price of $${underlying.toFixed(2)} — very far out of the money.`
              : 'Choose a strike closer to the current stock price for tradeable options.'}
          </div>
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
          IV: {row.iv > 0 ? `${row.iv.toFixed(1)}% (from last trade — stale)` : '—'}
          {'  ·  '}OI: {row.openInterest.toLocaleString()}
          {'  ·  '}Vol: {row.volume.toLocaleString()}
        </div>
      </div>
    )
  }

  const premium = fillPrice * 100 * qty

  // Breakeven
  const breakeven = side === 'call' ? row.strike + fillPrice : row.strike - fillPrice
  const beMove    = underlying > 0 ? ((breakeven - underlying) / underlying) * 100 : 0
  const beDir     = side === 'call' ? 'rise' : 'fall'

  // Probability of profit (≈ |delta|); show '<1%' when delta is non-null but rounds to 0
  const rawPop   = row.delta != null ? Math.abs(row.delta) * 100 : null
  const pop      = rawPop != null ? Math.round(rawPop) : null
  const popLabel = rawPop == null ? '—' : rawPop < 1 ? '<1%' : `~${pop}%`

  // Theta
  const thetaDay  = row.theta != null ? Math.abs(row.theta) * 100 * qty : null
  const thetaWeek = thetaDay != null ? thetaDay * 7 : null

  // Spread cost
  const spreadWidth = (row.ask ?? 0) - (row.bid ?? 0)
  const spreadCost  = spreadWidth * 100 * qty
  const spreadPct   = fillPrice > 0.01 ? (spreadWidth / fillPrice) * 100 : 0

  // IV level
  const iv = row.iv
  const ivLevel = iv < 20 ? 'low' : iv < 35 ? 'normal' : iv < 55 ? 'elevated' : 'high'
  const ivColor: Record<string, string> = { low: '#2563eb', normal: '#15803d', elevated: '#d97706', high: '#dc2626' }
  const ivLabel: Record<string, string> = {
    low:      'Low IV — options are cheap, good time to buy',
    normal:   'Normal IV — fairly priced',
    elevated: 'Elevated IV — options cost more than usual; prefer selling',
    high:     'Very high IV — likely a major event nearby; very expensive to buy',
  }

  // Verdict (only for BUY — selling is a different game)
  const issues: string[] = []
  const goods:  string[] = []
  if (action === 'BUY') {
    if (rawPop != null && rawPop < 1) issues.push(`<1% chance of profit — strike is too far out of the money`)
    else if (pop != null && pop < 30) issues.push(`only ~${pop}% chance of profit at expiry`)
    else if (pop != null) goods.push(`~${pop}% PoP`)

    if (Math.abs(beMove) > 5) issues.push(`needs ${Math.abs(beMove).toFixed(1)}% move to break even`)
    else goods.push(`${Math.abs(beMove).toFixed(1)}% move to break even`)

    if (spreadPct > 15) issues.push('wide bid-ask spread eats entry')
    else if (spreadPct < 5) goods.push('tight spread')

    if (dte < 21) issues.push(`${dte} DTE — aggressive time decay`)
    else if (dte >= 45) goods.push(`${dte} DTE gives room`)

    if (ivLevel === 'elevated') issues.push('IV elevated — paying a premium')
    if (ivLevel === 'high')     issues.push('very high IV — very expensive')
    if (ivLevel === 'low')      goods.push('low IV — cheap to buy')

    if (thetaDay != null && premium > 0 && (thetaDay / premium) > 0.03)
      issues.push(`theta burns ${((thetaDay / premium) * 100).toFixed(1)}%/day`)
  }

  const verdictText = action === 'SELL'
    ? `Selling — theta works in your favor (+$${thetaDay?.toFixed(2) ?? '?'}/day). Max profit = premium received.`
    : issues.length >= 2 ? `⚠️ ${issues.join('  ·  ')}`
    : issues.length === 1 ? `⚠️ ${issues[0]}${goods.length ? '  ·  ' + goods.join(', ') : ''}`
    : `✅ ${goods.join('  ·  ')}`
  const vBg     = action === 'SELL' ? '#eff6ff' : issues.length >= 2 ? '#fef2f2' : issues.length === 1 ? '#fffbeb' : '#f0fdf4'
  const vBorder = action === 'SELL' ? '#93c5fd' : issues.length >= 2 ? '#fca5a5' : issues.length === 1 ? '#fcd34d' : '#86efac'
  const vColor  = action === 'SELL' ? '#1d4ed8' : issues.length >= 2 ? '#991b1b' : issues.length === 1 ? '#92400e' : '#15803d'

  return (
    <div style={{ marginBottom: 12 }}>
      {/* One-line verdict */}
      <div style={{ background: vBg, border: `1px solid ${vBorder}`, borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
        <div style={{ fontWeight: 700, color: vColor, fontSize: '0.8rem', lineHeight: 1.55 }}>{verdictText}</div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        {/* Breakeven */}
        <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Breakeven</div>
          <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.88rem' }}>${breakeven.toFixed(2)}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>
            Stock must {beDir} {Math.abs(beMove).toFixed(1)}% from ${underlying.toFixed(2)}
          </div>
        </div>

        {/* PoP */}
        <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Prob. of Profit</div>
          <div style={{
            fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.88rem',
            color: rawPop == null ? 'var(--text)' : rawPop < 1 ? 'var(--red)' : pop! > 45 ? 'var(--green)' : pop! < 25 ? 'var(--red)' : '#d97706',
          }}>{popLabel}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>At expiry (≈ |delta|)</div>
        </div>

        {/* Theta drain */}
        <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Daily Theta Drain</div>
          <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.88rem', color: 'var(--red)' }}>
            {thetaDay != null ? `−$${thetaDay.toFixed(2)}` : '—'}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>
            {thetaWeek != null ? `~$${thetaWeek.toFixed(0)} lost per week if flat` : 'Per day if stock stays flat'}
          </div>
        </div>

        {/* Spread cost */}
        <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Spread Entry Cost</div>
          <div style={{
            fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.88rem',
            color: spreadPct > 15 ? 'var(--red)' : spreadPct > 5 ? '#d97706' : 'var(--green)',
          }}>${spreadCost.toFixed(2)}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>
            {spreadPct.toFixed(1)}% of premium  ·  bid {row.bid?.toFixed(2) ?? '—'} / ask {row.ask?.toFixed(2) ?? '—'}
          </div>
        </div>
      </div>

      {/* IV bar */}
      <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)' }}>Implied Volatility</span>
          <span style={{ fontSize: '0.78rem', fontWeight: 800, color: ivColor[ivLevel], fontFamily: 'var(--mono)' }}>{iv.toFixed(1)}%</span>
        </div>
        <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginBottom: 4 }}>
          <div style={{ height: '100%', width: `${Math.min(100, iv * 1.2)}%`, background: ivColor[ivLevel], borderRadius: 3, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: '0.7rem', color: ivColor[ivLevel] }}>{ivLabel[ivLevel]}</div>
      </div>
    </div>
  )
}

// ── Help Modal ────────────────────────────────────────────────────────────────

function HelpModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState(0)

  const sections = [
    {
      title: '📖 What is an Option?',
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>An option is a <strong>contract</strong> that gives you the right (but not the obligation) to buy or sell 100 shares of a stock at a specific price, before a specific date.</p>
          <p style={{ marginBottom: 12 }}>Think of it like a reservation at a restaurant. You pay a small fee to lock in a table (price). If you don't use it, you lose just the reservation fee — not the whole meal cost.</p>
          <div style={{ background: 'var(--panel-inset)', borderRadius: 8, padding: '12px 16px', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--cyan)' }}>There are two types:</div>
            <div style={{ marginBottom: 8 }}><strong>CALL option</strong> — the right to <em>buy</em> 100 shares at the strike price. You buy calls when you think the stock will go <strong>UP</strong>.</div>
            <div><strong>PUT option</strong> — the right to <em>sell</em> 100 shares at the strike price. You buy puts when you think the stock will go <strong>DOWN</strong>.</div>
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>In this simulator you never own actual shares. Everything is a paper trade against a $10,000 virtual account.</p>
        </div>
      ),
    },
    {
      title: '📚 Key Terms Explained',
      content: (
        <div>
          {[
            { term: 'Strike Price', def: 'The price you have the right to buy/sell at. Example: an AAPL $200 call gives you the right to buy AAPL at $200 — even if it trades at $220.' },
            { term: 'Expiry Date', def: 'The contract\'s last day. After this date, the option is worthless if not exercised. Pick longer expiry to give your thesis more time.' },
            { term: 'Premium', def: 'The price you pay for the contract. If a call shows a bid/ask of $3.00/$3.20, you\'d pay $3.20 × 100 = $320 for 1 contract.' },
            { term: 'DTE (Days to Expiry)', def: 'How many calendar days until the option expires. < 21 DTE is where time decay really accelerates.' },
            { term: 'ITM (In the Money)', def: 'A call is ITM when the stock price is ABOVE the strike. A put is ITM when stock is BELOW the strike. ITM options have intrinsic value.' },
            { term: 'OTM (Out of the Money)', def: 'The opposite of ITM. An OTM option has no intrinsic value — it\'s pure time value. Cheaper, but needs a bigger move to profit.' },
            { term: 'ATM (At the Money)', def: 'When the strike is very close to the current stock price. Highlighted in cyan in this simulator.' },
          ].map(({ term, def }) => (
            <div key={term} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, color: 'var(--cyan)', marginBottom: 3, fontFamily: 'var(--mono)' }}>{term}</div>
              <div style={{ fontSize: '0.82rem' }}>{def}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: '🔢 The Greeks (Plain English)',
      content: (
        <div>
          <p style={{ marginBottom: 12, color: 'var(--text-dim)', fontSize: '0.82rem' }}>The Greeks measure how your option's price changes when market conditions change. You don't need to memorize them — just know what each one <em>feels</em> like.</p>
          {[
            { greek: 'Delta (Δ)', emoji: '📈', def: 'How much your option moves for every $1 move in the stock. Delta 0.50 means if the stock goes up $1, your option gains $0.50 (×100 = $50 per contract). Call deltas are 0 to 1. Put deltas are -1 to 0.' },
            { greek: 'Gamma (Γ)', emoji: '⚡', def: 'How fast Delta itself changes. High gamma = your delta can shift dramatically if the stock moves. This cuts both ways — ATM options have the highest gamma.' },
            { greek: 'Theta (θ)', emoji: '⏳', def: 'Time decay — how much your option loses in value each day, all else equal. A theta of -0.05 means you lose $5 per contract per day just from the passage of time. This is the enemy for option buyers.' },
            { greek: 'Vega (ν)', emoji: '🌊', def: 'Sensitivity to implied volatility (IV). A vega of 0.20 means if IV rises 1%, your option gains $0.20 (×100 = $20). Rising IV (fear) helps option buyers. Falling IV hurts.' },
          ].map(({ greek, emoji, def }) => (
            <div key={greek} style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--panel-inset)', borderRadius: 6 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{emoji} {greek}</div>
              <div style={{ fontSize: '0.82rem' }}>{def}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: '📞 Step-by-Step: Buy Your First Call',
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>Scenario: You think <strong>SPY</strong> is going to rally next month.</p>
          <div style={{ counterReset: 'steps' }}>
            {[
              { step: '1. Enter the ticker', detail: 'Type "SPY" in the ticker box (top-left of the chain panel). Click Load.' },
              { step: '2. Pick an expiry', detail: 'A dropdown appears with dates. Choose one ~30 days out (e.g. "2026-06-20"). Longer = more time, but costs more premium. Click Fetch Chain.' },
              { step: '3. Read the chain table', detail: 'The chain shows calls on the LEFT and puts on the RIGHT. The cyan highlighted row is ATM. Green shading = in-the-money.' },
              { step: '4. Click a call strike', detail: 'Click on the Bid or Ask cell of a call slightly above the current price (OTM call). This selects it and opens the builder on the right.' },
              { step: '5. Set action & quantity', detail: 'Action = BUY (you\'re going long). Quantity = 1 contract = rights on 100 shares. You\'ll see the estimated cost.' },
              { step: '6. Review the scenario grid', detail: 'The centre panel shows your P&L at different stock prices and dates. Green = profitable, red = loss. This shows your max loss (the premium you paid).' },
              { step: '7. Click Submit', detail: 'The blue button opens the position. Cash is debited. You\'ll see it under Open Positions tab.' },
              { step: '8. Monitor', detail: 'Click ↻ Reval to refresh prices. Your unrealized P&L updates in real time during market hours (auto every 15 min).' },
            ].map(({ step, detail }) => (
              <div key={step} style={{ display: 'flex', gap: 12, marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
                <div style={{ minWidth: 28, height: 28, borderRadius: '50%', background: 'var(--cyan-bg)', color: 'var(--cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--mono)', flexShrink: 0 }}>{step.split('.')[0]}</div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{step.split('. ')[1]}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      title: '📉 Step-by-Step: Buy Your First Put',
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>Scenario: You think <strong>AAPL</strong> is going to drop after earnings.</p>
          {[
            { step: '1. Enter AAPL', detail: 'Type "AAPL", Load → pick an expiry just after the earnings date → Fetch Chain.' },
            { step: '2. Click on the PUT side', detail: 'Puts are on the RIGHT side of the chain. Click on a strike slightly below the current price (OTM put, cheaper) or right at it (ATM put, more expensive but higher chance of profit).' },
            { step: '3. Note the negative delta', detail: 'Put deltas are negative (e.g. -0.40). This means the option gains value as the stock falls — $1 drop → +$40 per contract.' },
            { step: '4. BUY → set quantity → Submit', detail: 'Same flow as the call. Your max loss is limited to the premium paid. If AAPL crashes, the put can multiply in value.' },
            { step: '5. Check the scenario grid', detail: 'Look at the bottom rows (lower stock prices) — those show your profit territory. The breakeven is your strike minus the premium paid.' },
          ].map(({ step, detail }) => (
            <div key={step} style={{ display: 'flex', gap: 12, marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 28, height: 28, borderRadius: '50%', background: '#fef2f2', color: '#b91c1c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--mono)', flexShrink: 0 }}>{step.split('.')[0]}</div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>{step.split('. ')[1]}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{detail}</div>
              </div>
            </div>
          ))}
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 12px', marginTop: 8 }}>
            <strong>⚠️ Risk reminder:</strong> <span style={{ fontSize: '0.82rem' }}>When buying options, your maximum loss is always the premium you paid — never more. A $320 call can only lose $320.</span>
          </div>
        </div>
      ),
    },
    {
      title: '🔀 Multi-Leg Strategies',
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>Multi-leg strategies combine two options to reduce cost or cap risk. Available under the <strong>Spreads</strong> tab in the builder.</p>
          {[
            { name: 'Bull Call Spread', when: 'You\'re moderately bullish.', how: 'Buy a lower-strike call + Sell a higher-strike call. The premium from the sell reduces your cost. Profit is capped between the two strikes.', example: 'SPY @ $585. Buy $585 call, Sell $590 call. Net cost: ~$1.50. Max profit: $3.50. Max loss: $1.50.' },
            { name: 'Bear Put Spread', when: 'You\'re moderately bearish.', how: 'Buy a higher-strike put + Sell a lower-strike put. Cheaper than a straight put. Profit is capped.', example: 'SPY @ $585. Buy $585 put, Sell $580 put. Net cost: ~$1.80. Max profit: $3.20. Max loss: $1.80.' },
            { name: 'Long Straddle', when: 'You expect a big move but don\'t know the direction (e.g. before earnings).', how: 'Buy a call AND a put at the same strike. You profit if the stock moves significantly in either direction.', example: 'NVDA before earnings. Buy $800 call + Buy $800 put. Total cost: $25. Profitable if NVDA moves more than $25 either way.' },
            { name: 'Long Strangle', when: 'Same as straddle but cheaper.', how: 'Buy an OTM call + Buy an OTM put. Cheaper than a straddle, but needs a bigger move.', example: 'NVDA $800. Buy $820 call + Buy $780 put. Cost: ~$18. Needs >$18 move either way.' },
          ].map(({ name, when, how, example }) => (
            <div key={name} style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--panel-inset)', borderRadius: 6 }}>
              <div style={{ fontWeight: 700, color: 'var(--cyan)', marginBottom: 4 }}>{name}</div>
              <div style={{ fontSize: '0.8rem', marginBottom: 4 }}><strong>When:</strong> {when}</div>
              <div style={{ fontSize: '0.8rem', marginBottom: 4 }}><strong>How:</strong> {how}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>Example: {example}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: '⚠️ Risk & Best Practices',
      content: (
        <div>
          {[
            { icon: '🛡️', title: 'Max loss = premium paid', text: 'When you buy options (calls or puts), you can never lose more than what you paid. A $200 option can lose at most $200.' },
            { icon: '⏳', title: 'Time is your enemy as a buyer', text: 'Every day that passes, theta eats away at your option\'s value. If the stock doesn\'t move, you\'ll lose money slowly. Always be aware of DTE.' },
            { icon: '📅', title: 'Choose enough time', text: 'Beginners often pick options that expire too soon. Give your thesis at least 30-45 days. A stock can take time to move in your direction.' },
            { icon: '💧', title: 'Check liquidity', text: 'Only trade options with decent open interest (> 500) and tight bid-ask spreads. Wide spreads cost you money on entry and exit.' },
            { icon: '🎯', title: 'Have an exit plan before you enter', text: 'Decide in advance: if this option reaches +50% profit, I sell. If it hits -30%, I cut the loss. Discipline beats hope.' },
            { icon: '🚨', title: 'Watch the alerts panel', text: 'This simulator flags positions approaching expiry (≤21 DTE), large theta drain, and big gains/losses. Act on them — expired options are worthless.' },
          ].map(({ icon, title, text }) => (
            <div key={title} style={{ display: 'flex', gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: '1.2rem' }}>{icon}</span>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>{title}</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>{text}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ]

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--panel)', borderRadius: 12, width: 720, maxWidth: '95vw',
        maxHeight: '85vh', display: 'flex', overflow: 'hidden',
        border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }} onClick={e => e.stopPropagation()}>
        {/* Sidebar */}
        <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--border)', background: '#ffffff', overflowY: 'auto', padding: '16px 0' }}>
          <div style={{ padding: '0 16px 12px', fontWeight: 800, fontSize: '0.72rem', color: 'var(--cyan)', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>Options Guide</div>
          {sections.map((s, i) => (
            <button key={i}
              onClick={() => setSection(i)}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none',
                background: section === i ? 'var(--cyan-bg)' : 'none',
                color: section === i ? 'var(--cyan)' : 'var(--text)',
                fontSize: '0.75rem', fontWeight: section === i ? 700 : 400,
                cursor: 'pointer', lineHeight: 1.4,
              }}>{s.title}</button>
          ))}
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-bright)' }}>{sections[section].title}</h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)', padding: '0 4px' }}>✕</button>
          </div>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.65 }}>{sections[section].content}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <button className="btn sm" disabled={section === 0} onClick={() => setSection(s => s - 1)}>← Previous</button>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{section + 1} / {sections.length}</span>
            <button className="btn sm" disabled={section === sections.length - 1} onClick={() => setSection(s => s + 1)}>Next →</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Account Bar ───────────────────────────────────────────────────────────────

// ── Portfolio Panel (home tab) ────────────────────────────────────────────────

interface BenchmarkPoint { date: string; price: number; return_pct: number }

// ── Advisory engine (rules-based, zero API cost) ─────────────────────────────

interface Advisory {
  verdict: 'HOLD' | 'WATCH' | 'EXIT'
  color: string; bg: string
  summary: string
  bullets: string[]
  stopHint: string
  targetHint: string
}

function getAdvisory(pos: Position, leg: Leg, dteVal: number, pnlPct: number, underlying: number | null): Advisory {
  const isLong  = leg.action === 'BUY'
  const isCall  = leg.option_type.toLowerCase() === 'call'
  const theta   = leg.current_theta ?? leg.theta_at_entry ?? 0
  const thetaDay = Math.abs(theta) * 100 * leg.quantity
  const delta   = Math.abs(leg.current_delta ?? leg.delta_at_entry ?? 0)
  const breakeven = isCall ? leg.strike + leg.fill_price : leg.strike - leg.fill_price
  const beDist  = underlying ? ((breakeven - underlying) / underlying * 100) : null
  const aboveBE = underlying ? (isCall ? underlying >= breakeven : underlying <= breakeven) : null

  // ── Verdict rules ──
  let verdict: 'HOLD' | 'WATCH' | 'EXIT' = 'HOLD'
  const bullets: string[] = []

  // Hard EXIT signals
  if (dteVal < 7) {
    verdict = 'EXIT'
    bullets.push(`Only ${dteVal} days left — options lose value extremely fast this close to expiry.`)
  } else if (pnlPct <= -45) {
    verdict = 'EXIT'
    bullets.push(`Down ${pnlPct.toFixed(1)}% — at this loss level you're better off cutting and redeploying.`)
  } else if (pnlPct >= 60 && dteVal < 30) {
    verdict = 'EXIT'
    bullets.push(`Up ${pnlPct.toFixed(1)}% with only ${dteVal} days left — capturing gains now reduces risk of reversal.`)
  }

  // WATCH signals (if not already EXIT)
  if (verdict === 'HOLD') {
    if (dteVal <= 21) {
      verdict = 'WATCH'
      bullets.push(`${dteVal} DTE — theta decay accelerates inside 21 days. Review daily.`)
    }
    if (pnlPct >= 40) {
      verdict = 'WATCH'
      bullets.push(`Up ${pnlPct.toFixed(1)}% — consider taking partial profits or moving your mental stop up.`)
    }
    if (pnlPct <= -25) {
      verdict = 'WATCH'
      bullets.push(`Down ${pnlPct.toFixed(1)}% — position under pressure. Confirm your original thesis still holds.`)
    }
    if (delta < 0.3 && dteVal < 30) {
      verdict = verdict === 'HOLD' ? 'WATCH' : verdict
      bullets.push(`Delta ${delta.toFixed(2)} — this option is far out of the money. A big move is needed to profit.`)
    }
  }

  // Contextual bullets (always shown)
  if (thetaDay > 0)
    bullets.push(`Theta drain: losing $${thetaDay.toFixed(2)}/day automatically — ${dteVal} days × $${thetaDay.toFixed(2)} = $${(thetaDay * dteVal).toFixed(0)} potential remaining decay.`)

  if (beDist != null && !aboveBE)
    bullets.push(`Stock is ${Math.abs(beDist).toFixed(1)}% away from your breakeven ($${breakeven.toFixed(2)}). The stock needs to ${isCall ? 'rise' : 'fall'} to be profitable at expiry.`)
  else if (beDist != null && aboveBE)
    bullets.push(`You're already above breakeven ($${breakeven.toFixed(2)}) — the position is profitable at expiry if held here.`)

  if (verdict === 'HOLD' && bullets.length === 0)
    bullets.push(`Position is on track with ${dteVal} days remaining. No immediate action needed.`)

  const stopHint  = isLong
    ? `Mental stop: exit if option loses ~40% of value (worth ~$${((leg.fill_price * 100 * leg.quantity) * 0.6).toFixed(0)}).`
    : `Manage risk: buy back if position moves against you more than 2×.`
  const targetHint = isLong
    ? `Profit target: consider exiting at ~50% gain ($${((Math.abs(pos.total_cost)) * 1.5).toFixed(0)} total value).`
    : `Target: buy back at 50% of credit received.`

  const summary =
    verdict === 'EXIT'  ? `Time to exit — ${bullets[0].split('—')[1]?.trim() ?? 'exit now'}` :
    verdict === 'WATCH' ? `Monitor closely — ${bullets[0].split('—')[1]?.trim() ?? 'review daily'}` :
                          `Hold — position on track, ${dteVal} days remaining`

  const color = verdict === 'EXIT' ? '#dc2626' : verdict === 'WATCH' ? '#d97706' : '#16a34a'
  const bg    = verdict === 'EXIT' ? '#fef2f2' : verdict === 'WATCH' ? '#fffbeb' : '#f0fdf4'

  return { verdict, color, bg, summary, bullets, stopHint, targetHint }
}

function PortfolioPanel() {
  const [account, setAccount]         = useState<Account | null>(null)
  const [positions, setPositions]     = useState<Position[]>([])
  const [closedPos, setClosedPos]     = useState<Position[]>([])
  const [perfCurve, setPerfCurve]     = useState<PerfPoint[]>([])
  const [benchmark, setBenchmark]     = useState<BenchmarkPoint[]>([])
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [nextRefresh, setNextRefresh] = useState<string | null>(null)
  const [reval, setReval]             = useState(false)
  const [sort, setSort]               = useState<{ col: string; dir: 1 | -1 }>({ col: 'pnl', dir: -1 })
  const [expandedPos, setExpandedPos] = useState<number | null>(null)
  const [showMathFor, setShowMathFor] = useState<number | null>(null)
  const [underlyings, setUnderlyings] = useState<Record<string, number>>({})
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [now, setNow]                 = useState(new Date())

  const loadData = useCallback(async () => {
    try {
      const [acctR, openR, closedR, perfR, benchR] = await Promise.all([
        getOptionsAccount(), getOpenPositions(), getClosedPositions(),
        getOptionsPerformance(90), getOptionsBenchmark(90),
      ])
      setAccount(acctR.data.account)
      const openPositions: Position[] = openR.data.positions ?? []
      setPositions(openPositions)
      setClosedPos(closedR.data.positions ?? [])
      setPerfCurve(perfR.data.curve ?? [])
      setBenchmark(benchR.data.benchmark ?? [])
      setLastRefreshed(new Date())

      // Fetch current underlying price for each unique ticker
      const tickers = [...new Set(openPositions.map(p => p.ticker))]
      const entries = await Promise.all(
        tickers.map(t => getUnderlying(t).then(r => [t, r.data.price] as [string, number]).catch(() => [t, 0] as [string, number]))
      )
      setUnderlyings(Object.fromEntries(entries))
    } catch { /* ignore */ }
    // Pull next revalue time from health endpoint
    try {
      const { default: axios } = await import('axios')
      const h = await axios.get('/api/health')
      const revalJob = (h.data.scheduler_jobs ?? []).find((j: any) => j.id === 'options_revalue')
      if (revalJob) setNextRefresh(revalJob.next_run)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadData()
    timerRef.current = setInterval(() => setNow(new Date()), 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [loadData])

  async function handleRevalue() {
    setReval(true)
    try { await triggerRevalue(); await loadData() } catch { /* ignore */ }
    setReval(false)
  }

  // ── Build combined chart data ───────────────────────────────────────────────
  const chartData = (() => {
    if (!perfCurve.length && !benchmark.length) return []
    const initial = account?.initial_capital ?? 10000
    const benchBase = benchmark[0]?.price ?? 1
    const allDates = Array.from(new Set([
      ...perfCurve.map(p => p.date),
      ...benchmark.map(b => b.date),
    ])).sort()
    const perfMap = new Map(perfCurve.map(p => [p.date, p.net_liq]))
    const benchMap = new Map(benchmark.map(b => [b.date, b.price]))
    return allDates.map(date => ({
      date,
      portfolio: perfMap.has(date) ? round2((perfMap.get(date)! - initial) / initial * 100) : null,
      spy: benchMap.has(date) ? round2((benchMap.get(date)! - benchBase) / benchBase * 100) : null,
    }))
  })()

  // ── Monthly gains bar data ──────────────────────────────────────────────────
  const monthlyData = (() => {
    const months: Record<string, { portfolio: number | null; spy: number | null; portStart: number; portEnd: number; spyStart: number; spyEnd: number }> = {}
    const initial = account?.initial_capital ?? 10000
    const benchBase = benchmark[0]?.price ?? 1

    perfCurve.forEach(p => {
      const mo = p.date.slice(0, 7)
      if (!months[mo]) months[mo] = { portfolio: null, spy: null, portStart: p.net_liq, portEnd: p.net_liq, spyStart: 0, spyEnd: 0 }
      else months[mo].portEnd = p.net_liq
    })
    benchmark.forEach(b => {
      const mo = b.date.slice(0, 7)
      if (months[mo]) {
        if (!months[mo].spyStart) months[mo].spyStart = b.price
        months[mo].spyEnd = b.price
      }
    })
    return Object.entries(months).sort().map(([mo, v]) => {
      const portPct = v.portStart > 0 ? round2((v.portEnd - v.portStart) / initial * 100) : 0
      const spyPct  = v.spyStart  > 0 ? round2((v.spyEnd  - v.spyStart) / benchBase  * 100) : 0
      const label = new Date(mo + '-01').toLocaleString('en-US', { month: 'short', year: '2-digit' })
      return { label, portfolio: portPct, spy: spyPct }
    })
  })()

  // ── Sorted position rows ────────────────────────────────────────────────────
  const sortedPositions = [...positions].sort((a, b) => {
    const pnlA = computeTotalPnl(a)
    const pnlB = computeTotalPnl(b)
    if (sort.col === 'pnl')  return sort.dir * (pnlA - pnlB)
    if (sort.col === 'cost') return sort.dir * (Math.abs(a.total_cost) - Math.abs(b.total_cost))
    if (sort.col === 'dte') {
      const dteA = a.legs[0] ? dte(a.legs[0].expiry) : 0
      const dteB = b.legs[0] ? dte(b.legs[0].expiry) : 0
      return sort.dir * (dteA - dteB)
    }
    return 0
  })

  function toggleSort(col: string) {
    setSort(s => ({ col, dir: s.col === col ? (-s.dir as 1 | -1) : -1 }))
  }

  const staleMin = positions[0]?.last_revalued_at
    ? Math.round((now.getTime() - new Date(positions[0].last_revalued_at).getTime()) / 60000)
    : null

  const nextRefreshFmt = nextRefresh
    ? new Date(nextRefresh).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div style={{ padding: '14px 20px', maxWidth: 1400, margin: '0 auto' }}>

      {/* ── Refresh status bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 14px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          {lastRefreshed
            ? <>Last refreshed: <strong style={{ color: 'var(--text)' }}>{lastRefreshed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></>
            : 'Loading…'}
          {staleMin != null && staleMin > 5 && (
            <span style={{ color: '#92400e', marginLeft: 6 }}>· Prices {staleMin}m old</span>
          )}
        </span>
        {nextRefreshFmt && (
          <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
            · Auto-refresh: <strong style={{ color: 'var(--text)' }}>{nextRefreshFmt}</strong>
          </span>
        )}
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={handleRevalue} disabled={reval}>
          {reval ? '…' : '↻ Refresh Now'}
        </button>
      </div>

      {/* ── KPI summary cards ── */}
      {account && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            {
              label: 'Net Liquidation Value',
              value: fmt$(account.net_liq),
              sub: `vs $${account.initial_capital.toLocaleString()} starting`,
              color: 'var(--cyan)',
            },
            {
              label: 'Total Return',
              value: fmtPct(account.total_return_pct),
              sub: `P&L: ${fmt$(account.total_pnl)}`,
              color: account.total_return_pct >= 0 ? 'var(--green)' : 'var(--red)',
            },
            {
              label: 'Unrealized P&L',
              value: fmt$(account.unrealized_pnl),
              sub: `Realized: ${fmt$(account.realized_pnl)}`,
              color: (account.unrealized_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
            },
            {
              label: 'Cash Available',
              value: fmt$(account.cash),
              sub: `${positions.length} open · ${closedPos.length} closed`,
              color: 'var(--text)',
            },
          ].map(({ label, value, sub, color }) => (
            <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 6 }}>{label}</div>
              <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '1.18rem', color }}>{value}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Charts row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 16 }}>

        {/* Equity curve vs SPY */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>Portfolio vs SPY — Return %</span>
            <div style={{ display: 'flex', gap: 12, fontSize: '0.67rem', color: 'var(--text-dim)' }}>
              <span><span style={{ color: 'var(--cyan)', fontWeight: 700 }}>—</span> Your Portfolio</span>
              <span><span style={{ color: '#f59e0b', fontWeight: 700 }}>- -</span> SPY</span>
            </div>
          </div>
          {chartData.length < 2 ? (
            <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Not enough history yet — chart will populate as daily snapshots accumulate
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="portGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--cyan)" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="var(--cyan)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--mono)' }}
                  tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--mono)' }}
                  tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`} />
                <Tooltip formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v?.toFixed(2)}%`, name === 'portfolio' ? 'Portfolio' : 'SPY']}
                  labelFormatter={l => l} contentStyle={{ fontSize: '0.72rem', fontFamily: 'var(--mono)' }} />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="portfolio" stroke="var(--cyan)" strokeWidth={2}
                  fill="url(#portGrad)" dot={false} connectNulls />
                <Line type="monotone" dataKey="spy" stroke="#f59e0b" strokeWidth={1.5}
                  strokeDasharray="5 3" dot={false} connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Monthly P&L bars */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)', marginBottom: 10 }}>
            Monthly P&L vs SPY
          </div>
          {monthlyData.length === 0 ? (
            <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              No monthly data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--mono)' }} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--mono)' }} tickFormatter={v => `${v.toFixed(1)}%`} />
                <Tooltip formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v?.toFixed(2)}%`, name === 'portfolio' ? 'Portfolio' : 'SPY']}
                  contentStyle={{ fontSize: '0.72rem', fontFamily: 'var(--mono)' }} />
                <Bar dataKey="portfolio" name="Portfolio" radius={[2, 2, 0, 0]}>
                  {monthlyData.map((d, i) => (
                    <Cell key={i} fill={d.portfolio >= 0 ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
                <Bar dataKey="spy" name="SPY" fill="#f59e0b" opacity={0.5} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Open Positions table ── */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--panel-inset)' }}>
          <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>
            Open Positions
          </span>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', background: 'var(--border)', borderRadius: 10, padding: '1px 8px', fontFamily: 'var(--mono)' }}>
            {positions.length}
          </span>
          {staleMin != null && staleMin > 15 && (
            <span style={{ fontSize: '0.65rem', color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, padding: '2px 8px' }}>
              ⚠ {staleMin}m since last price update
            </span>
          )}
        </div>

        {positions.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
            No open positions. Use the Trading Desk tab to enter a trade.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {[
                    { key: null,    label: 'Position' },
                    { key: null,    label: 'Strategy' },
                    { key: 'dte',   label: 'Expiry / DTE' },
                    { key: 'cost',  label: 'Entry' },
                    { key: null,    label: 'Current' },
                    { key: 'pnl',   label: 'Unrealized P&L' },
                    { key: null,    label: 'Greeks' },
                    { key: null,    label: "Today's Call" },
                  ].map(({ key, label }) => (
                    <th key={label} onClick={key ? () => toggleSort(key) : undefined}
                      style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: '0.62rem',
                        textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)',
                        fontFamily: 'var(--mono)', cursor: key ? 'pointer' : 'default',
                        userSelect: 'none', whiteSpace: 'nowrap',
                        background: sort.col === key ? 'var(--panel-inset)' : undefined }}>
                      {label}{key && sort.col === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map(pos => {
                  const totalPnl    = computeTotalPnl(pos)
                  const totalCost   = Math.abs(pos.total_cost)
                  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0
                  const firstLeg    = pos.legs[0]
                  const currVal     = pos.legs.reduce((sum, l) => {
                    const cp = l.current_price ?? l.fill_price
                    return sum + (l.action === 'BUY' ? 1 : -1) * cp * 100 * l.quantity
                  }, 0)
                  const dteVal      = firstLeg ? dte(firstLeg.expiry) : 0
                  const delta       = firstLeg?.current_delta ?? firstLeg?.delta_at_entry
                  const theta       = firstLeg?.current_theta ?? firstLeg?.theta_at_entry
                  const iv          = firstLeg?.current_iv ?? firstLeg?.iv_at_entry
                  const underlying  = underlyings[pos.ticker] ?? null
                  const advisory    = firstLeg ? getAdvisory(pos, firstLeg, dteVal, totalPnlPct, underlying) : null
                  const isExpanded  = expandedPos === pos.id
                  const mathOpen    = showMathFor === pos.id

                  // Breakeven for single-leg
                  const isCall     = firstLeg?.option_type.toLowerCase() === 'call'
                  const breakeven  = firstLeg
                    ? (isCall ? firstLeg.strike + firstLeg.fill_price : firstLeg.strike - firstLeg.fill_price)
                    : null
                  const beDistAbs  = breakeven && underlying ? Math.abs(breakeven - underlying) : null
                  const bePct      = breakeven && underlying ? ((breakeven - underlying) / underlying * 100) : null
                  const aboveBE    = breakeven && underlying ? (isCall ? underlying >= breakeven : underlying <= breakeven) : null

                  return (
                    <Fragment key={pos.id}>
                    <tr
                      style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                        cursor: 'pointer', transition: 'background 0.1s',
                        background: isExpanded ? 'var(--panel-inset)' : undefined }}
                      onClick={() => setExpandedPos(isExpanded ? null : pos.id)}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'var(--panel-inset)' }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = '' }}>

                      {/* Position */}
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        <div style={{ fontWeight: 800, fontSize: '0.82rem', color: 'var(--text-bright)' }}>{pos.ticker}</div>
                        {firstLeg && (
                          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 2 }}>
                            <span style={{ color: firstLeg.action === 'BUY' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                              {firstLeg.action}
                            </span>
                            {' '}{firstLeg.quantity}× {firstLeg.option_type.toUpperCase()} K=${firstLeg.strike}
                          </div>
                        )}
                      </td>

                      {/* Strategy */}
                      <td style={{ padding: '9px 10px' }}>
                        <span style={{ fontSize: '0.68rem', background: 'var(--panel-inset)', padding: '2px 7px', borderRadius: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                          {pos.strategy_label}
                        </span>
                        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginTop: 3 }}>
                          Opened {new Date(pos.open_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      </td>

                      {/* Expiry / DTE */}
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        {firstLeg && (
                          <>
                            <div style={{ fontSize: '0.72rem' }}>{firstLeg.expiry}</div>
                            <div style={{ fontSize: '0.65rem', marginTop: 2,
                              color: dteVal <= 7 ? 'var(--red)' : dteVal <= 21 ? '#d97706' : 'var(--text-dim)' }}>
                              {dteVal}d left{dteVal <= 7 ? ' ⚠' : ''}
                            </div>
                            {/* DTE progress bar */}
                            {(() => {
                              const totalDays = Math.max(1, Math.round((new Date(firstLeg.expiry).getTime() - new Date(pos.open_date).getTime()) / 86400000))
                              const pct = Math.max(0, Math.min(100, ((totalDays - dteVal) / totalDays) * 100))
                              return (
                                <div style={{ height: 3, width: 60, background: 'var(--border)', borderRadius: 2, marginTop: 4 }}>
                                  <div style={{ height: '100%', width: `${pct}%`, borderRadius: 2,
                                    background: pct > 75 ? 'var(--red)' : pct > 50 ? '#d97706' : 'var(--cyan)' }} />
                                </div>
                              )
                            })()}
                          </>
                        )}
                      </td>

                      {/* Entry */}
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        {firstLeg && (
                          <>
                            <div style={{ fontSize: '0.72rem' }}>${firstLeg.fill_price.toFixed(2)}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>/sh</span></div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>{fmt$(totalCost)} total</div>
                          </>
                        )}
                      </td>

                      {/* Current */}
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        {firstLeg && (() => {
                          const cp = firstLeg.current_price ?? firstLeg.fill_price
                          return (
                            <>
                              <div style={{ fontSize: '0.72rem' }}>${cp.toFixed(2)}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>/sh</span></div>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>{fmt$(currVal)} value</div>
                            </>
                          )
                        })()}
                      </td>

                      {/* Unrealized P&L — with ⓘ info toggle */}
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '0.82rem', color: totalPnl > 0 ? 'var(--green)' : totalPnl < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                              {totalPnl >= 0 ? '+' : ''}{fmt$(totalPnl)}
                            </div>
                            <div style={{ fontSize: '0.65rem', marginTop: 2,
                              color: totalPnlPct > 0 ? 'var(--green)' : totalPnlPct < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                              {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%
                            </div>
                          </div>
                          <button
                            onClick={e => { e.stopPropagation(); setShowMathFor(mathOpen ? null : pos.id); setExpandedPos(pos.id) }}
                            title="How is this calculated?"
                            style={{ background: mathOpen ? 'var(--cyan-bg)' : 'var(--panel-inset)',
                              border: `1px solid ${mathOpen ? 'var(--cyan)' : 'var(--border)'}`,
                              borderRadius: '50%', width: 18, height: 18, cursor: 'pointer',
                              fontSize: '0.6rem', color: mathOpen ? 'var(--cyan)' : 'var(--text-dim)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              flexShrink: 0, fontWeight: 700, lineHeight: 1 }}>
                            ⓘ
                          </button>
                        </div>
                      </td>

                      {/* Greeks */}
                      <td style={{ padding: '9px 10px', fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                        {delta != null && <div>Δ <strong style={{ color: 'var(--text)' }}>{delta.toFixed(2)}</strong></div>}
                        {theta != null && <div>θ <strong style={{ color: 'var(--red)' }}>${(Math.abs(theta) * 100 * (firstLeg?.quantity ?? 1)).toFixed(2)}/d</strong></div>}
                        {iv != null && <div>IV <strong style={{ color: 'var(--text)' }}>{iv.toFixed(1)}%</strong></div>}
                      </td>

                      {/* Today's Call — verdict badge */}
                      <td style={{ padding: '9px 10px' }} onClick={e => e.stopPropagation()}>
                        {advisory && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <button
                              onClick={() => setExpandedPos(isExpanded ? null : pos.id)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '3px 10px', borderRadius: 20, border: `1px solid ${advisory.color}`,
                                background: advisory.bg, color: advisory.color,
                                fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.68rem',
                                cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              {advisory.verdict === 'HOLD' ? '🟢' : advisory.verdict === 'WATCH' ? '🟡' : '🔴'}
                              {' '}{advisory.verdict}
                            </button>
                            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', maxWidth: 120, lineHeight: 1.3 }}>
                              {isExpanded ? 'Click to collapse ▲' : 'Click for details ▼'}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>

                    {/* ── Expanded advisory panel ── */}
                    {isExpanded && advisory && firstLeg && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <div style={{ padding: '14px 16px', background: 'var(--panel-inset)', borderTop: `2px solid ${advisory.color}` }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

                              {/* Column 1 — Advisory */}
                              <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: `1px solid ${advisory.color}33` }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                  <span style={{ fontWeight: 800, fontSize: '0.8rem', color: advisory.color }}>
                                    {advisory.verdict === 'HOLD' ? '🟢 HOLD' : advisory.verdict === 'WATCH' ? '🟡 WATCH' : '🔴 EXIT'}
                                  </span>
                                  <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>Today's guidance</span>
                                </div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--text)', fontWeight: 600, marginBottom: 8, lineHeight: 1.4 }}>
                                  {advisory.summary}
                                </div>
                                {advisory.bullets.map((b, i) => (
                                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: '0.69rem', color: 'var(--text-dim)', lineHeight: 1.45 }}>
                                    <span style={{ color: advisory.color, flexShrink: 0, marginTop: 1 }}>•</span>
                                    <span>{b}</span>
                                  </div>
                                ))}
                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <div style={{ fontSize: '0.65rem', color: '#16a34a' }}>🎯 {advisory.targetHint}</div>
                                  <div style={{ fontSize: '0.65rem', color: '#dc2626' }}>🛑 {advisory.stopHint}</div>
                                </div>
                              </div>

                              {/* Column 2 — Breakeven & distance */}
                              <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.74rem', color: 'var(--text-bright)', marginBottom: 10 }}>
                                  📍 Breakeven Analysis
                                </div>
                                {breakeven && (
                                  <>
                                    <div style={{ marginBottom: 8 }}>
                                      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 3 }}>Breakeven at expiry</div>
                                      <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.9rem', color: 'var(--text-bright)' }}>
                                        ${breakeven.toFixed(2)}
                                        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 400, marginLeft: 4 }}>per share</span>
                                      </div>
                                      <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>
                                        {isCall ? `Strike $${firstLeg.strike} + $${firstLeg.fill_price.toFixed(2)} premium` : `Strike $${firstLeg.strike} − $${firstLeg.fill_price.toFixed(2)} premium`}
                                      </div>
                                    </div>

                                    {underlying && (
                                      <div style={{ marginBottom: 8 }}>
                                        <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 3 }}>Current {pos.ticker} price</div>
                                        <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.84rem' }}>${underlying.toFixed(2)}</div>
                                      </div>
                                    )}

                                    {beDistAbs != null && bePct != null && (
                                      <div style={{ padding: '8px 10px', borderRadius: 6,
                                        background: aboveBE ? '#f0fdf4' : '#fef3c7',
                                        border: `1px solid ${aboveBE ? '#86efac' : '#fcd34d'}` }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.72rem',
                                          color: aboveBE ? '#15803d' : '#92400e' }}>
                                          {aboveBE
                                            ? `✅ Already above breakeven by $${beDistAbs.toFixed(2)} (${Math.abs(bePct).toFixed(1)}%)`
                                            : `⚠️ $${beDistAbs.toFixed(2)} below breakeven — need ${Math.abs(bePct).toFixed(1)}% move`}
                                        </div>
                                        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 3 }}>
                                          {isCall
                                            ? `${pos.ticker} needs to ${aboveBE ? 'stay above' : `rise ${Math.abs(bePct).toFixed(1)}% to reach`} $${breakeven.toFixed(2)} to profit at expiry`
                                            : `${pos.ticker} needs to ${aboveBE ? 'stay below' : `fall ${Math.abs(bePct).toFixed(1)}% to reach`} $${breakeven.toFixed(2)} to profit at expiry`}
                                        </div>
                                      </div>
                                    )}

                                    {/* DTE timeline */}
                                    <div style={{ marginTop: 10 }}>
                                      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 5 }}>Time decay zones</div>
                                      {[
                                        { label: '45+ DTE', note: 'Slow theta. You have time.', active: dteVal >= 45 },
                                        { label: '21–45 DTE', note: 'Moderate decay. Monitor weekly.', active: dteVal >= 21 && dteVal < 45 },
                                        { label: '7–21 DTE', note: '⚠️ Theta accelerating. Review daily.', active: dteVal >= 7 && dteVal < 21 },
                                        { label: '<7 DTE', note: '🔴 Critical. Exit or roll urgently.', active: dteVal < 7 },
                                      ].map(({ label, note, active }) => (
                                        <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4,
                                          opacity: active ? 1 : 0.45 }}>
                                          <div style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 3, flexShrink: 0,
                                            background: active ? advisory.color : 'var(--border)' }} />
                                          <div style={{ fontSize: '0.63rem', lineHeight: 1.3 }}>
                                            <strong style={{ color: active ? advisory.color : 'var(--text-dim)' }}>{label}</strong>
                                            <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>{note}</span>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </div>

                              {/* Column 3 — P&L Math */}
                              <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                  <div style={{ fontWeight: 700, fontSize: '0.74rem', color: 'var(--text-bright)' }}>
                                    🧮 How P&L is calculated
                                  </div>
                                </div>
                                {(() => {
                                  const entryPremium = firstLeg.fill_price
                                  const currPremium  = firstLeg.current_price ?? firstLeg.fill_price
                                  const qty          = firstLeg.quantity
                                  const multiplier   = 100
                                  const entryCost    = entryPremium * multiplier * qty
                                  const currValue    = currPremium  * multiplier * qty
                                  const pnl          = (firstLeg.action === 'BUY' ? 1 : -1) * (currPremium - entryPremium) * multiplier * qty
                                  return (
                                    <div style={{ fontSize: '0.69rem', lineHeight: 1.7, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                                      <div style={{ marginBottom: 6 }}>
                                        <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Entry cost</div>
                                        <div>${entryPremium.toFixed(2)} × {multiplier} shares × {qty} contract{qty > 1 ? 's' : ''}</div>
                                        <div style={{ color: 'var(--text)', fontWeight: 700 }}>= {fmt$(entryCost)}</div>
                                      </div>
                                      <div style={{ marginBottom: 6 }}>
                                        <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current value</div>
                                        <div>${currPremium.toFixed(2)} × {multiplier} × {qty}</div>
                                        <div style={{ color: 'var(--text)', fontWeight: 700 }}>= {fmt$(currValue)}</div>
                                      </div>
                                      <div style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                                        <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Unrealized P&L</div>
                                        <div>{fmt$(currValue)} − {fmt$(entryCost)}</div>
                                        <div style={{ fontWeight: 800, fontSize: '0.82rem', color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                          = {pnl >= 0 ? '+' : ''}{fmt$(pnl)}{' '}
                                          <span style={{ fontSize: '0.65rem', fontWeight: 600 }}>
                                            ({pnl >= 0 ? '+' : ''}{entryCost > 0 ? ((pnl / entryCost) * 100).toFixed(2) : '0.00'}%)
                                          </span>
                                        </div>
                                      </div>
                                      <div style={{ marginTop: 10, padding: '6px 8px', background: 'var(--panel-inset)', borderRadius: 5, fontSize: '0.62rem', color: 'var(--text-dim)', lineHeight: 1.5, fontFamily: 'var(--sans)' }}>
                                        Each contract = 100 shares. You don't own shares directly — you own the <em>right</em> to buy them at ${firstLeg.strike}. The option's price moves with the stock.
                                      </div>
                                    </div>
                                  )
                                })()}
                              </div>

                            </div>
                              {(() => {
                                const d   = delta
                                const th  = theta
                                const vol = iv
                                const qty = firstLeg.quantity
                                const ul  = underlying
                                const dollarDelta = d != null ? Math.abs(d) * 100 * qty : null
                                const dailyDecay  = th != null ? Math.abs(th) * 100 * qty : null
                                const weekDecay   = dailyDecay != null ? dailyDecay * 5 : null
                                const dailyMovePct = vol != null ? vol / Math.sqrt(252) : null
                                const dailyMoveDollar = dailyMovePct != null && ul ? ul * (dailyMovePct / 100) : null
                                const ivLevel = vol == null ? '' : vol < 20 ? 'low' : vol < 35 ? 'normal' : vol < 55 ? 'elevated' : 'very high'
                                const ivColor = vol == null ? 'var(--text-dim)' : vol < 20 ? '#2563eb' : vol < 35 ? '#15803d' : vol < 55 ? '#d97706' : '#dc2626'
                                const popPct  = d != null ? Math.round(Math.abs(d) * 100) : null

                                const greeks = [
                                  d != null && {
                                    symbol: 'Δ', name: 'Delta', value: d.toFixed(2),
                                    color: Math.abs(d) >= 0.5 ? 'var(--cyan)' : Math.abs(d) >= 0.3 ? '#d97706' : 'var(--text-dim)',
                                    headline: dollarDelta != null
                                      ? `Option moves ~$${dollarDelta.toFixed(0)} per $1 move in ${pos.ticker}`
                                      : 'Sensitivity to stock price',
                                    explain: [
                                      `Delta of ${d.toFixed(2)} means for every $1 ${isCall ? 'rise' : 'fall'} in ${pos.ticker}, this option gains ~$${dollarDelta?.toFixed(0) ?? '?'}.`,
                                      `It's roughly equivalent to owning ${Math.round(Math.abs(d) * 100 * qty)} virtual shares of ${pos.ticker}.`,
                                      popPct != null ? `Also read as ~${popPct}% probability this option expires in-the-money.` : '',
                                      Math.abs(d) < 0.3 ? `⚠️ Low delta — the option is far out-of-the-money. The stock needs a bigger move to profit.` : '',
                                      Math.abs(d) > 0.7 ? `High delta — option moves almost like stock. More expensive but more reactive.` : '',
                                    ].filter(Boolean),
                                  },
                                  th != null && {
                                    symbol: 'θ', name: 'Theta', value: `-$${dailyDecay?.toFixed(2) ?? '?'}/day`,
                                    color: (dailyDecay ?? 0) > 20 ? '#dc2626' : (dailyDecay ?? 0) > 8 ? '#d97706' : 'var(--text-dim)',
                                    headline: dailyDecay != null
                                      ? `Costs $${dailyDecay.toFixed(2)}/day just by holding — even if ${pos.ticker} doesn't move`
                                      : 'Daily time decay cost',
                                    explain: [
                                      `Options lose value every day as expiry approaches. This is called time decay (theta).`,
                                      dailyDecay != null ? `You're paying ~$${dailyDecay.toFixed(2)} per calendar day${weekDecay != null ? `, or ~$${weekDecay.toFixed(2)} per week` : ''} just for holding this position.` : '',
                                      dteVal <= 21
                                        ? `⚠️ With only ${dteVal} days left, theta is accelerating. Decay is fastest in the last 3 weeks.`
                                        : `With ${dteVal} DTE, decay is moderate. It speeds up significantly inside 21 days.`,
                                      `If ${pos.ticker} stays flat, this position loses value daily purely from time passing.`,
                                    ].filter(Boolean),
                                  },
                                  vol != null && {
                                    symbol: 'IV', name: 'Implied Volatility', value: `${vol.toFixed(1)}%`,
                                    color: ivColor,
                                    headline: dailyMoveDollar != null
                                      ? `Market expects ~$${dailyMoveDollar.toFixed(1)} daily swings in ${pos.ticker}`
                                      : `${ivLevel} IV — ${ivLevel === 'low' ? 'cheap options' : ivLevel === 'normal' ? 'fairly priced' : 'expensive options'}`,
                                    explain: [
                                      `IV measures how much the market expects ${pos.ticker} to swing. Higher IV = more expensive options.`,
                                      dailyMovePct != null ? `At ${vol.toFixed(1)}% IV, the market prices in ~${dailyMovePct.toFixed(1)}% daily moves${dailyMoveDollar != null ? ` (~$${dailyMoveDollar.toFixed(1)} on a $${ul?.toFixed(0)} stock)` : ''}.` : '',
                                      ivLevel === 'elevated' || ivLevel === 'very high'
                                        ? `⚠️ You bought at ${ivLevel} IV — if volatility falls (IV crush), your option can lose value even if the stock moves your way.`
                                        : `IV is ${ivLevel} — option pricing is relatively ${ivLevel === 'low' ? 'cheap' : 'reasonable'} right now.`,
                                    ].filter(Boolean),
                                  },
                                ].filter(Boolean) as { symbol: string; name: string; value: string; color: string; headline: string; explain: string[] }[]

                                if (greeks.length === 0) return null
                                return (
                                  <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                                      The Greeks — what each risk number means for this trade
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${greeks.length}, 1fr)`, gap: 10 }}>
                                      {greeks.map(g => (
                                        <div key={g.name} style={{ background: 'var(--panel)', borderRadius: 8, padding: '10px 12px', border: `1px solid ${g.color}33` }}>
                                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                                            <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: '1rem', color: g.color }}>{g.symbol}</span>
                                            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>{g.value}</span>
                                            <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{g.name}</span>
                                          </div>
                                          <div style={{ fontSize: '0.68rem', color: g.color, fontWeight: 600, marginBottom: 6, lineHeight: 1.35 }}>
                                            {g.headline}
                                          </div>
                                          {g.explain.map((line, i) => (
                                            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, fontSize: '0.63rem', color: 'var(--text-dim)', lineHeight: 1.45 }}>
                                              <span style={{ flexShrink: 0, marginTop: 1 }}>·</span>
                                              <span>{line}</span>
                                            </div>
                                          ))}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )
                              })()}

                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Closed Positions summary ── */}
      {closedPos.length > 0 && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--panel-inset)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>Closed Positions</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', background: 'var(--border)', borderRadius: 10, padding: '1px 8px', fontFamily: 'var(--mono)' }}>
              {closedPos.length}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Position', 'Strategy', 'Opened', 'Closed', 'Realized P&L', 'Return'].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: '0.62rem',
                      textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closedPos.map(pos => {
                  const pnl = pos.realized_pnl ?? 0
                  const pnlPct = Math.abs(pos.total_cost) > 0 ? (pnl / Math.abs(pos.total_cost)) * 100 : 0
                  const firstLeg = pos.legs[0]
                  return (
                    <tr key={pos.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                        <div style={{ fontWeight: 700 }}>{pos.ticker}</div>
                        {firstLeg && <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{firstLeg.action} {firstLeg.quantity}× {firstLeg.option_type.toUpperCase()} K=${firstLeg.strike}</div>}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        <span style={{ fontSize: '0.68rem', background: 'var(--panel-inset)', padding: '2px 7px', borderRadius: 10, fontFamily: 'var(--mono)' }}>{pos.strategy_label}</span>
                      </td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                        {new Date(pos.open_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                        {pos.close_date ? new Date(pos.close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)', fontWeight: 700, color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {pnl >= 0 ? '+' : ''}{fmt$(pnl)}
                      </td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)', color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── helpers used by PortfolioPanel ────────────────────────────────────────────

function round2(v: number) { return Math.round(v * 100) / 100 }

function dte(expiry: string) {
  return Math.max(0, Math.round((new Date(expiry).getTime() - Date.now()) / 86400000))
}

function computeTotalPnl(pos: Position): number {
  if (pos.status === 'CLOSED') return pos.realized_pnl ?? 0
  return pos.legs.reduce((sum, l) => {
    const cp = l.current_price ?? l.fill_price
    return sum + (l.action === 'BUY' ? 1 : -1) * (cp - l.fill_price) * 100 * l.quantity
  }, 0)
}

// ── Live Portfolio ────────────────────────────────────────────────────────────

interface LivePosition {
  id: number; ticker: string; action: string; option_type: string
  strike: number; expiry: string; fill_price: number; quantity: number
  strategy_label: string; open_date: string; status: string
  close_price: number | null; close_date: string | null
  commission: number; note: string | null
  current_price?: number | null
  current_delta?: number | null; current_theta?: number | null; current_iv?: number | null
  underlying_price?: number | null
}

function livePnl(p: LivePosition): number {
  const cp = p.current_price ?? p.fill_price
  return (p.action === 'BUY' ? 1 : -1) * (cp - p.fill_price) * 100 * p.quantity
}

function liveRealizedPnl(p: LivePosition): number {
  if (!p.close_price) return 0
  return (p.action === 'BUY' ? 1 : -1) * (p.close_price - p.fill_price) * 100 * p.quantity - p.commission
}

function liveAdvisory(p: LivePosition, dteVal: number, underlying: number | null): Advisory {
  const fakeLeg = {
    id: p.id, position_id: p.id, action: p.action, option_type: p.option_type,
    strike: p.strike, expiry: p.expiry, fill_price: p.fill_price, quantity: p.quantity,
    iv_at_entry: null, delta_at_entry: null, theta_at_entry: null, underlying_at_entry: null,
    current_price: p.current_price ?? null, current_delta: p.current_delta ?? null,
    current_theta: p.current_theta ?? null, current_iv: p.current_iv ?? null, status: 'OPEN',
  } as unknown as Leg
  const fakePos = {
    id: p.id, ticker: p.ticker, strategy_label: p.strategy_label, status: 'OPEN',
    open_date: p.open_date, total_cost: p.fill_price * 100 * p.quantity,
    legs: [fakeLeg], realized_pnl: null,
  } as unknown as Position
  const cost = p.fill_price * 100 * p.quantity
  const pnlPct = cost > 0 ? (livePnl(p) / cost) * 100 : 0
  return getAdvisory(fakePos, fakeLeg, dteVal, pnlPct, underlying)
}

const LIVE_EMPTY_FORM = {
  ticker: '', action: 'BUY', option_type: 'CALL',
  strike: '', expiry: '', fill_price: '', quantity: '1', commission: '0.65', note: '',
}

function LivePortfolioPanel() {
  const [open, setOpen]             = useState<LivePosition[]>([])
  const [closed, setClosed]         = useState<LivePosition[]>([])
  const [underlyings, setUnderlyings] = useState<Record<string, number>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showMathFor, setShowMathFor] = useState<number | null>(null)
  const [loading, setLoading]       = useState(false)
  const [showForm, setShowForm]     = useState(false)
  const [form, setForm]             = useState({ ...LIVE_EMPTY_FORM })
  const [formErr, setFormErr]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [closeModal, setCloseModal] = useState<{ id: number; ticker: string } | null>(null)
  const [closePrice, setClosePrice] = useState('')
  const [closeNote, setCloseNote]   = useState('')
  const [closing, setClosing]       = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [openR, closedR] = await Promise.all([getLivePositions(), getLiveClosedPositions()])
      const openPos: LivePosition[] = openR.data.positions ?? []
      setClosed(closedR.data.positions ?? [])

      const tickers = [...new Set(openPos.map(p => p.ticker))]
      const ulEntries = await Promise.all(
        tickers.map(t =>
          getUnderlying(t).then(r => [t, r.data.price] as [string, number]).catch(() => [t, 0] as [string, number])
        )
      )
      const ulMap = Object.fromEntries(ulEntries)
      setUnderlyings(ulMap)

      const enriched = await Promise.all(
        openPos.map(async p => {
          try {
            const cr = await getOptionChain(p.ticker, p.expiry)
            const rows: ChainRow[] = cr.data.chain ?? []
            const match = rows.find(
              r => r.strike === p.strike && r.option_type?.toLowerCase() === p.option_type.toLowerCase()
            )
            if (match) {
              const mid = match.bid > 0 && match.ask > 0 ? (match.bid + match.ask) / 2 : null
              return { ...p, current_price: mid, current_delta: match.delta ?? null,
                current_theta: match.theta ?? null, current_iv: match.iv ?? null,
                underlying_price: ulMap[p.ticker] ?? null }
            }
          } catch { /* no chain */ }
          return { ...p, underlying_price: ulMap[p.ticker] ?? null }
        })
      )
      setOpen(enriched)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  async function handleSubmit() {
    setFormErr('')
    if (!form.ticker.trim()) { setFormErr('Ticker is required'); return }
    if (!form.strike)        { setFormErr('Strike is required'); return }
    if (!form.expiry)        { setFormErr('Expiry is required'); return }
    if (!form.fill_price)    { setFormErr('Fill price is required'); return }
    setSubmitting(true)
    try {
      await openLivePosition({
        ticker: form.ticker.trim().toUpperCase(), action: form.action,
        option_type: form.option_type, strike: parseFloat(form.strike),
        expiry: form.expiry, fill_price: parseFloat(form.fill_price),
        quantity: parseInt(form.quantity) || 1,
        commission: parseFloat(form.commission) || 0.65,
        note: form.note || null,
      })
      setShowForm(false); setForm({ ...LIVE_EMPTY_FORM })
      await loadData()
    } catch (e: any) {
      setFormErr(e?.response?.data?.detail ?? 'Failed to save position')
    }
    setSubmitting(false)
  }

  async function handleClose() {
    if (!closeModal || !closePrice) return
    setClosing(true)
    try {
      await closeLivePosition(closeModal.id, { close_price: parseFloat(closePrice), note: closeNote || null })
      setCloseModal(null); setClosePrice(''); setCloseNote('')
      await loadData()
    } catch { /* ignore */ }
    setClosing(false)
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this position?')) return
    await deleteLivePosition(id); await loadData()
  }

  const fmt$ = (v: number) => `$${Math.abs(v).toFixed(2)}`

  return (
    <div style={{ padding: '16px 20px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-bright)' }}>Live Portfolio</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>Manually track options positions from your brokerage</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadData} disabled={loading}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--panel)', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.75rem' }}>
            {loading ? '↻ Refreshing…' : '↻ Refresh'}
          </button>
          <button onClick={() => setShowForm(true)}
            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--cyan)',
              background: 'var(--cyan-bg)', color: 'var(--cyan)', fontWeight: 700, cursor: 'pointer', fontSize: '0.75rem' }}>
            + Enter Position
          </button>
        </div>
      </div>

      {/* Open Positions table */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
          borderBottom: '1px solid var(--border)', background: 'var(--panel-inset)' }}>
          <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>Open Positions</span>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', background: 'var(--border)',
            borderRadius: 10, padding: '1px 8px', fontFamily: 'var(--mono)' }}>{open.length}</span>
        </div>

        {open.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
            No open positions. Click <strong>+ Enter Position</strong> to add one.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Position', 'Strategy', 'Expiry / DTE', 'Entry', 'Current', 'Unrealized P&L', 'Greeks', "Today's Call", ''].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: '0.62rem',
                      textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)',
                      fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.map(pos => {
                  const dteVal    = dte(pos.expiry)
                  const ul        = underlyings[pos.ticker] ?? null
                  const pnl       = livePnl(pos)
                  const cost      = pos.fill_price * 100 * pos.quantity
                  const pnlPct    = cost > 0 ? (pnl / cost) * 100 : 0
                  const currVal   = (pos.current_price ?? pos.fill_price) * 100 * pos.quantity
                  const isCall    = pos.option_type.toLowerCase() === 'call'
                  const breakeven = isCall ? pos.strike + pos.fill_price : pos.strike - pos.fill_price
                  const beDistAbs = ul ? Math.abs(breakeven - ul) : null
                  const bePct     = ul ? ((breakeven - ul) / ul * 100) : null
                  const aboveBE   = ul ? (isCall ? ul >= breakeven : ul <= breakeven) : null
                  const advisory  = liveAdvisory(pos, dteVal, ul)
                  const isExpanded = expandedId === pos.id
                  const mathOpen   = showMathFor === pos.id

                  return (
                    <Fragment key={pos.id}>
                      <tr
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                          cursor: 'pointer', transition: 'background 0.1s',
                          background: isExpanded ? 'var(--panel-inset)' : undefined }}
                        onClick={() => setExpandedId(isExpanded ? null : pos.id)}
                        onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'var(--panel-inset)' }}
                        onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = '' }}>

                        <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                          <div style={{ fontWeight: 800, fontSize: '0.82rem', color: 'var(--text-bright)' }}>{pos.ticker}</div>
                          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 2 }}>
                            <span style={{ color: pos.action === 'BUY' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{pos.action}</span>
                            {' '}{pos.quantity}× {pos.option_type.toUpperCase()} K=${pos.strike}
                          </div>
                        </td>
                        <td style={{ padding: '9px 10px' }}>
                          <span style={{ fontSize: '0.68rem', background: 'var(--panel-inset)', padding: '2px 7px',
                            borderRadius: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{pos.strategy_label}</span>
                          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginTop: 3 }}>
                            Opened {new Date(pos.open_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                          <div style={{ fontSize: '0.72rem' }}>{pos.expiry}</div>
                          <div style={{ fontSize: '0.65rem', marginTop: 2,
                            color: dteVal <= 7 ? 'var(--red)' : dteVal <= 21 ? '#d97706' : 'var(--text-dim)' }}>
                            {dteVal}d left{dteVal <= 7 ? ' ⚠' : ''}
                          </div>
                          {(() => {
                            const td2 = Math.max(1, Math.round((new Date(pos.expiry).getTime() - new Date(pos.open_date).getTime()) / 86400000))
                            const pct = Math.max(0, Math.min(100, ((td2 - dteVal) / td2) * 100))
                            return (
                              <div style={{ height: 3, width: 60, background: 'var(--border)', borderRadius: 2, marginTop: 4 }}>
                                <div style={{ height: '100%', width: `${pct}%`, borderRadius: 2,
                                  background: pct > 75 ? 'var(--red)' : pct > 50 ? '#d97706' : 'var(--cyan)' }} />
                              </div>
                            )
                          })()}
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                          <div style={{ fontSize: '0.72rem' }}>${pos.fill_price.toFixed(2)}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>/sh</span></div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>{fmt$(cost)} total</div>
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                          {pos.current_price != null ? (
                            <>
                              <div style={{ fontSize: '0.72rem' }}>${pos.current_price.toFixed(2)}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>/sh</span></div>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>{fmt$(currVal)} value</div>
                            </>
                          ) : (
                            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>No quote</div>
                          )}
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--mono)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: '0.82rem',
                                color: pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                                {pnl >= 0 ? '+' : ''}{fmt$(pnl)}
                              </div>
                              <div style={{ fontSize: '0.65rem', marginTop: 2,
                                color: pnlPct > 0 ? 'var(--green)' : pnlPct < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                                {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); setShowMathFor(mathOpen ? null : pos.id); setExpandedId(pos.id) }}
                              title="How is this calculated?"
                              style={{ background: mathOpen ? 'var(--cyan-bg)' : 'var(--panel-inset)',
                                border: `1px solid ${mathOpen ? 'var(--cyan)' : 'var(--border)'}`,
                                borderRadius: '50%', width: 18, height: 18, cursor: 'pointer',
                                fontSize: '0.6rem', color: mathOpen ? 'var(--cyan)' : 'var(--text-dim)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0, fontWeight: 700 }}>ⓘ
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: '9px 10px', fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                          {pos.current_delta != null && <div>Δ <strong style={{ color: 'var(--text)' }}>{pos.current_delta.toFixed(2)}</strong></div>}
                          {pos.current_theta != null && <div>θ <strong style={{ color: 'var(--red)' }}>${(Math.abs(pos.current_theta) * 100 * pos.quantity).toFixed(2)}/d</strong></div>}
                          {pos.current_iv != null && <div>IV <strong style={{ color: 'var(--text)' }}>{pos.current_iv.toFixed(1)}%</strong></div>}
                          {pos.current_delta == null && <span style={{ opacity: 0.4 }}>—</span>}
                        </td>
                        <td style={{ padding: '9px 10px' }} onClick={e => e.stopPropagation()}>
                          <button onClick={() => setExpandedId(isExpanded ? null : pos.id)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
                              borderRadius: 20, border: `1px solid ${advisory.color}`, background: advisory.bg,
                              color: advisory.color, fontWeight: 700, fontFamily: 'var(--mono)',
                              fontSize: '0.68rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            {advisory.verdict === 'HOLD' ? '🟢' : advisory.verdict === 'WATCH' ? '🟡' : '🔴'}{' '}{advisory.verdict}
                          </button>
                          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginTop: 3 }}>
                            {isExpanded ? 'Click to collapse ▲' : 'Click for details ▼'}
                          </div>
                        </td>
                        <td style={{ padding: '9px 10px' }} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <button onClick={() => { setCloseModal({ id: pos.id, ticker: pos.ticker }); setClosePrice(''); setCloseNote('') }}
                              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
                                background: 'var(--panel-inset)', color: 'var(--text)', cursor: 'pointer',
                                fontSize: '0.65rem', fontWeight: 600, whiteSpace: 'nowrap' }}>Close</button>
                            <button onClick={() => handleDelete(pos.id)}
                              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
                                background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.62rem' }}>Delete</button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded advisory panel */}
                      {isExpanded && (
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={9} style={{ padding: 0 }}>
                            <div style={{ padding: '14px 16px', background: 'var(--panel-inset)', borderTop: `2px solid ${advisory.color}` }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

                                {/* Advisory */}
                                <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: `1px solid ${advisory.color}33` }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                    <span style={{ fontWeight: 800, fontSize: '0.8rem', color: advisory.color }}>
                                      {advisory.verdict === 'HOLD' ? '🟢 HOLD' : advisory.verdict === 'WATCH' ? '🟡 WATCH' : '🔴 EXIT'}
                                    </span>
                                    <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>Today's guidance</span>
                                  </div>
                                  <div style={{ fontSize: '0.72rem', color: 'var(--text)', fontWeight: 600, marginBottom: 8, lineHeight: 1.4 }}>{advisory.summary}</div>
                                  {advisory.bullets.map((b, i) => (
                                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: '0.69rem', color: 'var(--text-dim)', lineHeight: 1.45 }}>
                                      <span style={{ color: advisory.color, flexShrink: 0 }}>•</span><span>{b}</span>
                                    </div>
                                  ))}
                                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <div style={{ fontSize: '0.65rem', color: '#16a34a' }}>🎯 {advisory.targetHint}</div>
                                    <div style={{ fontSize: '0.65rem', color: '#dc2626' }}>🛑 {advisory.stopHint}</div>
                                  </div>
                                </div>

                                {/* Breakeven */}
                                <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                                  <div style={{ fontWeight: 700, fontSize: '0.74rem', color: 'var(--text-bright)', marginBottom: 10 }}>📍 Breakeven Analysis</div>
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 3 }}>Breakeven at expiry</div>
                                    <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.9rem', color: 'var(--text-bright)' }}>
                                      ${breakeven.toFixed(2)}<span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 400, marginLeft: 4 }}>per share</span>
                                    </div>
                                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>
                                      {isCall ? `Strike $${pos.strike} + $${pos.fill_price.toFixed(2)} premium` : `Strike $${pos.strike} − $${pos.fill_price.toFixed(2)} premium`}
                                    </div>
                                  </div>
                                  {ul && <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 3 }}>Current {pos.ticker}</div>
                                    <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.84rem' }}>${ul.toFixed(2)}</div>
                                  </div>}
                                  {beDistAbs != null && bePct != null && (
                                    <div style={{ padding: '8px 10px', borderRadius: 6, background: aboveBE ? '#f0fdf4' : '#fef3c7', border: `1px solid ${aboveBE ? '#86efac' : '#fcd34d'}` }}>
                                      <div style={{ fontWeight: 700, fontSize: '0.72rem', color: aboveBE ? '#15803d' : '#92400e' }}>
                                        {aboveBE ? `✅ Above breakeven by $${beDistAbs.toFixed(2)} (${Math.abs(bePct).toFixed(1)}%)` : `⚠️ $${beDistAbs.toFixed(2)} below breakeven — need ${Math.abs(bePct).toFixed(1)}% move`}
                                      </div>
                                    </div>
                                  )}
                                  <div style={{ marginTop: 10 }}>
                                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 5 }}>Time decay zones</div>
                                    {[
                                      { label: '45+ DTE', note: 'Slow theta.', active: dteVal >= 45 },
                                      { label: '21–45 DTE', note: 'Moderate decay.', active: dteVal >= 21 && dteVal < 45 },
                                      { label: '7–21 DTE', note: '⚠️ Accelerating.', active: dteVal >= 7 && dteVal < 21 },
                                      { label: '<7 DTE', note: '🔴 Exit urgently.', active: dteVal < 7 },
                                    ].map(({ label, note, active }) => (
                                      <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4, opacity: active ? 1 : 0.45 }}>
                                        <div style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 3, flexShrink: 0, background: active ? advisory.color : 'var(--border)' }} />
                                        <div style={{ fontSize: '0.63rem', lineHeight: 1.3 }}>
                                          <strong style={{ color: active ? advisory.color : 'var(--text-dim)' }}>{label}</strong>
                                          <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>{note}</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* P&L Math */}
                                <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                                  <div style={{ fontWeight: 700, fontSize: '0.74rem', color: 'var(--text-bright)', marginBottom: 10 }}>🧮 How P&L is calculated</div>
                                  {(() => {
                                    const cp        = pos.current_price ?? pos.fill_price
                                    const entryCost = pos.fill_price * 100 * pos.quantity
                                    const currValue = cp * 100 * pos.quantity
                                    const calcPnl   = (pos.action === 'BUY' ? 1 : -1) * (cp - pos.fill_price) * 100 * pos.quantity
                                    return (
                                      <div style={{ fontSize: '0.69rem', lineHeight: 1.7, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                                        <div style={{ marginBottom: 6 }}>
                                          <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Entry cost</div>
                                          <div>${pos.fill_price.toFixed(2)} × 100 × {pos.quantity} contract{pos.quantity > 1 ? 's' : ''}</div>
                                          <div style={{ color: 'var(--text)', fontWeight: 700 }}>= {fmt$(entryCost)}</div>
                                        </div>
                                        <div style={{ marginBottom: 6 }}>
                                          <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current value</div>
                                          <div>${cp.toFixed(2)} × 100 × {pos.quantity}</div>
                                          <div style={{ color: 'var(--text)', fontWeight: 700 }}>= {fmt$(currValue)}</div>
                                        </div>
                                        <div style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                                          <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 2, fontFamily: 'var(--sans)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Unrealized P&L</div>
                                          <div>{fmt$(currValue)} − {fmt$(entryCost)}</div>
                                          <div style={{ fontWeight: 800, fontSize: '0.82rem', color: calcPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                            = {calcPnl >= 0 ? '+' : ''}{fmt$(calcPnl)}{' '}
                                            <span style={{ fontSize: '0.65rem', fontWeight: 600 }}>({calcPnl >= 0 ? '+' : ''}{entryCost > 0 ? ((calcPnl / entryCost) * 100).toFixed(2) : '0.00'}%)</span>
                                          </div>
                                        </div>
                                        <div style={{ marginTop: 10, padding: '6px 8px', background: 'var(--panel-inset)', borderRadius: 5, fontSize: '0.62rem', color: 'var(--text-dim)', lineHeight: 1.5, fontFamily: 'var(--sans)' }}>
                                          Each contract = 100 shares. You own the <em>right</em> to {isCall ? 'buy' : 'sell'} {pos.ticker} at ${pos.strike}.
                                        </div>
                                        {pos.current_price == null && (
                                          <div style={{ marginTop: 6, fontSize: '0.6rem', color: '#d97706' }}>⚠ No live quote — P&L shown at entry (change = $0)</div>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>

                              </div>

                              {/* Greeks row */}
                              {(pos.current_delta != null || pos.current_theta != null || pos.current_iv != null) && (() => {
                                const d   = pos.current_delta
                                const th  = pos.current_theta
                                const vol = pos.current_iv
                                const qty = pos.quantity
                                const dollarDelta    = d   != null ? Math.abs(d)  * 100 * qty : null
                                const dailyDecay     = th  != null ? Math.abs(th) * 100 * qty : null
                                const weekDecay      = dailyDecay != null ? dailyDecay * 5 : null
                                const dailyMovePct   = vol != null ? vol / Math.sqrt(252) : null
                                const dailyMoveDollar = dailyMovePct != null && ul ? ul * (dailyMovePct / 100) : null
                                const ivLevel = vol == null ? '' : vol < 20 ? 'low' : vol < 35 ? 'normal' : vol < 55 ? 'elevated' : 'very high'
                                const ivColor = vol == null ? 'var(--text-dim)' : vol < 20 ? '#2563eb' : vol < 35 ? '#15803d' : vol < 55 ? '#d97706' : '#dc2626'
                                const popPct  = d != null ? Math.round(Math.abs(d) * 100) : null
                                const greeks = [
                                  d != null && { symbol: 'Δ', name: 'Delta', value: d.toFixed(2),
                                    color: Math.abs(d) >= 0.5 ? 'var(--cyan)' : Math.abs(d) >= 0.3 ? '#d97706' : 'var(--text-dim)',
                                    headline: dollarDelta != null ? `~$${dollarDelta.toFixed(0)} per $1 move in ${pos.ticker}` : 'Price sensitivity',
                                    explain: [
                                      `Delta ${d.toFixed(2)}: option gains ~$${dollarDelta?.toFixed(0) ?? '?'} for every $1 ${isCall ? 'rise' : 'fall'} in ${pos.ticker}.`,
                                      `Equivalent to owning ${Math.round(Math.abs(d) * 100 * qty)} virtual shares.`,
                                      popPct != null ? `~${popPct}% chance of expiring in-the-money.` : '',
                                    ].filter(Boolean) },
                                  th != null && { symbol: 'θ', name: 'Theta', value: `-$${dailyDecay?.toFixed(2) ?? '?'}/day`,
                                    color: (dailyDecay ?? 0) > 20 ? '#dc2626' : (dailyDecay ?? 0) > 8 ? '#d97706' : 'var(--text-dim)',
                                    headline: dailyDecay != null ? `Costs $${dailyDecay.toFixed(2)}/day to hold` : 'Daily time decay',
                                    explain: [
                                      `Options lose value each day even if the stock doesn't move.`,
                                      dailyDecay != null ? `You pay ~$${dailyDecay.toFixed(2)}/day${weekDecay != null ? `, ~$${weekDecay.toFixed(2)}/week` : ''}.` : '',
                                      dteVal <= 21 ? `⚠️ Only ${dteVal} DTE — decay is accelerating rapidly.` : `Decay speeds up significantly inside 21 days.`,
                                    ].filter(Boolean) },
                                  vol != null && { symbol: 'IV', name: 'Implied Volatility', value: `${vol.toFixed(1)}%`,
                                    color: ivColor,
                                    headline: dailyMoveDollar != null ? `~$${dailyMoveDollar.toFixed(1)} daily swings in ${pos.ticker}` : `${ivLevel} IV`,
                                    explain: [
                                      `IV ${vol.toFixed(1)}%: market expects ${dailyMovePct?.toFixed(1) ?? '?'}% daily moves in ${pos.ticker}.`,
                                      ivLevel === 'elevated' || ivLevel === 'very high' ? `⚠️ High IV — beware IV crush if volatility drops after entry.` : `IV is ${ivLevel} — option pricing is relatively ${ivLevel === 'low' ? 'cheap' : 'fair'}.`,
                                    ].filter(Boolean) },
                                ].filter(Boolean) as { symbol: string; name: string; value: string; color: string; headline: string; explain: string[] }[]

                                return (
                                  <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                                      The Greeks — what each risk number means for this trade
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${greeks.length}, 1fr)`, gap: 10 }}>
                                      {greeks.map(g => (
                                        <div key={g.name} style={{ background: 'var(--panel)', borderRadius: 8, padding: '10px 12px', border: `1px solid ${g.color}33` }}>
                                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                                            <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: '1rem', color: g.color }}>{g.symbol}</span>
                                            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>{g.value}</span>
                                            <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{g.name}</span>
                                          </div>
                                          <div style={{ fontSize: '0.68rem', color: g.color, fontWeight: 600, marginBottom: 6, lineHeight: 1.35 }}>{g.headline}</div>
                                          {g.explain.map((line, i) => (
                                            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, fontSize: '0.63rem', color: 'var(--text-dim)', lineHeight: 1.45 }}>
                                              <span style={{ flexShrink: 0 }}>·</span><span>{line}</span>
                                            </div>
                                          ))}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )
                              })()}

                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Closed Positions */}
      {closed.length > 0 && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--panel-inset)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)' }}>Closed Positions</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', background: 'var(--border)', borderRadius: 10, padding: '1px 8px', fontFamily: 'var(--mono)' }}>{closed.length}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Position', 'Strategy', 'Opened', 'Closed', 'Realized P&L', 'Return'].map(h => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: '0.62rem',
                      textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map(pos => {
                  const realized = liveRealizedPnl(pos)
                  const cost     = pos.fill_price * 100 * pos.quantity
                  const retPct   = cost > 0 ? (realized / cost) * 100 : 0
                  return (
                    <tr key={pos.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)' }}>
                        <div style={{ fontWeight: 700 }}>{pos.ticker}</div>
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{pos.action} {pos.option_type.toUpperCase()} K=${pos.strike}</div>
                      </td>
                      <td style={{ padding: '8px 10px', fontSize: '0.68rem', color: 'var(--text-dim)' }}>{pos.strategy_label}</td>
                      <td style={{ padding: '8px 10px', fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{pos.open_date}</td>
                      <td style={{ padding: '8px 10px', fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{pos.close_date ?? '—'}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontWeight: 700, color: realized >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {realized >= 0 ? '+' : ''}{fmt$(realized)}
                      </td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: retPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {retPct >= 0 ? '+' : ''}{retPct.toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Enter Position Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false) }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '24px 28px', width: 460, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', color: 'var(--text-bright)', marginBottom: 18 }}>Enter Position</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Ticker</label>
                <input className="input" value={form.ticker} placeholder="e.g. SPY"
                  onChange={e => setForm(f => ({ ...f, ticker: e.target.value.toUpperCase() }))}
                  style={{ width: '100%', fontFamily: 'var(--mono)', fontWeight: 700 }} />
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Action</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['BUY', 'SELL'].map(v => (
                    <button key={v} onClick={() => setForm(f => ({ ...f, action: v }))}
                      style={{ flex: 1, padding: '7px 0', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: '0.75rem',
                        border: form.action === v ? `1.5px solid ${v === 'BUY' ? 'var(--green)' : 'var(--red)'}` : '1px solid var(--border)',
                        background: form.action === v ? (v === 'BUY' ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)') : 'var(--panel-inset)',
                        color: form.action === v ? (v === 'BUY' ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)' }}>{v}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Type</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['CALL', 'PUT'].map(v => (
                    <button key={v} onClick={() => setForm(f => ({ ...f, option_type: v }))}
                      style={{ flex: 1, padding: '7px 0', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: '0.75rem',
                        border: form.option_type === v ? '1.5px solid var(--cyan)' : '1px solid var(--border)',
                        background: form.option_type === v ? 'var(--cyan-bg)' : 'var(--panel-inset)',
                        color: form.option_type === v ? 'var(--cyan)' : 'var(--text-dim)' }}>{v}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Strike Price</label>
                <input className="input" type="number" step="0.5" value={form.strike} placeholder="e.g. 580"
                  onChange={e => setForm(f => ({ ...f, strike: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Expiry Date</label>
                <input className="input" type="date" value={form.expiry}
                  onChange={e => setForm(f => ({ ...f, expiry: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Fill Price (premium/sh)</label>
                <input className="input" type="number" step="0.01" value={form.fill_price} placeholder="e.g. 4.50"
                  onChange={e => setForm(f => ({ ...f, fill_price: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Contracts</label>
                <input className="input" type="number" min="1" value={form.quantity}
                  onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Commission (per contract)</label>
                <input className="input" type="number" step="0.01" value={form.commission}
                  onChange={e => setForm(f => ({ ...f, commission: e.target.value }))} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
              {form.fill_price && form.quantity && (
                <div style={{ gridColumn: '1 / -1', padding: '8px 12px', background: 'var(--panel-inset)', borderRadius: 6, border: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: '0.7rem' }}>
                  <span style={{ color: 'var(--text-dim)' }}>Total cost: </span>
                  <strong style={{ color: 'var(--text-bright)' }}>${(parseFloat(form.fill_price || '0') * 100 * (parseInt(form.quantity) || 1)).toFixed(2)}</strong>
                  {form.strike && (
                    <span style={{ color: 'var(--text-dim)', marginLeft: 12 }}>
                      Breakeven: <strong style={{ color: 'var(--cyan)' }}>
                        ${(form.option_type === 'CALL'
                          ? parseFloat(form.strike) + parseFloat(form.fill_price || '0')
                          : parseFloat(form.strike) - parseFloat(form.fill_price || '0')
                        ).toFixed(2)}
                      </strong>
                    </span>
                  )}
                </div>
              )}
            </div>
            {formErr && <div style={{ color: 'var(--red)', fontSize: '0.72rem', marginBottom: 10 }}>{formErr}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => { setShowForm(false); setForm({ ...LIVE_EMPTY_FORM }) }}
                style={{ padding: '8px 18px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel-inset)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.78rem' }}>Cancel</button>
              <button onClick={handleSubmit} disabled={submitting}
                style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid var(--cyan)', background: 'var(--cyan-bg)', color: 'var(--cyan)', fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: '0.78rem', opacity: submitting ? 0.7 : 1 }}>
                {submitting ? 'Saving…' : 'Save Position'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Position Modal */}
      {closeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setCloseModal(null) }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '24px 28px', width: 360, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', color: 'var(--text-bright)', marginBottom: 4 }}>Close Position</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: 18 }}>
              {closeModal.ticker} — enter the premium you received/paid to close
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Close Price (premium/sh)</label>
              <input className="input" type="number" step="0.01" value={closePrice} placeholder="e.g. 8.20" autoFocus
                onChange={e => setClosePrice(e.target.value)} style={{ width: '100%', fontFamily: 'var(--mono)' }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>Note (optional)</label>
              <input className="input" value={closeNote} placeholder="e.g. Took profit at target"
                onChange={e => setCloseNote(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCloseModal(null)}
                style={{ padding: '8px 18px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel-inset)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.78rem' }}>Cancel</button>
              <button onClick={handleClose} disabled={closing || !closePrice}
                style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid var(--green)', background: 'rgba(22,163,74,0.1)', color: 'var(--green)', fontWeight: 700,
                  cursor: closing || !closePrice ? 'not-allowed' : 'pointer', fontSize: '0.78rem', opacity: closing || !closePrice ? 0.6 : 1 }}>
                {closing ? 'Closing…' : 'Confirm Close'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── Account Bar ───────────────────────────────────────────────────────────────

function AccountBar({ account, marketStatus, onHelp, onReval, revalLoading }: {
  account: Account | null; marketStatus: MarketStatus | null
  onHelp: () => void; onReval: () => void; revalLoading: boolean
}) {
  if (!account) return <div className="opts-account-bar"><span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>Loading account…</span></div>
  const isLive = marketStatus?.is_open ?? false
  return (
    <div className="opts-account-bar">
      {/* Market status pill */}
      <div className="opts-acct-stat" style={{ paddingRight: 14, marginRight: 14 }}>
        <span className="opts-acct-label">MARKET</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 8px', borderRadius: 20, fontSize: '0.72rem', fontWeight: 700,
          fontFamily: 'var(--mono)',
          background: isLive ? '#f0fdf4' : '#fef3c7',
          color: isLive ? '#15803d' : '#92400e',
          border: `1px solid ${isLive ? '#86efac' : '#fcd34d'}`,
        }} title={marketStatus?.reason ?? ''}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: isLive ? '#22c55e' : '#f59e0b', display: 'inline-block' }} />
          {isLive ? 'LIVE' : (marketStatus?.data_freshness === 'STALE' ? 'STALE' : '—')}
        </span>
        {marketStatus && !isLive && (
          <span style={{ fontSize: '0.58rem', color: '#92400e', maxWidth: 120, lineHeight: 1.3, marginTop: 2, display: 'block' }}>
            {marketStatus.is_weekend ? 'Weekend — last close prices' :
             marketStatus.is_holiday ? 'Holiday — last close prices' : 'Market closed'}
          </span>
        )}
      </div>

      <div className="opts-acct-stat">
        <span className="opts-acct-label">NET LIQ</span>
        <span className="opts-acct-val" style={{ color: 'var(--cyan)' }}>{fmt$(account.net_liq)}</span>
      </div>
      <div className="opts-acct-stat">
        <span className="opts-acct-label">CASH</span>
        <span className="opts-acct-val">{fmt$(account.cash)}</span>
      </div>
      <div className="opts-acct-stat">
        <span className="opts-acct-label">UNREALIZED</span>
        <span className={`opts-acct-val ${pnlClass(account.unrealized_pnl)}`}>{fmt$(account.unrealized_pnl)}</span>
      </div>
      <div className="opts-acct-stat">
        <span className="opts-acct-label">REALIZED</span>
        <span className={`opts-acct-val ${pnlClass(account.realized_pnl)}`}>{fmt$(account.realized_pnl)}</span>
      </div>
      <div className="opts-acct-stat">
        <span className="opts-acct-label">TOTAL RETURN</span>
        <span className={`opts-acct-val ${pnlClass(account.total_return_pct)}`}>{fmtPct(account.total_return_pct)}</span>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn sm" onClick={onReval} disabled={revalLoading}
          title={isLive ? 'Refresh positions to current live prices' : 'Market closed — will refresh to last close prices'}>
          {revalLoading ? '…' : '↻ Refresh'}
        </button>
        <button className="btn sm primary" onClick={onHelp}>? How to Use</button>
      </div>
    </div>
  )
}

// ── Alerts Banner ─────────────────────────────────────────────────────────────

function AlertsBanner({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null
  return (
    <div style={{ background: '#fffbeb', borderBottom: '1px solid #fcd34d', padding: '6px 16px', display: 'flex', gap: 16, overflowX: 'auto', flexShrink: 0 }}>
      {alerts.map((a, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
          fontSize: '0.75rem',
          color: a.level === 'danger' ? '#991b1b' : a.level === 'warning' ? '#92400e' : '#1e40af',
        }}>
          <span>{a.level === 'danger' ? '🔴' : a.level === 'warning' ? '🟡' : '🔵'}</span>
          <span>{a.message}</span>
        </div>
      ))}
    </div>
  )
}

// ── Chain Table ───────────────────────────────────────────────────────────────

function ChainTable({
  calls, puts, underlying, onSelect,
}: {
  calls: ChainRow[]; puts: ChainRow[]; underlying: number
  onSelect: (side: 'call' | 'put', row: ChainRow) => void
}) {
  const atmStrike = calls.length
    ? calls.reduce((best, c) => Math.abs(c.strike - underlying) < Math.abs(best.strike - underlying) ? c : best, calls[0]).strike
    : null

  const callMap = new Map(calls.map(c => [c.strike, c]))
  const putMap  = new Map(puts.map(p => [p.strike, p]))
  const allStrikes = [...new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)])].sort((a, b) => a - b)

  return (
    <div className="opts-chain-wrap">
      <table className="opts-chain-table">
        <thead>
          <tr>
            <th colSpan={5} style={{ color: 'var(--green)', background: '#f0fdf4' }}>CALLS ▲</th>
            <th style={{ background: 'var(--cyan-bg)', color: 'var(--cyan)' }}>STRIKE</th>
            <th colSpan={5} style={{ color: 'var(--red)', background: '#fef2f2' }}>PUTS ▼</th>
          </tr>
          <tr>
            <th>BID</th><th>ASK</th><th>IV%</th><th>Δ</th><th>θ</th>
            <th style={{ background: 'var(--cyan-bg)' }} />
            <th>BID</th><th>ASK</th><th>IV%</th><th>Δ</th><th>θ</th>
          </tr>
        </thead>
        <tbody>
          {allStrikes.map(strike => {
            const call = callMap.get(strike)
            const put  = putMap.get(strike)
            const isAtm = strike === atmStrike

            // Liquidity badge — score the better side or average both
            const callLiq = call ? getLiquidityScore(call) : null
            const putLiq  = put  ? getLiquidityScore(put)  : null
            const liqRank = { good: 2, fair: 1, poor: 0 }
            const rowLiq: 'good' | 'fair' | 'poor' = (
              callLiq && putLiq
                ? (liqRank[callLiq] + liqRank[putLiq] >= 3 ? 'good' : liqRank[callLiq] + liqRank[putLiq] === 0 ? 'poor' : 'fair')
                : callLiq ?? putLiq ?? 'poor'
            )

            return (
              <tr key={strike} className={isAtm ? 'opts-atm-row' : ''}>
                <td className={call?.inTheMoney ? 'opts-itm' : ''} onClick={() => call && onSelect('call', call)} style={{ cursor: call ? 'pointer' : 'default' }}>
                  {call?.bid != null ? call.bid.toFixed(2) : '—'}
                </td>
                <td className={call?.inTheMoney ? 'opts-itm' : ''} onClick={() => call && onSelect('call', call)} style={{ cursor: call ? 'pointer' : 'default' }}>
                  {call?.ask != null ? call.ask.toFixed(2) : '—'}
                </td>
                <td>{call?.iv != null ? call.iv.toFixed(1) : '—'}</td>
                <td>{call?.delta != null ? call.delta.toFixed(2) : '—'}</td>
                <td>{call?.theta != null ? call.theta.toFixed(3) : '—'}</td>
                <td style={{ background: isAtm ? 'var(--cyan-bg)' : 'var(--panel-inset)', fontWeight: 700, textAlign: 'center', color: 'var(--cyan)', fontFamily: 'var(--mono)' }}>
                  <span
                    style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: LIQ_DOT[rowLiq], marginRight: 5, verticalAlign: 'middle', flexShrink: 0 }}
                    title={LIQ_TIP[rowLiq]}
                  />
                  {strike.toFixed(2)}
                </td>
                <td className={put?.inTheMoney ? 'opts-itm' : ''} onClick={() => put && onSelect('put', put)} style={{ cursor: put ? 'pointer' : 'default' }}>
                  {put?.bid != null ? put.bid.toFixed(2) : '—'}
                </td>
                <td className={put?.inTheMoney ? 'opts-itm' : ''} onClick={() => put && onSelect('put', put)} style={{ cursor: put ? 'pointer' : 'default' }}>
                  {put?.ask != null ? put.ask.toFixed(2) : '—'}
                </td>
                <td>{put?.iv != null ? put.iv.toFixed(1) : '—'}</td>
                <td style={{ color: put?.delta != null && put.delta < 0 ? 'var(--red)' : undefined }}>{put?.delta != null ? put.delta.toFixed(2) : '—'}</td>
                <td>{put?.theta != null ? put.theta.toFixed(3) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Scenario Table ────────────────────────────────────────────────────────────

function ScenarioTable({ rows }: { rows: ScenarioRow[] }) {
  const days = [...new Set(rows.map(r => r.days_forward))].sort((a, b) => a - b)
  const prices = [...new Set(rows.map(r => r.underlying_price))].sort((a, b) => a - b)
  const lookup = new Map(rows.map(r => [`${r.underlying_price}|${r.days_forward}`, r]))

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: '0.72rem' }}>
        <thead>
          <tr>
            <th>Stock Price</th>
            {days.map(d => <th key={d}>{d === 0 ? 'At expiry' : `${d}d`}</th>)}
          </tr>
        </thead>
        <tbody>
          {prices.map(price => (
            <tr key={price}>
              <td className="mono" style={{ fontWeight: 700 }}>{fmt$(price)}</td>
              {days.map(d => {
                const cell = lookup.get(`${price}|${d}`)
                const pnl = cell?.pnl ?? 0
                const intensity = Math.min(0.35, Math.abs(pnl) / 300)
                return (
                  <td key={d} style={{
                    background: pnl > 0 ? `rgba(21,128,61,${intensity})` :
                                pnl < 0 ? `rgba(185,28,28,${intensity})` : undefined,
                    textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.7rem',
                    color: pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-dim)',
                  }}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 6 }}>All values in USD per position. Green = profit, Red = loss.</div>
    </div>
  )
}

// ── Position Card ─────────────────────────────────────────────────────────────

function PositionCard({ pos, onClose, onAI }: {
  pos: Position; onClose: (id: number) => void; onAI: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (!pos.legs.length) return null

  const pnl = pos.unrealized_pnl ?? pos.realized_pnl ?? 0
  const cost = Math.abs(pos.total_cost)
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
  const isClosed = pos.status === 'CLOSED'

  // Last-updated staleness
  const staleMin = pos.last_revalued_at
    ? Math.round((Date.now() - new Date(pos.last_revalued_at).getTime()) / 60000)
    : null
  const stale = staleMin != null && staleMin > 20 && !isClosed

  return (
    <div className="opts-pos-card">
      {/* ── Header ── */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}
           onClick={() => setExpanded(e => !e)}>
        <span className="opts-pos-ticker">{pos.ticker}</span>
        <span className="badge hold" style={{ fontSize: '0.6rem' }}>{pos.strategy_label}</span>
        <span className={`badge ${isClosed ? 'hold' : 'buy'}`}>{pos.status}</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-dim)' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* ── Per-leg summary rows (always visible) ── */}
      {pos.legs.map((l, i) => {
        const currPx   = l.current_price ?? l.fill_price
        const entryVal = l.fill_price * 100 * l.quantity
        const currVal  = currPx * 100 * l.quantity
        const legPnl   = (l.action === 'BUY' ? 1 : -1) * (currPx - l.fill_price) * 100 * l.quantity
        const dte      = Math.max(0, Math.round((new Date(l.expiry).getTime() - Date.now()) / 86400000))

        return (
          <div key={i} style={{ marginBottom: i < pos.legs.length - 1 ? 8 : 0 }}>
            {/* Trade description */}
            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', fontWeight: 700, marginBottom: 5, color: 'var(--text)' }}>
              <span style={{ color: l.action === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{l.action}</span>
              {' '}{l.quantity}× {l.option_type.toUpperCase()}
              <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
                {' '}· Strike <strong style={{ color: 'var(--text)' }}>${l.strike}</strong>
                {' '}· Exp <strong style={{ color: 'var(--text)' }}>{l.expiry}</strong>
                {' '}({dte}d left)
              </span>
            </div>

            {/* Entry vs Current price comparison */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 6 }}>
              <div style={{ background: 'var(--panel-inset)', borderRadius: 5, padding: '6px 8px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>Entry price</div>
                <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>${l.fill_price.toFixed(2)}<span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'var(--text-dim)' }}>/sh</span></div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{fmt$(entryVal)} total</div>
              </div>
              <div style={{ background: 'var(--panel-inset)', borderRadius: 5, padding: '6px 8px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>
                  Current price{stale ? ' ⚠' : ''}
                </div>
                <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>${currPx.toFixed(2)}<span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'var(--text-dim)' }}>/sh</span></div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{fmt$(currVal)} value</div>
              </div>
              <div style={{ background: legPnl > 0 ? '#f0fdf4' : legPnl < 0 ? '#fef2f2' : 'var(--panel-inset)', borderRadius: 5, padding: '6px 8px', border: legPnl !== 0 ? `1px solid ${legPnl > 0 ? '#86efac' : '#fca5a5'}` : undefined }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>
                  {isClosed ? 'Realized P&L' : 'Unrealized P&L'}
                </div>
                <div className={pnlClass(legPnl)} style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{fmt$(legPnl)}</div>
                <div className={pnlClass(legPnl)} style={{ fontSize: '0.65rem' }}>{legPnl >= 0 ? '+' : ''}{entryVal > 0 ? ((legPnl / entryVal) * 100).toFixed(1) : '0.0'}%</div>
              </div>
            </div>

            {/* Greeks row */}
            {(l.current_delta != null || l.delta_at_entry != null) && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                <span>Delta <strong style={{ color: 'var(--text)' }}>{fmtNum(l.current_delta ?? l.delta_at_entry, 2)}</strong> <span style={{ fontSize: '0.6rem' }}>(${((Math.abs(l.current_delta ?? l.delta_at_entry ?? 0)) * 100).toFixed(0)} per $1 move)</span></span>
                {l.current_theta != null && (
                  <span>Theta <strong style={{ color: 'var(--red)' }}>${(Math.abs(l.current_theta) * 100 * l.quantity).toFixed(2)}/day</strong></span>
                )}
                {l.current_iv != null && (
                  <span>IV <strong style={{ color: 'var(--text)' }}>{l.current_iv.toFixed(1)}%</strong></span>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Staleness note */}
      {stale && (
        <div style={{ fontSize: '0.62rem', color: '#92400e', marginTop: 6 }}>
          ⚠ Prices last updated {staleMin}m ago — click ↻ Refresh in the top bar to update
        </div>
      )}

      {/* Expanded: open date + actions */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: 8 }}>
            Opened: {new Date(pos.open_date).toLocaleString()}
            {pos.close_date && ` · Closed: ${new Date(pos.close_date).toLocaleString()}`}
            {pos.last_revalued_at && ` · Updated: ${new Date(pos.last_revalued_at).toLocaleString()}`}
          </div>
          {pos.status === 'OPEN' && (
            <div className="opts-pos-actions">
              <button className="btn sm" onClick={() => onAI(pos.id)}>🤖 AI Analysis</button>
              <button className="btn sm danger" onClick={() => onClose(pos.id)}>Close Position</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Performance Chart ─────────────────────────────────────────────────────────

function PerformanceChart({ curve }: { curve: PerfPoint[] }) {
  if (!curve.length) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
        No performance data yet — open a position to start tracking.
      </div>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} width={52} />
        <Tooltip formatter={(v: any) => [`$${Number(v).toFixed(2)}`, '']} labelStyle={{ fontSize: 11 }} />
        <ReferenceLine y={10000} stroke="var(--border)" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="net_liq" stroke="var(--cyan)" strokeWidth={2} dot={false} name="Net Liq" />
        <Line type="monotone" dataKey="realized" stroke="var(--green)" strokeWidth={1.5} dot={false} name="Realized" />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Spread Builder ────────────────────────────────────────────────────────────

function SpreadBuilder({
  ticker, expiry, chainData, onOpened,
}: {
  ticker: string; expiry: string
  chainData: { calls: ChainRow[]; puts: ChainRow[]; underlying: number } | null
  onOpened: () => void
}) {
  const [strategyId, setStrategyId] = useState('bull_call')
  const [strikeA, setStrikeA]       = useState<number | ''>('')
  const [strikeB, setStrikeB]       = useState<number | ''>('')
  const [qty, setQty]               = useState(1)
  const [note, setNote]             = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  const preset = STRATEGY_PRESETS.find(p => p.id === strategyId)!

  const strikeOptions = chainData
    ? [...new Set([...chainData.calls.map(c => c.strike), ...chainData.puts.map(p => p.strike)])].sort((a, b) => a - b)
    : []

  async function handleSubmit() {
    if (!preset || strikeA === '') { setError('Please select a strike.'); return }
    setLoading(true); setError('')
    try {
      const sA = Number(strikeA)
      const sB = strikeB !== '' ? Number(strikeB) : sA
      const legs = preset.legs(sA, sB, qty)
      await openMultiLegPosition({
        ticker: ticker.toUpperCase(),
        expiry,
        strategy_label: preset.label,
        legs,
        note,
      })
      setStrikeA(''); setStrikeB(''); setNote('')
      onOpened()
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Failed to open')
    }
    setLoading(false)
  }

  if (!chainData) {
    return <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>Load a chain first to build a spread.</div>
  }

  const needsTwo = preset.fields.includes('sellStrike') || preset.fields.includes('putStrike') || preset.fields.includes('callStrike')

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Strategy</label>
        <select className="input" value={strategyId} onChange={e => { setStrategyId(e.target.value); setStrikeA(''); setStrikeB('') }}>
          {STRATEGY_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: '0.75rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
        {preset.description}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: needsTwo ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>
            {preset.id === 'bull_call' ? 'Buy Strike (lower)' :
             preset.id === 'bear_put'  ? 'Buy Strike (higher)' :
             preset.id === 'straddle'  ? 'Strike' : 'Call Strike'}
          </label>
          <select className="input" value={strikeA} onChange={e => setStrikeA(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">Select…</option>
            {strikeOptions.map(s => <option key={s} value={s}>{s.toFixed(2)}</option>)}
          </select>
        </div>
        {needsTwo && (
          <div>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>
              {preset.id === 'bull_call' ? 'Sell Strike (higher)' :
               preset.id === 'bear_put'  ? 'Sell Strike (lower)' : 'Put Strike'}
            </label>
            <select className="input" value={strikeB} onChange={e => setStrikeB(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Select…</option>
              {strikeOptions.map(s => <option key={s} value={s}>{s.toFixed(2)}</option>)}
            </select>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Contracts (each leg)</label>
        <input type="number" className="input" min={1} max={20} value={qty} onChange={e => setQty(Math.max(1, Number(e.target.value)))} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Trade Note</label>
        <textarea className="input" rows={2} style={{ resize: 'vertical', fontFamily: 'var(--sans)' }}
          value={note} onChange={e => setNote(e.target.value)} placeholder="Why this trade?" />
      </div>

      {error && <div style={{ color: 'var(--red)', fontSize: '0.75rem', marginBottom: 8 }}>{error}</div>}
      <button className="btn primary" style={{ width: '100%' }} onClick={handleSubmit} disabled={loading || strikeA === ''}>
        {loading ? 'Submitting…' : `Open ${preset.label}`}
      </button>
    </div>
  )
}

// ── ARIA Panel ────────────────────────────────────────────────────────────────

function ScoreboardCard({ board }: { board: Scoreboard | null }) {
  if (!board) return <div className="loading">Loading scoreboard…</div>
  const { user, aria, leader, edge } = board
  const isAria = leader === 'aria'
  const isUser = leader === 'user'
  return (
    <div className="aria-scoreboard">
      <div className="aria-score-header">
        <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          Head-to-Head · Same $10,000 Starting Capital
        </span>
        <span style={{
          fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--mono)',
          padding: '2px 10px', borderRadius: 20,
          background: leader === 'tie' ? 'var(--panel-inset)' : isAria ? '#fef3c7' : '#f0fdf4',
          color: leader === 'tie' ? 'var(--text-dim)' : isAria ? '#92400e' : '#15803d',
          border: `1px solid ${leader === 'tie' ? 'var(--border)' : isAria ? '#fcd34d' : '#86efac'}`,
        }}>
          {leader === 'tie' ? 'TIE' : isAria ? `ARIA leads by $${edge}` : `YOU lead by $${edge}`}
        </span>
      </div>
      <div className="aria-score-grid">
        {/* Columns */}
        <div />
        <div style={{ textAlign: 'center', fontWeight: 800, fontSize: '0.72rem', color: 'var(--cyan)', fontFamily: 'var(--mono)' }}>YOU</div>
        <div style={{ textAlign: 'center', fontWeight: 800, fontSize: '0.72rem', color: '#f59e0b', fontFamily: 'var(--mono)' }}>ARIA</div>

        {[
          { label: 'Net Liq',      u: fmt$(user.net_liq),            a: fmt$(aria.net_liq),            highlight: true },
          { label: 'Total P&L',    u: fmtPct(user.total_return_pct), a: fmtPct(aria.total_return_pct), uClass: pnlClass(user.total_return_pct), aClass: pnlClass(aria.total_return_pct) },
          { label: 'Realized',     u: fmt$(user.realized_pnl),       a: fmt$(aria.realized_pnl),       uClass: pnlClass(user.realized_pnl),     aClass: pnlClass(aria.realized_pnl) },
          { label: 'Unrealized',   u: fmt$(user.unrealized_pnl),     a: fmt$(aria.unrealized_pnl),     uClass: pnlClass(user.unrealized_pnl),   aClass: pnlClass(aria.unrealized_pnl) },
          { label: 'Trades',       u: String(user.trade_count),      a: String(aria.trade_count) },
          { label: 'Win Rate',     u: `${user.win_rate}%`,           a: `${aria.win_rate}%` },
          { label: 'Commissions',  u: fmt$(user.commissions),        a: fmt$(aria.commissions) },
        ].map(({ label, u, a, highlight, uClass, aClass }) => (
          <>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', padding: '3px 0' }}>{label}</div>
            <div style={{ textAlign: 'center', fontSize: highlight ? '0.9rem' : '0.78rem', fontWeight: highlight ? 800 : 600, fontFamily: 'var(--mono)' }} className={uClass}>{u}</div>
            <div style={{ textAlign: 'center', fontSize: highlight ? '0.9rem' : '0.78rem', fontWeight: highlight ? 800 : 600, fontFamily: 'var(--mono)' }} className={aClass}>{a}</div>
          </>
        ))}
      </div>
    </div>
  )
}

function AriaPositionCard({ pos, entryAction }: { pos: AriaPosition; entryAction?: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const isClosed   = pos.status !== 'OPEN'
  const pnl        = pos.unrealized_pnl ?? pos.realized_pnl ?? 0
  const isBuy      = pos.action === 'BUY'
  // For BUY: cost = premium paid. For SELL: premium collected (negative total_cost).
  const entryVal   = pos.fill_price * 100 * pos.quantity
  const currPx     = pos.current_price ?? pos.fill_price
  const currVal    = currPx * 100 * pos.quantity
  const legPnl     = isBuy ? (currVal - entryVal) : (entryVal - currVal)
  const pnlPct     = entryVal > 0 ? (legPnl / entryVal) * 100 : 0
  const dte        = Math.max(0, Math.round((new Date(pos.expiry).getTime() - Date.now()) / 86400000))
  const openedDate = new Date(pos.open_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const exitConds  = (() => { try { return JSON.parse(pos.exit_conditions_json || '{}') } catch { return {} } })()

  // Breakeven at expiry
  const breakeven = isBuy
    ? (pos.option_type === 'call' ? pos.strike + pos.fill_price : pos.strike - pos.fill_price)
    : (pos.option_type === 'put'  ? pos.strike - pos.fill_price : pos.strike + pos.fill_price)

  return (
    <div className="opts-pos-card" style={{ borderLeft: '3px solid #f59e0b' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}
           onClick={() => setExpanded(e => !e)}>
        <span className="opts-pos-ticker" style={{ color: '#f59e0b' }}>{pos.ticker}</span>
        <span className="badge hold" style={{ fontSize: '0.6rem' }}>{pos.strategy_label}</span>
        <span className={`badge ${isClosed ? 'hold' : 'buy'}`} style={{ fontSize: '0.6rem' }}>
          {isClosed ? 'CLOSED' : '⚡ ARIA'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
          Confidence {pos.confidence_score}/10 · {expanded ? 'Click to collapse ▲' : 'Click for details ▼'}
        </span>
      </div>

      {/* ── Trade description ── */}
      <div style={{ fontSize: '0.72rem', fontFamily: 'var(--mono)', fontWeight: 700, marginBottom: 5, color: 'var(--text)' }}>
        <span style={{ color: isBuy ? 'var(--green)' : 'var(--red)' }}>{pos.action}</span>
        {' '}{pos.quantity}× {pos.option_type.toUpperCase()}
        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
          {' '}· Strike <strong style={{ color: 'var(--text)' }}>${pos.strike}</strong>
          {' '}· Opened {openedDate}
          {' '}· Exp <strong style={{ color: 'var(--text)' }}>{pos.expiry}</strong>
          {' '}({dte}d left)
        </span>
      </div>

      {/* ── Price / value / P&L grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 6 }}>
        <div style={{ background: 'var(--panel-inset)', borderRadius: 5, padding: '6px 8px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>Entry price</div>
          <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>${pos.fill_price.toFixed(2)}<span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'var(--text-dim)' }}>/sh</span></div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{fmt$(entryVal)} {isBuy ? 'paid' : 'collected'}</div>
        </div>
        <div style={{ background: 'var(--panel-inset)', borderRadius: 5, padding: '6px 8px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>
            {isBuy ? 'Current price' : 'Cost to close'}
          </div>
          <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>${currPx.toFixed(2)}<span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'var(--text-dim)' }}>/sh</span></div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
            {isBuy ? `${fmt$(currVal)} value` : `${fmt$(currVal)} to buy back`}
          </div>
        </div>
        <div style={{
          background: legPnl > 0 ? '#f0fdf4' : legPnl < 0 ? '#fef2f2' : 'var(--panel-inset)',
          borderRadius: 5, padding: '6px 8px',
          border: legPnl !== 0 ? `1px solid ${legPnl > 0 ? '#86efac' : '#fca5a5'}` : undefined,
        }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 2 }}>
            {isClosed ? 'Realized P&L' : 'Unrealized P&L'}
          </div>
          <div className={pnlClass(legPnl)} style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{fmt$(legPnl)}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 1 }}>
            {!isBuy && !isClosed && <span>↑ profit as option loses value</span>}
          </div>
        </div>
      </div>

      {/* ── Exit targets strip ── */}
      <div style={{ display: 'flex', gap: 12, fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: 4 }}>
        <span>🎯 Target <strong style={{ color: 'var(--green)' }}>+{exitConds.profit_target_pct ?? 80}%</strong></span>
        <span>🛑 Stop <strong style={{ color: 'var(--red)' }}>{exitConds.stop_loss_pct ?? -35}%</strong></span>
        <span>📍 Breakeven <strong style={{ color: 'var(--text)' }}>${breakeven.toFixed(2)}</strong></span>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>

          {/* Entry thesis */}
          {pos.entry_thesis && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Entry thesis</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6 }}>{pos.entry_thesis}</div>
            </div>
          )}

          {/* Exit conditions */}
          {exitConds.thesis_decay_signals && (
            <div style={{ marginBottom: 12, background: '#fef2f2', borderRadius: 6, padding: '8px 10px', border: '1px solid #fca5a5' }}>
              <div style={{ fontSize: '0.62rem', color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 4 }}>Exit if…</div>
              <div style={{ fontSize: '0.78rem', color: '#7f1d1d', lineHeight: 1.55 }}>{exitConds.thesis_decay_signals}</div>
            </div>
          )}

          {/* P&L breakdown */}
          <div style={{ marginBottom: 12, background: 'var(--panel-inset)', borderRadius: 6, padding: '10px 12px' }}>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 8 }}>P&L calculation</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontSize: '0.72rem' }}>
              <span style={{ color: 'var(--text-dim)' }}>{isBuy ? 'Entry cost' : 'Premium collected'}</span>
              <span style={{ fontFamily: 'var(--mono)' }}>${pos.fill_price.toFixed(2)} × 100 × {pos.quantity} = {fmt$(entryVal)}</span>
              <span style={{ color: 'var(--text-dim)' }}>{isBuy ? 'Current value' : 'Cost to close now'}</span>
              <span style={{ fontFamily: 'var(--mono)' }}>${currPx.toFixed(2)} × 100 × {pos.quantity} = {fmt$(currVal)}</span>
              <span style={{ color: 'var(--text-dim)' }}>Unrealized P&L</span>
              <span className={pnlClass(legPnl)} style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>
                {isBuy ? `${fmt$(currVal)} − ${fmt$(entryVal)}` : `${fmt$(entryVal)} − ${fmt$(currVal)}`} = {fmt$(legPnl)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
              </span>
            </div>
            {!isBuy && (
              <div style={{ marginTop: 8, fontSize: '0.68rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Short option P&L = premium collected − current cost to close. You profit when the option loses value (theta decay + stock moving away from strike).
              </div>
            )}
          </div>

          {/* Divergence / independent note */}
          {pos.divergence_note && (
            <div style={{ marginBottom: 12, background: '#fef3c7', borderRadius: 6, padding: '8px 10px', border: '1px solid #fcd34d' }}>
              <div style={{ fontSize: '0.62rem', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 3 }}>ARIA note</div>
              <div style={{ fontSize: '0.78rem', color: '#78350f', lineHeight: 1.55 }}>{pos.divergence_note}</div>
            </div>
          )}

          {/* Exit post-mortem */}
          {pos.exit_reasoning && (
            <div style={{ background: '#f0fdf4', borderRadius: 6, padding: '8px 10px', border: '1px solid #86efac' }}>
              <div style={{ fontSize: '0.62rem', color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 3 }}>Exit post-mortem</div>
              <div style={{ fontSize: '0.78rem', color: '#166534', lineHeight: 1.55 }}>{pos.exit_reasoning}</div>
            </div>
          )}

          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 8, fontFamily: 'var(--mono)' }}>
            Opened: {new Date(pos.open_date).toLocaleString()}
            {pos.close_date && ` · Closed: ${new Date(pos.close_date).toLocaleString()}`}
          </div>
        </div>
      )}
    </div>
  )
}

function AriaDecisionLog({ decisions }: { decisions: AriaDecision[] }) {
  const typeConfig: Record<string, { color: string; bg: string; label: string; icon: string }> = {
    ENTRY:         { color: '#1d4ed8', bg: '#eff6ff', label: 'ENTERED',  icon: '⚡' },
    PASS:          { color: '#6b7280', bg: '#f9fafb', label: 'PASSED',   icon: '⏭' },
    HOLD:          { color: '#92400e', bg: '#fffbeb', label: 'HOLDING',  icon: '⏸' },
    EXIT_PROFIT_TARGET: { color: '#15803d', bg: '#f0fdf4', label: 'PROFIT EXIT', icon: '✅' },
    EXIT_STOP_LOSS:     { color: '#991b1b', bg: '#fef2f2', label: 'STOP EXIT',   icon: '🛑' },
    EXIT_AI_EXIT:         { color: '#7c3aed', bg: '#f5f3ff', label: 'AI EXIT',       icon: '🤖' },
    EXIT_HARD_RULE:       { color: '#92400e', bg: '#fffbeb', label: 'HARD EXIT',     icon: '📅' },
    INDEPENDENT_ENTRY:    { color: '#0891b2', bg: '#ecfeff', label: 'ARIA ENTERED',  icon: '⚡' },
    INDEPENDENT_PASS:     { color: '#7c3aed', bg: '#f5f3ff', label: 'ARIA PASSED',   icon: '🧠' },
    INDEPENDENT_SKIP:     { color: '#4b5563', bg: '#f3f4f6', label: 'ARIA SKIPPED',  icon: '⏩' },
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {decisions.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.82rem', padding: '8px 0' }}>
          No decisions yet. Place a trade to trigger ARIA.
        </div>
      )}
      {decisions.map(d => {
        const cfg = typeConfig[d.decision_type] || { color: 'var(--text)', bg: 'var(--panel-inset)', label: d.decision_type, icon: '•' }
        return (
          <div key={d.id} style={{ borderLeft: `3px solid ${cfg.color}`, paddingLeft: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.65rem', padding: '1px 7px', borderRadius: 4, background: cfg.bg, color: cfg.color, fontWeight: 700, fontFamily: 'var(--mono)' }}>
                {cfg.icon} {cfg.label}
              </span>
              <span style={{ fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{d.ticker}</span>
              {d.aria_action && <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{d.aria_action}</span>}
              {d.pnl_at_decision != null && (
                <span className={pnlClass(d.pnl_at_decision)} style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', marginLeft: 'auto' }}>
                  {fmt$(d.pnl_at_decision)}
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.5, marginBottom: 2 }}>{d.reasoning}</div>
            {d.user_trade_summary && (
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>Your trade: {d.user_trade_summary}</div>
            )}
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--mono)' }}>
              {new Date(d.decision_at).toLocaleString()}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Options Scanner ───────────────────────────────────────────────────────────

interface ScanSetup {
  ticker: string; scan_date: string; current_price: number
  direction: string; conviction_score: number; strategy_label: string
  iv_current: number; iv_30d_hv: number; iv_vs_rv: number; iv_regime: string; iv_rank_approx: number
  risk_reversal: number | null; skew_direction: string; call_25d_iv: number | null; put_25d_iv: number | null
  max_pain: number | null; call_wall: number | null; put_wall: number | null
  rsi: number | null; macd_crossover: string | null; above_sma50: boolean | null
  volume_ratio: number | null; adx: number
  rec_expiry: string; rec_dte: number; expected_move: number
  rec_legs: { action: string; option_type: string; strike: number; delta: number; iv: number | null; fill_price: number }[]
  entry_cost: number | null; max_profit: number | null; max_loss: number | null
  breakeven: number | null; risk_reward: number | null; prob_profit: number | null
  days_to_earnings: number | null; signal_summary: string
  warnings: string[]
  advanced_rec: ScanRec | null
  basic_rec: ScanRec | null
}

interface StrikeCompRow {
  label: string; strike: number
  delta: number; gamma: number; theta: number; vega: number
  iv: number | null; premium: number; cost: number
  breakeven: number; breakeven_pct: number; recommended: boolean
}

interface ScanRec {
  strategy_label: string; reasoning: string
  legs: { action: string; option_type: string; strike: number; delta: number; gamma?: number; theta?: number; vega?: number; iv: number | null; fill_price: number }[]
  entry_cost: number | null; max_profit: number | null; max_loss: number | null
  breakeven: number | null; breakeven_up: number | null; breakeven_down: number | null
  risk_reward: number | null; prob_profit: number | null
  strike_comparison?: StrikeCompRow[]
}

function ScannerPanel({ onOpenSetup }: { onOpenSetup: (ticker: string, expiry: string) => void }) {
  const [setups, setSetups]       = useState<ScanSetup[]>([])
  const [selected, setSelected]   = useState<ScanSetup | null>(null)
  const [loading, setLoading]     = useState(true)
  const [scanning, setScanning]   = useState(false)
  const [status, setStatus]       = useState<any>(null)

  const loadSetups = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([getScannerSetups(), getScannerStatus()])
      setSetups(r.data.setups ?? [])
      setStatus(s.data)
      if ((r.data.setups ?? []).length > 0 && !selected)
        setSelected(r.data.setups[0])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadSetups() }, [loadSetups])

  async function handleRunScan() {
    setScanning(true)
    try {
      await triggerScan()
      await new Promise(r => setTimeout(r, 3000))
      await loadSetups()
    } catch { /* ignore */ }
    setScanning(false)
  }

  const dirColor  = (d: string) => d === 'BULLISH' ? '#22c55e' : d === 'BEARISH' ? '#ef4444' : '#94a3b8'
  const ivColor   = (r: string) => r === 'LOW' ? '#22c55e' : r === 'HIGH' ? '#f59e0b' : '#94a3b8'
  const fmt$      = (v: number | null) => v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtPct    = (v: number | null) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
  const convBg    = (s: number) => s >= 70 ? '#166534' : s >= 55 ? '#1e3a5f' : '#374151'

  return (
    <div style={{ display: 'flex', height: '100%', gap: 0 }}>

      {/* Left — setup cards */}
      <div style={{ width: 260, borderRight: '1px solid var(--border)', overflowY: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text)', flex: 1 }}>
            🔭 Scanner {status?.today_count ? `(${status.today_count})` : ''}
          </span>
          <button className="btn sm" onClick={handleRunScan} disabled={scanning}
            style={{ fontSize: '0.7rem', padding: '3px 8px' }}>
            {scanning ? '⟳ Scanning…' : '↻ Run'}
          </button>
        </div>

        {loading && <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: '0.8rem' }}>Loading…</div>}

        {!loading && setups.length === 0 && (
          <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: '0.8rem' }}>
            No setups yet. Click <b>↻ Run</b> to scan 48 blue-chip tickers.
            <br /><br />Scanner runs automatically at 9:40 AM ET on trading days.
          </div>
        )}

        {setups.map(s => (
          <div key={s.ticker} onClick={() => setSelected(s)}
            style={{
              padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
              background: selected?.ticker === s.ticker ? 'var(--hover-bg, rgba(255,255,255,0.05))' : 'transparent',
              borderLeft: selected?.ticker === s.ticker ? '3px solid #06b6d4' : '3px solid transparent',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)' }}>{s.ticker}</span>
              <span style={{
                fontSize: '0.68rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                background: convBg(s.conviction_score), color: '#fff',
              }}>{s.conviction_score}</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: dirColor(s.direction), fontWeight: 600, marginTop: 2 }}>
              {s.direction === 'BULLISH' ? '▲' : '▼'} {s.direction}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>{s.strategy_label}</div>
            <div style={{ fontSize: '0.68rem', color: ivColor(s.iv_regime), marginTop: 2 }}>
              IV {s.iv_regime} · ${s.current_price.toFixed(2)}
            </div>
          </div>
        ))}
      </div>

      {/* Right — full detail */}
      {selected ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontWeight: 800, fontSize: '1.5rem', color: 'var(--text)' }}>{selected.ticker}</span>
            <span style={{ fontSize: '1rem', color: 'var(--text-dim)' }}>${selected.current_price.toFixed(2)}</span>
            <span style={{ padding: '3px 10px', borderRadius: 6, fontWeight: 700, fontSize: '0.8rem',
              background: selected.direction === 'BULLISH' ? '#166534' : '#7f1d1d',
              color: selected.direction === 'BULLISH' ? '#86efac' : '#fca5a5' }}>
              {selected.direction === 'BULLISH' ? '▲' : '▼'} {selected.direction}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              Conviction: <b style={{ color: 'var(--text)', fontSize: '0.9rem' }}>{selected.conviction_score}/100</b>
            </span>
          </div>

          {/* Signal summary */}
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '10px 14px', marginBottom: 14,
            fontSize: '0.75rem', color: 'var(--text-dim)', lineHeight: 1.6, borderLeft: '3px solid #06b6d4' }}>
            {selected.signal_summary}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>

            {/* IV Intelligence */}
            <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#06b6d4', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                IV Intelligence
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { label: 'ATM IV', value: `${selected.iv_current}%` },
                  { label: '30d Realized', value: `${selected.iv_30d_hv}%` },
                  { label: 'IV / HV Ratio', value: `${selected.iv_vs_rv}×` },
                  { label: 'IV Rank ~', value: `${selected.iv_rank_approx}` },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 8, padding: '5px 8px', borderRadius: 5,
                background: selected.iv_regime === 'LOW' ? '#14532d' : selected.iv_regime === 'HIGH' ? '#451a03' : '#1e293b',
                fontSize: '0.7rem', fontWeight: 600,
                color: selected.iv_regime === 'LOW' ? '#86efac' : selected.iv_regime === 'HIGH' ? '#fed7aa' : '#94a3b8' }}>
                {selected.iv_regime === 'LOW' && '✓ Options cheap — buying premium has edge'}
                {selected.iv_regime === 'HIGH' && '⚡ Options rich — selling premium has edge'}
                {selected.iv_regime === 'MEDIUM' && '≈ IV fair — spreads reduce risk'}
              </div>
            </div>

            {/* Volatility Skew */}
            <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#a78bfa', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Volatility Skew
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                {[
                  { label: '25Δ Call IV', value: selected.call_25d_iv != null ? `${selected.call_25d_iv}%` : '—' },
                  { label: '25Δ Put IV',  value: selected.put_25d_iv  != null ? `${selected.put_25d_iv}%`  : '—' },
                  { label: 'Risk Reversal', value: selected.risk_reversal != null ? `${selected.risk_reversal > 0 ? '+' : ''}${selected.risk_reversal.toFixed(1)}` : '—' },
                  { label: 'Skew',  value: selected.skew_direction.replace('_', ' ') },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {selected.skew_direction === 'BULLISH' && '📈 Market is paying up for calls — institutional bullish bias'}
                {selected.skew_direction === 'BEARISH' && '📉 Heavy put demand — market hedging downside aggressively'}
                {selected.skew_direction === 'SLIGHTLY_BEARISH' && '↙ Normal put skew — routine protective demand'}
                {selected.skew_direction === 'NEUTRAL' && '↔ Skew neutral — no strong directional bias from options market'}
              </div>
            </div>

            {/* OI Landscape */}
            <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#f59e0b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                OI Landscape
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                {[
                  { label: 'Max Pain', value: selected.max_pain != null ? `$${selected.max_pain.toFixed(0)}` : '—', note: 'price where most options expire worthless' },
                  { label: 'Call Wall', value: selected.call_wall != null ? `$${selected.call_wall.toFixed(0)}` : '—', note: 'resistance from OI concentration' },
                  { label: 'Put Wall',  value: selected.put_wall  != null ? `$${selected.put_wall.toFixed(0)}`  : '—', note: 'support from OI concentration' },
                ].map(({ label, value, note }) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{value}</div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.3 }}>{note}</div>
                  </div>
                ))}
              </div>
              {selected.call_wall && selected.put_wall && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                  Price range: <b style={{ color: 'var(--text)' }}>${selected.put_wall.toFixed(0)} – ${selected.call_wall.toFixed(0)}</b>
                  {' '}({((selected.call_wall - selected.put_wall) / selected.current_price * 100).toFixed(1)}% band)
                </div>
              )}
            </div>

            {/* Technical Signals */}
            <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.75rem', color: '#34d399', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Technical Signals
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { label: 'RSI (14)',  value: selected.rsi != null ? selected.rsi.toFixed(1) : '—',
                    color: selected.rsi != null ? (selected.rsi > 70 ? '#f59e0b' : selected.rsi > 50 ? '#22c55e' : '#ef4444') : 'var(--text)' },
                  { label: 'ADX',  value: selected.adx.toFixed(1),
                    color: selected.adx > 25 ? '#22c55e' : selected.adx > 18 ? '#f59e0b' : '#94a3b8' },
                  { label: 'MACD',  value: selected.macd_crossover ?? '—',
                    color: selected.macd_crossover === 'bullish' ? '#22c55e' : '#ef4444' },
                  { label: 'Above SMA50',  value: selected.above_sma50 == null ? '—' : selected.above_sma50 ? 'Yes' : 'No',
                    color: selected.above_sma50 ? '#22c55e' : '#ef4444' },
                  { label: 'Volume Ratio',  value: selected.volume_ratio != null ? `${selected.volume_ratio}×` : '—',
                    color: selected.volume_ratio != null && selected.volume_ratio > 1.3 ? '#22c55e' : 'var(--text)' },
                  { label: 'Exp. Move',  value: `±$${selected.expected_move.toFixed(2)}`, color: 'var(--text)' },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Warnings banner */}
          {selected.warnings && selected.warnings.length > 0 && (
            <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: '0.68rem', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                ⚠ Caution Flags
              </div>
              {selected.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: '0.75rem', color: '#78350f', lineHeight: 1.5, marginBottom: i < selected.warnings.length - 1 ? 4 : 0 }}>
                  · {w}
                </div>
              ))}
            </div>
          )}

          {/* Two recommendation cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              { rec: selected.advanced_rec, label: '🧠 Advanced', accent: '#7c3aed', tag: 'Strategy-optimised pick — uses full signal context', isBasic: false },
              { rec: selected.basic_rec,    label: '📌 Basic',    accent: '#06b6d4', tag: 'Simple directional trade — always a long call or put', isBasic: true },
            ].map(({ rec, label, accent, tag, isBasic }) => rec && (
              <div key={label} style={{ background: 'var(--card-bg)', borderRadius: 8, padding: '14px', border: `1px solid ${accent}` }}>
                {/* Header */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.75rem', color: accent, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>
                    {rec.strategy_label}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2, fontStyle: 'italic' }}>{tag}</div>
                </div>

                {/* Reasoning */}
                <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '8px 10px', marginBottom: 10,
                  fontSize: '0.73rem', color: 'var(--text)', lineHeight: 1.6 }}>
                  {rec.reasoning}
                </div>

                {/* Legs */}
                <div style={{ marginBottom: 10 }}>
                  {rec.legs.map((leg, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5,
                      padding: '5px 8px', borderRadius: 5,
                      background: leg.action === 'BUY' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                      border: `1px solid ${leg.action === 'BUY' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                      <span style={{ fontWeight: 700, fontSize: '0.72rem', color: leg.action === 'BUY' ? '#22c55e' : '#ef4444', width: 32 }}>
                        {leg.action}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text)' }}>
                        ${leg.strike.toFixed(0)} {leg.option_type.toUpperCase()}
                      </span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                        Δ{leg.delta.toFixed(2)} · {leg.iv != null ? `${leg.iv.toFixed(0)}%` : '—'}
                        {leg.theta != null && ` · θ${leg.theta.toFixed(3)}`}
                        {leg.vega != null && ` · ν${leg.vega.toFixed(3)}`}
                      </span>
                      <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>
                        ${leg.fill_price.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Metrics */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
                  {[
                    { label: 'Entry Cost', value: fmt$(rec.entry_cost) },
                    { label: 'Max Profit', value: rec.max_profit != null ? fmt$(rec.max_profit) : 'Unlimited', color: '#22c55e' },
                    { label: 'Max Loss',   value: fmt$(rec.max_loss), color: '#ef4444' },
                    { label: rec.breakeven_up ? 'B/E ↑' : 'Breakeven',
                      value: rec.breakeven_up ? `$${rec.breakeven_up.toFixed(2)}` : rec.breakeven != null ? `$${rec.breakeven.toFixed(2)}` : '—' },
                    ...(rec.breakeven_down ? [{ label: 'B/E ↓', value: `$${rec.breakeven_down.toFixed(2)}` }] : []),
                    ...(rec.risk_reward ? [{ label: 'R/R', value: `${rec.risk_reward.toFixed(2)}×`, color: rec.risk_reward >= 1.5 ? '#22c55e' : undefined }] : []),
                    ...(rec.prob_profit ? [{ label: 'PoP', value: `${rec.prob_profit}%`, color: rec.prob_profit >= 60 ? '#22c55e' : undefined }] : []),
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '6px 8px' }}>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontWeight: 700, fontSize: '0.78rem', color: color ?? 'var(--text)', fontFamily: 'var(--mono)' }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Strike Comparison Table — Basic only */}
                {isBasic && rec.strike_comparison && rec.strike_comparison.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#06b6d4', textTransform: 'uppercase',
                      letterSpacing: '0.06em', marginBottom: 6 }}>
                      Strike Comparison — Greeks vs Breakeven
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.66rem' }}>
                        <thead>
                          <tr style={{ color: 'var(--text-dim)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                            {['Strike', 'Δ Delta', 'θ Theta/day', 'ν Vega', 'IV%', 'Premium', 'Breakeven'].map(h => (
                              <th key={h} style={{ padding: '3px 6px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rec.strike_comparison.map((row) => (
                            <tr key={row.label} style={{
                              borderBottom: '1px solid rgba(255,255,255,0.04)',
                              background: row.recommended ? 'rgba(6,182,212,0.1)' : 'transparent',
                            }}>
                              <td style={{ padding: '4px 6px', fontWeight: row.recommended ? 700 : 400, color: row.recommended ? '#06b6d4' : 'var(--text)', whiteSpace: 'nowrap' }}>
                                ${row.strike} <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>({row.label.split(' ')[0]})</span>
                                {row.recommended && <span style={{ marginLeft: 4, color: '#06b6d4', fontSize: '0.6rem' }}>✓ picked</span>}
                              </td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: 'var(--text)' }}>{row.delta.toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: '#ef4444' }}>{row.theta.toFixed(3)}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: '#a78bfa' }}>{row.vega.toFixed(3)}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{row.iv != null ? `${row.iv.toFixed(0)}%` : '—'}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: 'var(--text)' }}>${row.premium.toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)', color: row.recommended ? '#06b6d4' : 'var(--text)' }}>
                                ${row.breakeven.toFixed(2)} <span style={{ color: 'var(--text-dim)' }}>({row.breakeven_pct > 0 ? '+' : ''}{row.breakeven_pct}%)</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 5, lineHeight: 1.5 }}>
                      θ = daily time decay cost · ν = sensitivity to 1% IV change · ✓ picked = recommended for current IV regime
                    </div>
                  </div>
                )}

                <button
                  onClick={() => onOpenSetup(selected.ticker, selected.rec_expiry)}
                  style={{ width: '100%', padding: '8px 0', background: accent, border: 'none',
                    borderRadius: 6, color: '#fff', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}>
                  Open on Trading Desk →
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Select a setup from the left to see full context
        </div>
      )}
    </div>
  )
}


function AriaPanel() {
  const [ariaAccount, setAriaAccount]   = useState<any>(null)
  const [ariaOpen, setAriaOpen]         = useState<AriaPosition[]>([])
  const [ariaClosed, setAriaClosed]     = useState<AriaPosition[]>([])
  const [decisions, setDecisions]       = useState<AriaDecision[]>([])
  const [scoreboard, setScoreboard]     = useState<Scoreboard | null>(null)
  const [ariaTab, setAriaTab]           = useState<'open' | 'closed'>('open')
  const [loading, setLoading]           = useState(true)

  const loadAria = useCallback(async () => {
    try {
      const [acctR, openR, closedR, decR, boardR] = await Promise.all([
        getAriaAccount(), getAriaPositions('OPEN'), getAriaPositions('CLOSED'),
        getAriaDecisions(60), getAriaScoreboard(),
      ])
      setAriaAccount(acctR.data.account)
      setAriaOpen(openR.data.positions ?? [])
      setAriaClosed(closedR.data.positions ?? [])
      setDecisions(decR.data.decisions ?? [])
      setScoreboard(boardR.data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadAria() }, [loadAria])

  async function handleCheckExits() {
    try { await triggerAriaExits(); await loadAria() } catch { /* ignore */ }
  }

  if (loading) return <div className="loading" style={{ padding: '32px 24px' }}>Loading ARIA…</div>

  return (
    <div className="aria-panel">
      {/* Header strip */}
      <div className="aria-header">
        <div>
          <div style={{ fontWeight: 800, fontSize: '0.88rem', color: '#f59e0b' }}>⚡ ARIA</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>Adaptive Risk Intelligence Agent</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn sm" onClick={handleCheckExits} title="Check ARIA exit conditions now">↻ Check exits</button>
          <button className="btn sm" onClick={loadAria}>↻</button>
        </div>
      </div>

      {/* KPI cards */}
      {ariaAccount && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          {[
            {
              label: 'Net Liquidation Value',
              value: fmt$(ariaAccount.net_liq),
              sub: `vs $${ariaAccount.initial_capital.toLocaleString()} starting`,
              color: '#f59e0b',
            },
            {
              label: 'Total Return',
              value: fmtPct(ariaAccount.total_return_pct),
              sub: `P&L: ${fmt$(ariaAccount.total_pnl)}`,
              color: (ariaAccount.total_return_pct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
            },
            {
              label: 'Unrealized P&L',
              value: fmt$(ariaAccount.unrealized_pnl),
              sub: `Realized: ${fmt$(ariaAccount.realized_pnl)}`,
              color: (ariaAccount.unrealized_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
            },
            {
              label: 'Cash Available',
              value: fmt$(ariaAccount.cash),
              sub: `${ariaOpen.length} open · ${ariaClosed.length} closed · ${ariaAccount.win_rate}% win rate`,
              color: 'var(--text)',
            },
          ].map(({ label, value, sub, color }) => (
            <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--mono)', marginBottom: 6 }}>{label}</div>
              <div style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '1.1rem', color }}>{value}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      <div className="aria-body">
        {/* Left (wide): Position cards */}
        <div className="aria-left">
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {(['open', 'closed'] as const).map(t => (
              <button key={t} className={`tab-btn ${ariaTab === t ? 'active' : ''}`}
                style={{ padding: '5px 10px', fontSize: '0.62rem' }}
                onClick={() => setAriaTab(t as 'open' | 'closed')}>
                {t === 'open' ? `OPEN (${ariaOpen.length})` : `CLOSED (${ariaClosed.length})`}
              </button>
            ))}
          </div>

          {ariaTab === 'open' && (
            <>
              {ariaOpen.length === 0 && (
                <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', padding: '8px 0', lineHeight: 1.7 }}>
                  No open ARIA positions.<br />
                  <span style={{ fontSize: '0.72rem' }}>ARIA scans for independent trades on each market revalue cycle. Every decision and reason is logged in the Decision Diary on the right.</span>
                </div>
              )}
              {(() => {
                const entryMap = new Map<number, string>()
                decisions.forEach(d => {
                  if (d.decision_type === 'ENTRY' && d.position_id != null && d.aria_action)
                    entryMap.set(d.position_id, d.aria_action)
                })
                return ariaOpen.map(pos =>
                  <AriaPositionCard key={pos.id} pos={pos} entryAction={entryMap.get(pos.id)} />
                )
              })()}
            </>
          )}

          {ariaTab === 'closed' && (
            <>
              {ariaClosed.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No closed positions.</div>}
              {(() => {
                const entryMap = new Map<number, string>()
                decisions.forEach(d => {
                  if (d.decision_type === 'ENTRY' && d.position_id != null && d.aria_action)
                    entryMap.set(d.position_id, d.aria_action)
                })
                return ariaClosed.map(pos =>
                  <AriaPositionCard key={pos.id} pos={pos} entryAction={entryMap.get(pos.id)} />
                )
              })()}
            </>
          )}
        </div>

        {/* Right (narrow rail): Scoreboard + Decision diary */}
        <div className="aria-right">
          <ScoreboardCard board={scoreboard} />
          <div style={{ margin: '16px 0 6px', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-bright)' }}>Decision Diary</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>
            Every ARIA decision — enter, hold, pass, skip, or exit — with full reasoning.
          </div>
          <AriaDecisionLog decisions={decisions.slice(0, 30)} />
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OptionsDeskPage() {
  const [account, setAccount]           = useState<Account | null>(null)
  const [positions, setPositions]       = useState<Position[]>([])
  const [closedPos, setClosedPos]       = useState<Position[]>([])
  const [alerts, setAlerts]             = useState<Alert[]>([])
  const [perfCurve, setPerfCurve]       = useState<PerfPoint[]>([])
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null)
  const [showHelp, setShowHelp]         = useState(false)

  // Chain state
  const [ticker, setTicker]             = useState('SPY')
  const [expirations, setExpirations]   = useState<string[]>([])
  const [selectedExpiry, setSelectedExpiry] = useState('')
  const [chainData, setChainData]       = useState<{ calls: ChainRow[]; puts: ChainRow[]; underlying: number; dte: number; expected_move: number } | null>(null)
  const [chainLoading, setChainLoading] = useState(false)

  // Single-leg builder
  const [selectedRow, setSelectedRow]   = useState<{ side: 'call' | 'put'; row: ChainRow } | null>(null)
  const [builderAction, setBuilderAction] = useState<'BUY' | 'SELL'>('BUY')
  const [builderQty, setBuilderQty]     = useState(1)
  const [builderNote, setBuilderNote]   = useState('')
  const [opening, setOpening]           = useState(false)
  const [openError, setOpenError]       = useState('')

  // Scenario
  const [scenarioRows, setScenarioRows] = useState<ScenarioRow[]>([])
  const [scenarioRange, setScenarioRange] = useState(20)
  const [scenarioSteps, setScenarioSteps] = useState(11)

  // AI
  const [aiPositionId, setAiPositionId] = useState<number | null>(null)
  const [aiQuestion, setAiQuestion]     = useState('')
  const [aiLoading, setAiLoading]       = useState(false)
  const [aiText, setAiText]             = useState('')

  // ARIA notifications
  const [ariaToast, setAriaToast]     = useState<{ ticker: string; strategy: string; thesis: string; cost: string } | null>(null)
  const lastAriaDecisionId            = useRef<number>(0)

  // Request browser notification permission once, then poll for new ARIA entries
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }

    const poll = async () => {
      try {
        const r = await getAriaDecisions(10)
        const decisions: AriaDecision[] = r.data.decisions ?? []
        if (decisions.length === 0) return

        const maxId = Math.max(...decisions.map((d: AriaDecision) => d.id ?? 0))
        if (lastAriaDecisionId.current === 0) {
          // First load — just seed the cursor, no notification
          lastAriaDecisionId.current = maxId
          return
        }

        const fresh = decisions.filter(
          (d: AriaDecision) =>
            (d.id ?? 0) > lastAriaDecisionId.current &&
            (d.decision_type === 'INDEPENDENT_ENTRY' || d.decision_type === 'ENTRY')
        )

        if (fresh.length > 0) {
          lastAriaDecisionId.current = maxId
          const d = fresh[0]
          const ticker   = d.ticker ?? ''
          const strategy = d.aria_action?.split(':')[0]?.trim() ?? 'Trade'
          const thesis   = d.reasoning?.slice(0, 100) ?? ''
          const cost     = ''

          // In-app toast
          setAriaToast({ ticker, strategy, thesis, cost })

          // OS-level browser notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`🤖 ARIA opened a position on ${ticker}`, {
              body: `${strategy}\n${thesis}`,
              icon: '/favicon.ico',
            })
          }
        }
      } catch { /* ignore polling errors */ }
    }

    poll() // immediate first check
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [])

  // Tabs
  const [pageTab, setPageTab]         = useState<'portfolio' | 'live' | 'trading' | 'aria' | 'scanner'>('portfolio')
  const [builderTab, setBuilderTab]   = useState<'single' | 'spread'>('single')
  const [rightTab, setRightTab]       = useState<'builder' | 'positions' | 'closed' | 'performance'>('builder')
  const [revalLoading, setRevalLoading] = useState(false)

  const loadAll = useCallback(async () => {
    try {
      const [acctR, openR, closedR, alertR, perfR, mktR] = await Promise.all([
        getOptionsAccount(), getOpenPositions(), getClosedPositions(),
        getOptionsAlerts(), getOptionsPerformance(30), getMarketStatus(),
      ])
      setAccount(acctR.data.account)
      setPositions(openR.data.positions ?? [])
      setClosedPos(closedR.data.positions ?? [])
      setAlerts(alertR.data.alerts ?? [])
      setPerfCurve(perfR.data.curve ?? [])
      setMarketStatus(mktR.data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function loadExpirations() {
    if (!ticker) return
    try {
      const r = await getOptionExpirations(ticker.toUpperCase())
      const exps: string[] = r.data.expirations ?? []
      setExpirations(exps)
      if (exps.length) setSelectedExpiry(exps[0])
    } catch { /* ignore */ }
  }

  async function loadChain() {
    if (!ticker || !selectedExpiry) return
    setChainLoading(true); setChainData(null); setScenarioRows([]); setSelectedRow(null)
    try {
      const r = await getOptionChain(ticker.toUpperCase(), selectedExpiry)
      setChainData(r.data)
    } catch { /* ignore */ }
    setChainLoading(false)
  }

  async function handleSelectChainRow(side: 'call' | 'put', row: ChainRow) {
    setSelectedRow({ side, row }); setOpenError(''); setBuilderTab('single')
    if (!chainData) return
    try {
      const r = await scenarioLive({
        ticker: ticker.toUpperCase(), expiry: selectedExpiry, strike: row.strike,
        option_type: side, action: builderAction,
        fill_price: row.mid ?? row.ask ?? row.lastPrice ?? 0,
        quantity: builderQty, price_range_pct: scenarioRange / 100, steps: scenarioSteps,
      })
      setScenarioRows(r.data.rows ?? [])
    } catch { /* ignore */ }
  }

  async function handleOpenPosition() {
    if (!selectedRow) return
    setOpening(true); setOpenError('')
    try {
      await openOptionsPosition({
        ticker: ticker.toUpperCase(), expiry: selectedExpiry, strike: selectedRow.row.strike,
        option_type: selectedRow.side, action: builderAction,
        quantity: builderQty, note: builderNote,
      })
      await loadAll(); setSelectedRow(null); setBuilderNote(''); setRightTab('positions')
    } catch (e: any) {
      setOpenError(e?.response?.data?.detail ?? 'Failed to open position')
    }
    setOpening(false)
  }

  async function handleClosePosition(posId: number) {
    if (!confirm('Close this position at current market price?')) return
    try { await closeOptionsPosition(posId); await loadAll() } catch { /* ignore */ }
  }

  async function handleRevalue() {
    setRevalLoading(true)
    try { await triggerRevalue(); await loadAll() } catch { /* ignore */ }
    setRevalLoading(false)
  }

  async function handleAICommentary(posId: number) {
    setAiPositionId(posId); setAiText(''); setAiLoading(true)
    try {
      const r = await getOptionsAICommentary(posId, aiQuestion)
      setAiText(r.data.commentary ?? '')
    } catch { /* ignore */ }
    setAiLoading(false)
  }

  async function refreshScenario() {
    if (!selectedRow || !chainData) return
    try {
      const r = await scenarioLive({
        ticker: ticker.toUpperCase(), expiry: selectedExpiry, strike: selectedRow.row.strike,
        option_type: selectedRow.side, action: builderAction,
        fill_price: selectedRow.row.mid ?? selectedRow.row.ask ?? 0,
        quantity: builderQty, price_range_pct: scenarioRange / 100, steps: scenarioSteps,
      })
      setScenarioRows(r.data.rows ?? [])
    } catch { /* ignore */ }
  }

  return (
    <div className="opts-desk">
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {/* ARIA trade notification toast */}
      {ariaToast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: 'var(--card-bg, #1a1f2e)', border: '1px solid #7c3aed',
          borderRadius: 10, padding: '14px 16px', maxWidth: 320,
          boxShadow: '0 4px 24px rgba(124,58,237,0.35)',
          animation: 'slideInRight 0.25s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#a78bfa', marginBottom: 4 }}>
                🤖 ARIA opened a position
              </div>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text)', marginBottom: 2 }}>
                {ariaToast.ticker} — {ariaToast.strategy}
              </div>
              {ariaToast.thesis && (
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                  {ariaToast.thesis}{ariaToast.thesis.length >= 100 ? '…' : ''}
                </div>
              )}
            </div>
            <button
              onClick={() => setAriaToast(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: 0, flexShrink: 0 }}
            >✕</button>
          </div>
          <button
            onClick={() => { setAriaToast(null); setPageTab('aria') }}
            style={{ marginTop: 10, width: '100%', padding: '6px 0', background: '#7c3aed', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer' }}
          >View ARIA →</button>
        </div>
      )}

      <AccountBar account={account} marketStatus={marketStatus} onHelp={() => setShowHelp(true)} onReval={handleRevalue} revalLoading={revalLoading} />
      <AlertsBanner alerts={alerts} />

      {/* Top-level tab selector */}
      <div className="opts-page-tabs">
        <button className={`opts-page-tab ${pageTab === 'portfolio' ? 'active' : ''}`} onClick={() => setPageTab('portfolio')}>
          📈 Portfolio
        </button>
        <button className={`opts-page-tab ${pageTab === 'live' ? 'active' : ''}`} onClick={() => setPageTab('live')}>
          📋 Live Portfolio
        </button>
        <button className={`opts-page-tab ${pageTab === 'trading' ? 'active' : ''}`} onClick={() => setPageTab('trading')}>
          📊 Trading Desk
        </button>
        <button className={`opts-page-tab aria-tab ${pageTab === 'aria' ? 'active' : ''}`} onClick={() => setPageTab('aria')}>
          ⚡ ARIA Agent
        </button>
        <button className={`opts-page-tab ${pageTab === 'scanner' ? 'active' : ''}`} onClick={() => setPageTab('scanner')}
          style={{ borderColor: pageTab === 'scanner' ? '#06b6d4' : undefined, color: pageTab === 'scanner' ? '#06b6d4' : undefined }}>
          🔭 Options Scanner
        </button>
      </div>

      {pageTab === 'portfolio' && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <PortfolioPanel />
        </div>
      )}

      {pageTab === 'live' && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <LivePortfolioPanel />
        </div>
      )}

      {pageTab === 'aria' && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <AriaPanel />
        </div>
      )}

      {pageTab === 'scanner' && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <ScannerPanel onOpenSetup={(t, exp) => {
            setTicker(t)
            setSelectedExpiry(exp)
            setPageTab('trading')
          }} />
        </div>
      )}

      {pageTab === 'trading' && <div className="opts-shell">
        {/* ── LEFT: Chain ── */}
        <div className="opts-left">
          <div className="opts-chain-controls">
            <input className="input" style={{ width: 86 }} value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="TICKER"
              onKeyDown={e => { if (e.key === 'Enter') loadExpirations() }} />
            <button className="btn sm" onClick={loadExpirations}>Load</button>
            {expirations.length > 0 && (
              <select className="input" style={{ width: 126 }} value={selectedExpiry}
                onChange={e => setSelectedExpiry(e.target.value)}>
                {expirations.map(exp => <option key={exp} value={exp}>{exp}</option>)}
              </select>
            )}
            {selectedExpiry && (
              <button className="btn sm primary" onClick={loadChain} disabled={chainLoading}>
                {chainLoading ? 'Loading…' : 'Fetch Chain'}
              </button>
            )}
          </div>

          {chainData && (
            <div className="opts-chain-meta">
              <span className="mono" style={{ fontWeight: 700 }}>{ticker} @ {fmt$(chainData.underlying)}</span>
              <span>DTE: <strong>{chainData.dte}</strong></span>
              <span style={{ color: 'var(--text-dim)' }}>Expected ±{fmt$(chainData.expected_move)}</span>
              {marketStatus && !marketStatus.is_open && (
                <span style={{ color: '#92400e', fontWeight: 700, fontSize: '0.68rem', background: '#fef3c7', padding: '1px 6px', borderRadius: 4 }}>
                  ⚠ Stale prices — {marketStatus.is_weekend ? 'market closed (weekend)' : 'market closed'}
                </span>
              )}
              {marketStatus?.is_open && (
                <span style={{ color: '#15803d', fontSize: '0.68rem' }}>● Live</span>
              )}
            </div>
          )}

          {chainLoading && <div className="loading" style={{ padding: '24px 16px' }}>Fetching live options chain…</div>}
          {chainData && <ChainTable calls={chainData.calls} puts={chainData.puts} underlying={chainData.underlying} onSelect={handleSelectChainRow} />}
          {!chainData && !chainLoading && (
            <div style={{ padding: '32px 16px', color: 'var(--text-dim)', textAlign: 'center', fontSize: '0.82rem', lineHeight: 1.8 }}>
              Enter a ticker → Load → pick expiry → Fetch Chain<br />
              <span style={{ fontSize: '0.72rem' }}>Green = in-the-money · Cyan row = ATM</span>
            </div>
          )}
        </div>

        {/* ── CENTER: Snapshot + Scenario + AI ── */}
        <div className="opts-center">
          {selectedRow ? (
            <>
              {/* Trade Snapshot */}
              <div className="card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ fontWeight: 800, fontFamily: 'var(--mono)', fontSize: '0.88rem' }}>
                    {ticker} ${selectedRow.row.strike} {selectedRow.side.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    {selectedExpiry} · Mid: <strong>{fmtNum(selectedRow.row.mid, 3)}</strong>
                  </span>
                  {(() => {
                    const liq = getLiquidityScore(selectedRow.row)
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.65rem', padding: '1px 8px', borderRadius: 12, fontFamily: 'var(--mono)', fontWeight: 700, background: liq === 'good' ? '#f0fdf4' : liq === 'fair' ? '#fffbeb' : '#fef2f2', color: LIQ_DOT[liq], border: `1px solid ${liq === 'good' ? '#86efac' : liq === 'fair' ? '#fcd34d' : '#fca5a5'}` }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: LIQ_DOT[liq], display: 'inline-block' }} />
                        {liq === 'good' ? 'Good liquidity' : liq === 'fair' ? 'Fair liquidity' : 'Poor liquidity'}
                      </span>
                    )
                  })()}
                </div>
                <TradeSnapshot
                  row={selectedRow.row} side={selectedRow.side} action={builderAction}
                  qty={builderQty} underlying={chainData?.underlying ?? 0} dte={chainData?.dte ?? 30}
                />
              </div>

              {/* Scenario P&L */}
              <div className="card" style={{ marginBottom: 10 }}>
                <div className="card-title" style={{ marginBottom: 6 }}>Scenario P&L Grid</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: 10 }}>
                  Each row = a possible stock price. Each column = days elapsed. <strong>Green = profit, Red = loss.</strong>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Price range ±</label>
                  <input type="range" min={5} max={50} value={scenarioRange}
                    onChange={e => setScenarioRange(Number(e.target.value))} style={{ width: 80 }} />
                  <span className="mono" style={{ fontSize: '0.72rem' }}>{scenarioRange}%</span>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: 8 }}>Steps</label>
                  <select className="input" style={{ width: 60 }} value={scenarioSteps}
                    onChange={e => setScenarioSteps(Number(e.target.value))}>
                    {[7, 9, 11, 13].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button className="btn sm" onClick={refreshScenario}>Recalculate</button>
                </div>
                {scenarioRows.length > 0 && <ScenarioTable rows={scenarioRows} />}
              </div>
            </>
          ) : (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="card-title">Trade Snapshot</div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.82rem', padding: '8px 0', lineHeight: 1.7 }}>
                Click any strike in the chain table to get a plain-English breakdown: breakeven price, probability of profit, daily theta drain, spread entry cost, and an IV reading — plus a one-line verdict.<br />
                <span style={{ fontSize: '0.72rem' }}>Liquidity dots in the chain: <span style={{ color: '#16a34a' }}>●</span> good · <span style={{ color: '#d97706' }}>●</span> fair · <span style={{ color: '#dc2626' }}>●</span> poor</span>
              </div>
            </div>
          )}

          {/* Performance chart */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 8 }}>Account Equity Curve</div>
            <PerformanceChart curve={perfCurve} />
          </div>

          {/* AI Commentary */}
          {aiPositionId != null && (
            <div className="card" style={{ marginTop: 10 }}>
              <div className="card-title">AI Analysis — Position #{aiPositionId}</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Ask anything about this position…"
                  value={aiQuestion} onChange={e => setAiQuestion(e.target.value)} style={{ flex: 1 }} />
                <button className="btn sm primary" onClick={() => handleAICommentary(aiPositionId!)} disabled={aiLoading}>
                  {aiLoading ? 'Asking…' : 'Ask Sonnet'}
                </button>
                <button className="btn sm" onClick={() => { setAiPositionId(null); setAiText('') }}>✕</button>
              </div>
              {aiLoading && <div className="loading">Analyzing with Claude Sonnet…</div>}
              {aiText && <div className="reasoning-box" style={{ whiteSpace: 'pre-wrap' }}>{aiText}</div>}
            </div>
          )}
        </div>

        {/* ── RIGHT: Builder + Positions ── */}
        <div className="opts-right">
          <div style={{ display: 'flex', gap: 2, marginBottom: 10, flexWrap: 'wrap' }}>
            {([['builder', 'BUILDER'], ['positions', `OPEN (${positions.length})`], ['closed', `CLOSED (${closedPos.length})`], ['performance', 'P&L']] as const).map(([t, label]) => (
              <button key={t} className={`tab-btn ${rightTab === t ? 'active' : ''}`}
                style={{ padding: '5px 8px', fontSize: '0.62rem' }}
                onClick={() => setRightTab(t as any)}>{label}</button>
            ))}
          </div>

          {/* ── BUILDER TAB ── */}
          {rightTab === 'builder' && (
            <div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                <button className={`btn sm ${builderTab === 'single' ? 'primary' : ''}`} onClick={() => setBuilderTab('single')}>Single Leg</button>
                <button className={`btn sm ${builderTab === 'spread' ? 'primary' : ''}`} onClick={() => setBuilderTab('spread')}>Spreads</button>
              </div>

              {builderTab === 'single' && (
                <>
                  {!selectedRow ? (
                    <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', padding: '8px 0', lineHeight: 1.6 }}>
                      Click any Bid or Ask price in the chain table to select a contract and build your order here.
                    </div>
                  ) : (
                    <div>
                      <div style={{ marginBottom: 10, padding: '8px 12px', background: 'var(--panel-inset)', borderRadius: 6, border: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', marginBottom: 6 }}>
                          {ticker} ${selectedRow.row.strike} {selectedRow.side.toUpperCase()}
                        </div>
                        <div style={{ fontSize: '0.72rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
                          <span>Bid: <strong>{fmtNum(selectedRow.row.bid, 2)}</strong></span>
                          <span>Ask: <strong>{fmtNum(selectedRow.row.ask, 2)}</strong></span>
                          <span>IV: <strong>{selectedRow.row.iv.toFixed(1)}%</strong></span>
                          <span>Δ: <strong>{fmtNum(selectedRow.row.delta, 3)}</strong></span>
                          <span>θ/day: <strong>{fmtNum(selectedRow.row.theta, 4)}</strong></span>
                          <span>OI: <strong>{selectedRow.row.openInterest.toLocaleString()}</strong></span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        <button className={`btn sm ${builderAction === 'BUY' ? 'primary' : ''}`} onClick={() => setBuilderAction('BUY')}>BUY (go long)</button>
                        <button className={`btn sm ${builderAction === 'SELL' ? 'danger' : ''}`} onClick={() => setBuilderAction('SELL')}>SELL (short)</button>
                      </div>

                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Contracts (1 = 100 shares)</label>
                        <input type="number" className="input" min={1} max={100} value={builderQty}
                          onChange={e => setBuilderQty(Math.max(1, Number(e.target.value)))} />
                      </div>

                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Trade Note</label>
                        <textarea className="input" rows={2} style={{ resize: 'vertical', fontFamily: 'var(--sans)' }}
                          value={builderNote} onChange={e => setBuilderNote(e.target.value)}
                          placeholder="Why are you making this trade?" />
                      </div>

                      <div style={{ marginBottom: 8, background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px', fontSize: '0.72rem' }}>
                        <div>Fill price: <strong>{builderAction === 'BUY' ? fmtNum(selectedRow.row.ask, 3) : fmtNum(selectedRow.row.bid, 3)}</strong> (market fill)</div>
                        <div>Total cost: <strong>{fmt$((builderAction === 'BUY' ? (selectedRow.row.ask ?? 0) : (selectedRow.row.bid ?? 0)) * 100 * builderQty + 0.65 * builderQty)}</strong></div>
                        <div style={{ color: 'var(--text-dim)' }}>Commission: ${(0.65 * builderQty).toFixed(2)} ($0.65/contract)</div>
                      </div>

                      {openError && <div style={{ color: 'var(--red)', fontSize: '0.75rem', marginBottom: 8 }}>{openError}</div>}
                      <button className="btn primary" style={{ width: '100%' }} onClick={handleOpenPosition} disabled={opening}>
                        {opening ? 'Submitting…' : `${builderAction} ${builderQty}x ${selectedRow.side.toUpperCase()} @ ${ticker}`}
                      </button>
                      <button className="btn sm" style={{ width: '100%', marginTop: 6 }} onClick={() => setSelectedRow(null)}>Cancel</button>
                    </div>
                  )}
                </>
              )}

              {builderTab === 'spread' && (
                <SpreadBuilder
                  ticker={ticker} expiry={selectedExpiry} chainData={chainData}
                  onOpened={() => { loadAll(); setRightTab('positions') }}
                />
              )}
            </div>
          )}

          {/* ── POSITIONS TAB ── */}
          {rightTab === 'positions' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span className="card-title">Open Positions</span>
                <button className="btn sm" onClick={loadAll}>↻</button>
              </div>
              {positions.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No open positions. Use the Builder tab to enter a trade.</div>}
              {positions.map(pos => (
                <PositionCard key={pos.id} pos={pos} onClose={handleClosePosition}
                  onAI={id => { setAiPositionId(id); setAiText('') }} />
              ))}
            </div>
          )}

          {/* ── CLOSED TAB ── */}
          {rightTab === 'closed' && (
            <div>
              <span className="card-title" style={{ display: 'block', marginBottom: 8 }}>Closed Positions</span>
              {closedPos.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No closed positions yet.</div>}
              {closedPos.map(pos => (
                <PositionCard key={pos.id} pos={pos} onClose={() => {}}
                  onAI={id => { setAiPositionId(id); setAiText('') }} />
              ))}
            </div>
          )}

          {/* ── PERFORMANCE TAB ── */}
          {rightTab === 'performance' && (
            <div>
              <div className="card-title" style={{ marginBottom: 10 }}>Equity Curve (30 days)</div>
              <PerformanceChart curve={perfCurve} />
              {account && (
                <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Starting Capital', value: fmt$(account.initial_capital) },
                    { label: 'Current Net Liq', value: fmt$(account.net_liq) },
                    { label: 'Total P&L', value: fmt$(account.total_pnl) },
                    { label: 'Total Return', value: fmtPct(account.total_return_pct) },
                    { label: 'Realized P&L', value: fmt$(account.realized_pnl) },
                    { label: 'Unrealized', value: fmt$(account.unrealized_pnl) },
                    { label: 'Commissions Paid', value: fmt$(account.total_commissions) },
                    { label: 'Open Positions', value: String(positions.length) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'var(--panel-inset)', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--mono)', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.88rem' }}>{value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>}
    </div>
  )
}
