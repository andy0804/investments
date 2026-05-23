import { useState, useEffect } from 'react'
import { getEvents } from '../api'

export default function EventsTab() {
  const [events, setEvents] = useState<any[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const source = filter === 'all' ? undefined : filter
    setLoading(true)
    getEvents(80, source).then(r => { setEvents(r.data.events); setLoading(false) }).catch(() => setLoading(false))
  }, [filter])

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['all', 'gdelt', 'edgar', 'rss', 'finnhub'].map(f => (
          <button key={f} className={`btn ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="card">
        <h2>Event Feed — {events.length} items</h2>
        {loading ? <p className="loading">Loading events...</p> : events.length === 0 ? (
          <p className="neutral">No events yet. Events populate as the scheduler runs.</p>
        ) : (
          events.map((e, i) => (
            <div key={e.id || i} className="event-item">
              <div className="event-title">
                <span className={`tag ${e.source}`}>{e.source}</span>
                {e.url ? <a href={e.url} target="_blank" rel="noreferrer" style={{ color: '#ccc', textDecoration: 'none' }}>{e.title}</a> : e.title}
              </div>
              <div className="event-meta">
                {e.event_type && <span style={{ marginRight: 8 }}>{e.event_type}</span>}
                {e.tone != null && <span style={{ marginRight: 8, color: e.tone > 0 ? '#4ade80' : e.tone < 0 ? '#f87171' : '#888' }}>
                  tone: {e.tone.toFixed(1)}
                </span>}
                <span>{e.fetched_at?.slice(0, 16)?.replace('T', ' ')}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
