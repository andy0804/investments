import { useState, useEffect } from 'react'
import {
  getFilterPresets, createFilterPreset, activatePreset,
  updateFilterPreset, deleteFilterPreset,
} from '../api'

const S: Record<string, React.CSSProperties> = {
  panel:    { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '16px 18px' },
  sectionHd:{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', fontFamily: 'var(--mono)', marginBottom: 10 },
  label:    { fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 4, display: 'block' },
  input:    { background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.85rem', padding: '5px 10px', width: '100%', outline: 'none' },
  select:   { background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.85rem', padding: '5px 10px', width: '100%', outline: 'none' },
}

const MARKET_CAP_OPTIONS = [
  { value: 'large',  label: 'Large Cap+ (>$10B)' },
  { value: 'mid',    label: 'Mid Cap+ (>$2B) — Recommended' },
  { value: 'small',  label: 'Small Cap+ (>$300M)' },
]

const RSI_OPTIONS = [
  { value: 'Not Overbought (<60)', label: 'Not Overbought (<60) — Recommended' },
  { value: 'Overbought (>70)',     label: 'Overbought (>70)' },
  { value: 'Any',                  label: 'Any (no RSI filter)' },
]

const PERF_OPTIONS = [
  { value: 'Week Up',    label: 'Week Up — Recommended' },
  { value: 'Month Up',   label: 'Month Up' },
  { value: 'Quarter Up', label: 'Quarter Up' },
]

const EMPTY_FORM = {
  name: '', description: '',
  min_price: 10, min_avg_volume: 1000000, market_cap: 'mid',
  rsi_filter: 'Not Overbought (<60)', performance_filter: 'Week Up',
  conviction_threshold: 65, limit_candidates: 40,
}

function PresetForm({
  initial, onSave, onCancel, saving,
}: {
  initial: typeof EMPTY_FORM;
  onSave: (data: typeof EMPTY_FORM) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(initial)
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
      <div>
        <label style={S.label}>Preset Name *</label>
        <input style={S.input} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Aggressive Growth" />
      </div>
      <div>
        <label style={S.label}>Description</label>
        <input style={S.input} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Optional" />
      </div>

      <div>
        <label style={S.label}>Min Price ($)</label>
        <input style={S.input} type="number" min={1} max={500} value={form.min_price}
          onChange={e => set('min_price', parseFloat(e.target.value))} />
      </div>
      <div>
        <label style={S.label}>Min Avg Volume</label>
        <input style={S.input} type="number" min={100000} step={100000} value={form.min_avg_volume}
          onChange={e => set('min_avg_volume', parseInt(e.target.value))} />
      </div>

      <div>
        <label style={S.label}>Market Cap Floor</label>
        <select style={S.select} value={form.market_cap} onChange={e => set('market_cap', e.target.value)}>
          {MARKET_CAP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label style={S.label}>RSI Filter</label>
        <select style={S.select} value={form.rsi_filter} onChange={e => set('rsi_filter', e.target.value)}>
          {RSI_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div>
        <label style={S.label}>Performance Window</label>
        <select style={S.select} value={form.performance_filter} onChange={e => set('performance_filter', e.target.value)}>
          {PERF_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label style={S.label}>Conviction Threshold (min score to signal)</label>
        <input style={S.input} type="number" min={40} max={100} value={form.conviction_threshold}
          onChange={e => set('conviction_threshold', parseInt(e.target.value))} />
      </div>

      <div>
        <label style={S.label}>Max Candidates from Screener</label>
        <input style={S.input} type="number" min={10} max={100} value={form.limit_candidates}
          onChange={e => set('limit_candidates', parseInt(e.target.value))} />
      </div>

      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn sm primary" onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : '✓ Save Preset'}
        </button>
        <button className="btn sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function UniverseTab() {
  const [presets, setPresets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState<Record<string, boolean>>({})
  const [showForm, setShowForm] = useState(false)
  const [editId,   setEditId]   = useState<number | null>(null)
  const [formInit, setFormInit] = useState<typeof EMPTY_FORM>(EMPTY_FORM)

  const load = () => {
    setLoading(true)
    getFilterPresets()
      .then(r => { setPresets(r.data.presets ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const withBusy = (key: string, fn: () => Promise<any>) => {
    setBusy(b => ({ ...b, [key]: true }))
    fn().then(load).catch(() => {}).finally(() => setBusy(b => ({ ...b, [key]: false })))
  }

  const handleActivate = (id: number) => withBusy(`act_${id}`, () => activatePreset(id))
  const handleDelete   = (id: number, name: string) => {
    if (!confirm(`Delete preset "${name}"?`)) return
    withBusy(`del_${id}`, () => deleteFilterPreset(id))
  }

  const handleSave = async (form: typeof EMPTY_FORM) => {
    setBusy(b => ({ ...b, form: true }))
    try {
      if (editId != null) {
        await updateFilterPreset(editId, form)
      } else {
        await createFilterPreset(form)
      }
      setShowForm(false); setEditId(null); setFormInit(EMPTY_FORM)
      load()
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? 'Save failed')
    } finally {
      setBusy(b => ({ ...b, form: false }))
    }
  }

  const handleEdit = (p: any) => {
    setFormInit({
      name: p.name, description: p.description ?? '',
      min_price: p.min_price, min_avg_volume: p.min_avg_volume,
      market_cap: p.market_cap, rsi_filter: p.rsi_filter,
      performance_filter: p.performance_filter,
      conviction_threshold: p.conviction_threshold,
      limit_candidates: p.limit_candidates,
    })
    setEditId(p.id)
    setShowForm(true)
  }

  const active = presets.find(p => p.is_active)

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-dim)', fontSize: '0.8rem' }}>
      Loading…
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Active preset banner */}
      {active && (
        <div style={{ background: '#0a1a0a', border: '1px solid #00d08444', borderRadius: 4, padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: '0.68rem', color: 'var(--green)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: '0.1em' }}>▶ ACTIVE UNIVERSE</span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{active.name}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            {'Price >$'}{active.min_price}{' · Vol >'}{ (active.min_avg_volume / 1e6).toFixed(1)}{'M · Cap '}{active.market_cap}{'+ · Score ≥'}{active.conviction_threshold}
          </span>
        </div>
      )}

      {/* Preset list */}
      <div style={S.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={S.sectionHd}>Filter Presets</div>
          <button className="btn sm primary" onClick={() => { setFormInit(EMPTY_FORM); setEditId(null); setShowForm(true) }}>
            + New Preset
          </button>
        </div>

        {showForm && (
          <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, padding: '14px 16px', marginBottom: 16 }}>
            <div style={{ ...S.sectionHd, marginBottom: 0 }}>{editId != null ? 'Edit Preset' : 'New Preset'}</div>
            <PresetForm initial={formInit} onSave={handleSave} onCancel={() => { setShowForm(false); setEditId(null) }} saving={!!busy.form} />
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Name</th><th>Price</th><th>Volume</th><th>Cap</th><th>RSI</th><th>Perf</th><th>Threshold</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {presets.map(p => (
              <tr key={p.id} style={{ opacity: busy[`act_${p.id}`] || busy[`del_${p.id}`] ? 0.5 : 1 }}>
                <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>
                  {p.name}
                  {p.description && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontWeight: 400 }}>{p.description}</div>}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>${p.min_price}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{(p.min_avg_volume / 1e6).toFixed(1)}M</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{p.market_cap}+</td>
                <td style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{p.rsi_filter.replace('Not Overbought (<60)', '<60').replace('Overbought (>70)', '>70')}</td>
                <td style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{p.performance_filter}</td>
                <td style={{ fontFamily: 'var(--mono)', color: 'var(--cyan)', fontSize: '0.82rem' }}>≥{p.conviction_threshold}</td>
                <td>
                  {p.is_active
                    ? <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>● ACTIVE</span>
                    : <button className="btn sm" onClick={() => handleActivate(p.id)} disabled={!!busy[`act_${p.id}`]}>Activate</button>
                  }
                </td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm" onClick={() => handleEdit(p)}>Edit</button>
                  {!p.is_active && (
                    <button className="btn sm danger" onClick={() => handleDelete(p.id, p.name)} disabled={!!busy[`del_${p.id}`]}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* What each filter does */}
      <div style={S.panel}>
        <div style={S.sectionHd}>Filter Reference</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            ['Min Price', 'Excludes penny stocks. Below $10 introduces manipulation risk and higher noise.'],
            ['Min Avg Volume', 'Ensures liquidity. Below 1M shares/day means your order can move the price.'],
            ['Market Cap Floor', 'Mid+ ($2B+) filters out micro-caps prone to manipulation. Large+ for institutional-grade only.'],
            ['RSI Filter', 'Not Overbought (<60) avoids chasing. Higher RSI means more extension risk.'],
            ['Performance Window', 'Week Up ensures recent momentum. Month Up is for longer trend confirmation.'],
            ['Conviction Threshold', 'Minimum score to show as a signal. Below threshold: displayed as "watching" only.'],
          ].map(([k, v]) => (
            <div key={k} style={{ background: '#0d1117', borderRadius: 3, padding: '8px 10px' }}>
              <div style={{ ...S.label, color: 'var(--cyan)', marginBottom: 3 }}>{k}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.5 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
