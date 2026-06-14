import { useEffect, useRef, useState } from 'react'
import { BASE_URL } from '../../api'

export interface ActivityEntry {
  id: number
  event_type: string
  message: string
  ticker: string | null
  level: string
  metadata_json: string | null
  created_at: string
}

interface Props {
  onDecisionReady?: (entry: ActivityEntry) => void
}

const LEVEL_COLOR: Record<string, string> = {
  info:    '#475569',
  success: '#22c55e',
  warning: '#f59e0b',
  alert:   '#a78bfa',
  danger:  '#ef4444',
}

const TYPE_ICON: Record<string, string> = {
  agent_toggle:       '⏻',
  universe_screen:    '🌐',
  auto_age:           '⏱',
  event_scan:         '🔍',
  promotion:          '⬆',
  event_scored:       '·',
  committee_trigger:  '⚡',
  committee_complete: '✓',
  position_opened:    '▶',
  position_closed:    '■',
  lesson_created:     '📝',
  proposal_created:   '⚠',
  heartbeat:          '',
}

function playChime() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime

    const notes = [880, 1108, 1318]  // A5, C#6, E6 — a gentle major chord
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, now + i * 0.08)
      gain.gain.linearRampToValueAtTime(0.18, now + i * 0.08 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.6)
      osc.start(now + i * 0.08)
      osc.stop(now + i * 0.08 + 0.65)
    })
  } catch { /* AudioContext not available */ }
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function showBrowserNotification(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico', silent: true })
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function LiveActivityFeed({ onDecisionReady }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [connected, setConnected] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    requestNotificationPermission()

    const es = new EventSource(`${BASE_URL}/alpha-agent/activity/stream`)
    esRef.current = es

    es.onopen = () => setConnected(true)

    es.onmessage = (e) => {
      try {
        const entry: ActivityEntry = JSON.parse(e.data)
        if (entry.event_type === 'heartbeat') return

        setEntries(prev => {
          // Deduplicate by id
          if (prev.some(p => p.id === entry.id)) return prev
          return [...prev.slice(-199), entry]  // keep last 200
        })

        // Trigger notifications for important events
        if (entry.event_type === 'committee_complete' && entry.level === 'alert') {
          playChime()
          showBrowserNotification(
            `Alpha Agent — Decision Ready`,
            entry.message,
          )
          onDecisionReady?.(entry)
        }

        if (entry.event_type === 'position_closed') {
          showBrowserNotification('Alpha Agent — Position Closed', entry.message)
        }
      } catch { /* */ }
    }

    es.onerror = () => setConnected(false)

    return () => { es.close(); setConnected(false) }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  const visible = entries.filter(e => e.event_type !== 'heartbeat')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                       letterSpacing: '0.1em', color: '#64748b' }}>
          Live Activity
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: connected ? '#22c55e' : '#475569',
            boxShadow: connected ? '0 0 5px #22c55e' : 'none',
          }} />
          <span style={{ color: connected ? '#22c55e' : '#475569' }}>
            {connected ? 'LIVE' : 'CONNECTING…'}
          </span>
        </span>
      </div>

      {/* Feed */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {visible.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center' }}>
            <p style={{ fontSize: 12, color: '#334155', lineHeight: 1.6 }}>
              Activity log is empty.
            </p>
            <p style={{ fontSize: 11, color: '#1e3a5f', marginTop: 6, lineHeight: 1.6 }}>
              Entries appear here as the agent works — universe screens, promotions,
              committee runs, position opens and closes.
            </p>
          </div>
        ) : (
          visible.map(entry => {
            const color = LEVEL_COLOR[entry.level] || '#475569'
            const icon  = TYPE_ICON[entry.event_type] || '·'
            return (
              <div
                key={entry.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '5px 16px',
                  background: entry.level === 'alert'
                    ? 'rgba(167,139,250,0.06)' : 'transparent',
                }}
              >
                {/* Icon */}
                <span style={{ fontSize: 11, color, width: 14, flexShrink: 0, textAlign: 'center', marginTop: 1 }}>
                  {icon}
                </span>
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                    {entry.ticker && (
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: '#94a3b8',
                        fontFamily: 'var(--mono)', flexShrink: 0,
                      }}>
                        {entry.ticker}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: entry.level === 'alert' ? '#e2e8f0' : '#64748b', lineHeight: 1.4 }}>
                      {entry.message}
                    </span>
                  </div>
                </div>
                {/* Time */}
                <span style={{ fontSize: 10, color: '#334155', flexShrink: 0, fontFamily: 'var(--mono)', marginTop: 2 }}>
                  {formatTime(entry.created_at)}
                </span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
