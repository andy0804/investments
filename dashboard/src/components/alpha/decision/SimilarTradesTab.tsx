import { useEffect, useState } from 'react'
import { getAlphaMemory } from '../../../api'

interface TradeMemory {
  id: number
  ticker: string
  direction: string
  pnl_pct: number
  holding_days: number
  what_went_right: string
  what_went_wrong: string
  counterfactual_lesson: string
  entry_date: string
}

export default function SimilarTradesTab({ ticker }: { ticker: string }) {
  const [memory, setMemory] = useState<TradeMemory[]>([])

  useEffect(() => {
    getAlphaMemory(30).then(r => {
      const data = (r.data as TradeMemory[]).filter(m => m.ticker !== ticker)
      setMemory(data.slice(0, 5))
    }).catch(() => {})
  }, [ticker])

  if (memory.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: '#475569' }}>
        <p className="text-xs">No similar historical trades yet.</p>
        <p className="text-xs">Trade memory builds as positions close.</p>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-3 overflow-y-auto">
      <p className="text-xs mb-3" style={{ color: '#64748b' }}>Recent closed trades for pattern reference</p>
      {memory.map(m => {
        const win = m.pnl_pct > 0
        return (
          <div key={m.id} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b' }}>
            <div className="flex items-center gap-3 mb-2">
              <span className="font-bold text-white text-sm">{m.ticker}</span>
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: win ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: win ? '#10b981' : '#ef4444' }}>
                {win ? '+' : ''}{m.pnl_pct?.toFixed(1)}%
              </span>
              <span className="text-xs" style={{ color: '#475569' }}>{m.holding_days}d hold</span>
              <span className="ml-auto text-xs" style={{ color: '#475569' }}>{m.entry_date}</span>
            </div>
            {m.what_went_right && (
              <p className="text-xs" style={{ color: '#94a3b8' }}>
                <span className="text-emerald-400 font-semibold">✓ </span>{m.what_went_right}
              </p>
            )}
            {m.what_went_wrong && (
              <p className="text-xs mt-1" style={{ color: '#94a3b8' }}>
                <span className="text-red-400 font-semibold">✗ </span>{m.what_went_wrong}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
