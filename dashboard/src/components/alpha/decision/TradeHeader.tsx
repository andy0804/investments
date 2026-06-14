import ConfidenceGauge from '../shared/ConfidenceGauge'

interface Run {
  id: number
  ticker: string
  final_action: string
  final_confidence: number
  decision_json: string
  approval_status: string
}

interface Props {
  run: Run
  onApprove: () => void
  onReject: () => void
  loading: boolean
}

export default function TradeHeader({ run, onApprove, onReject, loading }: Props) {
  const dec = (() => { try { return JSON.parse(run.decision_json || '{}') } catch { return {} } })()
  const action = run.final_action || dec.action || 'PASS'
  const conf = run.final_confidence ?? dec.confidence ?? 0

  const actionColor = {
    BUY: '#10b981', LONG: '#10b981',
    SELL: '#ef4444', SHORT: '#ef4444',
    HOLD: '#f59e0b', REDUCE: '#f59e0b',
    WATCHLIST: '#60a5fa', PASS: '#64748b',
  }[action] ?? '#94a3b8'

  const isPending = run.approval_status === 'PENDING'

  return (
    <div className="flex items-center gap-6 px-6 py-4 border-b" style={{ borderColor: '#1e293b', background: '#0a1628' }}>
      <ConfidenceGauge value={conf} size={72} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-white">{run.ticker}</span>
          <span className="text-sm font-bold px-2.5 py-0.5 rounded" style={{ background: `${actionColor}22`, color: actionColor }}>
            {action}
          </span>
          {isPending && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded animate-pulse" style={{ background: 'rgba(139,92,246,0.2)', color: '#a78bfa' }}>
              PENDING APPROVAL
            </span>
          )}
        </div>
        {dec.rationale && (
          <p className="text-xs mt-1 truncate" style={{ color: '#64748b' }}>{dec.rationale}</p>
        )}
      </div>

      {isPending && !loading && (
        <div className="flex gap-2 shrink-0">
          <button
            onClick={onReject}
            className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: '#10b981', color: '#fff' }}
          >
            Approve & Trade
          </button>
        </div>
      )}
      {loading && <span className="text-xs text-slate-400 animate-pulse">Processing…</span>}
      {run.approval_status === 'APPROVED' && (
        <span className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)' }}>
          Approved
        </span>
      )}
      {run.approval_status === 'REJECTED' && (
        <span className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
          Rejected
        </span>
      )}
    </div>
  )
}
