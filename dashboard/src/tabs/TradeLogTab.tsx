import { useState, useEffect } from 'react'
import { getTradeLog } from '../api'

export default function TradeLogTab() {
  const [trades, setTrades] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getTradeLog(100).then(r => { setTrades(r.data.trades); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <p className="loading">Loading trade log...</p>

  const wins = trades.filter(t => t.action === 'sell')
  const totalTraded = trades.reduce((s, t) => s + (t.total_value || 0), 0)

  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h2>Summary</h2>
          <p style={{ fontSize: '0.85rem', color: '#888' }}>Total trades logged: <strong style={{ color: '#ccc' }}>{trades.length}</strong></p>
          <p style={{ fontSize: '0.85rem', color: '#888', marginTop: 8 }}>Total value traded: <strong style={{ color: '#ccc' }}>${totalTraded.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong></p>
          <p style={{ fontSize: '0.75rem', color: '#555', marginTop: 12 }}>Log trades via Telegram /bought or /sold commands, or POST /portfolio/log-trade</p>
        </div>
        <div className="card">
          <h2>How to log trades</h2>
          <p style={{ fontSize: '0.8rem', color: '#888', lineHeight: 1.6 }}>
            Via Telegram: <code style={{ background: '#2a2a2a', padding: '2px 6px', borderRadius: 4 }}>/bought AAPL 10 150.00</code><br />
            Via API: <code style={{ background: '#2a2a2a', padding: '2px 6px', borderRadius: 4 }}>POST /portfolio/log-trade</code>
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Trade History</h2>
        {trades.length === 0 ? (
          <p className="neutral">No trades logged yet.</p>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Symbol</th><th>Action</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={t.id || i}>
                  <td style={{ color: '#555', fontSize: '0.75rem' }}>{t.traded_at?.slice(0, 10)}</td>
                  <td style={{ fontWeight: 600 }}>{t.symbol}</td>
                  <td><span className={`badge ${t.action}`}>{t.action}</span></td>
                  <td>{t.quantity}</td>
                  <td>${t.price?.toFixed(2)}</td>
                  <td>${(t.total_value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
