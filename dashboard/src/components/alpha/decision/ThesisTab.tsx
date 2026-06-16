interface Props { decisionJson: string; researchJson: string }

const ALPHA_SOURCES = ["Sector Momentum", "Event Catalyst", "Mean Reversion", "Earnings Re-rate", "Macro Theme"]

function GateRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
          color: ok ? '#22c55e' : '#ef4444',
        }}>
          {ok ? '✓' : '✗'} {label}
        </span>
      </div>
      <p style={{
        fontSize: 13, color: value ? '#cbd5e1' : '#475569',
        lineHeight: 1.5, margin: 0, fontStyle: value ? 'normal' : 'italic',
        paddingLeft: 16, borderLeft: `2px solid ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
      }}>
        {value || '— Not provided'}
      </p>
    </div>
  )
}

export default function ThesisTab({ decisionJson, researchJson }: Props) {
  const dec = (() => { try { return JSON.parse(decisionJson || '{}') } catch { return {} } })()
  const res = (() => { try { return JSON.parse(researchJson || '{}') } catch { return {} } })()

  const isBlocked   = dec.gate_blocked === true
  const gateReason  = dec.gate_reason  || ''
  const alphaSource = dec.alpha_source  || ''
  const spyArg      = dec.spy_outperformance_argument || ''
  const histEv      = dec.historical_evidence || ''
  const falsif      = dec.falsification_condition || dec.invalidation || ''
  const expAlpha    = dec.expected_alpha_pct   ?? dec.expected_alpha ?? null
  const pred20d     = dec.predicted_return_20d ?? null
  const predSpy     = dec.predicted_spy_return_20d ?? null

  const hasGateData = alphaSource || spyArg || histEv || falsif
  const alphaSourceValid = ALPHA_SOURCES.includes(alphaSource)

  return (
    <div className="content" style={{ overflowY: 'auto' }}>

      {/* Gate block banner */}
      {isBlocked && (
        <div style={{
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8, padding: '12px 16px', marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 4 }}>
            ⛔ FOUR-QUESTION GATE BLOCKED THIS TRADE
          </div>
          <p style={{ fontSize: 12, color: '#fca5a5', margin: 0, lineHeight: 1.5 }}>{gateReason}</p>
        </div>
      )}

      {/* Decision summary */}
      {dec.decision_summary && (
        <div className="card" style={{ borderLeft: `3px solid ${dec.action === 'BUY' ? '#22c55e' : '#64748b'}` }}>
          <div className="card-title">Decision Summary</div>
          <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.7 }}>{dec.decision_summary}</p>
        </div>
      )}

      {/* Expected alpha vs SPY */}
      {(expAlpha !== null || pred20d !== null) && (
        <div className="card">
          <div className="card-title">Return Forecast vs SPY</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            {pred20d !== null && (
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Expected Return</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#22c55e', fontFamily: 'var(--mono)' }}>
                  {pred20d >= 0 ? '+' : ''}{Number(pred20d).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: '#475569' }}>over 20 days</div>
              </div>
            )}
            {predSpy !== null && (
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>SPY Expected</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#94a3b8', fontFamily: 'var(--mono)' }}>
                  {Number(predSpy) >= 0 ? '+' : ''}{Number(predSpy).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: '#475569' }}>same period</div>
              </div>
            )}
            {expAlpha !== null && (
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Expected Alpha</div>
                <div style={{
                  fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)',
                  color: Number(expAlpha) >= 3 ? '#22c55e' : '#ef4444',
                }}>
                  {Number(expAlpha) >= 0 ? '+' : ''}{Number(expAlpha).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: Number(expAlpha) >= 3 ? '#22c55e' : '#ef4444' }}>
                  {Number(expAlpha) >= 3 ? '✓ above 3% hurdle' : '✗ below 3% hurdle'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Four-question gate */}
      {hasGateData && (
        <div className="card">
          <div className="card-title">Four-Question Gate</div>
          <div style={{ fontSize: 11, color: '#475569', marginBottom: 12 }}>
            Every trade must answer all four questions with specifics. Missing or generic answers block the trade.
          </div>

          <GateRow
            label="1. Alpha Source"
            value={alphaSource}
            ok={alphaSourceValid}
          />
          <GateRow
            label="2. Why This Beats SPY"
            value={spyArg}
            ok={spyArg.length >= 50}
          />
          <GateRow
            label="3. Historical Evidence"
            value={histEv}
            ok={histEv.length >= 20}
          />
          <GateRow
            label="4. Falsification Condition (thesis exit trigger)"
            value={falsif}
            ok={falsif.length >= 30}
          />
        </div>
      )}

      {/* Why bull/bear won */}
      {(dec.why_bull_won || dec.why_bear_won) && (
        <div className="card">
          <div className="card-title">{dec.action === 'BUY' ? 'Why Bull Prevailed' : 'Why Bear Prevailed'}</div>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
            {dec.why_bull_won || dec.why_bear_won}
          </p>
        </div>
      )}

      {/* Research catalyst */}
      {res.catalyst && (
        <div className="card">
          <div className="card-title">Catalyst</div>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>{res.catalyst}</p>
        </div>
      )}

      {/* Key stats */}
      {res.key_stats && (
        <div className="card">
          <div className="card-title">Key Statistics</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {Object.entries(res.key_stats).map(([k, v]) => (
              <div key={k} style={{
                background: 'rgba(255,255,255,0.03)', borderRadius: 8,
                padding: '10px 14px', border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--mono)' }}>{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!dec.decision_summary && !hasGateData && !res.catalyst && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <p style={{ color: '#64748b', fontSize: 14 }}>No thesis data available for this run yet.</p>
        </div>
      )}
    </div>
  )
}
