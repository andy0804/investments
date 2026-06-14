import { useEffect, useState } from 'react'
import { getAlphaMemory, getAlphaStrategyLog, runAlphaWeeklyReview } from '../../api'

interface TradeMemory {
  id: number; ticker: string; direction: string; pnl_pct: number
  holding_days: number; what_went_right: string; what_went_wrong: string
  counterfactual_lesson: string; entry_date: string
}
interface StrategyLog {
  id: number; week_start: string; portfolio_return_pct: number
  spy_return_pct: number; alpha_pct: number; win_rate: number
  trades_count: number; llm_analysis: string
}

type Tab = 'memory' | 'strategy'

export default function AgentMemory() {
  const [memory, setMemory]     = useState<TradeMemory[]>([])
  const [strategy, setStrategy] = useState<StrategyLog[]>([])
  const [tab, setTab]           = useState<Tab>('memory')
  const [running, setRunning]   = useState(false)

  useEffect(() => {
    getAlphaMemory(30).then(r => setMemory(r.data as TradeMemory[])).catch(() => {})
    getAlphaStrategyLog(12).then(r => setStrategy(r.data as StrategyLog[])).catch(() => {})
  }, [])

  const handleWeeklyReview = async () => {
    setRunning(true)
    try {
      await runAlphaWeeklyReview()
      const r = await getAlphaStrategyLog(12)
      setStrategy(r.data as StrategyLog[])
    } catch { /* */ } finally { setRunning(false) }
  }

  return (
    <div className="content" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Agent Memory</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['memory', 'strategy'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} className="btn sm"
              style={tab === t ? { background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.25)' } : {}}>
              {t === 'memory' ? 'Trade Memory' : 'Strategy Log'}
            </button>
          ))}
        </div>
        {tab === 'strategy' && (
          <button className="btn sm" onClick={handleWeeklyReview} disabled={running} style={{ marginLeft: 'auto' }}>
            {running ? 'Running…' : 'Run Weekly Review'}
          </button>
        )}
      </div>

      {tab === 'memory' && (
        memory.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: '#64748b', fontSize: 14 }}>No trade memory yet</p>
            <p style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>Memory builds as positions close and counterfactuals run</p>
          </div>
        ) : memory.map(m => (
          <div key={m.id} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>{m.ticker}</span>
              <span className={m.pnl_pct > 0 ? 'positive' : 'negative'} style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
                {m.pnl_pct > 0 ? '+' : ''}{m.pnl_pct?.toFixed(1)}%
              </span>
              <span style={{ fontSize: 12, color: '#475569' }}>{m.holding_days}d · {m.entry_date}</span>
            </div>
            {m.what_went_right && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <span style={{ color: '#22c55e', fontSize: 13, flexShrink: 0 }}>✓</span>
                <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>{m.what_went_right}</p>
              </div>
            )}
            {m.what_went_wrong && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <span style={{ color: '#ef4444', fontSize: 13, flexShrink: 0 }}>✗</span>
                <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>{m.what_went_wrong}</p>
              </div>
            )}
            {m.counterfactual_lesson && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 7, background: 'rgba(124,58,237,0.08)', borderLeft: '3px solid rgba(124,58,237,0.4)' }}>
                <p style={{ fontSize: 13, color: '#a78bfa', lineHeight: 1.5 }}>Lesson: {m.counterfactual_lesson}</p>
              </div>
            )}
          </div>
        ))
      )}

      {tab === 'strategy' && (
        strategy.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
            <p style={{ color: '#64748b', fontSize: 14 }}>No weekly reviews yet</p>
            <p style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>Click "Run Weekly Review" above to generate the first entry</p>
          </div>
        ) : strategy.map(s => (
          <div key={s.id} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>Week of {s.week_start}</span>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: s.alpha_pct > 0 ? '#22c55e' : '#ef4444' }}>
                Alpha {s.alpha_pct > 0 ? '+' : ''}{s.alpha_pct?.toFixed(2)}%
              </span>
              <span style={{ fontSize: 12, color: '#64748b' }}>Win rate: {s.win_rate?.toFixed(0)}%</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>{s.trades_count} trades</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>Portfolio <span style={{ fontFamily: 'var(--mono)', color: s.portfolio_return_pct > 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{s.portfolio_return_pct?.toFixed(2)}%</span></span>
                <span style={{ color: '#64748b' }}>SPY <span style={{ fontFamily: 'var(--mono)', color: '#94a3b8', fontWeight: 600 }}>{s.spy_return_pct?.toFixed(2)}%</span></span>
              </div>
            </div>
            {s.llm_analysis && (
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>{s.llm_analysis}</p>
            )}
          </div>
        ))
      )}
    </div>
  )
}
