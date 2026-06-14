import { useEffect, useState } from 'react'
import { getAlphaLessons, decideAlphaLesson } from '../../api'

interface Lesson {
  id: number; lesson_text: string; evidence: string; category: string
  status: string; applied_count: number; created_at: string
}

type Filter = 'ALL' | 'PENDING' | 'ACTIVE' | 'DISMISSED'

const catColor: Record<string, string> = {
  entry: '#60a5fa', exit: '#f59e0b', sizing: '#a78bfa',
  thesis: '#22c55e', timing: '#38bdf8', general: '#94a3b8',
}

export default function LessonsLearned() {
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [filter, setFilter]   = useState<Filter>('ALL')
  const [acting, setActing]   = useState<number | null>(null)

  const load = () => { getAlphaLessons().then(r => setLessons(r.data as Lesson[])).catch(() => {}) }
  useEffect(() => { load() }, [])

  const decide = async (id: number, action: 'apply' | 'dismiss') => {
    setActing(id)
    try { await decideAlphaLesson(id, action); load() } catch { /* */ } finally { setActing(null) }
  }

  const visible = filter === 'ALL' ? lessons : lessons.filter(l => l.status === filter)
  const pending = lessons.filter(l => l.status === 'PENDING').length

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Lessons Learned</h2>
        {pending > 0 && (
          <span className="badge" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
            {pending} pending review
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['ALL', 'PENDING', 'ACTIVE', 'DISMISSED'] as Filter[]).map(f => (
            <button
              key={f} onClick={() => setFilter(f)}
              className="btn sm"
              style={filter === f ? { background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.25)' } : {}}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>No {filter !== 'ALL' ? filter.toLowerCase() + ' ' : ''}lessons yet</p>
          <p style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>
            Lessons generate automatically when trades close and the counterfactual runs
          </p>
        </div>
      ) : (
        visible.map(l => {
          const color = catColor[l.category] || '#94a3b8'
          const isPending = l.status === 'PENDING'
          return (
            <div key={l.id} className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span className="badge" style={{ background: `${color}22`, color }}>{l.category}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color:
                      l.status === 'ACTIVE' ? '#22c55e' :
                      l.status === 'DISMISSED' ? '#475569' : '#a78bfa',
                  }}>
                    {l.status}
                  </span>
                  {l.applied_count > 0 && (
                    <span style={{ fontSize: 11, color: '#475569' }}>· Applied {l.applied_count}×</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#475569' }}>
                    {new Date(l.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p style={{ fontSize: 14, color: '#f1f5f9', lineHeight: 1.6, marginBottom: l.evidence ? 6 : 0 }}>
                  {l.lesson_text}
                </p>
                {l.evidence && (
                  <p style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{l.evidence}</p>
                )}
              </div>
              {isPending && acting !== l.id && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, paddingTop: 2 }}>
                  <button className="btn sm danger" onClick={() => decide(l.id, 'dismiss')}>Dismiss</button>
                  <button className="btn sm primary" onClick={() => decide(l.id, 'apply')}>Apply</button>
                </div>
              )}
              {acting === l.id && <span style={{ fontSize: 13, color: '#64748b' }}>…</span>}
            </div>
          )
        })
      )}
    </div>
  )
}
