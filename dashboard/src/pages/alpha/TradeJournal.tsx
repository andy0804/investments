import { useEffect, useState } from 'react'
import { getAlphaHistory, getAlphaRun } from '../../api'

interface Position {
  id: number; ticker: string; direction: string; entry_price: number
  close_price: number; open_date: string; close_date: string
  conviction: number; status: string; run_id: number
}

interface TimelineEvent {
  stage: string; message: string; confidence: number; event_time: string
}

export default function TradeJournal() {
  const [trades, setTrades] = useState<Position[]>([])
  const [selected, setSelected] = useState<Position | null>(null)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])

  useEffect(() => {
    getAlphaHistory().then(r => {
      const all = r.data as Position[]
      setTrades(all)
      if (all.length > 0) setSelected(all[0])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selected?.run_id) { setTimeline([]); return }
    getAlphaRun(selected.run_id).then(r => {
      setTimeline(r.data.timeline as TimelineEvent[])
    }).catch(() => { setTimeline([]) })
  }, [selected?.run_id])

  const pnlColor = (p: Position) => {
    if (!p.entry_price || !p.close_price) return '#64748b'
    return p.close_price > p.entry_price ? '#10b981' : '#ef4444'
  }

  const pnlPct = (p: Position) => {
    if (!p.entry_price || !p.close_price) return null
    return ((p.close_price - p.entry_price) / p.entry_price * 100).toFixed(1)
  }

  const stageColors: Record<string, string> = {
    event: '#60a5fa', research: '#a78bfa', bull: '#34d399',
    bear: '#f87171', risk: '#fbbf24', decision: '#38bdf8',
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Trade list */}
      <div className="shrink-0 overflow-y-auto border-r py-3 space-y-1 px-2" style={{ width: 180, borderColor: '#1e293b' }}>
        <div className="text-xs font-semibold px-2 mb-2" style={{ color: '#475569' }}>All Trades</div>
        {trades.length === 0 && <p className="text-xs px-2" style={{ color: '#475569' }}>No trades yet</p>}
        {trades.map(t => {
          const pct = pnlPct(t)
          return (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className="w-full text-left px-2 py-2 rounded-lg text-xs transition-colors"
              style={selected?.id === t.id
                ? { background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }
                : { color: '#64748b', hover: 'text-white' }
              }
            >
              <div className="font-bold text-white">{t.ticker}</div>
              {pct && (
                <div className="font-semibold" style={{ color: pnlColor(t) }}>
                  {parseFloat(pct) >= 0 ? '+' : ''}{pct}%
                </div>
              )}
              <div style={{ color: '#475569' }}>{t.open_date}</div>
            </button>
          )
        })}
      </div>

      {/* Detail */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-lg font-bold text-white">{selected.ticker}</h2>
              {pnlPct(selected) && (
                <span className="font-bold text-sm" style={{ color: pnlColor(selected) }}>
                  {parseFloat(pnlPct(selected)!) >= 0 ? '+' : ''}{pnlPct(selected)}%
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#1e293b', color: '#64748b' }}>
                {selected.status}
              </span>
            </div>
            <div className="text-xs grid grid-cols-4 gap-4 mt-2" style={{ color: '#64748b' }}>
              <span>Entry: ${selected.entry_price?.toFixed(2)}</span>
              {selected.close_price && <span>Exit: ${selected.close_price?.toFixed(2)}</span>}
              <span>Opened: {selected.open_date}</span>
              {selected.close_date && <span>Closed: {selected.close_date}</span>}
            </div>
          </div>

          {/* Conviction timeline */}
          <div>
            <div className="text-xs font-bold mb-3" style={{ color: '#64748b' }}>Conviction Timeline</div>
            {timeline.length === 0 ? (
              <p className="text-xs" style={{ color: '#475569' }}>No timeline events recorded</p>
            ) : (
              <div className="space-y-2">
                {timeline.map((ev, i) => {
                  const color = stageColors[ev.stage] || '#94a3b8'
                  return (
                    <div key={i} className="flex gap-3 items-start">
                      <div className="flex flex-col items-center">
                        <span className="w-2 h-2 rounded-full mt-1" style={{ background: color }} />
                        {i < timeline.length - 1 && <span className="w-px flex-1 mt-1" style={{ background: '#1e293b', minHeight: 16 }} />}
                      </div>
                      <div className="flex-1 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold capitalize" style={{ color }}>{ev.stage}</span>
                          {ev.confidence != null && (
                            <span className="text-xs" style={{ color: '#64748b' }}>{ev.confidence}%</span>
                          )}
                          {ev.event_time && (
                            <span className="ml-auto text-xs" style={{ color: '#475569' }}>
                              {new Date(ev.event_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                        {ev.message && <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>{ev.message}</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center" style={{ color: '#475569' }}>
          <p className="text-xs">Select a trade to view its journal</p>
        </div>
      )}
    </div>
  )
}
