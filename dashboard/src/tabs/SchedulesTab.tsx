import { useState, useEffect } from 'react'
import {
  getSchedules, toggleSchedule, runJobNow, deleteSchedule,
  createSchedule, updateSchedule, setScheduleTelegram,
  restartDaemon,
} from '../api'
import { PageInfoModal, InfoButton, usePageInfo } from '../components/PageInfoModal'

const S: Record<string, React.CSSProperties> = {
  panel:    { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' },
  sectionHd:{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.12em', fontFamily: 'var(--mono)', marginBottom: 8 },
  label:    { fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 4, display: 'block' },
  input:    { background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.85rem', padding: '5px 10px', outline: 'none' },
  select:   { background: '#0d1117', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: '0.85rem', padding: '5px 10px', outline: 'none' },
}

const JOB_TYPES = [
  { value: 'morning_brief',  label: 'Morning Portfolio Brief' },
  { value: 'risk_check',     label: 'Risk Check (stop/target alerts)' },
  { value: 'ytd_coach',      label: 'YTD Coaching Report' },
  { value: 'top_performers', label: 'Top Performers of the Day' },
  { value: 'sotd',           label: 'SOTD Pipeline — Stock of the Day' },
  { value: 'vix',            label: 'VIX Sync' },
  { value: 'rss',            label: 'News Feed Sync' },
  { value: 'edgar',          label: 'SEC Filing Sync' },
  { value: 'gdelt',          label: 'Geopolitical Events (GDELT)' },
]

const DAYS_OF_WEEK = [
  { value: '1', label: 'Mon' }, { value: '2', label: 'Tue' }, { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' }, { value: '5', label: 'Fri' }, { value: '6', label: 'Sat' }, { value: '0', label: 'Sun' },
]

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <label className="toggle" style={{ opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={enabled} onChange={onChange} disabled={disabled} />
      <div className="toggle-track" />
      <div className="toggle-thumb" />
    </label>
  )
}

function ChannelBadge({ channel }: { channel: string }) {
  const map: Record<string, string> = { telegram: 'bull', both: 'chop', ui: 'neutral', internal: 'neutral' }
  return <span className={`hbadge ${map[channel] ?? 'neutral'}`} style={{ fontSize: '0.6rem', padding: '1px 5px' }}>{channel.toUpperCase()}</span>
}

function BuilderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', description: '', job_type: 'top_performers',
    schedule_type: 'cron', hour: '16', minute: '05',
    days: ['1','2','3','4','5'], interval_minutes: '60',
    delivery_channel: 'both', telegram_enabled: true,
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')

  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  const toggleDay = (d: string) =>
    setForm(f => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d],
    }))

  const buildCron = () => {
    const sorted = [...form.days].sort().join(',')
    return `${form.minute} ${form.hour} * * ${sorted || '*'}`
  }

  const handleCreate = async () => {
    if (!form.name.trim()) { setErr('Name is required'); return }
    setSaving(true); setErr('')
    try {
      const payload: Record<string, any> = {
        name:             form.name,
        description:      form.description,
        job_type:         form.job_type,
        schedule_type:    form.schedule_type,
        delivery_channel: form.delivery_channel,
        telegram_enabled: form.telegram_enabled,
      }
      if (form.schedule_type === 'cron') {
        payload.cron_expression = buildCron()
      } else {
        payload.interval_minutes = parseInt(form.interval_minutes)
      }
      await createSchedule(payload)
      onCreated()
      onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? 'Failed to create schedule')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#00000099', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ ...S.panel, width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ ...S.sectionHd, marginBottom: 0 }}>New Schedule</div>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Schedule Name *</label>
            <input style={{ ...S.input, width: '100%' }} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Afternoon Close Summary" />
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Job Type *</label>
            <select style={{ ...S.select, width: '100%' }} value={form.job_type} onChange={e => set('job_type', e.target.value)}>
              {JOB_TYPES.map(j => <option key={j.value} value={j.value}>{j.label}</option>)}
            </select>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Schedule Type</label>
            <div style={{ display: 'flex', gap: 16 }}>
              {['cron', 'interval'].map(t => (
                <label key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: '0.8rem', color: form.schedule_type === t ? 'var(--cyan)' : 'var(--text-dim)' }}>
                  <input type="radio" name="sched_type" value={t} checked={form.schedule_type === t} onChange={() => set('schedule_type', t)} />
                  {t === 'cron' ? 'Fixed time (cron)' : 'Repeating interval'}
                </label>
              ))}
            </div>
          </div>

          {form.schedule_type === 'cron' ? (
            <>
              <div>
                <label style={S.label}>Hour (ET, 24h)</label>
                <input style={{ ...S.input, width: '100%' }} type="number" min={0} max={23} value={form.hour} onChange={e => set('hour', e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Minute</label>
                <input style={{ ...S.input, width: '100%' }} type="number" min={0} max={59} value={form.minute} onChange={e => set('minute', e.target.value)} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={S.label}>Days of Week</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAYS_OF_WEEK.map(d => {
                    const active = form.days.includes(d.value)
                    return (
                      <button
                        key={d.value}
                        className={`btn sm${active ? ' primary' : ''}`}
                        onClick={() => toggleDay(d.value)}
                        style={{ minWidth: 44 }}
                      >
                        {d.label}
                      </button>
                    )
                  })}
                </div>
                <div style={{ marginTop: 6, fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                  Cron: <span style={{ color: 'var(--cyan)' }}>{buildCron()}</span>
                </div>
              </div>
            </>
          ) : (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label}>Repeat Every (minutes)</label>
              <input style={{ ...S.input, width: 160 }} type="number" min={5} value={form.interval_minutes} onChange={e => set('interval_minutes', e.target.value)} />
            </div>
          )}

          <div>
            <label style={S.label}>Delivery Channel</label>
            <select style={{ ...S.select, width: '100%' }} value={form.delivery_channel} onChange={e => set('delivery_channel', e.target.value)}>
              <option value="both">Both (Telegram + Dashboard)</option>
              <option value="telegram">Telegram only</option>
              <option value="ui">Dashboard only</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <Toggle enabled={form.telegram_enabled} onChange={() => set('telegram_enabled', !form.telegram_enabled)} />
              <span style={{ fontSize: '0.75rem', color: form.telegram_enabled ? 'var(--green)' : 'var(--text-dim)' }}>
                Telegram {form.telegram_enabled ? 'ON' : 'OFF'}
              </span>
            </label>
          </div>
        </div>

        {err && <div style={{ marginTop: 10, color: 'var(--red)', fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>{err}</div>}

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn sm primary" onClick={handleCreate} disabled={saving}>{saving ? 'Creating…' : '✓ Create Schedule'}</button>
          <button className="btn sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function EditModal({ schedule, onClose, onSaved }: { schedule: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name:             schedule.name ?? '',
    description:      schedule.description ?? '',
    delivery_channel: schedule.delivery_channel ?? 'both',
    telegram_enabled: schedule.telegram_enabled !== 0,
    cron_expression:  schedule.cron_expression ?? '',
    interval_minutes: schedule.interval_minutes?.toString() ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    setSaving(true); setErr('')
    try {
      const payload: Record<string, any> = {
        name:             form.name,
        description:      form.description,
        delivery_channel: form.delivery_channel,
        telegram_enabled: form.telegram_enabled ? 1 : 0,
      }
      if (schedule.schedule_type === 'cron' && form.cron_expression)
        payload.cron_expression = form.cron_expression
      if (schedule.schedule_type === 'interval' && form.interval_minutes)
        payload.interval_minutes = parseInt(form.interval_minutes)
      await updateSchedule(schedule.job_id, payload)
      onSaved(); onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000099', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ ...S.panel, width: 460 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ ...S.sectionHd, marginBottom: 0 }}>Edit Schedule</div>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Name</label>
            <input style={{ ...S.input, width: '100%' }} value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Description</label>
            <input style={{ ...S.input, width: '100%' }} value={form.description} onChange={e => set('description', e.target.value)} />
          </div>

          <div>
            <label style={S.label}>Delivery Channel</label>
            <select style={{ ...S.select, width: '100%' }} value={form.delivery_channel} onChange={e => set('delivery_channel', e.target.value)}>
              <option value="both">Both (Telegram + Dashboard)</option>
              <option value="telegram">Telegram only</option>
              <option value="ui">Dashboard only</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <Toggle enabled={form.telegram_enabled} onChange={() => set('telegram_enabled', !form.telegram_enabled)} />
              <span style={{ fontSize: '0.75rem', color: form.telegram_enabled ? 'var(--green)' : 'var(--text-dim)' }}>
                Telegram {form.telegram_enabled ? 'ON' : 'OFF'}
              </span>
            </label>
          </div>

          {schedule.schedule_type === 'cron' && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label}>Cron Expression (min hour dom mon dow)</label>
              <input style={{ ...S.input, width: '100%', fontFamily: 'var(--mono)' }} value={form.cron_expression} onChange={e => set('cron_expression', e.target.value)} placeholder="e.g. 5 16 * * 1-5" />
              <div style={{ marginTop: 4, fontSize: '0.65rem', color: 'var(--text-dim)' }}>Current: {schedule.human_schedule}</div>
            </div>
          )}
          {schedule.schedule_type === 'interval' && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label}>Interval (minutes)</label>
              <input style={{ ...S.input, width: 160 }} type="number" min={1} value={form.interval_minutes} onChange={e => set('interval_minutes', e.target.value)} />
            </div>
          )}
        </div>

        {err && <div style={{ marginTop: 8, color: 'var(--red)', fontSize: '0.78rem', fontFamily: 'var(--mono)' }}>{err}</div>}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button className="btn sm primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : '✓ Save Changes'}</button>
          <button className="btn sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export default function SchedulesTab() {
  const [schedules,    setSchedules]    = useState<any[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [busy,         setBusy]         = useState<Record<string, boolean>>({})
  const [showBuilder,  setShowBuilder]  = useState(false)
  const [editTarget,   setEditTarget]   = useState<any>(null)
  const [restarting,   setRestarting]   = useState(false)
  const [restartMsg,   setRestartMsg]   = useState<string | null>(null)
  const info = usePageInfo()

  const load = () => {
    setLoading(true)
    getSchedules()
      .then(r => { setSchedules(r.data.schedules ?? []); setLoading(false) })
      .catch(() => { setError('Failed to load schedules.'); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const withBusy = (key: string, fn: () => Promise<any>) => {
    setBusy(b => ({ ...b, [key]: true }))
    fn().then(load).catch(() => {}).finally(() => setBusy(b => ({ ...b, [key]: false })))
  }

  const handleToggle   = (jobId: string) => withBusy(jobId, () => toggleSchedule(jobId))
  const handleRunNow   = (jobId: string) => withBusy(`run_${jobId}`, () => runJobNow(jobId))
  const handleDelete   = (jobId: string, name: string) => {
    if (!confirm(`Delete schedule "${name}"? This cannot be undone.`)) return
    withBusy(`del_${jobId}`, () => deleteSchedule(jobId))
  }
  const handleTelegram = (jobId: string, current: boolean) =>
    withBusy(`tg_${jobId}`, () => setScheduleTelegram(jobId, !current))

  const handleRestart = () => {
    setRestarting(true)
    setRestartMsg(null)
    restartDaemon()
      .then(r => setRestartMsg(r.data?.ok ? '✓ Daemon restarted — all scheduler jobs reloaded' : `Warning: ${r.data?.detail ?? 'unexpected response'}`))
      .catch(() => setRestartMsg('ℹ Not running as daemon — if using --reload, changes are live automatically. Otherwise restart manually in terminal.'))
      .finally(() => setRestarting(false))
  }

  const fmtTime = (iso: string | null) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
    catch { return iso.slice(0, 16).replace('T', ' ') }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-dim)', fontSize: '0.8rem' }}>
      Loading schedules…
    </div>
  )
  if (error) return <div style={{ padding: 24, color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>

  const enabled  = schedules.filter(s => s.enabled)
  const disabled = schedules.filter(s => !s.enabled)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {info.show && (
        <PageInfoModal
          title="Schedules"
          subtitle="Cron jobs that keep the agent running 24/7"
          benefit="See exactly when every job fires and manually trigger any job on demand — so you always know the data is fresh."
          sections={[
            { title: 'What this page shows', body: 'Every automated job the agent runs: SOTD pipeline, market data sync, GDELT geopolitical events, RSS news, portfolio CSV sync, health monitoring, and Telegram alerts. Each shows when it last ran, its cron schedule, and whether Telegram delivery is enabled.' },
            { title: 'Key jobs and their cadence', body: '', bullets: [
              'SOTD Pipeline — 7:30 AM daily (Mon–Fri) + 3 intraday refreshes',
              'Finnhub Market Data — every 30–60 minutes during market hours',
              'GDELT Events — every 3 hours (geopolitical risk signals)',
              'Portfolio CSV — every 30 minutes',
              'Health Monitor — every 15 minutes',
            ]},
            { title: 'Manual triggers', body: 'Click "▶ Run Now" on any job to fire it immediately regardless of its cron schedule. Useful when you want fresh data outside normal hours, or to test that a job is working after a code change.' },
          ]}
          onClose={info.close}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -8 }}>
        <InfoButton onClick={info.open} />
      </div>
      {showBuilder && (
        <BuilderModal onClose={() => setShowBuilder(false)} onCreated={load} />
      )}
      {editTarget && (
        <EditModal schedule={editTarget} onClose={() => setEditTarget(null)} onSaved={load} />
      )}

      {/* Stats + actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ ...S.panel, flex: 1, minWidth: 100, textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--green)' }}>{enabled.length}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>ACTIVE</div>
        </div>
        <div style={{ ...S.panel, flex: 1, minWidth: 100, textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--text-dim)' }}>{disabled.length}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>PAUSED</div>
        </div>
        <div style={{ ...S.panel, flex: 1, minWidth: 100, textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem', fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--cyan)' }}>{schedules.length}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>TOTAL</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={handleRestart} disabled={restarting}
              title="Restart the backend daemon — reloads all scheduler jobs without touching running state"
              style={{ borderColor: restarting ? 'var(--border)' : '#f59e0b', color: restarting ? 'var(--text-dim)' : '#f59e0b' }}>
              {restarting ? '↻ Restarting…' : '↺ Restart Backend'}
            </button>
            <button className="btn sm primary" onClick={() => setShowBuilder(true)}>
              + New Schedule
            </button>
          </div>
          {restartMsg && (
            <div style={{ fontSize: '0.65rem', fontFamily: 'var(--mono)', color: restartMsg.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>
              {restartMsg}
            </div>
          )}
        </div>
      </div>

      {/* Schedule table */}
      <div style={S.panel}>
        <div style={S.sectionHd}>All Schedules ({schedules.length})</div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Frequency</th>
              <th>Channel</th>
              <th>Telegram</th>
              <th>Last Run</th>
              <th>Next Run</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map(s => {
              const isBusy = busy[s.job_id] || busy[`run_${s.job_id}`] || busy[`del_${s.job_id}`] || busy[`tg_${s.job_id}`]
              return (
                <tr key={s.job_id} style={{ opacity: isBusy ? 0.5 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: '0.85rem' }}>{s.name}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 2, maxWidth: 280 }}>{s.description}</div>
                  </td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{s.human_schedule ?? s.cron_expression ?? `every ${s.interval_minutes}m`}</td>
                  <td><ChannelBadge channel={s.delivery_channel ?? 'ui'} /></td>
                  <td>
                    <Toggle
                      enabled={s.telegram_enabled !== 0}
                      onChange={() => handleTelegram(s.job_id, s.telegram_enabled !== 0)}
                      disabled={isBusy}
                    />
                  </td>
                  <td style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{fmtTime(s.last_run)}</td>
                  <td style={{ fontSize: '0.72rem', color: s.next_run ? 'var(--cyan)' : 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{fmtTime(s.next_run)}</td>
                  <td>
                    <Toggle enabled={s.enabled} onChange={() => handleToggle(s.job_id)} disabled={isBusy} />
                  </td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm" title="Run now" onClick={() => handleRunNow(s.job_id)} disabled={isBusy}>▶</button>
                    <button className="btn sm" title="Edit" onClick={() => setEditTarget(s)} disabled={isBusy}>✎</button>
                    <button className="btn sm danger" title="Delete" onClick={() => handleDelete(s.job_id, s.name)} disabled={isBusy}>✕</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
