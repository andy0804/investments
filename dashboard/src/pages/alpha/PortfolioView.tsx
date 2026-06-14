import { useEffect, useState } from 'react'
import { getAlphaPortfolio, getAlphaHistory, closeAlphaPosition } from '../../api'

interface Position {
  id: number; ticker: string; direction: string; size_pct: number
  entry_price: number; current_price: number; stop_price: number
  target_price: number; status: string; open_date: string
  close_date: string; close_price: number; realized_pnl: number
  unrealized_pnl: number; conviction: number
}
interface Portfolio { cash: number; total_value: number; updated_at: string }

const pnlColor = (v: number) => v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#64748b'

export default function PortfolioView() {
  const [port, setPort]         = useState<Portfolio | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [history, setHistory]   = useState<Position[]>([])
  const [tab, setTab]           = useState<'open' | 'history'>('open')
  const [closing, setClosing]   = useState<number | null>(null)

  const load = () => {
    getAlphaPortfolio().then(r => {
      const d = r.data as { portfolio: Portfolio; positions: Position[] }
      setPort(d.portfolio); setPositions(d.positions)
    }).catch(() => {})
    getAlphaHistory().then(r => setHistory(r.data as Position[])).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const handleClose = async (id: number) => {
    setClosing(id)
    try { await closeAlphaPosition(id); load() } catch { /* */ } finally { setClosing(null) }
  }

  const openPositions = positions
  const closedPositions = history.filter(p => p.status === 'CLOSED')
  const startingCapital = 10000
  const pnlDollar = port ? port.total_value - startingCapital : 0
  const pnlPct = (pnlDollar / startingCapital * 100)

  return (
    <div className="content" style={{ overflowY: 'auto' }}>

      {/* Summary cards */}
      {port && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Total Value',  value: `$${port.total_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, color: '#f1f5f9' },
            { label: 'Cash',         value: `$${port.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, color: '#f1f5f9' },
            { label: 'Invested',     value: `$${(port.total_value - port.cash).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, color: '#f1f5f9' },
            { label: 'Total P&L',    value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, color: pnlColor(pnlPct) },
          ].map(({ label, value, color }) => (
            <div key={label} className="card" style={{ margin: 0, padding: '12px 16px' }}>
              <div style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', marginBottom: 6, fontFamily: 'var(--mono)' }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16 }}>
        {(['open', 'history'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="btn sm"
            style={tab === t ? { background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.25)' } : {}}
          >
            {t === 'open' ? `Open (${openPositions.length})` : `History (${closedPositions.length})`}
          </button>
        ))}
      </div>

      {/* Open positions */}
      {tab === 'open' && (
        openPositions.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: '#64748b', fontSize: 14 }}>No open positions</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Ticker</th><th>Direction</th><th>Size</th><th>Entry</th>
                  <th>Current</th><th>Unrealized P&L</th><th>Stop</th><th>Target</th>
                  <th>Conviction</th><th>Opened</th><th></th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map(p => {
                  const unrealPct = p.entry_price ? ((p.current_price - p.entry_price) / p.entry_price * 100) : 0
                  return (
                    <tr key={p.id}>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9' }}>{p.ticker}</td>
                      <td><span className="badge">{p.direction}</span></td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p.size_pct}%</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>${p.entry_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p.current_price ? `$${p.current_price.toFixed(2)}` : '—'}</td>
                      <td className={unrealPct >= 0 ? 'positive' : 'negative'}>
                        {unrealPct >= 0 ? '+' : ''}{unrealPct.toFixed(1)}%
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', color: '#ef4444' }}>${p.stop_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', color: '#22c55e' }}>${p.target_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p.conviction}%</td>
                      <td style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{p.open_date}</td>
                      <td>
                        <button className="btn sm danger" onClick={() => handleClose(p.id)} disabled={closing === p.id}>
                          {closing === p.id ? '…' : 'Close'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* History */}
      {tab === 'history' && (
        closedPositions.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: '#64748b', fontSize: 14 }}>No closed trades yet</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Ticker</th><th>Direction</th><th>Entry</th><th>Exit</th>
                  <th>P&L %</th><th>P&L $</th><th>Opened</th><th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {closedPositions.map(p => {
                  const ep = p.entry_price || 0
                  const cp = p.close_price || ep
                  const pPct = ep ? ((cp - ep) / ep * 100) : 0
                  return (
                    <tr key={p.id}>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9' }}>{p.ticker}</td>
                      <td><span className="badge">{p.direction}</span></td>
                      <td style={{ fontFamily: 'var(--mono)' }}>${ep.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>${cp.toFixed(2)}</td>
                      <td className={pPct >= 0 ? 'positive' : 'negative'}>
                        {pPct >= 0 ? '+' : ''}{pPct.toFixed(1)}%
                      </td>
                      <td className={p.realized_pnl >= 0 ? 'positive' : 'negative'}>
                        {p.realized_pnl >= 0 ? '+' : ''}${p.realized_pnl?.toFixed(2)}
                      </td>
                      <td style={{ color: '#64748b' }}>{p.open_date}</td>
                      <td style={{ color: '#64748b' }}>{p.close_date}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
