import { useEffect, useState } from 'react'
import { getAlphaPortfolio, getAlphaHistory, closeAlphaPosition, getAlphaPredictions, getAlphaPerformance } from '../../api'

interface Position {
  id: number; ticker: string; direction: string; size_pct: number
  entry_price: number; current_price: number; stop_price: number
  target_price: number; status: string; open_date: string
  close_date: string; close_price: number; realized_pnl: number
  unrealized_pnl: number; conviction: number
}
interface Portfolio { cash: number; total_value: number; updated_at: string }

interface Prediction {
  position_id: number; alpha_source: string; falsification_condition: string
  predicted_alpha_20d: number; regime_at_entry: string; theme_at_entry: string
  actual_alpha_20d: number | null; resolved_at: string | null
}

interface PerformanceData {
  portfolio: {
    total_value: number; initial_capital: number; total_return_pct: number
    spy_since_inception: number | null; alpha_vs_spy: number | null
    open_positions: number; closed_trades: number
  }
  trade_stats: {
    win_rate: number; avg_win_pct: number; avg_loss_pct: number
    avg_alpha_per_trade: number | null
  }
  by_alpha_source: Record<string, { trades: number; win_rate: number; avg_pnl: number; avg_alpha: number | null }>
  by_regime: Record<string, { trades: number; win_rate: number; avg_pnl: number }>
  recent_trades: Array<{
    ticker: string; pnl_pct: number; spy_ret_pct: number | null
    alpha_pct: number | null; alpha_source: string; regime: string
    open_date: string; close_date: string; size_pct: number
  }>
}

const pnlColor = (v: number) => v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#64748b'

export default function PortfolioView() {
  const [port, setPort]         = useState<Portfolio | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [history, setHistory]   = useState<Position[]>([])
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [perf, setPerf]               = useState<PerformanceData | null>(null)
  const [tab, setTab]                 = useState<'open' | 'history' | 'performance'>('open')
  const [closing, setClosing]         = useState<number | null>(null)
  const [expanded, setExpanded]       = useState<number | null>(null)

  const load = () => {
    getAlphaPortfolio().then(r => {
      const d = r.data as { portfolio: Portfolio; positions: Position[] }
      setPort(d.portfolio); setPositions(d.positions)
    }).catch(() => {})
    getAlphaHistory().then(r => setHistory(r.data as Position[])).catch(() => {})
    getAlphaPredictions().then(r => setPredictions(r.data as Prediction[])).catch(() => {})
    getAlphaPerformance().then(r => setPerf(r.data as PerformanceData)).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const predByPosition = Object.fromEntries(predictions.map(p => [p.position_id, p]))

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
        {([
          ['open', `Open (${openPositions.length})`],
          ['history', `History (${closedPositions.length})`],
          ['performance', '📊 vs SPY'],
        ] as [typeof tab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="btn sm"
            style={tab === t ? { background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.25)' } : {}}
          >
            {label}
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
                  const pred = predByPosition[p.id]
                  const isExpanded = expanded === p.id
                  return (
                    <>
                      <tr key={p.id} onClick={() => setExpanded(isExpanded ? null : p.id)}
                        style={{ cursor: pred ? 'pointer' : 'default' }}>
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
                          <button className="btn sm danger" onClick={e => { e.stopPropagation(); handleClose(p.id) }} disabled={closing === p.id}>
                            {closing === p.id ? '…' : 'Close'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && pred && (
                        <tr key={`${p.id}-pred`}>
                          <td colSpan={11} style={{ padding: '10px 16px', background: 'rgba(0,0,0,0.2)' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div>
                                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 4 }}>
                                  ALPHA SOURCE · {pred.regime_at_entry} · {pred.theme_at_entry}
                                </div>
                                <div style={{ fontSize: 12, color: '#cbd5e1' }}>{pred.alpha_source || '—'}</div>
                                <div style={{ marginTop: 6, fontSize: 10, color: '#64748b', fontWeight: 700 }}>EXPECTED ALPHA VS SPY</div>
                                <div style={{ fontSize: 12, color: (pred.predicted_alpha_20d ?? 0) >= 3 ? '#22c55e' : '#ef4444', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                                  {(pred.predicted_alpha_20d ?? 0) >= 0 ? '+' : ''}{(pred.predicted_alpha_20d ?? 0).toFixed(1)}% / 20d
                                </div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, color: '#ef4444', fontWeight: 700, marginBottom: 4 }}>
                                  ⚠ THESIS EXIT TRIGGER
                                </div>
                                <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.5 }}>
                                  {pred.falsification_condition || 'No falsification condition set'}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Performance vs SPY */}
      {tab === 'performance' && (
        !perf ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: '#64748b', fontSize: 14 }}>No closed trades yet — performance data appears once trades close</p>
          </div>
        ) : (
          <>
            {/* Top-level vs SPY */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Portfolio Return',     val: `${perf.portfolio.total_return_pct >= 0 ? '+' : ''}${perf.portfolio.total_return_pct.toFixed(2)}%`, color: pnlColor(perf.portfolio.total_return_pct) },
                { label: 'SPY (same period)',    val: perf.portfolio.spy_since_inception !== null ? `${perf.portfolio.spy_since_inception >= 0 ? '+' : ''}${perf.portfolio.spy_since_inception.toFixed(2)}%` : '—', color: '#94a3b8' },
                { label: 'Alpha vs SPY',         val: perf.portfolio.alpha_vs_spy !== null ? `${perf.portfolio.alpha_vs_spy >= 0 ? '+' : ''}${perf.portfolio.alpha_vs_spy.toFixed(2)}%` : '—', color: pnlColor(perf.portfolio.alpha_vs_spy ?? 0) },
                { label: 'Win Rate',             val: `${perf.trade_stats.win_rate.toFixed(1)}%`, color: perf.trade_stats.win_rate >= 50 ? '#22c55e' : '#ef4444' },
              ].map(({ label, val, color }) => (
                <div key={label} className="card" style={{ margin: 0, padding: '12px 16px' }}>
                  <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{val}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              {/* By alpha source */}
              <div className="card" style={{ margin: 0 }}>
                <div className="card-title">By Alpha Source</div>
                {Object.keys(perf.by_alpha_source).length === 0 ? (
                  <p style={{ color: '#475569', fontSize: 13 }}>No data yet</p>
                ) : (
                  <table>
                    <thead><tr><th>Source</th><th>Trades</th><th>Win%</th><th>Avg P&L</th><th>Avg Alpha</th></tr></thead>
                    <tbody>
                      {Object.entries(perf.by_alpha_source).map(([src, s]) => (
                        <tr key={src}>
                          <td style={{ fontSize: 12, color: '#cbd5e1' }}>{src}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.trades}</td>
                          <td className={s.win_rate >= 50 ? 'positive' : 'negative'} style={{ fontSize: 12 }}>{s.win_rate.toFixed(0)}%</td>
                          <td className={s.avg_pnl >= 0 ? 'positive' : 'negative'} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.avg_pnl >= 0 ? '+' : ''}{s.avg_pnl.toFixed(1)}%</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: (s.avg_alpha ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                            {s.avg_alpha !== null ? `${s.avg_alpha >= 0 ? '+' : ''}${s.avg_alpha.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* By regime */}
              <div className="card" style={{ margin: 0 }}>
                <div className="card-title">By Market Regime</div>
                {Object.keys(perf.by_regime).length === 0 ? (
                  <p style={{ color: '#475569', fontSize: 13 }}>No data yet</p>
                ) : (
                  <table>
                    <thead><tr><th>Regime</th><th>Trades</th><th>Win%</th><th>Avg P&L</th></tr></thead>
                    <tbody>
                      {Object.entries(perf.by_regime).map(([r, s]) => (
                        <tr key={r}>
                          <td style={{ fontSize: 12, color: '#cbd5e1' }}>{r}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.trades}</td>
                          <td className={s.win_rate >= 50 ? 'positive' : 'negative'} style={{ fontSize: 12 }}>{s.win_rate.toFixed(0)}%</td>
                          <td className={s.avg_pnl >= 0 ? 'positive' : 'negative'} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.avg_pnl >= 0 ? '+' : ''}{s.avg_pnl.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Recent trades with SPY comparison */}
            <div className="card">
              <div className="card-title">Recent Trades vs SPY Benchmark</div>
              <table>
                <thead><tr><th>Ticker</th><th>Source</th><th>Regime</th><th>P&L</th><th>SPY same period</th><th>Alpha</th><th>Opened</th><th>Closed</th></tr></thead>
                <tbody>
                  {perf.recent_trades.map((t, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9' }}>{t.ticker}</td>
                      <td style={{ fontSize: 11, color: '#94a3b8' }}>{t.alpha_source || '—'}</td>
                      <td style={{ fontSize: 11, color: '#64748b' }}>{t.regime || '—'}</td>
                      <td className={t.pnl_pct >= 0 ? 'positive' : 'negative'} style={{ fontFamily: 'var(--mono)' }}>
                        {t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct.toFixed(1)}%
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', color: '#64748b', fontSize: 12 }}>
                        {t.spy_ret_pct !== null ? `${t.spy_ret_pct >= 0 ? '+' : ''}${t.spy_ret_pct.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: (t.alpha_pct ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                        {t.alpha_pct !== null ? `${t.alpha_pct >= 0 ? '+' : ''}${t.alpha_pct.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ color: '#64748b', fontSize: 11 }}>{t.open_date}</td>
                      <td style={{ color: '#64748b', fontSize: 11 }}>{t.close_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
