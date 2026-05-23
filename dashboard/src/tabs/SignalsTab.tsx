import { useState, useEffect } from 'react'
import { getSignalOutcomes, computeOutcomes } from '../api'

const S: Record<string, React.CSSProperties> = {
  panel:     { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' },
  sectionHd: { fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.12em', fontFamily: 'var(--mono)', marginBottom: 8 },
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: 4, padding: '12px 14px', flex: 1 }}>
      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, fontFamily: 'var(--mono)', color: color ?? 'var(--text-bright)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, string> = { win: 'bull', loss: 'bear', neutral: 'chop' }
  return <span className={`hbadge ${map[outcome] ?? 'neutral'}`} style={{ fontSize: '0.62rem', padding: '1px 6px' }}>{outcome.toUpperCase()}</span>
}

function ReturnCell({ val }: { val: number | null }) {
  if (val == null) return <span style={{ color: 'var(--text-dim)' }}>—</span>
  const color = val >= 0 ? 'var(--green)' : 'var(--red)'
  return <span style={{ fontFamily: 'var(--mono)', color }}>{val >= 0 ? '+' : ''}{val.toFixed(2)}%</span>
}

export default function SignalsTab() {
  const [data,     setData]     = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [computing, setComputing] = useState(false)

  const load = () => {
    setLoading(true)
    getSignalOutcomes()
      .then(r => { setData(r.data); setLoading(false) })
      .catch(() => { setError('Failed to load signal outcomes.'); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const handleCompute = () => {
    setComputing(true)
    computeOutcomes().then(load).catch(() => {}).finally(() => setComputing(false))
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-dim)', fontSize: '0.8rem' }}>
      Loading track record…
    </div>
  )
  if (error) return <div style={{ padding: 24, color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>

  const stats   = data?.stats ?? {}
  const history = data?.history ?? []

  const winRate   = stats.win_rate != null ? `${(stats.win_rate * 100).toFixed(0)}%` : '—'
  const avgRet    = stats.avg_return_7d != null ? `${stats.avg_return_7d >= 0 ? '+' : ''}${stats.avg_return_7d.toFixed(2)}%` : '—'
  const avgAlpha  = stats.avg_alpha_7d  != null ? `${stats.avg_alpha_7d  >= 0 ? '+' : ''}${stats.avg_alpha_7d.toFixed(2)}%`  : '—'
  const retColor  = stats.avg_return_7d != null ? (stats.avg_return_7d >= 0 ? 'var(--green)' : 'var(--red)') : undefined
  const alphaColor = stats.avg_alpha_7d != null ? (stats.avg_alpha_7d  >= 0 ? 'var(--green)' : 'var(--red)') : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          SOTD pick performance — 7-day outcomes vs SPY alpha
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={load}>↻ Refresh</button>
          <button className="btn sm primary" onClick={handleCompute} disabled={computing}>
            {computing ? 'Computing…' : '⟳ Compute Outcomes'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatCard label="Win Rate" value={winRate}
          color={stats.win_rate != null ? (stats.win_rate >= 0.5 ? 'var(--green)' : 'var(--red)') : undefined}
          sub={`${stats.wins ?? 0}W / ${stats.losses ?? 0}L / ${stats.neutrals ?? 0}N`} />
        <StatCard label="Avg 7d Return" value={avgRet} color={retColor} sub="per SOTD pick" />
        <StatCard label="Avg Alpha vs SPY" value={avgAlpha} color={alphaColor} sub="7d excess return" />
        <StatCard label="Total Picks" value={String(stats.total ?? 0)} sub="picks with outcomes" />
      </div>

      {/* By regime */}
      {stats.by_regime && Object.keys(stats.by_regime).length > 0 && (
        <div style={S.panel}>
          <div style={S.sectionHd}>Win Rate by Market Regime</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {Object.entries(stats.by_regime).map(([regime, rs]: [string, any]) => (
              <div key={regime} style={{ textAlign: 'center' }}>
                <span className={`hbadge ${regime.toLowerCase()}`} style={{ marginBottom: 4, display: 'block' }}>{regime}</span>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: rs.win_rate >= 0.5 ? 'var(--green)' : 'var(--red)' }}>
                  {(rs.win_rate * 100).toFixed(0)}%
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{rs.count} picks</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History table */}
      <div style={S.panel}>
        <div style={S.sectionHd}>Pick History — {history.length} outcomes tracked</div>
        {history.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem', lineHeight: 1.7 }}>
            No outcomes yet. Outcomes are computed nightly for picks older than 1 day.<br />
            Click <strong style={{ color: 'var(--cyan)' }}>Compute Outcomes</strong> to run manually.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Ticker</th>
                <th>Tier</th>
                <th>Regime</th>
                <th>1d</th>
                <th>3d</th>
                <th>7d</th>
                <th>Alpha 7d</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.id ?? h.pick_date + h.ticker}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-dim)' }}>{h.pick_date}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{h.ticker}</td>
                  <td>
                    <span className={`badge ${
                      h.tier === 'Stock of the Day' ? 'sotd'
                      : h.tier === 'Watchlist Candidate' ? 'watchlist'
                      : 'best-available'
                    }`} style={{ fontSize: '0.58rem' }}>
                      {h.tier === 'Stock of the Day' ? 'SOTD'
                       : h.tier === 'Watchlist Candidate' ? 'WATCHLIST'
                       : 'BEST AVAIL'}
                    </span>
                  </td>
                  <td>
                    {h.regime && (
                      <span className={`hbadge ${h.regime.toLowerCase()}`} style={{ fontSize: '0.58rem', padding: '1px 5px' }}>{h.regime}</span>
                    )}
                  </td>
                  <td><ReturnCell val={h.return_1d} /></td>
                  <td><ReturnCell val={h.return_3d} /></td>
                  <td><ReturnCell val={h.return_7d} /></td>
                  <td>
                    {h.alpha_7d != null ? (
                      <span style={{ fontFamily: 'var(--mono)', color: h.alpha_7d >= 0 ? 'var(--cyan)' : 'var(--red)' }}>
                        {h.alpha_7d >= 0 ? '+' : ''}{h.alpha_7d.toFixed(2)}%
                      </span>
                    ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                  </td>
                  <td>{h.outcome ? <OutcomeBadge outcome={h.outcome} /> : <span style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>pending</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
