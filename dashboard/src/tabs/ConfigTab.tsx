import { useState, useEffect } from 'react'
import { getConfig, putConfig, getDaemonStatus, startDaemon, stopDaemon, restartDaemon } from '../api'

interface ConfigItem {
  key: string
  value: string
  value_type: string
  label: string
  group_name: string
}

interface GroupState {
  [key: string]: string
}

function ConfigGroup({
  title, items, onSave,
}: {
  title: string
  items: ConfigItem[]
  onSave: (updates: Record<string, string>) => Promise<void>
}) {
  const init = Object.fromEntries(items.map(i => [i.key, i.value]))
  const [values, setValues] = useState<GroupState>(init)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)

  useEffect(() => {
    setValues(Object.fromEntries(items.map(i => [i.key, i.value])))
  }, [items])

  const handle = (key: string, val: string) => setValues(v => ({ ...v, [key]: val }))

  const handleSave = async () => {
    setSaving(true)
    await onSave(values)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const groupDesc: Record<string, string> = {
    'Risk Thresholds':  'Percentage triggers for stop loss and profit-take alerts on individual positions.',
    'Position Limits':  'Maximum concentration rules enforced across your portfolio.',
    'Budget':           'Daily API spend limits. Scans abort when the threshold is hit to stay on budget.',
    'Notifications':    'Telegram message cadence and on/off controls.',
  }

  return (
    <div className="card">
      <h2>{title}</h2>
      {groupDesc[title] && (
        <p style={{ fontSize: '0.82rem', color: '#666', marginBottom: 16 }}>{groupDesc[title]}</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
        {items.map(item => (
          <div key={item.key}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#888', marginBottom: 4 }}>
              {item.label}
            </label>
            {item.value_type === 'bool' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={values[item.key] === 'true'}
                  onChange={e => handle(item.key, e.target.checked ? 'true' : 'false')}
                  style={{ width: 16, height: 16, accentColor: '#7eb8ff' }}
                />
                <span style={{ fontSize: '0.85rem', color: '#ccc' }}>
                  {values[item.key] === 'true' ? 'Enabled' : 'Disabled'}
                </span>
              </label>
            ) : (
              <input
                className="input"
                type="number"
                step={item.value_type === 'float' ? '0.01' : '1'}
                value={values[item.key]}
                onChange={e => handle(item.key, e.target.value)}
                style={{ width: '100%' }}
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : `Save ${title}`}
        </button>
        {saved && <span style={{ color: '#4ade80', fontSize: '0.85rem' }}>Saved</span>}
      </div>
    </div>
  )
}

function DaemonPanel() {
  const [status,  setStatus]  = useState<{ running: boolean; pid: number | null } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [msg,     setMsg]     = useState('')

  const poll = () => {
    getDaemonStatus()
      .then(r => setStatus(r.data))
      .catch(() => setStatus(null))
  }

  useEffect(() => { poll() }, [])

  const act = (fn: () => Promise<any>, label: string) => {
    setBusy(true); setMsg('')
    fn()
      .then(() => { setMsg(`${label} sent`); setTimeout(poll, 1500) })
      .catch(() => setMsg('Command failed'))
      .finally(() => setBusy(false))
  }

  const running = status?.running ?? false

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Background Daemon</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
            background: status === null ? '#555' : running ? '#4ade80' : '#f87171',
          }} />
          <span style={{ fontSize: '0.82rem', fontFamily: 'var(--mono)', color: status === null ? '#555' : running ? '#4ade80' : '#f87171', fontWeight: 700 }}>
            {status === null ? 'UNKNOWN' : running ? `RUNNING${status.pid ? ` · PID ${status.pid}` : ''}` : 'STOPPED'}
          </span>
        </div>
      </div>

      <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: 14 }}>
        The daemon runs the backend server and all scheduled jobs (SOTD, morning brief, risk checks) 24/7 in the background via macOS launchd.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {running ? (
          <>
            <button className="btn danger" onClick={() => act(stopDaemon, 'Stop')} disabled={busy}>Stop Daemon</button>
            <button className="btn" onClick={() => act(restartDaemon, 'Restart')} disabled={busy}>↻ Restart</button>
          </>
        ) : (
          <button className="btn primary" onClick={() => act(startDaemon, 'Start')} disabled={busy}>▶ Start Daemon</button>
        )}
        <button className="btn" onClick={poll} disabled={busy} style={{ marginLeft: 4 }}>↻ Refresh</button>
        {msg && <span style={{ fontSize: '0.78rem', color: '#4ade80', fontFamily: 'var(--mono)' }}>{msg}</span>}
      </div>
    </div>
  )
}

export default function ConfigTab() {
  const [grouped, setGrouped] = useState<Record<string, ConfigItem[]>>({})
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    getConfig().then(r => {
      setGrouped(r.data.grouped)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleSave = async (updates: Record<string, string>) => {
    await putConfig(updates).catch(() => {})
  }

  if (loading) return <p className="loading">Loading configuration...</p>

  const GROUP_ORDER = ['Risk Thresholds', 'Position Limits', 'Budget', 'Notifications']

  return (
    <div>
      <DaemonPanel />

      <div className="card" style={{ background: '#12121e', border: '1px solid #2a2a3a', marginBottom: 8 }}>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#888' }}>
          Changes take effect immediately for the next analysis run.
          Scheduler intervals are fixed — restart the backend to change them.
        </p>
      </div>

      {GROUP_ORDER.filter(g => grouped[g]).map(group => (
        <ConfigGroup
          key={group}
          title={group}
          items={grouped[group]}
          onSave={handleSave}
        />
      ))}

      {Object.keys(grouped).filter(g => !GROUP_ORDER.includes(g)).map(group => (
        <ConfigGroup key={group} title={group} items={grouped[group]} onSave={handleSave} />
      ))}
    </div>
  )
}
