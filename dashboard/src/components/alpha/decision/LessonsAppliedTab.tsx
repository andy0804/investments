interface Props { decisionJson: string }

export default function LessonsAppliedTab({ decisionJson }: Props) {
  const dec = (() => { try { return JSON.parse(decisionJson || '{}') } catch { return {} } })()
  const lessons: Array<{ text: string; category: string; impact: string }> = dec.lessons_applied || []

  if (lessons.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: '#475569' }}>
        <p className="text-xs">No lessons were applied to this decision.</p>
        <p className="text-xs">Lessons accumulate as trades close and you approve them.</p>
      </div>
    )
  }

  const catColor: Record<string, string> = {
    entry: '#60a5fa', exit: '#f59e0b', sizing: '#a78bfa',
    thesis: '#10b981', timing: '#38bdf8',
  }

  return (
    <div className="p-5 space-y-3 overflow-y-auto">
      <p className="text-xs" style={{ color: '#64748b' }}>
        {lessons.length} lesson{lessons.length !== 1 ? 's' : ''} influenced this decision
      </p>
      {lessons.map((l, i) => {
        const color = catColor[l.category] || '#94a3b8'
        return (
          <div key={i} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}22` }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs px-2 py-0.5 rounded font-bold" style={{ background: `${color}22`, color }}>{l.category}</span>
            </div>
            <p className="text-sm text-white">{l.text}</p>
            {l.impact && <p className="text-xs mt-1.5" style={{ color: '#64748b' }}>{l.impact}</p>}
          </div>
        )
      })}
    </div>
  )
}
