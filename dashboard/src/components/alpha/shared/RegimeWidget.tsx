import { useEffect, useState } from 'react'
import { getAlphaEvents } from '../../../api'

interface Props { compact?: boolean }

export default function RegimeWidget({ compact = false }: Props) {
  const [regime, setRegime] = useState<string>('UNKNOWN')
  const [vix, setVix] = useState<number | null>(null)

  useEffect(() => {
    getAlphaEvents(5).then(r => {
      const events = r.data as Array<{ event_type: string; data_json: string }>
      const vixEv = events.find(e => e.event_type === 'regime')
      if (vixEv) {
        try {
          const d = JSON.parse(vixEv.data_json)
          if (d.vix) setVix(d.vix)
          if (d.regime) setRegime(d.regime)
        } catch { /* */ }
      }
    }).catch(() => {})
  }, [])

  const color = regime === 'BULLISH' ? '#10b981' : regime === 'BEARISH' ? '#ef4444' : '#f59e0b'

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="text-xs font-bold" style={{ color }}>{regime}</span>
        {vix && <span className="text-xs" style={{ color: '#64748b' }}>VIX {vix.toFixed(1)}</span>}
      </div>
    )
  }

  return (
    <div className="p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b' }}>
      <div className="text-xs mb-1" style={{ color: '#64748b' }}>Market Regime</div>
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-bold" style={{ color }}>{regime}</span>
      </div>
      {vix && (
        <div className="mt-1 text-xs" style={{ color: '#94a3b8' }}>VIX {vix.toFixed(1)}</div>
      )}
    </div>
  )
}
