interface Props { value: number; size?: number }

export default function ConfidenceGauge({ value, size = 80 }: Props) {
  const r = (size / 2) * 0.75
  const cx = size / 2
  const cy = size / 2
  const circumference = Math.PI * r          // semicircle
  const filled = (value / 100) * circumference
  const color = value >= 75 ? '#10b981' : value >= 55 ? '#f59e0b' : '#ef4444'

  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width={size} height={size / 2 + 8} style={{ overflow: 'visible' }}>
        {/* background arc */}
        <path
          d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
          fill="none" stroke="#1e293b" strokeWidth={8} strokeLinecap="round"
        />
        {/* filled arc */}
        <path
          d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
          fill="none" stroke={color} strokeWidth={8} strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      <span className="text-sm font-bold" style={{ color }}>{value}%</span>
    </div>
  )
}
