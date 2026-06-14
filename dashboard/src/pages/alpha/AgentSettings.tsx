import { useEffect, useState } from 'react'
import {
  getAlphaStatus, setAlphaOnOff, setAlphaConfig,
  getAlphaWatchlist, getAlphaWatchlistSummary, addAlphaTicker, removeAlphaTicker,
  seedAlphaWatchlist, screenAlphaUniverse, autoAgeAlphaWatchlist,
  getAlphaProposals, decideAlphaProposal,
} from '../../api'

interface WatchlistItem { id: number; ticker: string; source: string; tier: string; agent_notes: string; added_at: string; promoted_at?: string }
interface Config { [key: string]: string }
interface Proposal {
  id: number; trigger_type: string; trigger_description: string
  proposed_changes_json: string; rationale: string; status: string; created_at: string
}

const srcColor: Record<string, string> = {
  seed: '#60a5fa', sotd: '#22c55e', discovery: '#f59e0b', manual: '#a78bfa',
}
const triggerLabels: Record<string, string> = {
  consecutive_stops: 'Consecutive Stop-Losses',
  low_win_rate:      'Low Win Rate',
  rr_imbalance:      'Risk/Reward Imbalance',
  drawdown:          'Portfolio Drawdown',
}
const triggerColors: Record<string, string> = {
  consecutive_stops: '#f59e0b',
  low_win_rate:      '#ef4444',
  rr_imbalance:      '#a78bfa',
  drawdown:          '#ef4444',
}

function ConfigField({ label, cfgKey, value, onSave, hint }: {
  label: string; cfgKey: string; value: string
  onSave: (k: string, v: string) => Promise<void>; hint?: string
}) {
  const [local, setLocal] = useState(value)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setLocal(value) }, [value])
  const save = async () => {
    if (local === value) return
    setSaving(true)
    await onSave(cfgKey, local)
    setSaving(false)
  }
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.78rem', color: '#64748b', marginBottom: 4 }}>{label}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="input" value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={save}
          onKeyDown={e => e.key === 'Enter' && save()}
        />
        {saving && <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>Saving…</span>}
      </div>
      {hint && <p style={{ fontSize: 11, color: '#475569', marginTop: 3, lineHeight: 1.4 }}>{hint}</p>}
    </div>
  )
}

export default function AgentSettings() {
  const [isOn, setIsOn]           = useState(false)
  const [config, setConfig]       = useState<Config>({})
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
  const [wlSummary, setWlSummary] = useState<Record<string,number>>({})
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [newTicker, setNewTicker] = useState('')
  const [seeding, setSeeding]     = useState(false)
  const [screening, setScreening] = useState(false)
  const [aging, setAging]         = useState(false)
  const [acting, setActing]       = useState<number | null>(null)
  const [wlTab, setWlTab]         = useState<'watchlist'|'manual'|'universe'>('watchlist')

  const load = () => {
    getAlphaStatus().then(r => { setIsOn(r.data.is_on); setConfig(r.data.config || {}) }).catch(() => {})
    getAlphaWatchlist().then(r => setWatchlistItems(r.data as WatchlistItem[])).catch(() => {})
    getAlphaWatchlistSummary().then(r => setWlSummary(r.data as Record<string,number>)).catch(() => {})
    getAlphaProposals().then(r => setProposals(r.data as Proposal[])).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const handleOnOff = async () => {
    const next = !isOn; setIsOn(next)
    try { await setAlphaOnOff(next) } catch { setIsOn(!next) }
  }

  const handleConfigSave = async (key: string, value: string) => {
    await setAlphaConfig(key, value)
    load()
  }

  const handleAddTicker = async () => {
    if (!newTicker.trim()) return
    try { await addAlphaTicker(newTicker.trim()); setNewTicker(''); load() } catch { /* */ }
  }

  const handleRemove = async (ticker: string) => {
    try { await removeAlphaTicker(ticker); load() } catch { /* */ }
  }

  const handleSeed = async () => {
    setSeeding(true)
    try { await seedAlphaWatchlist(); load() } catch { /* */ } finally { setSeeding(false) }
  }

  const handleScreenUniverse = async () => {
    setScreening(true)
    try { await screenAlphaUniverse(); load() } catch { /* */ } finally { setScreening(false) }
  }

  const handleAutoAge = async () => {
    setAging(true)
    try { await autoAgeAlphaWatchlist(); load() } catch { /* */ } finally { setAging(false) }
  }

  const handleProposal = async (id: number, action: 'approve' | 'reject') => {
    setActing(id)
    try { await decideAlphaProposal(id, action); load() } catch { /* */ } finally { setActing(null) }
  }

  const c = (key: string, fallback = '') => config[key] ?? fallback
  const pendingProposals = proposals.filter(p => p.status === 'PENDING')
  const visibleItems = watchlistItems.filter(w => w.tier === wlTab)

  return (
    <div className="content" style={{ overflowY: 'auto' }}>

      {/* ── Self-Corrector Proposals (shown first if any pending) ── */}
      {pendingProposals.length > 0 && (
        <div className="card" style={{ borderTop: '3px solid #f59e0b' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span className="card-title" style={{ margin: 0 }}>Agent Self-Correction Proposals</span>
            <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
              {pendingProposals.length} pending your review
            </span>
          </div>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 1.6 }}>
            The agent detected performance issues and is proposing rule changes.
            Review each proposal — approve to update the rules, or reject to keep things as-is.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pendingProposals.map(p => {
              const color = triggerColors[p.trigger_type] || '#94a3b8'
              const changes = (() => { try { return JSON.parse(p.proposed_changes_json) } catch { return {} } })()
              return (
                <div key={p.id} style={{
                  border: `1px solid ${color}33`, borderRadius: 8, padding: '14px 16px',
                  background: `${color}08`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span className="badge" style={{ background: `${color}22`, color }}>
                          {triggerLabels[p.trigger_type] || p.trigger_type}
                        </span>
                        <span style={{ fontSize: 11, color: '#475569' }}>
                          {new Date(p.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p style={{ fontSize: 13, fontWeight: 500, color: '#f1f5f9', marginBottom: 6 }}>
                        {p.trigger_description}
                      </p>
                      <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, marginBottom: 10 }}>
                        {p.rationale}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(changes).map(([k, v]) => (
                          <span key={k} style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 4,
                            background: 'rgba(255,255,255,0.06)', color: '#cbd5e1',
                            fontFamily: 'var(--mono)',
                          }}>
                            {k}: <strong style={{ color: '#f59e0b' }}>{String(v)}</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                    {acting !== p.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                        <button className="btn sm danger" onClick={() => handleProposal(p.id, 'reject')}>
                          Reject
                        </button>
                        <button className="btn sm primary" onClick={() => handleProposal(p.id, 'approve')}>
                          Approve
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: '#64748b' }}>…</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Agent Control ── */}
      <div className="card">
        <div className="card-title">Agent Control</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9', marginBottom: 3 }}>Alpha Agent</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              {isOn
                ? 'Running — scanning watchlist every 5 min during market hours (9:30–4:00 ET)'
                : 'Stopped — no events will be detected and no new positions will open'}
            </div>
          </div>
          <button className="btn" onClick={handleOnOff}
            style={isOn
              ? { background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.25)' }
              : { background: '#22c55e', color: '#fff', borderColor: 'transparent' }
            }>
            {isOn ? 'Turn OFF' : 'Turn ON'}
          </button>
        </div>
      </div>

      {/* ── Position Sizing ── */}
      <div className="card">
        <div className="card-title">Position Sizing</div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 1.6 }}>
          Conviction-weighted: the higher the bull agent's confidence, the larger the position.
          All sizes are % of total portfolio value.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          <ConfigField label="Low conviction size (%)" cfgKey="min_position_pct"
            value={c('min_position_pct', '3')} onSave={handleConfigSave}
            hint="Bull confidence < 60%" />
          <ConfigField label="Medium conviction size (%)" cfgKey="med_position_pct"
            value={c('med_position_pct', '7')} onSave={handleConfigSave}
            hint="Bull confidence 60–75%" />
          <ConfigField label="High conviction size (%)" cfgKey="max_position_pct"
            value={c('max_position_pct', '12')} onSave={handleConfigSave}
            hint="Bull confidence > 75%" />
        </div>
      </div>

      {/* ── Portfolio Deployment ── */}
      <div className="card">
        <div className="card-title">Portfolio Deployment</div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 1.6 }}>
          Controls how much of the portfolio can be invested at any time.
          The cash floor is your permanent dry powder reserve.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <ConfigField label="Cash floor — always keep (%)" cfgKey="cash_floor_pct"
            value={c('cash_floor_pct', '25')} onSave={handleConfigSave}
            hint="Default 25% — never invested, always available" />
          <ConfigField label="Max deployed (%)" cfgKey="max_deployed_pct"
            value={c('max_deployed_pct', '75')} onSave={handleConfigSave}
            hint="Default 75% — agent stops opening positions beyond this" />
        </div>
      </div>

      {/* ── Exit Rules ── */}
      <div className="card">
        <div className="card-title">Exit Rules</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          <ConfigField label="Hard stop loss (%)" cfgKey="hard_stop_pct"
            value={c('hard_stop_pct', '8')} onSave={handleConfigSave}
            hint="Default regime overrides this (see below)" />
          <ConfigField label="Default take profit (%)" cfgKey="default_take_profit_pct"
            value={c('default_take_profit_pct', '18')} onSave={handleConfigSave}
            hint="Risk agent may adjust based on evidence" />
          <ConfigField label="Time stop (days)" cfgKey="time_stop_days"
            value={c('time_stop_days', '21')} onSave={handleConfigSave}
            hint="Exit any position open longer than this, regardless of P&L" />
        </div>
      </div>

      {/* ── Entry Quality ── */}
      <div className="card">
        <div className="card-title">Entry Quality Gate</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <ConfigField label="Min confidence to trade (%)" cfgKey="min_confidence_to_trade"
            value={c('min_confidence_to_trade', '55')} onSave={handleConfigSave}
            hint="Bull agent must exceed this to proceed to Risk Agent" />
          <ConfigField label="Min event significance (0–100)" cfgKey="significance_min_score"
            value={c('significance_min_score', '60')} onSave={handleConfigSave}
            hint="Events scoring below this are ignored, no committee triggered" />
        </div>
      </div>

      {/* ── Regime Gates ── */}
      <div className="card">
        <div className="card-title">VIX Regime Gates</div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 1.6 }}>
          Rules tighten automatically as VIX rises. In CRISIS (VIX {'>'} 35) no new positions open.
          Each regime has its own deployment ceiling and stop width.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { regime: 'BULL',    vix: 'VIX < 15',    color: '#22c55e' },
            { regime: 'NORMAL',  vix: 'VIX 15–25',   color: '#60a5fa' },
            { regime: 'CAUTION', vix: 'VIX 25–35',   color: '#f59e0b' },
            { regime: 'CRISIS',  vix: 'VIX > 35',    color: '#ef4444' },
          ].map(({ regime, vix, color }) => {
            const prefix = regime.toLowerCase()
            return (
              <div key={regime} style={{ border: `1px solid ${color}33`, borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {regime}
                  </span>
                  <span style={{ fontSize: 10, color: '#475569', marginLeft: 2 }}>{vix}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: '0.72rem', color: '#64748b', display: 'block', marginBottom: 3 }}>Max deployed %</label>
                    <input className="input" style={{ fontSize: 12 }}
                      defaultValue={c(`${prefix}_max_deployed_pct`)}
                      onBlur={e => handleConfigSave(`${prefix}_max_deployed_pct`, e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.72rem', color: '#64748b', display: 'block', marginBottom: 3 }}>Hard stop %</label>
                    <input className="input" style={{ fontSize: 12 }}
                      defaultValue={c(`${prefix}_hard_stop_pct`)}
                      onBlur={e => handleConfigSave(`${prefix}_hard_stop_pct`, e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>Regime gates enabled</span>
          <button className="btn sm"
            onClick={() => handleConfigSave('regime_gate_enabled',
              c('regime_gate_enabled', '1') === '1' ? '0' : '1')}
            style={c('regime_gate_enabled', '1') === '1'
              ? { background: 'rgba(34,197,94,0.1)', color: '#22c55e', borderColor: 'rgba(34,197,94,0.25)' }
              : {}}>
            {c('regime_gate_enabled', '1') === '1' ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      </div>

      {/* ── Self-Correction ── */}
      <div className="card">
        <div className="card-title">Self-Correction Triggers</div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 1.6 }}>
          The agent monitors its own performance. When a trigger fires, a proposal appears above
          for your review. No rule changes without your approval.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <ConfigField label="Consecutive stop-losses (count)" cfgKey="self_correct_consec_stops"
            value={c('self_correct_consec_stops', '3')} onSave={handleConfigSave}
            hint="Triggers: tighten stop + reduce max position" />
          <ConfigField label="Min acceptable win rate (%)" cfgKey="self_correct_min_win_rate"
            value={c('self_correct_min_win_rate', '40')} onSave={handleConfigSave}
            hint="Triggers after 15+ trades: raise confidence threshold" />
          <ConfigField label="Loss/win ratio threshold" cfgKey="self_correct_rr_threshold"
            value={c('self_correct_rr_threshold', '1.5')} onSave={handleConfigSave}
            hint="Triggers if avg loss > X × avg win: tighten stops" />
          <ConfigField label="Max drawdown from peak (%)" cfgKey="self_correct_max_drawdown"
            value={c('self_correct_max_drawdown', '15')} onSave={handleConfigSave}
            hint="Hard pause trigger: reduces deployment + tightens all stops" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>Self-correction enabled</span>
          <button className="btn sm"
            onClick={() => handleConfigSave('self_correct_enabled',
              c('self_correct_enabled', '1') === '1' ? '0' : '1')}
            style={c('self_correct_enabled', '1') === '1'
              ? { background: 'rgba(34,197,94,0.1)', color: '#22c55e', borderColor: 'rgba(34,197,94,0.25)' }
              : {}}>
            {c('self_correct_enabled', '1') === '1' ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        {/* Past proposals */}
        {proposals.filter(p => p.status !== 'PENDING').length > 0 && (
          <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>PROPOSAL HISTORY</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {proposals.filter(p => p.status !== 'PENDING').slice(0, 5).map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                    background: p.status === 'APPROVED' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: p.status === 'APPROVED' ? '#22c55e' : '#ef4444',
                  }}>{p.status}</span>
                  <span style={{ color: '#94a3b8' }}>{triggerLabels[p.trigger_type] || p.trigger_type}</span>
                  <span style={{ color: '#475569', marginLeft: 'auto' }}>
                    {new Date(p.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Watchlist ── */}
      <div className="card">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span className="card-title" style={{ margin: 0 }}>Watchlist</span>

          {/* Tier counts */}
          {[
            { key: 'universe',  label: 'Universe',  color: '#60a5fa' },
            { key: 'watchlist', label: 'Watchlist',  color: '#22c55e' },
            { key: 'manual',    label: 'Manual',     color: '#a78bfa' },
          ].map(({ key, label, color }) => (
            <span key={key} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: `${color}18`, color }}>
              {label} <strong>{wlSummary[key] ?? 0}</strong>
            </span>
          ))}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={handleSeed} disabled={seeding}>
              {seeding ? 'Seeding…' : 'Seed SOTD → Watchlist'}
            </button>
            <button className="btn sm" onClick={handleScreenUniverse} disabled={screening}>
              {screening ? 'Screening…' : 'Screen Universe'}
            </button>
            <button className="btn sm" onClick={handleAutoAge} disabled={aging}>
              {aging ? 'Aging…' : 'Auto-Age'}
            </button>
          </div>
        </div>

        {/* Explanation */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { tier: 'Universe',  color: '#60a5fa', desc: '~150 S&P 500 stocks. Price/volume scan only — no Haiku calls. A move >3% or volume >3× auto-promotes to Watchlist.' },
            { tier: 'Watchlist', color: '#22c55e', desc: 'Agent-curated stocks. Full scan + Haiku significance scoring + committee trigger. Auto-demoted after 30 days of no action.' },
            { tier: 'Manual',    color: '#a78bfa', desc: 'Your own picks. Full scan. Never auto-aged or removed by the agent.' },
          ].map(({ tier, color, desc }) => (
            <div key={tier} style={{ padding: '10px 12px', borderRadius: 7, background: `${color}0a`, border: `1px solid ${color}22` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 4 }}>{tier}</div>
              <p style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5, margin: 0 }}>{desc}</p>
            </div>
          ))}
        </div>

        {/* Add ticker */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input className="input" style={{ width: 120, fontFamily: 'var(--mono)' }}
            value={newTicker}
            onChange={e => setNewTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleAddTicker()}
            placeholder="AAPL" />
          <button className="btn primary sm" onClick={handleAddTicker} disabled={!newTicker.trim()}>
            Add to Manual
          </button>
        </div>

        {/* Tier tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 12 }}>
          {([['watchlist','Watchlist'],['manual','Manual'],['universe','Universe']] as const).map(([t, label]) => (
            <button key={t} className="btn sm" onClick={() => setWlTab(t)}
              style={wlTab === t ? { background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.25)' } : {}}>
              {label} ({wlSummary[t] ?? 0})
            </button>
          ))}
        </div>

        {/* Ticker table */}
        {visibleItems.length === 0 ? (
          <p style={{ fontSize: 13, color: '#475569' }}>
            {wlTab === 'universe'
              ? 'Universe is empty — click "Screen Universe" to populate it with S&P 500 stocks.'
              : wlTab === 'watchlist'
              ? 'No watchlist tickers yet. Stocks auto-promote here when they trigger a strong price/volume move in the universe scan.'
              : 'No manual picks. Add a ticker above.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Source</th>
                <th>Notes</th>
                {wlTab === 'watchlist' && <th>Promoted</th>}
                {wlTab !== 'watchlist' && <th>Added</th>}
                {wlTab !== 'universe' && <th></th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map(w => (
                <tr key={w.id}>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#f1f5f9' }}>{w.ticker}</td>
                  <td>
                    <span className="badge" style={{ background: `${srcColor[w.source] || '#94a3b8'}22`, color: srcColor[w.source] || '#94a3b8' }}>
                      {w.source}
                    </span>
                  </td>
                  <td style={{ color: '#64748b', fontSize: '0.78rem', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {w.agent_notes || '—'}
                  </td>
                  {wlTab === 'watchlist'
                    ? <td style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{w.promoted_at ? new Date(w.promoted_at).toLocaleDateString() : '—'}</td>
                    : <td style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{new Date(w.added_at).toLocaleDateString()}</td>
                  }
                  {wlTab !== 'universe' && (
                    <td><button className="btn sm danger" onClick={() => handleRemove(w.ticker)}>Remove</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
