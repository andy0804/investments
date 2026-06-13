interface ScoreGaugeProps {
  score: number
  size?: number
}

export default function ScoreGauge({ score, size = 110 }: ScoreGaugeProps) {
  const cx = 50, cy = 56, r = 42

  const color   = score >= 85 ? '#16a34a' : score >= 75 ? '#2563eb' : score >= 65 ? '#d97706' : '#9ca3af'
  const trackBg = 'rgba(255,255,255,0.07)'

  const toRad = (deg: number) => (deg * Math.PI) / 180

  const bgPath = `M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`

  let filledPath = ''
  if (score > 0) {
    if (score >= 100) {
      filledPath = bgPath
    } else {
      const endAngle = 180 + (score / 100) * 180
      const ex = cx + r * Math.cos(toRad(endAngle))
      const ey = cy + r * Math.sin(toRad(endAngle))
      filledPath = `M ${cx - r},${cy} A ${r},${r} 0 0,1 ${ex.toFixed(2)},${ey.toFixed(2)}`
    }
  }

  return (
    <svg
      viewBox="0 0 100 64"
      width={size}
      height={size * 0.64}
      style={{ overflow: 'visible' }}
    >
      {/* Track */}
      <path d={bgPath} fill="none" stroke={trackBg} strokeWidth={9} strokeLinecap="round" />
      {/* Fill */}
      {filledPath && (
        <path d={filledPath} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round"
          strokeOpacity={score < 65 ? 0.5 : 1}
        />
      )}
      {/* Score number */}
      <text
        x={cx} y={cy - 6}
        textAnchor="middle" dominantBaseline="middle"
        fill={color} fontSize={20} fontWeight="800"
        fontFamily="'JetBrains Mono', 'Fira Code', monospace"
        fillOpacity={score < 65 ? 0.6 : 1}
      >
        {score}
      </text>
      <text
        x={cx} y={cy + 10}
        textAnchor="middle"
        fill="#9ca3af" fontSize={8}
        fontFamily="'JetBrains Mono', monospace"
      >
        / 100
      </text>
      {/* Tier label below score */}
      <text
        x={cx} y={cy + 22}
        textAnchor="middle"
        fill={color} fontSize={6} fontWeight="700"
        fontFamily="'JetBrains Mono', monospace"
        fillOpacity={score < 65 ? 0.4 : 0.8}
        letterSpacing="0.5"
      >
        {score >= 85 ? 'HIGH' : score >= 75 ? 'MED-HIGH' : score >= 65 ? 'WATCHLIST' : 'LOW'}
      </text>
    </svg>
  )
}
