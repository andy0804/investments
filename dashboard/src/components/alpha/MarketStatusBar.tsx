import { useEffect, useState } from 'react'
import { getAlphaMarketStatus } from '../../api'

interface MarketStatus {
  status: 'OPEN' | 'PRE_MARKET' | 'CLOSED'
  is_open: boolean
  seconds_to_event: number
  now_et: string
  last_scan_at: string | null
  scan_interval_sec: number
}

function fmt(secs: number): string {
  if (secs <= 0) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function timeSince(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)  return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

const STATUS_STYLE: Record<string, { color: string; dot: string; label: string }> = {
  OPEN:       { color: '#22c55e', dot: '#22c55e', label: 'MARKET OPEN'  },
  PRE_MARKET: { color: '#f59e0b', dot: '#f59e0b', label: 'PRE-MARKET'   },
  CLOSED:     { color: '#475569', dot: '#334155', label: 'MARKET CLOSED' },
}

export default function MarketStatusBar() {
  const [status, setStatus]         = useState<MarketStatus | null>(null)
  const [countdown, setCountdown]   = useState(0)

  const load = () => {
    getAlphaMarketStatus().then(r => {
      setStatus(r.data)
      setCountdown(r.data.seconds_to_event)
    }).catch(() => {})
  }

  useEffect(() => {
    load()
    const refresh = setInterval(load, 30_000)
    return () => clearInterval(refresh)
  }, [])

  // Tick countdown every second
  useEffect(() => {
    if (countdown <= 0) return
    const tick = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(tick)
  }, [countdown])

  // Always render — show a neutral bar while loading or if API is down
  if (!status) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px',
        height: 32, flexShrink: 0, fontSize: 11,
        borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1e3a5f' }} />
        <span style={{ color: '#334155' }}>Checking market status…</span>
        <span style={{ color: '#1e3a5f', marginLeft: 'auto', fontSize: 10 }}>
          If this persists, restart the backend to initialise new DB tables
        </span>
      </div>
    )
  }

  const st = STATUS_STYLE[status.status] || STATUS_STYLE.CLOSED
  const label = status.status === 'OPEN'
    ? `Closes in ${fmt(countdown)}`
    : status.status === 'PRE_MARKET'
    ? `Opens in ${fmt(countdown)}`
    : `Opens in ${fmt(countdown)}`

  // Next scan estimate (only meaningful when market is open)
  const lastScanSecs = status.last_scan_at
    ? Math.floor((Date.now() - new Date(status.last_scan_at).getTime()) / 1000)
    : null
  const nextScanSecs = lastScanSecs !== null
    ? Math.max(0, status.scan_interval_sec - lastScanSecs)
    : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 20,
      padding: '0 20px', height: 32, flexShrink: 0,
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(0,0,0,0.2)', fontSize: 11,
    }}>
      {/* Market status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: st.dot, flexShrink: 0,
          boxShadow: status.is_open ? `0 0 6px ${st.dot}` : 'none',
          animation: status.is_open ? 'pulse 2s infinite' : 'none',
        }} />
        <span style={{ fontWeight: 700, color: st.color, letterSpacing: '0.05em' }}>{st.label}</span>
        <span style={{ color: '#475569' }}>{label}</span>
      </div>

      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.06)' }} />

      {/* Current ET time */}
      <span style={{ color: '#64748b' }}>{status.now_et}</span>

      {/* Last scan */}
      {status.last_scan_at && (
        <>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.06)' }} />
          <span style={{ color: '#475569' }}>
            Last scan <span style={{ color: '#64748b' }}>{timeSince(status.last_scan_at)}</span>
          </span>
        </>
      )}

      {/* Next scan countdown — only during market hours */}
      {status.is_open && nextScanSecs !== null && (
        <>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.06)' }} />
          <span style={{ color: '#475569' }}>
            Next scan{' '}
            <span style={{ color: nextScanSecs < 60 ? '#22c55e' : '#64748b', fontFamily: 'var(--mono)' }}>
              {fmt(nextScanSecs)}
            </span>
          </span>
        </>
      )}

      {/* Pre-market info */}
      {status.status === 'PRE_MARKET' && (
        <>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.06)' }} />
          <span style={{ color: '#475569' }}>Universe screen ran at 6:45 AM ET · Event scan starts at market open</span>
        </>
      )}
    </div>
  )
}
