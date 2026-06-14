import { useEffect, useRef, useState } from 'react'
import { BASE_URL } from '../../api'

interface TimelineEvent {
  id?: number; stage: string; status?: string; message?: string
  confidence?: number; data_json?: string; event_time?: string
}

interface Props { runId: number | null; onDone?: (status: string) => void }

const STAGE_LABELS: Record<string, string> = {
  event: 'Event Detected', research: 'Research Agent', bull: 'Bull Agent',
  bear: 'Bear Agent', risk: 'Risk Agent', decision: 'Portfolio Manager',
  done: 'Complete', error: 'Error', timeout: 'Timed Out',
}
const STAGE_COLORS: Record<string, string> = {
  event: '#60a5fa', research: '#a78bfa', bull: '#22c55e',
  bear: '#ef4444', risk: '#f59e0b', decision: '#38bdf8',
  done: '#22c55e', error: '#ef4444',
}

export default function ThinkingTimeline({ runId, onDone }: Props) {
  const [events, setEvents]     = useState<TimelineEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!runId) return
    setEvents([])
    setStreaming(true)
    const es = new EventSource(`${BASE_URL}/alpha-agent/committee/stream/${runId}`)
    es.onmessage = e => {
      try {
        const ev: TimelineEvent = JSON.parse(e.data)
        setEvents(prev => [...prev, ev])
        if (ev.stage === 'done' || ev.stage === 'timeout' || ev.stage === 'error') {
          setStreaming(false); es.close(); onDone?.(ev.status || ev.stage)
        }
      } catch { /* */ }
    }
    es.onerror = () => { setStreaming(false); es.close() }
    return () => { es.close(); setStreaming(false) }
  }, [runId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [events])

  if (!runId && events.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '0 20px', textAlign: 'center', gap: 10 }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1e3a5f" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
        </svg>
        <p style={{ fontSize: 12, color: '#334155', lineHeight: 1.5 }}>
          AI Thinking will appear here when a committee run is active
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b' }}>
          AI Thinking
        </span>
        {streaming && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#22c55e' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'pulse 1.5s infinite' }} />
            LIVE
          </span>
        )}
      </div>

      {/* Events */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {events.map((ev, i) => {
          const color = STAGE_COLORS[ev.stage] || '#64748b'
          const label = STAGE_LABELS[ev.stage] || ev.stage
          const data = ev.data_json ? (() => { try { return JSON.parse(ev.data_json) } catch { return {} } })() : {}
          return (
            <div key={i} style={{
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${color}22`,
              borderRadius: 8, padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: ev.message ? 6 : 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>
                  {label}
                </span>
                {ev.event_time && (
                  <span style={{ fontSize: 10, color: '#475569' }}>
                    {new Date(ev.event_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              {ev.message && (
                <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>{ev.message}</p>
              )}
              {ev.confidence != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
                    <div style={{ width: `${ev.confidence}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 0.4s ease' }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{ev.confidence}%</span>
                </div>
              )}
              {data.size && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 6 }}>
                  {data.size   && <div style={{ fontSize: 10, color: '#64748b' }}>Size <span style={{ color: '#cbd5e1', fontFamily: 'var(--mono)', fontWeight: 600 }}>{data.size}%</span></div>}
                  {data.stop   && <div style={{ fontSize: 10, color: '#64748b' }}>Stop <span style={{ color: '#ef4444', fontFamily: 'var(--mono)', fontWeight: 600 }}>{data.stop}%</span></div>}
                  {data.target && <div style={{ fontSize: 10, color: '#64748b' }}>Target <span style={{ color: '#22c55e', fontFamily: 'var(--mono)', fontWeight: 600 }}>+{data.target}%</span></div>}
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
