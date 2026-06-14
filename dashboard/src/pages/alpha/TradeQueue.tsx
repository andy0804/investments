import { useEffect, useState } from 'react'
import { getAlphaQueue, decideAlphaRun } from '../../api'

interface Run {
  id: number; ticker: string; final_action: string
  final_confidence: number; completed_at: string; approval_status: string
}

const actionColor: Record<string, string> = {
  BUY: '#22c55e', LONG: '#22c55e', SELL: '#ef4444', SHORT: '#ef4444',
  HOLD: '#f59e0b', REDUCE: '#f59e0b', WATCHLIST: '#60a5fa', PASS: '#64748b',
}

export default function TradeQueue() {
  const [queue, setQueue]     = useState<Run[]>([])
  const [loading, setLoading] = useState<number | null>(null)

  const load = () => {
    getAlphaQueue().then(r => setQueue(r.data as Run[])).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const decide = async (runId: number, action: 'approve' | 'reject') => {
    setLoading(runId)
    try { await decideAlphaRun(runId, action); load() }
    catch { /* */ } finally { setLoading(null) }
  }

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Trade Queue</h2>
        {queue.length > 0 && (
          <span className="badge" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
            {queue.length} pending
          </span>
        )}
      </div>

      {queue.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>No decisions awaiting approval</p>
          <p style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>
            The committee fires automatically when events score above the significance threshold
          </p>
        </div>
      ) : (
        queue.map(run => {
          const color = actionColor[run.final_action] || '#94a3b8'
          const isProcessing = loading === run.id
          return (
            <div key={run.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>
                    {run.ticker}
                  </span>
                  <span className="badge" style={{ background: `${color}22`, color }}>
                    {run.final_action}
                  </span>
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    Confidence: <strong style={{ color: '#cbd5e1' }}>{run.final_confidence}%</strong>
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#475569' }}>
                  {new Date(run.completed_at).toLocaleString()}
                </div>
              </div>
              {!isProcessing ? (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn sm danger" onClick={() => decide(run.id, 'reject')}>Reject</button>
                  <button className="btn sm primary" onClick={() => decide(run.id, 'approve')}>Approve & Trade</button>
                </div>
              ) : (
                <span style={{ fontSize: 13, color: '#64748b' }}>Processing…</span>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
