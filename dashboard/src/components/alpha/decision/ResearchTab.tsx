interface Props { researchJson: string }

export default function ResearchTab({ researchJson }: Props) {
  const res = (() => { try { return JSON.parse(researchJson || '{}') } catch { return {} } })()

  const sections = [
    { label: 'News Headlines', key: 'news', isArray: true },
    { label: 'Analyst Ratings', key: 'analyst_ratings', isArray: true },
    { label: 'Earnings', key: 'earnings', isArray: false },
    { label: 'Institutional Ownership', key: 'institutional', isArray: false },
    { label: 'Insider Activity', key: 'insider', isArray: false },
    { label: 'SEC Filings', key: 'filings', isArray: true },
  ]

  const hasContent = sections.some(s => res[s.key])

  if (!hasContent) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: '#475569' }}>
        <p className="text-xs">Research data not yet available for this run.</p>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-5 overflow-y-auto">
      {sections.map(({ label, key, isArray }) => {
        const val = res[key]
        if (!val) return null
        return (
          <div key={key}>
            <div className="text-xs font-bold mb-2" style={{ color: '#64748b' }}>{label}</div>
            {isArray && Array.isArray(val) ? (
              <ul className="space-y-1.5">
                {(val as string[]).slice(0, 5).map((item, i) => (
                  <li key={i} className="text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', color: '#cbd5e1' }}>
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', color: '#cbd5e1' }}>
                {typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
