import { useEffect, useState, useCallback } from 'react'
import {
  getAlphaQueue, getAlphaRun, decideAlphaRun, triggerAlphaCommittee,
  getAlphaMarketNarrative, getAlphaCalibration, applyCalibration,
  rejectCalibration, getCounterfactualSummary,
} from '../../api'
import ThesisTab from '../../components/alpha/decision/ThesisTab'
import ResearchTab from '../../components/alpha/decision/ResearchTab'
import DebateTab from '../../components/alpha/decision/DebateTab'
import RiskPlanTab from '../../components/alpha/decision/RiskPlanTab'
import LessonsAppliedTab from '../../components/alpha/decision/LessonsAppliedTab'
import SimilarTradesTab from '../../components/alpha/decision/SimilarTradesTab'
import ThinkingTimeline from '../../components/alpha/ThinkingTimeline'
import LiveActivityFeed from '../../components/alpha/LiveActivityFeed'
import type { ActivityEntry } from '../../components/alpha/LiveActivityFeed'

interface Run {
  id: number; ticker: string; final_action: string; final_confidence: number
  decision_json: string; research_json: string; bull_json: string
  bear_json: string; risk_json: string; approval_status: string; completed_at: string
}

interface Theme {
  sector: string; direction: 'UP' | 'DOWN'; stocks: string[]; avg_move: number
}

interface Narrative {
  id: number; scan_at: string; regime: string; theme: string
  confidence: number; narrative: string; promoted_count: number
  sectors_leading_up: string[]; sectors_leading_down: string[]
  themes: Theme[]
}

interface Opportunity {
  ticker: string; price_move: number; vol_ratio: number; sector: string
  expected_alpha_20d: number; confidence: number; score: number
  tier: string; tier_label: string; meets_hurdle: boolean; data_source: string
}

interface CalibrationRecord {
  id: number; alpha_source: string; observations: number
  avg_predicted: number; avg_actual: number; calibration_error: number
  proposed_multiplier: number; status: string; created_at: string
}

interface CounterfactualSummary {
  total_tracked: number; resolved: number
  opportunity_cost_usd: number; bias_detected: boolean
  bias_message: string; recent: CounterfactualEntry[]
}

interface CounterfactualEntry {
  id: number; ticker: string; passed_at: string; reason_passed: string
  expected_alpha_at_pass: number; return_20d: number | null
  alpha_20d: number | null; regime: string; theme: string
}

type TabId = 'thesis' | 'research' | 'debate' | 'similar' | 'lessons' | 'risk' | 'zone3'

const TABS: { id: TabId; label: string }[] = [
  { id: 'zone3',    label: '⚡ Portfolio Fit'  },
  { id: 'thesis',   label: 'Thesis'            },
  { id: 'research', label: 'Research'           },
  { id: 'debate',   label: 'Bull vs Bear'       },
  { id: 'similar',  label: 'Similar Trades'    },
  { id: 'lessons',  label: 'Lessons Applied'   },
  { id: 'risk',     label: 'Risk Plan'          },
]

const actionColor: Record<string, string> = {
  BUY: '#22c55e', LONG: '#22c55e', SELL: '#ef4444', SHORT: '#ef4444',
  HOLD: '#f59e0b', REDUCE: '#f59e0b', WATCHLIST: '#60a5fa', PASS: '#64748b',
}

const regimeColor: Record<string, { bg: string; text: string; border: string }> = {
  EVENT_DRIVEN: { bg: 'rgba(234,179,8,0.12)',   text: '#eab308', border: 'rgba(234,179,8,0.3)'   },
  RISK_ON:      { bg: 'rgba(34,197,94,0.12)',   text: '#22c55e', border: 'rgba(34,197,94,0.3)'   },
  RISK_OFF:     { bg: 'rgba(239,68,68,0.12)',   text: '#ef4444', border: 'rgba(239,68,68,0.3)'   },
  CRISIS:       { bg: 'rgba(239,68,68,0.2)',    text: '#f87171', border: 'rgba(239,68,68,0.5)'   },
  NORMAL:       { bg: 'rgba(100,116,139,0.12)', text: '#94a3b8', border: 'rgba(100,116,139,0.3)' },
}

const tierColor: Record<string, string> = {
  FULL_COMMITTEE: '#22c55e',
  LIGHT_REVIEW:   '#eab308',
  WATCH:          '#60a5fa',
  IGNORE:         '#475569',
}

function RegimeBadge({ regime }: { regime: string }) {
  const c = regimeColor[regime] || regimeColor.NORMAL
  return (
    <span style={{
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700,
      fontFamily: 'var(--mono)', letterSpacing: '0.05em',
    }}>
      {regime.replace('_', ' ')}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value))
  const color = pct >= 75 ? '#22c55e' : pct >= 55 ? '#eab308' : '#ef4444'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color, fontFamily: 'var(--mono)' }}>{pct}%</span>
    </div>
  )
}

function MarketStoryZone({ narrative, loading }: { narrative: Narrative | null; loading: boolean }) {
  const upThemes  = narrative?.themes?.filter(t => t.direction === 'UP').slice(0, 4)  || []
  const dnThemes  = narrative?.themes?.filter(t => t.direction === 'DOWN').slice(0, 3) || []
  const noActivity = !narrative || narrative.theme === 'No Activity' || narrative.promoted_count === 0

  return (
    <div style={{
      flex: '0 0 42%', borderRight: '1px solid rgba(255,255,255,0.06)',
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Zone 1 · Market Story
        </span>
        {loading && <span style={{ fontSize: 10, color: '#475569' }}>updating…</span>}
      </div>

      {noActivity ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#475569' }}>
            {!narrative ? 'Awaiting first scan…' : 'Market quiet — no stocks moved 3%+ in last scan.'}
          </span>
          {narrative?.scan_at && (
            <span style={{ fontSize: 10, color: '#334155' }}>
              Last scan: {new Date(narrative.scan_at).toLocaleTimeString()}
            </span>
          )}
          <div style={{ fontSize: 11, color: '#334155', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: 8 }}>
            💡 The agent scans every 5 min during market hours. When stocks move 3%+ you'll see the theme here.
          </div>
        </div>
      ) : (
        <>
          {/* Regime + theme row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <RegimeBadge regime={narrative.regime} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{narrative.theme}</span>
            <ConfidenceBar value={narrative.confidence} />
          </div>

          {/* Narrative text */}
          <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.45, margin: 0, flexShrink: 0 }}>
            {narrative.narrative}
          </p>

          {/* Sector heatmap */}
          {(upThemes.length > 0 || dnThemes.length > 0) && (
            <div style={{ display: 'flex', gap: 10, flex: 1, overflow: 'hidden' }}>
              {upThemes.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: '#22c55e', fontWeight: 700, marginBottom: 4, letterSpacing: '0.06em' }}>
                    ▲ LEADING
                  </div>
                  {upThemes.map(t => (
                    <div key={t.sector} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{t.sector}</span>
                      <span style={{ fontSize: 11, color: '#22c55e', fontFamily: 'var(--mono)', fontWeight: 600 }}>
                        {t.avg_move > 0 ? '+' : ''}{t.avg_move.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {dnThemes.length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 700, marginBottom: 4, letterSpacing: '0.06em' }}>
                    ▼ LAGGING
                  </div>
                  {dnThemes.map(t => (
                    <div key={t.sector} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{t.sector}</span>
                      <span style={{ fontSize: 11, color: '#ef4444', fontFamily: 'var(--mono)', fontWeight: 600 }}>
                        {t.avg_move.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div style={{ fontSize: 10, color: '#334155', flexShrink: 0 }}>
            {narrative.promoted_count} stocks promoted · {narrative.scan_at ? new Date(narrative.scan_at).toLocaleTimeString() : ''}
          </div>
        </>
      )}
    </div>
  )
}

function OpportunitiesZone({ opportunities, cfSummary, onRunCommittee }: {
  opportunities: Opportunity[]
  cfSummary: CounterfactualSummary | null
  onRunCommittee: (ticker: string) => void
}) {
  const top = opportunities.slice(0, 6)
  const bestAlpha = top[0]?.expected_alpha_20d ?? 0
  const hurdleMet = top.some(o => o.meets_hurdle)

  // Recent counterfactuals to suggest for manual analysis
  const recentPasses = cfSummary?.recent?.slice(0, 4) ?? []

  return (
    <div style={{
      flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
      overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
        Zone 2 · Opportunities — ranked by expected alpha vs SPY
      </div>

      {top.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#475569' }}>No live movers in last scan.</span>

          {recentPasses.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                ↓ Recent passes — tracked for outcome · click to analyse manually
              </div>
              {recentPasses.map(cf => (
                <div key={cf.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 10px', borderRadius: 5,
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)',
                }}>
                  <div>
                    <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9', marginRight: 8 }}>{cf.ticker}</span>
                    <span style={{ fontSize: 10, color: '#475569' }}>{cf.regime} · passed {new Date(cf.passed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <button
                    onClick={() => onRunCommittee(cf.ticker)}
                    style={{
                      fontSize: 10, padding: '2px 10px', borderRadius: 4,
                      background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
                      color: '#818cf8', cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    Analyse →
                  </button>
                </div>
              ))}
            </>
          )}

          {recentPasses.length === 0 && (
            <div style={{ fontSize: 11, color: '#334155' }}>
              💡 Enter any ticker above to manually trigger a committee run.
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Table header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.4fr 1fr auto',
            gap: 6, padding: '0 4px', flexShrink: 0,
          }}>
            {['Ticker', 'Move', 'Exp. Alpha vs SPY', 'Tier', ''].map(h => (
              <div key={h} style={{ fontSize: 10, color: '#475569', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</div>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {top.map((opp, i) => (
              <div key={opp.ticker} style={{
                display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.4fr 1fr auto',
                gap: 6, padding: '4px', borderRadius: 4,
                background: i === 0 ? 'rgba(34,197,94,0.04)' : 'transparent',
                alignItems: 'center',
              }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
                  {i + 1}. {opp.ticker}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 12,
                  color: opp.price_move >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600,
                }}>
                  {opp.price_move >= 0 ? '+' : ''}{opp.price_move.toFixed(1)}%
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                    color: opp.meets_hurdle ? '#22c55e' : '#94a3b8',
                  }}>
                    {opp.expected_alpha_20d >= 0 ? '+' : ''}{opp.expected_alpha_20d.toFixed(1)}%
                  </span>
                  <span style={{ fontSize: 10, color: '#475569' }}>/{opp.confidence}%</span>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: tierColor[opp.tier] || '#64748b',
                }}>
                  {opp.tier_label}
                </span>
                {(opp.tier === 'FULL_COMMITTEE' || opp.tier === 'LIGHT_REVIEW') && (
                  <button
                    onClick={() => onRunCommittee(opp.ticker)}
                    style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 4,
                      background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
                      color: '#818cf8', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
                    }}
                  >
                    Review →
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Status footer */}
          <div style={{ fontSize: 11, color: '#475569', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 6 }}>
            {hurdleMet
              ? `Best expected alpha +${bestAlpha.toFixed(1)}% vs SPY — above 3% hurdle`
              : `Best expected alpha +${bestAlpha.toFixed(1)}% vs SPY — all below 3% hurdle`}
          </div>
        </>
      )}
    </div>
  )
}

function Zone3Tab({ riskJson, decisionJson, onApprove, onReject, isPending, loading }: {
  riskJson: string; decisionJson: string
  onApprove: () => void; onReject: () => void
  isPending: boolean; loading: boolean
}) {
  const risk = (() => { try { return JSON.parse(riskJson || '{}') } catch { return {} } })()
  const dec  = (() => { try { return JSON.parse(decisionJson || '{}') } catch { return {} } })()

  const sb       = risk.sizing_breakdown || {}
  const regime   = risk.regime || '—'
  const regLimits = risk.macro_regime_limits || {}
  const expAlpha = dec.expected_alpha_pct ?? dec.expected_alpha ?? 0
  const pred20d  = dec.predicted_return_20d ?? null
  const predSpy  = dec.predicted_spy_return_20d ?? null
  const posSize  = risk.position_size_pct || dec.position_size_pct || 0
  const posUsd   = risk.position_size_usd || 0
  const corrNote = sb.correlation_note || ''
  const thesTick = (risk.thesis_tickers || []) as string[]

  const Stat = ({ label, value, color = '#f1f5f9', sub = '' }: { label: string; value: string; color?: string; sub?: string }) => (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 7, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{sub}</div>}
    </div>
  )

  const MultBar = ({ label, value, neutral = 1.0 }: { label: string; value: number; neutral?: number }) => {
    const color = value >= neutral ? '#22c55e' : value >= neutral * 0.7 ? '#eab308' : '#ef4444'
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#64748b', width: 130, flexShrink: 0 }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600, color }}>×{value.toFixed(2)}</span>
        <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
          <div style={{ width: `${Math.min(value / 1.5 * 100, 100)}%`, height: '100%', background: color, borderRadius: 2 }} />
        </div>
      </div>
    )
  }

  return (
    <div className="content" style={{ overflowY: 'auto' }}>

      {/* Key numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <Stat label="Position Size"   value={`${posSize.toFixed(1)}%`} sub={posUsd ? `$${posUsd.toLocaleString('en-US', {maximumFractionDigits: 0})}` : ''} color={posSize > 0 ? '#f1f5f9' : '#ef4444'} />
        <Stat label="Expected Alpha"  value={`${Number(expAlpha) >= 0 ? '+' : ''}${Number(expAlpha).toFixed(1)}%`} color={Number(expAlpha) >= 3 ? '#22c55e' : '#ef4444'} sub="vs SPY / 20d" />
        {pred20d !== null && <Stat label="Return Forecast" value={`${Number(pred20d) >= 0 ? '+' : ''}${Number(pred20d).toFixed(1)}%`} color="#94a3b8" sub="total / 20d" />}
        {predSpy !== null && <Stat label="SPY Forecast"    value={`${Number(predSpy) >= 0 ? '+' : ''}${Number(predSpy).toFixed(1)}%`} color="#64748b" sub="same period" />}
      </div>

      {/* Sizing breakdown */}
      {Object.keys(sb).length > 0 && (
        <div className="card">
          <div className="card-title">Dynamic Sizing Breakdown</div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#64748b' }}>Regime: </span>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{regime}</span>
            {regLimits.max_deployed_pct && (
              <span style={{ fontSize: 11, color: '#64748b', marginLeft: 8 }}>
                (max deployment {regLimits.max_deployed_pct}% | deployed {risk.deployed_pct?.toFixed(0)}%)
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              Kelly base: <span style={{ color: '#94a3b8', fontFamily: 'var(--mono)', fontWeight: 600 }}>{sb.kelly_base_pct?.toFixed(1)}%</span>
            </div>
            <MultBar label="Conviction"           value={sb.conviction_mult  || 1} />
            <MultBar label="Bear penalty"         value={sb.bear_mult        || 1} />
            <MultBar label={`Regime (${regime})`} value={sb.regime_mult      || 1} />
            <MultBar label="Evidence quality"     value={sb.evidence_mult    || 1} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>Final size:</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: posSize > 0 ? '#22c55e' : '#ef4444', fontFamily: 'var(--mono)' }}>
              {posSize.toFixed(1)}%
            </span>
          </div>
        </div>
      )}

      {/* Correlation check */}
      <div className="card">
        <div className="card-title">Correlation & Thesis Exposure</div>
        {corrNote ? (
          <div style={{ background: 'rgba(239,68,68,0.08)', borderRadius: 6, padding: '8px 12px', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: '#ef4444' }}>⚠ {corrNote}</span>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: '#22c55e' }}>✓ No correlated positions — thesis exposure clear</span>
        )}
        {thesTick.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#64748b' }}>
            Same thesis positions: {thesTick.join(', ')}
          </div>
        )}
        <div style={{ marginTop: 6, fontSize: 11, color: '#475569' }}>
          Thesis exposure cap: 25% of portfolio in same alpha source
        </div>
      </div>

      {/* Falsification */}
      {dec.falsification_condition && (
        <div className="card" style={{ borderLeft: '3px solid rgba(239,68,68,0.5)' }}>
          <div className="card-title" style={{ color: '#ef4444' }}>⚠ Thesis Exit Trigger</div>
          <p style={{ fontSize: 13, color: '#fca5a5', lineHeight: 1.5 }}>{dec.falsification_condition}</p>
          <p style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
            The agent monitors this condition every 30 min. If met → THESIS_INVALIDATED alert.
          </p>
        </div>
      )}

      {/* Approve / Pass */}
      {isPending && !loading && (
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button className="btn danger" style={{ flex: 1 }} onClick={onReject}>
            Pass — Log to Counterfactual
          </button>
          <button className="btn primary" style={{ flex: 1 }} onClick={onApprove}>
            Approve & Open Position
          </button>
        </div>
      )}
      {loading && <div style={{ fontSize: 13, color: '#64748b', textAlign: 'center' }}>Processing…</div>}
    </div>
  )
}

function LearningZone({ calibration, onApply, onReject }: {
  calibration: CalibrationRecord[]
  onApply: (id: number) => void
  onReject: (id: number) => void
}) {
  const pending = calibration.filter(c => c.status === 'PENDING')
  const all     = calibration.slice(0, 5)

  return (
    <div style={{
      flex: '0 0 44%', borderRight: '1px solid rgba(255,255,255,0.06)',
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
        Zone 4 · Learning — Calibration by Alpha Source
        {pending.length > 0 && (
          <span style={{ marginLeft: 8, background: 'rgba(234,179,8,0.15)', color: '#eab308', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>
            {pending.length} pending
          </span>
        )}
      </div>

      {all.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 11, color: '#334155' }}>No calibration data yet — needs 3+ resolved predictions</span>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {all.map(c => {
            const isOver  = c.calibration_error > 2
            const isUnder = c.calibration_error < -2
            const color   = isOver ? '#ef4444' : isUnder ? '#eab308' : '#22c55e'
            const label   = isOver ? 'overestimates' : isUnder ? 'underestimates' : 'well-calibrated'
            return (
              <div key={c.id} style={{
                background: c.status === 'PENDING' ? 'rgba(234,179,8,0.06)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${c.status === 'PENDING' ? 'rgba(234,179,8,0.2)' : 'rgba(255,255,255,0.04)'}`,
                borderRadius: 5, padding: '6px 10px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{c.alpha_source}</span>
                  <span style={{ fontSize: 11, color, fontWeight: 600 }}>
                    {c.calibration_error > 0 ? '+' : ''}{c.calibration_error.toFixed(1)}% error · {label}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {c.observations} obs · predicted {c.avg_predicted > 0 ? '+' : ''}{c.avg_predicted.toFixed(1)}% · actual {c.avg_actual > 0 ? '+' : ''}{c.avg_actual.toFixed(1)}%
                  {c.proposed_multiplier !== 1 && ` · proposed ×${c.proposed_multiplier.toFixed(2)}`}
                </div>
                {c.status === 'PENDING' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                    <button onClick={() => onApply(c.id)} style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 4,
                      background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                      color: '#22c55e', cursor: 'pointer', fontWeight: 600,
                    }}>Apply update</button>
                    <button onClick={() => onReject(c.id)} style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 4,
                      background: 'transparent', border: '1px solid rgba(100,116,139,0.3)',
                      color: '#64748b', cursor: 'pointer',
                    }}>Dismiss</button>
                  </div>
                )}
                {c.status === 'APPLIED' && <span style={{ fontSize: 10, color: '#22c55e' }}>✓ applied</span>}
                {c.status === 'REJECTED' && <span style={{ fontSize: 10, color: '#475569' }}>dismissed</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CounterfactualsZone({ summary }: { summary: CounterfactualSummary | null }) {
  if (!summary) return (
    <div style={{ flex: 1, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 11, color: '#334155' }}>No passed opportunities tracked yet</span>
    </div>
  )

  const { total_tracked, resolved, opportunity_cost_usd, bias_detected, bias_message, recent } = summary
  const resolvedItems = recent.filter(r => r.return_20d !== null)

  return (
    <div style={{
      flex: 1, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Zone 5 · Counterfactuals — Passed Opportunities
        </span>
        <span style={{ fontSize: 10, color: '#64748b' }}>{total_tracked} tracked · {resolved} resolved</span>
      </div>

      {opportunity_cost_usd !== 0 && (
        <div style={{ background: 'rgba(239,68,68,0.06)', borderRadius: 5, padding: '6px 10px', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>
            30-day opportunity cost: ${Math.abs(opportunity_cost_usd).toLocaleString()}
          </span>
          <span style={{ fontSize: 10, color: '#64748b', marginLeft: 6 }}>(alpha we left on the table)</span>
        </div>
      )}

      {bias_detected && bias_message && (
        <div style={{ background: 'rgba(234,179,8,0.06)', borderRadius: 5, padding: '6px 10px', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#eab308', fontWeight: 600 }}>Pattern detected: </span>
          <span style={{ fontSize: 11, color: '#fde68a' }}>{bias_message}</span>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {recent.slice(0, 8).map(cf => (
          <div key={cf.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '4px 6px', borderRadius: 4,
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: '#f1f5f9', width: 48 }}>{cf.ticker}</span>
              <span style={{ fontSize: 10, color: '#475569' }}>passed {new Date(cf.passed_at).toLocaleDateString()}</span>
              {cf.regime && <span style={{ fontSize: 10, color: '#334155' }}>{cf.regime}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {cf.return_20d !== null ? (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                  color: cf.return_20d >= 0 ? '#22c55e' : '#ef4444',
                }}>
                  {cf.return_20d >= 0 ? '+' : ''}{cf.return_20d.toFixed(1)}%
                </span>
              ) : (
                <span style={{ fontSize: 10, color: '#334155' }}>pending</span>
              )}
              {cf.alpha_20d !== null && (
                <span style={{
                  fontSize: 10,
                  color: cf.alpha_20d >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)',
                }}>
                  {cf.alpha_20d >= 0 ? '+' : ''}{cf.alpha_20d.toFixed(1)}% α
                </span>
              )}
            </div>
          </div>
        ))}
        {recent.length === 0 && (
          <div style={{ fontSize: 11, color: '#334155', textAlign: 'center', paddingTop: 20 }}>
            No opportunities passed yet
          </div>
        )}
      </div>
    </div>
  )
}

export default function DecisionCenter() {
  const [queue, setQueue]           = useState<Run[]>([])
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [activeTab, setActiveTab]   = useState<TabId>('thesis')
  const [streamRunId, setStreamRunId] = useState<number | null>(null)
  const [loading, setLoading]       = useState(false)
  const [ticker, setTicker]         = useState('')

  // Phase 1: Market Intelligence state
  const [narrative, setNarrative]       = useState<Narrative | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [narrativeLoading, setNarrativeLoading] = useState(false)

  // Phase 3: Calibration + Counterfactuals
  const [calibration, setCalibration]       = useState<CalibrationRecord[]>([])
  const [cfSummary, setCfSummary]           = useState<CounterfactualSummary | null>(null)
  const [learningExpanded, setLearningExpanded] = useState(true)

  const loadQueue = useCallback(() => {
    getAlphaQueue().then(r => {
      const q = r.data as Run[]
      setQueue(q)
      if (q.length > 0 && !selectedRun) setSelectedRun(q[0])
    }).catch(() => {})
  }, [selectedRun])

  const loadNarrative = useCallback(() => {
    setNarrativeLoading(true)
    getAlphaMarketNarrative().then(r => {
      const d = r.data as { narrative: Narrative | null; opportunities: Opportunity[] }
      setNarrative(d.narrative)
      setOpportunities(d.opportunities || [])
    }).catch(() => {}).finally(() => setNarrativeLoading(false))
  }, [])

  const loadLearning = useCallback(() => {
    getAlphaCalibration().then(r => setCalibration(r.data as CalibrationRecord[])).catch(() => {})
    getCounterfactualSummary().then(r => setCfSummary(r.data as CounterfactualSummary)).catch(() => {})
  }, [])

  const handleCalibrationApply = async (id: number) => {
    try {
      await applyCalibration(id)
      loadLearning()
    } catch { /* */ }
  }

  const handleCalibrationReject = async (id: number) => {
    try {
      await rejectCalibration(id)
      loadLearning()
    } catch { /* */ }
  }

  useEffect(() => {
    loadQueue()
    loadNarrative()
    loadLearning()
    const t = setInterval(loadNarrative, 120_000)
    const t2 = setInterval(loadLearning, 300_000)  // refresh learning every 5 min
    return () => { clearInterval(t); clearInterval(t2) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectRun = (runId: number) => {
    getAlphaRun(runId).then(r => setSelectedRun(r.data.run)).catch(() => {})
  }

  const handleApprove = async () => {
    if (!selectedRun) return
    setLoading(true)
    try {
      await decideAlphaRun(selectedRun.id, 'approve')
      setSelectedRun(prev => prev ? { ...prev, approval_status: 'APPROVED' } : prev)
      loadQueue()
    } catch { /* */ } finally { setLoading(false) }
  }

  const handleReject = async () => {
    if (!selectedRun) return
    setLoading(true)
    try {
      await decideAlphaRun(selectedRun.id, 'reject')
      setSelectedRun(prev => prev ? { ...prev, approval_status: 'REJECTED' } : prev)
      loadQueue()
    } catch { /* */ } finally { setLoading(false) }
  }

  const handleTrigger = async (tickerOverride?: string) => {
    const t = (tickerOverride || ticker).trim().toUpperCase()
    if (!t) return
    setLoading(true)
    try {
      const r = await triggerAlphaCommittee(t)
      setStreamRunId(r.data.run_id)
      if (!tickerOverride) setTicker('')
    } catch { /* */ } finally { setLoading(false) }
  }

  const isPending = selectedRun?.approval_status === 'PENDING'
  const dec = selectedRun ? (() => { try { return JSON.parse(selectedRun.decision_json || '{}') } catch { return {} } })() : {}
  const ac = selectedRun?.final_action || dec.action || '—'
  const conf = selectedRun?.final_confidence ?? dec.confidence ?? 0
  const color = actionColor[ac] || '#94a3b8'

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Main column */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>

        {/* Trigger bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#081225', flexShrink: 0,
        }}>
          <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleTrigger()}
            placeholder="Enter ticker (e.g. NVDA)"
            className="input"
            style={{ width: 200, fontFamily: 'var(--mono)' }}
          />
          <button className="btn primary" onClick={() => handleTrigger()} disabled={!ticker.trim() || loading}>
            Run Committee
          </button>
          {queue.length > 0 && (
            <>
              <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)', margin: '0 4px' }} />
              <span style={{ fontSize: 12, color: '#64748b' }}>Pending:</span>
              {queue.map(r => (
                <button key={r.id} className="btn sm"
                  onClick={() => handleSelectRun(r.id)}
                  style={selectedRun?.id === r.id
                    ? { background: 'rgba(124,58,237,0.2)', color: '#a78bfa', borderColor: 'rgba(124,58,237,0.3)' }
                    : {}}>
                  {r.ticker}
                </button>
              ))}
            </>
          )}
        </div>

        {/* ── Zone 1 + Zone 2 ── */}
        <div style={{
          display: 'flex', height: 190, flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: '#060f1e',
        }}>
          <MarketStoryZone narrative={narrative} loading={narrativeLoading} />
          <OpportunitiesZone
            opportunities={opportunities}
            cfSummary={cfSummary}
            onRunCommittee={(t) => handleTrigger(t)}
          />
        </div>

        {/* ── Zone 4 + Zone 5 (collapsible learning panel) ── */}
        <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#050d1a' }}>
          {/* Toggle bar */}
          <button
            onClick={() => setLearningExpanded(e => !e)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 16px', background: 'none', border: 'none', cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 10, color: '#475569', letterSpacing: '0.06em', fontWeight: 700, textTransform: 'uppercase' }}>
              {learningExpanded ? '▼' : '▶'} Learning & Counterfactuals
            </span>
            {calibration.filter(c => c.status === 'PENDING').length > 0 && (
              <span style={{ background: 'rgba(234,179,8,0.15)', color: '#eab308', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
                {calibration.filter(c => c.status === 'PENDING').length} belief updates pending
              </span>
            )}
            {cfSummary && cfSummary.total_tracked > 0 && (
              <span style={{ fontSize: 10, color: '#475569' }}>
                · {cfSummary.total_tracked} counterfactuals tracked
                {cfSummary.opportunity_cost_usd !== 0 && ` · $${Math.abs(cfSummary.opportunity_cost_usd).toLocaleString()} opportunity cost`}
              </span>
            )}
          </button>
          {learningExpanded && (
            <div style={{ display: 'flex', height: 200 }}>
              <LearningZone
                calibration={calibration}
                onApply={handleCalibrationApply}
                onReject={handleCalibrationReject}
              />
              <CounterfactualsZone summary={cfSummary} />
            </div>
          )}
        </div>

        {selectedRun ? (
          <>
            {/* Trade header */}
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: '#0C1A2E', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 800, color: '#f1f5f9' }}>
                    {selectedRun.ticker}
                  </span>
                  <span className="badge" style={{ background: `${color}22`, color, fontSize: 11 }}>{ac}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color, fontWeight: 700 }}>{conf}% confidence</span>
                  {isPending && (
                    <span className="badge" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
                      PENDING APPROVAL
                    </span>
                  )}
                  {selectedRun.approval_status === 'APPROVED' && (
                    <span className="badge sotd">APPROVED</span>
                  )}
                  {selectedRun.approval_status === 'REJECTED' && (
                    <span className="badge" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>REJECTED</span>
                  )}
                </div>
                {dec.rationale && (
                  <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.4 }}>{dec.rationale}</p>
                )}
              </div>
              {isPending && !loading && (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn danger" onClick={handleReject}>Reject</button>
                  <button className="btn primary" onClick={handleApprove}>Approve & Trade</button>
                </div>
              )}
              {loading && <span style={{ fontSize: 13, color: '#64748b' }}>Processing…</span>}
            </div>

            {/* Tabs */}
            <div style={{
              display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)',
              padding: '0 20px', flexShrink: 0, background: '#0a1628',
            }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                  padding: '10px 16px', fontSize: 13, fontWeight: activeTab === t.id ? 500 : 400,
                  color: activeTab === t.id ? '#f1f5f9' : '#64748b',
                  borderBottom: activeTab === t.id ? '2px solid #3b82f6' : '2px solid transparent',
                  background: 'none', border: 'none', cursor: 'pointer', transition: 'all 150ms',
                  marginBottom: -1,
                }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {activeTab === 'zone3'    && <Zone3Tab riskJson={selectedRun.risk_json} decisionJson={selectedRun.decision_json} onApprove={handleApprove} onReject={handleReject} isPending={isPending} loading={loading} />}
              {activeTab === 'thesis'   && <ThesisTab decisionJson={selectedRun.decision_json} researchJson={selectedRun.research_json} />}
              {activeTab === 'research' && <ResearchTab researchJson={selectedRun.research_json} />}
              {activeTab === 'debate'   && <DebateTab bullJson={selectedRun.bull_json} bearJson={selectedRun.bear_json} decisionJson={selectedRun.decision_json} />}
              {activeTab === 'similar'  && <SimilarTradesTab ticker={selectedRun.ticker} />}
              {activeTab === 'lessons'  && <LessonsAppliedTab decisionJson={selectedRun.decision_json} />}
              {activeTab === 'risk'     && <RiskPlanTab riskJson={selectedRun.risk_json} />}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1e3a5f" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
            </svg>
            <p style={{ fontSize: 14, color: '#475569' }}>No pending decisions</p>
            <p style={{ fontSize: 13, color: '#334155' }}>Enter a ticker above to manually trigger a committee run</p>
          </div>
        )}
      </div>

      {/* Right: AI Thinking (active run) or Live Activity Feed (idle) */}
      <div style={{
        width: 280, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.06)',
        background: '#081225', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {streamRunId ? (
          <ThinkingTimeline
            runId={streamRunId}
            onDone={status => {
              if (status === 'COMPLETE' || status === 'done') {
                loadQueue()
                if (streamRunId) handleSelectRun(streamRunId)
              }
              setStreamRunId(null)
            }}
          />
        ) : (
          <LiveActivityFeed
            onDecisionReady={(entry: ActivityEntry) => {
              loadQueue()
              const meta = entry.metadata_json ? JSON.parse(entry.metadata_json) : {}
              if (meta.run_id) handleSelectRun(meta.run_id)
              // Refresh narrative after each scan
              if (entry.event_type === 'macro_narrative') loadNarrative()
            }}
          />
        )}
      </div>
    </div>
  )
}
