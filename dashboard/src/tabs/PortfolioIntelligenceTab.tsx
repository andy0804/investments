import { useState, useEffect } from 'react'
import { getPortfolioIntelligence } from '../api'
import { PageInfoModal, InfoButton, usePageInfo } from '../components/PageInfoModal'

const S: Record<string, React.CSSProperties> = {
  panel:     { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' },
  sectionHd: { fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.12em', fontFamily: 'var(--mono)', marginBottom: 8 },
  divider:   { borderTop: '1px solid var(--border)', margin: '12px 0' },
  bullet:    { display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #0f1623', fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.5 },
  dot:       { color: 'var(--cyan)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)' },
  wdot:      { color: 'var(--yellow)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)' },
  rdot:      { color: 'var(--red)', fontWeight: 700, flexShrink: 0, fontFamily: 'var(--mono)' },
}

function SectorExposureBar({ name, pct, limit, overLimit }: { name: string; pct: number; limit: number; overLimit: boolean }) {
  const color = overLimit ? 'var(--red)' : pct > limit * 0.8 ? 'var(--yellow)' : 'var(--cyan)'
  return (
    <div className="sector-bar-row">
      <span className="sector-bar-name">{name}</span>
      <div className="sector-bar-track" style={{ position: 'relative' }}>
        <div className="sector-bar-fill" style={{ width: `${Math.min(pct / 40 * 100, 100)}%`, background: color }} />
        {/* Limit marker at 35% */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: `${limit / 40 * 100}%`,
          width: 1, background: 'var(--border-hi)'
        }} />
      </div>
      <span className="sector-bar-val" style={{ color }}>
        {pct.toFixed(1)}%{overLimit ? ' !' : ''}
      </span>
    </div>
  )
}

function EfficiencyBar({ score }: { score: number }) {
  const color = score >= 7 ? 'var(--green)' : score >= 4 ? 'var(--yellow)' : 'var(--red)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ width: `${score / 10 * 100}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: '0.7rem', fontFamily: 'var(--mono)', color, width: 20, textAlign: 'right' }}>{score}</span>
    </div>
  )
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<string, string> = {
    trim: 'bear', hold: 'neutral', review: 'chop', watch: 'bull'
  }
  return <span className={`hbadge ${map[action] ?? 'neutral'}`}>{action.toUpperCase()}</span>
}

export default function PortfolioIntelligenceTab() {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [refresh, setRefresh] = useState(false)

  const load = () => {
    setLoading(true); setError('')
    getPortfolioIntelligence()
      .then(r => { setData(r.data); setLoading(false) })
      .catch(() => { setError('Failed to load portfolio intelligence.'); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const handleRefresh = () => { setRefresh(true); load(); setTimeout(() => setRefresh(false), 3000) }
  const info = usePageInfo()

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 12 }}>
      <div style={{ color: 'var(--cyan)', fontSize: '0.8rem', fontFamily: 'var(--mono)' }}>Analyzing portfolio…</div>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Fetching positions, computing efficiency, running Haiku analysis</div>
    </div>
  )

  if (error) return <div style={{ padding: 24, color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
  if (!data) return null

  // No positions loaded yet
  if (data.error || !data.holdings?.length) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 16, textAlign: 'center' }}>
      <div style={{ fontSize: '1.5rem', color: 'var(--border-hi)' }}>⬜</div>
      <div style={{ color: 'var(--text-bright)', fontSize: '0.9rem', fontWeight: 600 }}>No Portfolio Positions Loaded</div>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', maxWidth: 380, lineHeight: 1.6 }}>
        To see portfolio intelligence, add your holdings to the CSV file or connect SnapTrade.
        Go to <strong style={{ color: 'var(--cyan)' }}>Config → Portfolio CSV</strong> to load your positions.
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-dim)', background: 'var(--panel)', border: '1px solid var(--border)', padding: '6px 12px', borderRadius: 4 }}>
        Backend: {data.error ?? 'No holdings found'}
      </div>
    </div>
  )

  const intel    = data.intelligence ?? {}
  const holdings = data.holdings ?? []
  const sectors  = data.sector_exposure ?? []
  const risks    = data.concentration_risks ?? []
  const perf     = data.performance_attribution ?? {}
  const regime   = (data.regime ?? 'CHOP').toLowerCase()

  return (
    <div>
      {info.show && (
        <PageInfoModal
          title="Portfolio Intelligence"
          subtitle="AI-powered analysis of your Fidelity holdings"
          benefit="Get an objective, AI-generated view of your portfolio's risk, sector concentration, and regime alignment — without logging into your broker."
          sections={[
            { title: 'What this page shows', body: 'Your current Fidelity holdings (loaded via portfolio CSV) are analyzed by Claude Haiku. It evaluates sector concentration, identifies concentration risks (any position >8% of portfolio), scores each position against the current market regime, and calculates performance attribution.' },
            { title: 'Regime alignment', body: 'Each holding is checked against the current regime (BULL/CHOP/BEAR). A tech-heavy portfolio in a BEAR regime has elevated risk. The agent flags mismatches and suggests whether to hold, reduce, or hedge.' },
            { title: 'How to keep it current', body: 'Click "↻ Refresh" to re-run the analysis. Portfolio data updates automatically from the CSV every 30 minutes. For live Fidelity sync you would connect via SnapTrade in the Settings page.' },
          ]}
          onClose={info.close}
        />
      )}
      {/* Top action row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
          {data.generated_at ? `Generated ${data.generated_at.slice(0, 16).replace('T', ' ')} UTC` : ''}
        </span>
        <InfoButton onClick={info.open} />
        <button className="btn sm" onClick={handleRefresh} disabled={refresh}>
          {refresh ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* 2-col grid */}
      <div className="intel-grid">

        {/* ── LEFT ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* AI Summary */}
          <div style={S.panel}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <span className={`hbadge ${regime}`}>{(data.regime ?? 'CHOP')} REGIME</span>
              <span className="hbadge neutral">
                ${(data.portfolio_value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.65, padding: '10px 12px', background: '#0d1117', borderRadius: 4, borderLeft: '2px solid var(--cyan)', marginBottom: 14 }}>
              {intel.summary ?? 'No analysis available.'}
            </div>

            {/* Risk flags */}
            {(intel.risk_flags ?? []).length > 0 && (
              <>
                <div style={S.sectionHd}>Risk Flags</div>
                <div style={{ marginBottom: 14 }}>
                  {intel.risk_flags.map((f: string, i: number) => (
                    <div key={i} style={{ ...S.bullet, borderBottom: i < intel.risk_flags.length - 1 ? '1px solid #0f1623' : 'none' }}>
                      <span style={S.rdot}>!</span>
                      <span>{f}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Action suggestions */}
            {(intel.action_suggestions ?? []).length > 0 && (
              <>
                <div style={S.divider} />
                <div style={S.sectionHd}>Action Suggestions</div>
                <div>
                  {intel.action_suggestions.map((s: any, i: number) => (
                    <div key={i} style={{ ...S.bullet, borderBottom: i < intel.action_suggestions.length - 1 ? '1px solid #0f1623' : 'none', alignItems: 'flex-start', gap: 12 }}>
                      <ActionBadge action={s.action} />
                      <div>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)', marginRight: 8 }}>{s.ticker}</span>
                        <span style={{ fontSize: '0.76rem' }}>{s.reason}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Holdings efficiency table */}
          <div style={S.panel}>
            <div style={S.sectionHd}>Holdings — Efficiency Analysis</div>
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Gain</th>
                  <th>Volatility</th>
                  <th>Regime</th>
                  <th style={{ width: 120 }}>Efficiency (0–10)</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h: any) => {
                  const gain = h.gain_pct ?? 0
                  const gColor = gain >= 0 ? 'var(--green)' : 'var(--red)'
                  return (
                    <tr key={h.ticker}>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{h.ticker}</td>
                      <td style={{ fontFamily: 'var(--mono)', color: gColor }}>
                        {gain >= 0 ? '+' : ''}{gain.toFixed(2)}%
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                        {h.volatility_30d != null ? `${(h.volatility_30d * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td>
                        <span className={`hbadge ${h.regime_alignment ? (data.regime ?? 'chop').toLowerCase() : 'neutral'}`} style={{ fontSize: '0.6rem', padding: '1px 5px' }}>
                          {h.regime_alignment ? 'ALIGNED' : 'NEUTRAL'}
                        </span>
                      </td>
                      <td><EfficiencyBar score={h.efficiency_score ?? 0} /></td>
                      <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--cyan)', fontSize: '0.82rem' }}>
                        {h.efficiency_score ?? 0}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── RIGHT SIDEBAR ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Sector exposure */}
          <div style={S.panel}>
            <div style={S.sectionHd}>Sector Exposure</div>
            {sectors.length === 0 && (
              <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', padding: '8px 0' }}>No position data.</p>
            )}
            {sectors.map((s: any) => (
              <SectorExposureBar
                key={s.sector}
                name={s.sector}
                pct={s.pct}
                limit={35}
                overLimit={s.over_limit ?? false}
              />
            ))}
            <div style={{ marginTop: 8, fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
              Limit line at 35% max concentration
            </div>
          </div>

          {/* Concentration risks */}
          {risks.length > 0 && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Concentration Risks</div>
              {risks.map((r: any, i: number) => (
                <div key={i} style={{ ...S.bullet, borderBottom: i < risks.length - 1 ? '1px solid #0f1623' : 'none' }}>
                  <span style={S.wdot}>▲</span>
                  <span style={{ fontSize: '0.76rem' }}>{r}</span>
                </div>
              ))}
            </div>
          )}

          {/* Performance attribution */}
          {(perf.top_contributors?.length > 0 || perf.top_detractors?.length > 0) && (
            <div style={S.panel}>
              <div style={S.sectionHd}>Performance Attribution</div>

              {perf.top_contributors?.length > 0 && (
                <>
                  <div style={{ fontSize: '0.65rem', color: 'var(--green)', fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: '0.08em' }}>TOP CONTRIBUTORS</div>
                  {perf.top_contributors.map((c: any) => (
                    <div key={c.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #0f1623', fontSize: '0.75rem' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{c.ticker}</span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>+{c.gain_pct?.toFixed(2)}%</span>
                    </div>
                  ))}
                </>
              )}

              {perf.top_detractors?.length > 0 && (
                <>
                  <div style={{ fontSize: '0.65rem', color: 'var(--red)', fontFamily: 'var(--mono)', margin: '8px 0 4px', letterSpacing: '0.08em' }}>TOP DETRACTORS</div>
                  {perf.top_detractors.map((c: any) => (
                    <div key={c.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #0f1623', fontSize: '0.75rem' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{c.ticker}</span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--red)' }}>{c.gain_pct?.toFixed(2)}%</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
