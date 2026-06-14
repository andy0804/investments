import { useEffect, useState } from 'react'
import { getAlphaQueue, getAlphaRun, decideAlphaRun, triggerAlphaCommittee } from '../../api'
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

type TabId = 'thesis' | 'research' | 'debate' | 'similar' | 'lessons' | 'risk'

const TABS: { id: TabId; label: string }[] = [
  { id: 'thesis',   label: 'Thesis'          },
  { id: 'research', label: 'Research'         },
  { id: 'debate',   label: 'Bull vs Bear'     },
  { id: 'similar',  label: 'Similar Trades'  },
  { id: 'lessons',  label: 'Lessons Applied' },
  { id: 'risk',     label: 'Risk Plan'        },
]

const actionColor: Record<string, string> = {
  BUY: '#22c55e', LONG: '#22c55e', SELL: '#ef4444', SHORT: '#ef4444',
  HOLD: '#f59e0b', REDUCE: '#f59e0b', WATCHLIST: '#60a5fa', PASS: '#64748b',
}

export default function DecisionCenter() {
  const [queue, setQueue]           = useState<Run[]>([])
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [activeTab, setActiveTab]   = useState<TabId>('thesis')
  const [streamRunId, setStreamRunId] = useState<number | null>(null)
  const [loading, setLoading]       = useState(false)
  const [ticker, setTicker]         = useState('')

  const loadQueue = () => {
    getAlphaQueue().then(r => {
      const q = r.data as Run[]
      setQueue(q)
      if (q.length > 0 && !selectedRun) setSelectedRun(q[0])
    }).catch(() => {})
  }

  useEffect(() => { loadQueue() }, [])

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

  const handleTrigger = async () => {
    if (!ticker.trim()) return
    setLoading(true)
    try {
      const r = await triggerAlphaCommittee(ticker.trim().toUpperCase())
      setStreamRunId(r.data.run_id)
      setTicker('')
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
          <button className="btn primary" onClick={handleTrigger} disabled={!ticker.trim() || loading}>
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
              // Auto-reload queue when a new committee decision arrives
              loadQueue()
              const meta = entry.metadata_json ? JSON.parse(entry.metadata_json) : {}
              if (meta.run_id) handleSelectRun(meta.run_id)
            }}
          />
        )}
      </div>
    </div>
  )
}
