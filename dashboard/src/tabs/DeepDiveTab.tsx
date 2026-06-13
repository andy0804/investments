import { useState, useEffect } from 'react'
import { runDeepDive, getSavedDeepDives, saveDeepDive } from '../api'
import { PageInfoModal, InfoButton, usePageInfo } from '../components/PageInfoModal'
import MiniChart from '../components/MiniChart'
import FundamentalPanel from '../components/FundamentalPanel'

const S: Record<string, React.CSSProperties> = {
  panel:    { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '16px 18px' },
  sectionHd:{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', fontFamily: 'var(--mono)', marginBottom: 10 },
  label:    { fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.1em', textTransform: 'uppercase' as const },
  value:    { fontSize: '0.9rem', color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontWeight: 600 },
  bullet:   { display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #0f1623', fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.55 },
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const v = (verdict || 'hold').toLowerCase()
  const map: Record<string, string> = { buy: 'var(--green)', sell: 'var(--red)', hold: 'var(--yellow)', watch: 'var(--cyan)' }
  const color = map[v] ?? 'var(--text-dim)'
  return (
    <span style={{
      display: 'inline-block', padding: '3px 12px', borderRadius: 2,
      fontSize: '0.75rem', fontWeight: 800, fontFamily: 'var(--mono)',
      letterSpacing: '0.1em', textTransform: 'uppercase',
      background: color + '1a', color, border: `1px solid ${color}55`,
    }}>
      {verdict.toUpperCase()}
    </span>
  )
}

function MetricRow({ label, value, color }: { label: string; value: any; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #0f1623' }}>
      <span style={S.label}>{label}</span>
      <span style={{ ...S.value, color: color ?? 'var(--text-bright)', fontSize: '0.82rem' }}>{value ?? '—'}</span>
    </div>
  )
}

function SavedList({ onLoad }: { onLoad: (dive: any) => void }) {
  const [dives, setDives] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSavedDeepDives()
      .then(r => { setDives(r.data.dives ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>Loading saved analyses…</div>
  if (!dives.length) return <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', padding: '8px 0' }}>No saved analyses yet.</div>

  return (
    <table>
      <thead>
        <tr><th>Ticker</th><th>Verdict</th><th>Score</th><th>Date</th><th></th></tr>
      </thead>
      <tbody>
        {dives.map(d => (
          <tr key={d.id}>
            <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{d.symbol}</td>
            <td><VerdictBadge verdict={d.verdict ?? 'hold'} /></td>
            <td style={{ fontFamily: 'var(--mono)', color: 'var(--cyan)' }}>{d.score ?? '—'}/10</td>
            <td style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{d.created_at?.slice(0, 10)}</td>
            <td><button className="btn sm" onClick={() => onLoad(d)}>View</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function DeepDiveTab() {
  const [symbol,  setSymbol]  = useState('')
  const [result,  setResult]  = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [saved,   setSaved]   = useState(false)
  const [savedId, setSavedId] = useState<number | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const info = usePageInfo()

  const handleRun = async (sym?: string) => {
    const s = (sym ?? symbol).trim().toUpperCase()
    if (!s) return
    setLoading(true); setError(''); setResult(null); setSaved(false); setSavedId(null)
    try {
      const r = await runDeepDive(s, false)
      setResult(r.data.result)
      setSymbol(s)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!result || !symbol) return
    // Re-run with save=true to store in DB
    setLoading(true)
    try {
      const r = await runDeepDive(symbol, true)
      setSaved(true)
      setSavedId(r.data.saved_id)
      setResult(r.data.result)
    } catch {
      // If re-run fails, try saving the existing result by id
    } finally {
      setLoading(false)
    }
  }

  const handleLoadSaved = (dive: any) => {
    setResult({ verdict: dive.verdict, score: dive.score, reasoning: dive.reasoning })
    setSymbol(dive.symbol)
    setSaved(true)
    setSavedId(dive.id)
    setShowSaved(false)
  }

  const tech  = result?.technicals  ?? {}
  const fund  = result?.fundamentals ?? {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {info.show && (
        <PageInfoModal
          title="Deep Dive"
          subtitle="On-demand full analysis for any ticker"
          benefit="Get the same institutional-grade analysis the SOTD pipeline uses, but for any stock you choose — not just today's pick."
          sections={[
            { title: 'What this page does', body: 'Type any US ticker and the agent runs the full analysis pipeline: downloads 60 days of price history, computes all technical indicators (RSI, MACD, ADX, Bollinger Bands, volume ratio), fetches fundamental data from Finnhub, runs V3 scoring, then calls Claude Haiku for a 6-dimension institutional analysis with entry quality, momentum stage, risk profile, and trade recommendation.' },
            { title: 'When to use it', body: '', bullets: [
              'You heard about a stock and want a quick AI-powered verdict before acting',
              'Today\'s SOTD pick is the same stock repeated — Deep Dive the next-best candidate',
              'You want to compare a stock against the SOTD pick\'s score breakdown',
              'Pre-earnings check on a name you already own',
            ]},
            { title: 'What you get back', body: 'Entry quality (EARLY/GOOD/MODERATE/LATE), momentum stage, risk profile, allocation suggestion (% of portfolio), invalidation conditions, and a full score breakdown identical to the SOTD scoring. Results are saved and accessible from the history panel at the bottom.' },
          ]}
          onClose={info.close}
        />
      )}
      {/* Search bar */}
      <div style={S.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={S.sectionHd} >On-Demand Deep Dive Analysis</div>
          <InfoButton onClick={info.open} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Enter ticker (e.g. NVDA)"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleRun()}
            style={{
              background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.9rem',
              padding: '6px 12px', width: 160, outline: 'none',
            }}
          />
          <button className="btn sm primary" onClick={() => handleRun()} disabled={loading || !symbol.trim()}>
            {loading ? '⟳ Running…' : '▶ Analyse'}
          </button>
          <button className="btn sm" onClick={() => setShowSaved(s => !s)}>
            {showSaved ? '▲ Hide Saved' : '📂 Saved Analyses'}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--text-dim)' }}>
          Uses Claude Sonnet · technicals + fundamentals + macro + news · ~10s
        </div>
        {error && <div style={{ marginTop: 8, color: 'var(--red)', fontSize: '0.8rem', fontFamily: 'var(--mono)' }}>{error}</div>}
      </div>

      {/* Saved list */}
      {showSaved && (
        <div style={S.panel}>
          <div style={S.sectionHd}>Saved Analyses</div>
          <SavedList onLoad={handleLoadSaved} />
        </div>
      )}

      {/* Fundamental Intelligence Panel — button-triggered */}
      {symbol && result && (
        <FundamentalPanel
          symbol={symbol}
          autoLoad={false}
        />
      )}

      {/* Result */}
      {result && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 12, alignItems: 'start' }}>

          {/* Left: main verdict */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={S.panel}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text-bright)', marginBottom: 6 }}>
                    {symbol}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <VerdictBadge verdict={result.verdict ?? 'hold'} />
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--cyan)', fontSize: '0.88rem', fontWeight: 700 }}>
                      {result.score ?? '—'}/10
                    </span>
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  {!saved && (
                    <button className="btn sm primary" onClick={handleSave} disabled={loading}>
                      💾 Save Analysis
                    </button>
                  )}
                  {saved && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--green)', fontFamily: 'var(--mono)', padding: '4px 8px' }}>
                      ✓ Saved
                    </span>
                  )}
                  <button className="btn sm" onClick={() => handleRun()}>↻ Re-run</button>
                </div>
              </div>

              {/* Reasoning */}
              <div style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.7, padding: '12px 14px', background: '#0d1117', borderRadius: 4, borderLeft: '3px solid var(--cyan)', marginBottom: 14 }}>
                {result.reasoning || result.analysis || 'No reasoning provided.'}
              </div>

              {/* Key points */}
              {result.key_factors?.length > 0 && (
                <>
                  <div style={S.sectionHd}>Key Factors</div>
                  <div style={{ marginBottom: 12 }}>
                    {result.key_factors.map((f: string, i: number) => (
                      <div key={i} style={S.bullet}>
                        <span style={{ color: 'var(--cyan)', fontFamily: 'var(--mono)', flexShrink: 0 }}>+</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Risks */}
              {result.risks?.length > 0 && (
                <>
                  <div style={{ ...S.sectionHd, color: 'var(--red)' }}>Risk Factors</div>
                  <div>
                    {result.risks.map((r: string, i: number) => (
                      <div key={i} style={S.bullet}>
                        <span style={{ color: 'var(--red)', fontFamily: 'var(--mono)', flexShrink: 0 }}>!</span>
                        <span>{r}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Chart */}
            <div style={S.panel}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.14em', fontFamily: 'var(--mono)', marginBottom: 10 }}>
                30-Day Price Action — {symbol}
              </div>
              <MiniChart symbol={symbol} days={30} height={170} />
            </div>
          </div>

          {/* Right: metrics */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Technicals */}
            {Object.keys(tech).length > 0 && (
              <div style={S.panel}>
                <div style={S.sectionHd}>Technicals</div>
                <MetricRow label="RSI (14)"   value={tech.rsi?.toFixed(1)} color={tech.rsi > 65 ? 'var(--yellow)' : tech.rsi < 45 ? 'var(--cyan)' : undefined} />
                <MetricRow label="ADX"        value={tech.adx?.toFixed(1)} color={tech.adx >= 25 ? 'var(--green)' : 'var(--text-dim)'} />
                <MetricRow label="Above SMA20" value={tech.above_sma20 ? 'Yes' : 'No'} color={tech.above_sma20 ? 'var(--green)' : 'var(--red)'} />
                <MetricRow label="Vol Ratio"  value={tech.vol_ratio ? `${tech.vol_ratio}×` : '—'} color={tech.vol_ratio >= 2 ? 'var(--green)' : undefined} />
                <MetricRow label="Return 10d" value={tech.return_10d != null ? `${tech.return_10d > 0 ? '+' : ''}${tech.return_10d}%` : '—'} color={tech.return_10d > 0 ? 'var(--green)' : 'var(--red)'} />
                {tech.bb_squeeze && <MetricRow label="BB Squeeze" value="Active" color="var(--cyan)" />}
              </div>
            )}

            {/* Fundamentals */}
            {Object.keys(fund).length > 0 && (
              <div style={S.panel}>
                <div style={S.sectionHd}>Fundamentals</div>
                {fund.pe_ratio    != null && <MetricRow label="P/E Ratio"    value={fund.pe_ratio?.toFixed(1)} />}
                {fund.eps         != null && <MetricRow label="EPS"          value={`$${fund.eps}`} />}
                {fund.revenue_growth != null && <MetricRow label="Rev Growth" value={`${fund.revenue_growth}%`} color={fund.revenue_growth > 0 ? 'var(--green)' : 'var(--red)'} />}
                {fund.profit_margin != null && <MetricRow label="Profit Margin" value={`${fund.profit_margin}%`} />}
                {fund.sector      && <MetricRow label="Sector"        value={fund.sector} />}
                {fund.market_cap  != null && <MetricRow label="Market Cap"   value={fund.market_cap ? `$${(fund.market_cap / 1e9).toFixed(1)}B` : '—'} />}
              </div>
            )}

            {/* Suggested action */}
            {result.suggested_action && (
              <div style={S.panel}>
                <div style={S.sectionHd}>Suggested Action</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.6 }}>{result.suggested_action}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
