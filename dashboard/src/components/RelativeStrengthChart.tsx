import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { getPriceHistory } from '../api'

interface RSPoint {
  label: string
  stock: number
  spy: number
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const stock = payload.find((p: any) => p.dataKey === 'stock')?.value
  const spy   = payload.find((p: any) => p.dataKey === 'spy')?.value
  return (
    <div style={{
      background: '#0d1117', border: '1px solid #1e293b', borderRadius: 3,
      padding: '6px 10px', fontSize: '0.72rem', fontFamily: 'monospace',
    }}>
      <div style={{ color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      {stock != null && <div style={{ color: '#00d084' }}>{payload[0]?.name ?? 'Stock'}  <b>{stock >= 0 ? '+' : ''}{stock.toFixed(1)}%</b></div>}
      {spy   != null && <div style={{ color: '#475569' }}>SPY   <b>{spy >= 0 ? '+' : ''}{spy.toFixed(1)}%</b></div>}
    </div>
  )
}

interface Props {
  symbol: string
  days?: number
  height?: number
}

export default function RelativeStrengthChart({ symbol, days = 30, height = 150 }: Props) {
  const [chartData, setChartData] = useState<RSPoint[]>([])
  const [alpha, setAlpha]         = useState<number | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(false)

  useEffect(() => {
    setLoading(true); setError(false)
    Promise.all([
      getPriceHistory(symbol, days),
      getPriceHistory('SPY', days),
    ])
      .then(([stockRes, spyRes]) => {
        const stockBars: { date: string; close: number }[] = stockRes.data.data
        const spyBars:   { date: string; close: number }[] = spyRes.data.data

        if (!stockBars?.length || !spyBars?.length) { setError(true); setLoading(false); return }

        // Build a date → close map for SPY
        const spyMap: Record<string, number> = {}
        for (const b of spyBars) spyMap[b.date] = b.close

        // Find common start (use first close of stock as base)
        const stockBase = stockBars[0].close
        const spyBase   = spyMap[stockBars[0].date] ?? spyBars[0].close

        const points: RSPoint[] = []
        for (const b of stockBars) {
          const spyClose = spyMap[b.date]
          if (spyClose == null) continue
          points.push({
            label: b.date.slice(5),
            stock: +((b.close / stockBase - 1) * 100).toFixed(2),
            spy:   +((spyClose / spyBase - 1) * 100).toFixed(2),
          })
        }

        setChartData(points)
        if (points.length > 0) {
          const last = points[points.length - 1]
          setAlpha(+(last.stock - last.spy).toFixed(1))
        }
        setLoading(false)
      })
      .catch(() => { setError(true); setLoading(false) })
  }, [symbol, days])

  if (loading) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: '0.75rem' }}>
      Loading…
    </div>
  )
  if (error || !chartData.length) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: '0.75rem' }}>
      Chart unavailable
    </div>
  )

  const tickInterval = Math.floor(chartData.length / 5)
  const allVals = chartData.flatMap(d => [d.stock, d.spy])
  const minY = Math.min(...allVals) - 1
  const maxY = Math.max(...allVals) + 1
  const alphaColor = alpha != null ? (alpha >= 0 ? '#00d084' : '#ff4757') : '#94a3b8'

  return (
    <div>
      <div style={{ display: 'flex', gap: 14, marginBottom: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <div style={{ width: 14, height: 2, background: '#00d084', borderRadius: 1 }} />
          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontFamily: 'monospace' }}>{symbol}</span>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <div style={{ width: 14, height: 2, background: '#475569', borderRadius: 1 }} />
          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontFamily: 'monospace' }}>SPY</span>
        </div>
        {alpha != null && (
          <span style={{ marginLeft: 'auto', fontSize: '0.72rem', fontFamily: 'monospace', color: alphaColor, fontWeight: 700 }}>
            Alpha {alpha >= 0 ? '+' : ''}{alpha}%
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#475569', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false} tickLine={false}
            interval={tickInterval}
          />
          <YAxis
            tick={{ fill: '#475569', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={false} tickLine={false}
            width={44}
            domain={[minY, maxY]}
            tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="#1e293b" strokeDasharray="4 4" />
          <Line
            name={symbol}
            dataKey="stock"
            stroke="#00d084"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: '#00d084' }}
          />
          <Line
            name="SPY"
            dataKey="spy"
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 2, fill: '#475569' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
