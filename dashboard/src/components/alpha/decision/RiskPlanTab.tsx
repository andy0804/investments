interface Props { riskJson: string }

export default function RiskPlanTab({ riskJson }: Props) {
  const risk = (() => { try { return JSON.parse(riskJson || '{}') } catch { return {} } })()

  const items = [
    { label: 'Position Size',        value: risk.size_pct != null ? `${risk.size_pct}%` : null,             color: '#60a5fa' },
    { label: 'Entry Price',          value: risk.entry_price ? `$${risk.entry_price}` : 'At market',        color: '#94a3b8' },
    { label: 'Stop Loss',            value: risk.stop_pct != null ? `−${Math.abs(risk.stop_pct)}%` : null,  color: '#ef4444' },
    { label: 'Target T1',            value: risk.target_pct != null ? `+${risk.target_pct}%` : null,        color: '#22c55e' },
    { label: 'Target T2',            value: risk.target2_pct != null ? `+${risk.target2_pct}%` : null,      color: '#22c55e' },
    { label: 'Time Stop',            value: risk.time_stop_days != null ? `${risk.time_stop_days} days` : null, color: '#f59e0b' },
    { label: 'Risk / Reward',        value: risk.rr_ratio != null ? `${risk.rr_ratio}:1` : null,            color: '#a78bfa' },
    { label: 'Max Portfolio Impact', value: risk.max_portfolio_impact != null ? `${risk.max_portfolio_impact}%` : null, color: '#64748b' },
  ].filter(i => i.value != null)

  if (items.length === 0) {
    return (
      <div className="content" style={{ overflowY: 'auto' }}>
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>Risk plan not yet available</p>
        </div>
      </div>
    )
  }

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
        {items.map(({ label, value, color }) => (
          <div key={label} className="card" style={{ margin: 0, padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{value}</div>
          </div>
        ))}
      </div>

      {risk.invalidation && (
        <div className="card" style={{ borderLeft: '3px solid #ef4444' }}>
          <div className="card-title">Invalidation Conditions</div>
          <p style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>{risk.invalidation}</p>
        </div>
      )}

      {risk.correlation_note && (
        <div className="card">
          <div className="card-title">Portfolio Correlation</div>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>{risk.correlation_note}</p>
        </div>
      )}
    </div>
  )
}
