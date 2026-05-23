import { useState, useEffect } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { getPositions, getRisk, reloadCSV, getStockOfDay } from '../api'

const SECTOR_COLORS = ['#7eb8ff','#4ade80','#fb923c','#a78bfa','#f87171','#34d399','#fbbf24','#60a5fa']

const SIGNAL_COLOR: Record<string, string> = {
  buy:         '#4ade80',
  strong_buy:  '#22c55e',
  sell:        '#f87171',
  strong_sell: '#ef4444',
  watch:       '#fbbf24',
  hold:        '#888',
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div style={{ display: 'flex', gap: 3, margin: '6px 0' }}>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} style={{
          width: 18, height: 8, borderRadius: 2,
          background: i < score
            ? (score >= 7 ? '#4ade80' : score <= 3 ? '#f87171' : '#fbbf24')
            : '#2a2a3a',
        }} />
      ))}
      <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: 4 }}>{score}/10</span>
    </div>
  )
}

function StockPickCard() {
  const [pick, setPick] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = async () => {
    setLoading(true)
    const r = await getStockOfDay().catch(() => null)
    if (r?.data?.pick && !r.data.pick.error) setPick(r.data.pick)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  if (loading) return (
    <div className="card" id="stock-pick-card" style={{ borderLeft: '3px solid #7eb8ff' }}>
      <h2>Today's Pick</h2>
      <p className="neutral" style={{ fontSize: '0.85rem' }}>Analysing screener candidates...</p>
    </div>
  )

  if (!pick) return (
    <div className="card" id="stock-pick-card" style={{ borderLeft: '3px solid #7eb8ff' }}>
      <h2>Today's Pick</h2>
      <p className="neutral" style={{ fontSize: '0.85rem' }}>
        No screener candidates available outside your portfolio right now.
      </p>
      <button className="btn" style={{ marginTop: 8 }} onClick={load}>Retry</button>
    </div>
  )

  const signal = pick.signal || 'watch'
  const score = pick.score ?? 5
  const color = SIGNAL_COLOR[signal] || '#888'

  return (
    <div className="card" id="stock-pick-card" style={{ borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span style={{ fontSize: '0.7rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Today's Pick — momentum screener
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{pick.symbol}</span>
            <span style={{
              background: color + '22', color, border: `1px solid ${color}44`,
              padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
            }}>
              {signal.replace('_', ' ').toUpperCase()}
            </span>
          </div>
        </div>
        <button className="btn" style={{ fontSize: '0.75rem', padding: '4px 10px' }}
          onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>

      <ScoreBar score={score} />

      <p style={{ fontSize: '0.85rem', color: '#ccc', margin: '6px 0 0' }}>
        {(pick.reasoning || '').slice(0, 160)}{(pick.reasoning || '').length > 160 ? '…' : ''}
      </p>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {pick.risks?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: '0.75rem', color: '#888', textTransform: 'uppercase' }}>Risks</span>
              <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
                {pick.risks.map((r: string, i: number) => (
                  <li key={i} style={{ fontSize: '0.8rem', color: '#f87171', marginTop: 2 }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {pick.suggested_action && (
            <p style={{ fontSize: '0.85rem', color: '#7eb8ff', margin: 0 }}>
              Action: {pick.suggested_action}
            </p>
          )}
          <p style={{ fontSize: '0.75rem', color: '#555', marginTop: 8 }}>
            {pick.pick_reason} · refreshes daily
          </p>
        </div>
      )}
    </div>
  )
}

export default function PortfolioTab() {
  const [positions, setPositions] = useState<any[]>([])
  const [risk, setRisk] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([getPositions(), getRisk()]).then(([p, r]) => {
      setPositions(p.data.positions)
      setRisk(r.data.summary || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleReload = async () => {
    setReloading(true)
    await reloadCSV().catch(() => {})
    setReloading(false)
    load()
  }

  const sectorMap: Record<string, number> = {}
  positions.forEach(p => {
    const sector = p.sector || 'Other'
    sectorMap[sector] = (sectorMap[sector] || 0) + (p.current_value || 0)
  })
  const sectorData = Object.entries(sectorMap).map(([name, value]) => ({ name, value }))

  if (loading) return <p className="loading">Loading portfolio...</p>

  const totalValue = positions.reduce((s, p) => s + (p.current_value || 0), 0)
  const totalGL    = positions.reduce((s, p) => s + (p.total_gain_loss_dollar || 0), 0)

  return (
    <div>
      <StockPickCard />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <span style={{ fontSize: '1.4rem', fontWeight: 700, color: '#4ade80' }}>
            ${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
          <span style={{ marginLeft: 12, color: totalGL >= 0 ? '#4ade80' : '#f87171', fontSize: '0.9rem' }}>
            {totalGL >= 0 ? '+' : ''}${totalGL.toLocaleString('en-US', { maximumFractionDigits: 0 })} all-time
          </span>
        </div>
        <button className="btn" onClick={handleReload} disabled={reloading}>
          {reloading ? 'Reloading...' : 'Reload CSV'}
        </button>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Holdings</h2>
          <table>
            <thead>
              <tr><th>Symbol</th><th>Value</th><th>Gain/Loss</th><th>Status</th></tr>
            </thead>
            <tbody>
              {positions.filter(p => p.position_type !== 'Cash_MM').map(p => {
                const gl = p.total_gain_loss_percent
                const status = risk.find((r: any) => r.symbol === p.symbol)?.status || 'normal'
                const statusColor: Record<string, string> = {
                  stop_loss:   '#f87171',
                  soft_review: '#fb923c',
                  target_2:    '#a78bfa',
                  target_1:    '#4ade80',
                  normal:      '#666',
                }
                return (
                  <tr key={`${p.account_number}-${p.symbol}`}>
                    <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                    <td>${(p.current_value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                    <td className={gl >= 0 ? 'positive' : 'negative'}>
                      {gl != null ? `${gl >= 0 ? '+' : ''}${gl.toFixed(1)}%` : '—'}
                    </td>
                    <td>
                      <span style={{ color: statusColor[status], fontSize: '0.7rem', textTransform: 'uppercase' }}>
                        {status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Sector Concentration</h2>
          {sectorData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={sectorData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%" outerRadius={80}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false} fontSize={10}
                >
                  {sectorData.map((_, i) => <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />)}
                </Pie>
                <Tooltip
                  formatter={(v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="neutral" style={{ padding: '20px 0' }}>No sector data yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
