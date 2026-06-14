interface Props { bullJson: string; bearJson: string; decisionJson: string }

export default function DebateTab({ bullJson, bearJson, decisionJson }: Props) {
  const bull = (() => { try { return JSON.parse(bullJson || '{}') } catch { return {} } })()
  const bear = (() => { try { return JSON.parse(bearJson || '{}') } catch { return {} } })()
  const dec  = (() => { try { return JSON.parse(decisionJson || '{}') } catch { return {} } })()

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 0 }}>
        {/* Bull */}
        <div className="card" style={{ borderTop: '3px solid #22c55e' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Bull Case
            </span>
            {bull.confidence && (
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontWeight: 700, color: '#22c55e' }}>
                {bull.confidence}%
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, marginBottom: bull.evidence ? 12 : 0 }}>
            {bull.thesis || bull.summary || JSON.stringify(bull)}
          </p>
          {Array.isArray(bull.evidence) && bull.evidence.length > 0 && (
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bull.evidence.map((e: string, i: number) => (
                <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: '#94a3b8' }}>
                  <span style={{ color: '#22c55e', flexShrink: 0 }}>+</span>{e}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Bear */}
        <div className="card" style={{ borderTop: '3px solid #ef4444' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Bear Case
            </span>
          </div>
          <p style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, marginBottom: bear.risks ? 12 : 0 }}>
            {bear.thesis || bear.summary || JSON.stringify(bear)}
          </p>
          {Array.isArray(bear.risks) && bear.risks.length > 0 && (
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bear.risks.map((e: string, i: number) => (
                <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: '#94a3b8' }}>
                  <span style={{ color: '#ef4444', flexShrink: 0 }}>−</span>{e}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {dec.debate_resolution && (
        <div className="card" style={{ borderLeft: '3px solid #3b82f6', marginTop: 0 }}>
          <div className="card-title">Why This Side Won</div>
          <p style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>{dec.debate_resolution}</p>
        </div>
      )}
    </div>
  )
}
