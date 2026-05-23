import { useState, useEffect } from 'react'
import { getMacro, postMorningBriefTelegram, postDeepDive, getYTDCoach } from '../api'

export default function AnalysisTab() {
  const [macro, setMacro]               = useState<any>(null)
  const [brief, setBrief]               = useState<any>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [sentTelegram, setSentTelegram] = useState(false)
  const [diving, setDiving]             = useState(false)
  const [deepDive, setDeepDive]         = useState<any>(null)
  const [ticker, setTicker]             = useState('')
  const [coaching, setCoaching]         = useState<any>(null)
  const [coachLoading, setCoachLoading] = useState(false)

  useEffect(() => {
    getMacro().then(r => setMacro(r.data.macro)).catch(() => {})
  }, [])

  const handleGenerateBrief = async (sendToTelegram: boolean) => {
    setBriefLoading(true)
    setSentTelegram(false)
    const r = await postMorningBriefTelegram(sendToTelegram).catch(() => null)
    if (r) {
      setBrief(r.data.brief)
      if (r.data.sent_to_telegram) setSentTelegram(true)
    }
    setBriefLoading(false)
  }

  const handleDeepDive = async () => {
    if (!ticker.trim()) return
    setDiving(true)
    const r = await postDeepDive(ticker.trim().toUpperCase()).catch(() => null)
    if (r) setDeepDive(r.data.analysis)
    setDiving(false)
  }

  const handleCoach = async () => {
    setCoachLoading(true)
    const r = await getYTDCoach().catch(() => null)
    if (r) setCoaching(r.data.coaching)
    setCoachLoading(false)
  }

  return (
    <div>
      {macro && (
        <div className="card">
          <h2>Market Conditions</h2>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>VIX</span><br />
              <strong style={{ fontSize: '1.2rem' }}>{macro.vix?.toFixed(1) || '—'}</strong>
            </div>
            <div>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>Regime</span><br />
              <strong>{macro.market_regime?.replace('_', ' ') || '—'}</strong>
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>Signal</span><br />
              <span style={{ fontSize: '0.85rem', color: '#ccc' }}>{macro.vix_signal}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Send Brief ───────────────────────────────────────────────────────── */}
      <div className="card" id="send-brief-section" style={{ borderLeft: '3px solid #7eb8ff' }}>
        <h2>Morning Brief</h2>
        <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: 12 }}>
          Generate a full portfolio brief from Claude. Optionally push it straight to your Telegram bot.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <button className="btn primary" onClick={() => handleGenerateBrief(false)} disabled={briefLoading}>
            {briefLoading ? 'Generating...' : 'Generate Brief'}
          </button>
          <button
            className="btn"
            onClick={() => handleGenerateBrief(true)}
            disabled={briefLoading}
            style={{ borderColor: '#7eb8ff', color: '#7eb8ff' }}
          >
            {briefLoading ? 'Generating...' : '✈ Generate & Send to Telegram'}
          </button>
        </div>

        {sentTelegram && (
          <p style={{ color: '#4ade80', fontSize: '0.85rem', marginBottom: 10 }}>
            Brief sent to Telegram successfully.
          </p>
        )}

        {brief && !brief.error && (
          <div>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>{brief.headline}</p>
            <div className="reasoning-box">{brief.full_brief}</div>
            {brief.key_watches?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong style={{ fontSize: '0.8rem', color: '#888' }}>Watch today:</strong>
                <ul style={{ paddingLeft: 16, marginTop: 4 }}>
                  {brief.key_watches.map((w: string, i: number) => (
                    <li key={i} style={{ fontSize: '0.85rem', color: '#ccc', marginTop: 4 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Deep Dive ───────────────────────────────────────────────────────── */}
      <div className="card">
        <h2>Deep Dive</h2>
        <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: 12 }}>
          Full Sonnet analysis: technicals, fundamentals, key levels, risks, verdict.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="input" placeholder="Ticker (e.g. NVDA)"
            value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleDeepDive()}
            style={{ width: 140 }}
          />
          <button className="btn primary" onClick={handleDeepDive} disabled={diving}>
            {diving ? 'Analysing...' : 'Deep Dive'}
          </button>
        </div>
        {deepDive && !deepDive.error && (
          <div>
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              <span style={{ fontWeight: 700 }}>{ticker}</span>
              <span className={`badge ${deepDive.verdict?.replace('strong_', '')}`}>
                {deepDive.verdict}
              </span>
              <span style={{ color: '#888', fontSize: '0.85rem' }}>{deepDive.score}/10</span>
            </div>
            <div className="reasoning-box">{deepDive.reasoning}</div>
            {deepDive.key_levels && (
              <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.8rem' }}>
                {Object.entries(deepDive.key_levels).map(([k, v]: any) => (
                  <span key={k} style={{ color: '#888' }}>
                    {k.replace('_', ' ')}: <strong style={{ color: '#ccc' }}>${v}</strong>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── YTD Coaching ────────────────────────────────────────────────────── */}
      <div className="card">
        <h2>YTD Coaching</h2>
        <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: 12 }}>
          Sonnet reviews your portfolio performance and suggests improvements.
        </p>
        <button className="btn" onClick={handleCoach} disabled={coachLoading} style={{ marginBottom: 12 }}>
          {coachLoading ? 'Generating...' : 'Get Coaching Report'}
        </button>
        {coaching && !coaching.error && (
          <div>
            <div style={{ marginBottom: 8 }}>
              <strong>{coaching.week_summary}</strong>
              {coaching.portfolio_grade && (
                <span style={{ marginLeft: 12, fontSize: '1.1rem', color: '#7eb8ff' }}>
                  Grade: {coaching.portfolio_grade}
                </span>
              )}
            </div>
            <div className="reasoning-box">{coaching.coaching_message}</div>
          </div>
        )}
      </div>
    </div>
  )
}
