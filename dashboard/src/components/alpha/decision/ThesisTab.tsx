interface Props { decisionJson: string; researchJson: string }

export default function ThesisTab({ decisionJson, researchJson }: Props) {
  const dec = (() => { try { return JSON.parse(decisionJson || '{}') } catch { return {} } })()
  const res = (() => { try { return JSON.parse(researchJson || '{}') } catch { return {} } })()

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      {dec.rationale && (
        <div className="card" style={{ borderLeft: '3px solid #3b82f6' }}>
          <div className="card-title">Why We Like It</div>
          <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.7 }}>{dec.rationale}</p>
        </div>
      )}

      {res.catalyst && (
        <div className="card">
          <div className="card-title">Catalyst</div>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>{res.catalyst}</p>
        </div>
      )}

      {res.key_stats && (
        <div className="card">
          <div className="card-title">Key Statistics</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {Object.entries(res.key_stats).map(([k, v]) => (
              <div key={k} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '10px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--mono)' }}>{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {dec.expected_return && (
        <div className="card" style={{ borderLeft: '3px solid #22c55e' }}>
          <div className="card-title">Trade Plan</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Expected Return</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e', fontFamily: 'var(--mono)' }}>{dec.expected_return}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Time Horizon</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>{dec.time_horizon || '30–45 days'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Confidence</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--mono)' }}>{dec.confidence ?? '—'}%</div>
            </div>
          </div>
        </div>
      )}

      {!dec.rationale && !res.catalyst && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>No thesis data available for this run yet.</p>
        </div>
      )}
    </div>
  )
}
