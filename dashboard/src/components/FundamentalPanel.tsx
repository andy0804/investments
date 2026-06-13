import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import { getFundamentals } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Quarter {
  period: string
  revenue?: number
  net_income?: number
  eps?: number
  fcf?: number
  gross_margin?: number
  net_margin?: number
  op_margin?: number
  revenue_yoy_pct?: number
  eps_yoy_pct?: number
  ni_yoy_pct?: number
  eps_beat?: boolean
  eps_surprise_pct?: number
}

interface Analysis {
  fundamental_strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'UNKNOWN'
  signal_alignment: 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL'
  summary: string
  key_insights: string[]
  risks: string[]
  final_take: string
}

interface FundamentalData {
  quarterly: Quarter[]
  balance?: { de_ratio?: number; total_debt?: number; total_equity?: number }
  finnhub?: { pe_ttm?: number; market_cap_usd?: number; net_margin_ttm?: number; roe_ttm?: number }
  analysis: Analysis
  fetch_errors: string[]
  cached: boolean
  model: string
  cost_usd: number
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface FundamentalPanelProps {
  symbol: string
  autoLoad?: boolean
  signalType?: string
  confidenceScore?: number
  regime?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtB(v?: number | null): string {
  if (v == null) return '—'
  const b = v / 1e9
  if (Math.abs(b) >= 1) return `$${b.toFixed(2)}B`
  return `$${(v / 1e6).toFixed(0)}M`
}

function fmtPct(v?: number | null, sign = true): string {
  if (v == null) return '—'
  return sign ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : `${v.toFixed(1)}%`
}

function fmtLabel(period: string): string {
  if (!period) return ''
  const parts = period.split('-')
  if (parts.length < 2) return period
  const year = parts[0].slice(2)
  const month = parseInt(parts[1])
  const qMap: Record<number, string> = { 1: 'Q1', 2: 'Q1', 3: 'Q1', 4: 'Q2', 5: 'Q2', 6: 'Q2', 7: 'Q3', 8: 'Q3', 9: 'Q3', 10: 'Q4', 11: 'Q4', 12: 'Q4' }
  return `${qMap[month] || 'Q?'}'${year}`
}

// ── Strength / alignment badges ───────────────────────────────────────────────

function StrengthBadge({ val }: { val: string }) {
  const map: Record<string, string> = {
    STRONG: '#16a34a', MODERATE: '#d97706', WEAK: '#dc2626', UNKNOWN: '#9ca3af',
  }
  const color = map[val] || '#9ca3af'
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 3,
      fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--mono)', letterSpacing: '0.08em',
      background: color + '15', color, border: `1px solid ${color}44`,
    }}>{val}</span>
  )
}

function AlignBadge({ val }: { val: string }) {
  const map: Record<string, string> = {
    SUPPORTS: '#16a34a', CONTRADICTS: '#dc2626', NEUTRAL: '#9ca3af',
  }
  const color = map[val] || '#9ca3af'
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 3,
      fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--mono)', letterSpacing: '0.08em',
      background: color + '15', color, border: `1px solid ${color}44`,
    }}>{val}</span>
  )
}

// ── Mini bar chart ────────────────────────────────────────────────────────────

function MiniBarChart({
  data, label, formatter,
}: {
  data: { x: string; v: number | null }[]
  label: string
  formatter: (v: number) => string
}) {
  const vals = data.map(d => d.v ?? 0)
  const allPos = vals.every(v => v >= 0)
  const allNeg = vals.every(v => v <= 0)

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 4, fontFamily: 'var(--mono)' }}>
        {label}
      </div>
      <ResponsiveContainer width="100%" height={64}>
        <BarChart data={data} barSize={14} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
          <XAxis dataKey="x" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <YAxis hide domain={['auto', 'auto']} />
          {!allPos && !allNeg && <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />}
          <Tooltip
            contentStyle={{ background: '#0C1A2E', border: '1px solid rgba(255,255,255,0.1)', fontSize: '0.75rem', borderRadius: 6, padding: '6px 10px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}
            labelStyle={{ color: '#F1F5F9', fontWeight: 600, marginBottom: 3 }}
            itemStyle={{ color: '#22C55E' }}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            formatter={(v: number) => [formatter(v), '']}
          />
          <Bar dataKey="v" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={(entry.v ?? 0) >= 0 ? '#16a34a' : '#dc2626'} fillOpacity={0.75} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Error panel ───────────────────────────────────────────────────────────────

function ErrorPanel({ errors }: { errors: string[] }) {
  const [open, setOpen] = useState(false)
  if (!errors.length) return null
  return (
    <div style={{
      border: '1px solid var(--warn-border, #fcd34d)', borderRadius: 6, marginBottom: 14,
      background: 'var(--warn-bg, #fffbeb)',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          textAlign: 'left',
        }}>
        <span style={{ fontSize: '0.75rem', color: '#92400e', fontWeight: 700, fontFamily: 'var(--mono)' }}>
          ⚠ {errors.length} DATA {errors.length === 1 ? 'ERROR' : 'ERRORS'}
        </span>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', flex: 1 }}>
          {open ? '' : 'Analysis ran with partial data — click to view'}
        </span>
        <span style={{ color: '#92400e', fontSize: '0.72rem' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid #fcd34d', padding: '8px 12px 10px' }}>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: '0.75rem', color: '#92400e', fontFamily: 'var(--mono)', padding: '3px 0', display: 'flex', gap: 6 }}>
              <span style={{ color: '#d97706', flexShrink: 0 }}>✗</span>
              <span>{e}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: '0.68rem', color: 'var(--text-dim)' }}>
            Data that failed to load is shown as "—" in the metrics. The LLM analysis used available data only.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Trend arrow ───────────────────────────────────────────────────────────────

function TrendArrow({ current, prior }: { current?: number | null; prior?: number | null }) {
  if (current == null || prior == null) return null
  if (current > prior * 1.03) return <span style={{ color: '#16a34a', fontSize: '0.72rem', marginLeft: 4 }}>↑</span>
  if (current < prior * 0.97) return <span style={{ color: '#dc2626', fontSize: '0.72rem', marginLeft: 4 }}>↓</span>
  return <span style={{ color: '#9ca3af', fontSize: '0.72rem', marginLeft: 4 }}>→</span>
}

// ── Metric row ────────────────────────────────────────────────────────────────

function MRow({ label, value, color, trend }: { label: string; value: string; color?: string; trend?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', fontSize: '0.82rem', color: color ?? 'var(--text-bright)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
        {value}{trend}
      </span>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function FundamentalPanel({
  symbol, autoLoad = false, signalType, confidenceScore, regime,
}: FundamentalPanelProps) {
  const [data,       setData]       = useState<FundamentalData | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [model,      setModel]      = useState<'haiku' | 'sonnet'>('haiku')
  const [quarters,   setQuarters]   = useState<4 | 8>(4)
  const [hasLoaded,  setHasLoaded]  = useState(false)

  const load = useCallback(async (mdl: 'haiku' | 'sonnet' = model, forceRefresh = false) => {
    if (!symbol) return
    setLoading(true); setError('')
    try {
      const r = await getFundamentals(symbol, mdl, forceRefresh, signalType, confidenceScore, regime)
      setData(r.data)
      setHasLoaded(true)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Failed to load fundamental data')
    } finally {
      setLoading(false)
    }
  }, [symbol, signalType, confidenceScore, regime, model])

  useEffect(() => {
    if (autoLoad && symbol) {
      load('haiku', false)
    }
  }, [autoLoad, symbol])

  const handleModelSwitch = (mdl: 'haiku' | 'sonnet') => {
    setModel(mdl)
    if (hasLoaded) load(mdl, false)
  }

  const q = data ? data.quarterly.slice(0, quarters) : []

  const revenueChart = q.map(x => ({ x: fmtLabel(x.period), v: x.revenue != null ? x.revenue / 1e9 : null }))
  const epsChart     = q.map(x => ({ x: fmtLabel(x.period), v: x.eps ?? null }))
  const niChart      = q.map(x => ({ x: fmtLabel(x.period), v: x.net_income != null ? x.net_income / 1e9 : null }))
  const fcfChart     = q.map(x => ({ x: fmtLabel(x.period), v: x.fcf != null ? x.fcf / 1e9 : null }))

  const latest = q[0] ?? {}
  const prev   = q[1] ?? {}

  const analysis  = data?.analysis
  const fetchErrs = data?.fetch_errors ?? []

  const btnBase: React.CSSProperties = {
    padding: '3px 10px', borderRadius: 4, fontSize: '0.65rem', cursor: 'pointer',
    fontWeight: 600, fontFamily: 'var(--mono)', letterSpacing: '0.05em',
    transition: 'all 0.1s',
  }

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>

      {/* ── Header ── */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'var(--panel-inset)',
      }}>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--green)', letterSpacing: '0.12em', fontFamily: 'var(--mono)' }}>
          FUNDAMENTAL INTELLIGENCE — {symbol}
        </span>

        {/* Model toggle */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {(['haiku', 'sonnet'] as const).map(m => (
            <button key={m} onClick={() => handleModelSwitch(m)}
              style={{
                ...btnBase,
                background: model === m ? 'var(--panel)' : 'transparent',
                color: model === m ? 'var(--text-bright)' : 'var(--text-dim)',
                border: `1px solid ${model === m ? 'var(--border-hi)' : 'var(--border)'}`,
                boxShadow: model === m ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}>{m.toUpperCase()}</button>
          ))}
        </div>

        {/* Quarters toggle */}
        <div style={{ display: 'flex', gap: 4 }}>
          {([4, 8] as const).map(n => (
            <button key={n} onClick={() => setQuarters(n)}
              style={{
                ...btnBase,
                background: quarters === n ? 'var(--panel)' : 'transparent',
                color: quarters === n ? 'var(--text-bright)' : 'var(--text-dim)',
                border: `1px solid ${quarters === n ? 'var(--border-hi)' : 'var(--border)'}`,
                boxShadow: quarters === n ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}>{n}Q</button>
          ))}
        </div>

        {/* Refresh */}
        {hasLoaded && (
          <button onClick={() => load(model, true)} disabled={loading}
            style={{
              ...btnBase,
              background: 'transparent', color: 'var(--text-dim)',
              border: '1px solid var(--border)',
            }}>↻ REFRESH</button>
        )}

        {data?.cached && (
          <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>CACHED</span>
        )}
      </div>

      {/* ── Not-yet-loaded state ── */}
      {!autoLoad && !hasLoaded && !loading && (
        <div style={{ padding: '24px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 12 }}>
            Run fundamental analysis to see financial strength, earnings trends, and signal alignment.
          </div>
          <button onClick={() => load('haiku', false)}
            style={{
              padding: '8px 20px', borderRadius: 6, fontSize: '0.8rem', fontWeight: 700,
              background: 'var(--green)', color: '#ffffff', border: 'none', cursor: 'pointer',
            }}>
            ▶ Run Fundamental Analysis
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: 8, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⟳</div>
          <div>Fetching financials from Alpha Vantage + Finnhub…</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 4 }}>Running {model === 'haiku' ? 'Haiku' : 'Sonnet'} analysis · first run ~15s</div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── Error ── */}
      {error && !loading && (
        <div style={{ padding: '16px', color: 'var(--red)', fontSize: '0.82rem', fontFamily: 'var(--mono)' }}>
          {error}
          <button onClick={() => load(model, true)} style={{ marginLeft: 12, fontSize: '0.72rem', color: 'var(--green)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {/* ── Main content ── */}
      {data && !loading && (
        <div style={{ padding: 16 }}>

          <ErrorPanel errors={fetchErrs} />

          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

            {/* ── LEFT: Charts + Metrics ── */}
            <div>
              {q.length > 0 && (
                <>
                  <MiniBarChart data={revenueChart} label="REVENUE ($B)" formatter={v => `$${v.toFixed(2)}B`} />
                  <MiniBarChart data={epsChart}     label="EPS ($)"      formatter={v => `$${v.toFixed(2)}`} />
                  <MiniBarChart data={niChart}      label="NET INCOME ($B)" formatter={v => `$${v.toFixed(2)}B`} />
                  <MiniBarChart data={fcfChart}     label="FREE CASH FLOW ($B)" formatter={v => `$${v.toFixed(2)}B`} />
                </>
              )}

              {/* Latest quarter snapshot */}
              {latest.period && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 8, fontFamily: 'var(--mono)' }}>
                    LATEST — {fmtLabel(latest.period)}
                  </div>
                  <MRow label="REVENUE"      value={fmtB(latest.revenue)}
                    trend={<TrendArrow current={latest.revenue} prior={prev.revenue} />} />
                  <MRow label="REV YoY"      value={fmtPct(latest.revenue_yoy_pct)}
                    color={(latest.revenue_yoy_pct ?? 0) > 0 ? '#16a34a' : '#dc2626'}
                    trend={<TrendArrow current={latest.revenue_yoy_pct} prior={prev.revenue_yoy_pct} />} />
                  <MRow label="EPS"          value={latest.eps != null ? `$${latest.eps}` : '—'}
                    trend={<TrendArrow current={latest.eps} prior={prev.eps} />} />
                  <MRow label="EPS YoY"      value={fmtPct(latest.eps_yoy_pct)}
                    color={(latest.eps_yoy_pct ?? 0) > 0 ? '#16a34a' : '#dc2626'}
                    trend={<TrendArrow current={latest.eps_yoy_pct} prior={prev.eps_yoy_pct} />} />
                  <MRow label="EPS BEAT"     value={latest.eps_beat != null ? (latest.eps_beat ? `+${(latest.eps_surprise_pct ?? 0).toFixed(1)}%` : `${(latest.eps_surprise_pct ?? 0).toFixed(1)}%`) : '—'}
                    color={latest.eps_beat ? '#16a34a' : latest.eps_beat === false ? '#dc2626' : undefined} />
                  <MRow label="GROSS MARGIN" value={fmtPct(latest.gross_margin, false)}
                    color={(latest.gross_margin ?? 0) > 40 ? '#16a34a' : undefined}
                    trend={<TrendArrow current={latest.gross_margin} prior={prev.gross_margin} />} />
                  <MRow label="NET MARGIN"   value={fmtPct(latest.net_margin, false)}
                    color={(latest.net_margin ?? 0) > 15 ? '#16a34a' : undefined}
                    trend={<TrendArrow current={latest.net_margin} prior={prev.net_margin} />} />
                  <MRow label="FCF"          value={fmtB(latest.fcf)}
                    color={(latest.fcf ?? 0) > 0 ? '#16a34a' : '#dc2626'}
                    trend={<TrendArrow current={latest.fcf} prior={prev.fcf} />} />
                  {data.balance?.de_ratio != null && (
                    <MRow label="D/E RATIO" value={data.balance.de_ratio.toFixed(2)}
                      color={(data.balance.de_ratio ?? 0) > 2 ? '#dc2626' : undefined} />
                  )}
                  {data.finnhub?.pe_ttm != null && (
                    <MRow label="P/E (TTM)" value={data.finnhub.pe_ttm.toFixed(1)} />
                  )}
                </div>
              )}
            </div>

            {/* ── RIGHT: LLM Analysis ── */}
            <div>
              {analysis && (
                <>
                  {/* Verdict row */}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: '0.1em' }}>FUNDAMENTAL STRENGTH</div>
                      <StrengthBadge val={analysis.fundamental_strength} />
                    </div>
                    {analysis.signal_alignment && analysis.signal_alignment !== 'NEUTRAL' && (
                      <div>
                        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: '0.1em' }}>SIGNAL ALIGNMENT</div>
                        <AlignBadge val={analysis.signal_alignment} />
                      </div>
                    )}
                  </div>

                  {/* Summary */}
                  <div style={{
                    fontSize: '0.83rem', color: 'var(--text)', lineHeight: 1.7,
                    padding: '10px 12px', background: 'var(--panel-inset)', borderRadius: 6,
                    borderLeft: `3px solid ${analysis.fundamental_strength === 'STRONG' ? '#16a34a' : analysis.fundamental_strength === 'WEAK' ? '#dc2626' : '#d97706'}`,
                    marginBottom: 14,
                  }}>
                    {analysis.summary}
                  </div>

                  {/* Key insights */}
                  {analysis.key_insights?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--green)', fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'var(--mono)', marginBottom: 6 }}>KEY INSIGHTS</div>
                      {analysis.key_insights.map((ins, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.55 }}>
                          <span style={{ color: '#16a34a', fontFamily: 'var(--mono)', flexShrink: 0, fontWeight: 700 }}>+</span>
                          <span>{ins}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Risks */}
                  {analysis.risks?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--red)', fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'var(--mono)', marginBottom: 6 }}>RISKS</div>
                      {analysis.risks.map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.55 }}>
                          <span style={{ color: '#dc2626', fontFamily: 'var(--mono)', flexShrink: 0, fontWeight: 700 }}>!</span>
                          <span>{r}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Final take */}
                  {analysis.final_take && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'var(--mono)', marginBottom: 5 }}>FINAL TAKE</div>
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-bright)', lineHeight: 1.65, fontWeight: 500 }}>
                        {analysis.final_take}
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <div style={{ marginTop: 14, fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    Model: {data.model.toUpperCase()}
                    {data.cost_usd > 0 && ` · $${data.cost_usd.toFixed(4)}`}
                    {' · '}Data: Alpha Vantage + Finnhub
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
