import { useEffect, useState } from 'react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceArea,
} from 'recharts'
import { getPriceHistory } from '../api'

interface PriceBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ChartRow extends PriceBar {
  label: string
  sma20: number | null
  sma50: number | null
}

interface MiniChartProps {
  symbol: string
  days?: number
  height?: number
  entryZone?: { low: number; high: number } | null
}

function sma(closes: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null
  const slice = closes.slice(idx - period + 1, idx + 1)
  return slice.reduce((a, b) => a + b, 0) / period
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const close  = payload.find((p: any) => p.dataKey === 'close')?.value
  const volume = payload.find((p: any) => p.dataKey === 'volume')?.value
  const s20    = payload.find((p: any) => p.dataKey === 'sma20')?.value
  const s50    = payload.find((p: any) => p.dataKey === 'sma50')?.value
  return (
    <div style={{
      background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 6,
      padding: '6px 10px', fontSize: '0.72rem', fontFamily: 'monospace',
      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    }}>
      <div style={{ color: '#6b7280', marginBottom: 2 }}>{label}</div>
      {close  != null && <div style={{ color: '#111827' }}>Close  <b>${close.toFixed(2)}</b></div>}
      {s20    != null && <div style={{ color: '#d97706' }}>SMA20  <b>${s20.toFixed(2)}</b></div>}
      {s50    != null && <div style={{ color: '#7c3aed' }}>SMA50  <b>${s50.toFixed(2)}</b></div>}
      {volume != null && <div style={{ color: '#9ca3af' }}>Vol    <b>{(volume / 1_000_000).toFixed(2)}M</b></div>}
    </div>
  )
}

export default function MiniChart({ symbol, days = 30, height = 160, entryZone }: MiniChartProps) {
  const [data, setData] = useState<ChartRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setLoading(true); setError(false)
    // Fetch extra history so SMA50 has data at the start of the display window
    const fetchDays = Math.max(days + 55, 90)
    getPriceHistory(symbol, fetchDays)
      .then(r => {
        const raw: PriceBar[] = r.data.data
        const closes = raw.map(d => d.close)
        const withSma: ChartRow[] = raw.map((d, i) => ({
          ...d,
          label: d.date.slice(5),
          sma20: sma(closes, 20, i),
          sma50: sma(closes, 50, i),
        }))
        // Only show requested days in the view
        setData(withSma.slice(-days))
        setLoading(false)
      })
      .catch(() => { setError(true); setLoading(false) })
  }, [symbol, days])

  if (loading) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '0.75rem' }}>
      Loading chart…
    </div>
  )
  if (error || !data.length) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '0.75rem' }}>
      Chart unavailable
    </div>
  )

  const closes    = data.map(d => d.close)
  const sma20s    = data.map(d => d.sma20).filter(v => v != null) as number[]
  const sma50s    = data.map(d => d.sma50).filter(v => v != null) as number[]
  const allPrices = [...closes, ...sma20s, ...sma50s]
  if (entryZone) { allPrices.push(entryZone.low, entryZone.high) }
  const minY = Math.min(...allPrices) * 0.985
  const maxY = Math.max(...allPrices) * 1.015
  const maxVol = Math.max(...data.map(d => d.volume))
  const lineColor = closes[closes.length - 1] >= closes[0] ? '#16a34a' : '#dc2626'
  const tickInterval = Math.floor(data.length / 5)

  return (
    <div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: '0.6rem', color: '#6b7280', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
          <span style={{ width: 14, height: 1.5, background: lineColor, display: 'inline-block' }} />PRICE
        </span>
        <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: '0.6rem', color: '#6b7280', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
          <span style={{ width: 14, height: 1, background: '#d97706', display: 'inline-block' }} />SMA20
        </span>
        <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: '0.6rem', color: '#6b7280', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
          <span style={{ width: 14, height: 1, background: '#7c3aed', display: 'inline-block' }} />SMA50
        </span>
        {entryZone && (
          <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: '0.6rem', color: '#6b7280', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            <span style={{ width: 10, height: 8, background: '#dbeafe', border: '1px solid #93c5fd', display: 'inline-block', borderRadius: 1 }} />ENTRY
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="#f1f5f9" vertical={false} strokeOpacity={1} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }}
            axisLine={false} tickLine={false}
            interval={tickInterval}
          />
          <YAxis
            yAxisId="price"
            domain={[minY, maxY]}
            tick={{ fill: '#9ca3af', fontSize: 9, fontFamily: 'monospace' }}
            axisLine={false} tickLine={false}
            width={48}
            tickFormatter={v => `$${v.toFixed(0)}`}
          />
          <YAxis yAxisId="vol" orientation="right" domain={[0, maxVol * 4]} hide />
          <Tooltip content={<CustomTooltip />} />

          {entryZone && (
            <ReferenceArea
              yAxisId="price"
              y1={entryZone.low}
              y2={entryZone.high}
              fill="#dbeafe"
              fillOpacity={0.5}
              stroke="#93c5fd"
              strokeOpacity={0.8}
              strokeDasharray="3 4"
            />
          )}

          <Bar yAxisId="vol" dataKey="volume" fill="#e5e7eb" opacity={0.8} radius={[1, 1, 0, 0]} />
          <Line yAxisId="price" dataKey="sma50" stroke="#7c3aed" strokeWidth={0.75} dot={false} strokeDasharray="4 3" connectNulls strokeOpacity={0.7} />
          <Line yAxisId="price" dataKey="sma20" stroke="#d97706" strokeWidth={0.75} dot={false} connectNulls strokeOpacity={0.8} />
          <Line yAxisId="price" dataKey="close" stroke={lineColor} strokeWidth={1.5} dot={false} activeDot={{ r: 2, fill: lineColor, strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
