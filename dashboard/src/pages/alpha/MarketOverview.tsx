import { useEffect, useState } from 'react'
import { getAlphaEvents, scanAlphaEvents } from '../../api'

interface Event {
  id: number; ticker: string; event_type: string; significance_score: number
  triggered_committee: number; detected_at: string; data_json: string
}

const typeColor: Record<string, string> = {
  price_move: '#60a5fa', volume_spike: '#a78bfa', news: '#f59e0b',
  earnings_surprise: '#22c55e', sector_move: '#38bdf8', regime: '#ef4444', rss_mention: '#fbbf24',
}

export default function MarketOverview() {
  const [events, setEvents]     = useState<Event[]>([])
  const [scanning, setScanning] = useState(false)

  const load = () => { getAlphaEvents(100).then(r => setEvents(r.data as Event[])).catch(() => {}) }
  useEffect(() => { load() }, [])

  const handleScan = async () => {
    setScanning(true)
    try { await scanAlphaEvents(); load() } catch { /* */ } finally { setScanning(false) }
  }

  const high   = events.filter(e => e.significance_score >= 70)
  const medium = events.filter(e => e.significance_score >= 40 && e.significance_score < 70)
  const low    = events.filter(e => e.significance_score < 40)

  const EventTable = ({ rows, title }: { rows: Event[]; title: string }) => (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="card-title" style={{ margin: 0 }}>{title}</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{rows.length} events</span>
      </div>
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: '#475569' }}>None</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ticker</th><th>Type</th><th>Score</th><th>Committee</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 15).map(ev => {
              const color = typeColor[ev.event_type] || '#94a3b8'
              return (
                <tr key={ev.id}>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9' }}>{ev.ticker}</td>
                  <td><span className="badge" style={{ background: `${color}22`, color }}>{ev.event_type.replace(/_/g, ' ')}</span></td>
                  <td style={{ fontFamily: 'var(--mono)', color }}>{ev.significance_score}</td>
                  <td>{ev.triggered_committee === 1 ? <span className="badge sotd">Yes</span> : <span style={{ color: '#475569' }}>—</span>}</td>
                  <td style={{ color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(ev.detected_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Market Overview</h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>{events.length} events tracked</span>
        <button className="btn sm primary" onClick={handleScan} disabled={scanning} style={{ marginLeft: 'auto' }}>
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>

      {events.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>No events detected yet</p>
          <p style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>Click "Scan Now" or wait for the scheduler to run</p>
        </div>
      ) : (
        <>
          <EventTable rows={high}   title="Tier 1 — High Significance (70+)" />
          <EventTable rows={medium} title="Tier 2 — Medium Significance (40–69)" />
          <EventTable rows={low}    title="Tier 3 — Low Significance (<40)" />
        </>
      )}
    </div>
  )
}
