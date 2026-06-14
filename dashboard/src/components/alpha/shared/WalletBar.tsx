interface Props {
  totalValue: number
  cash: number
  dailyCost: number
  monthlyCost: number
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function WalletBar({ totalValue, cash, dailyCost, monthlyCost }: Props) {
  const invested = totalValue - cash
  const pnlPct = ((totalValue - 10000) / 10000 * 100)
  const pnlPos = pnlPct >= 0

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 24,
      padding: '0 20px',
      height: 40,
      background: 'transparent',
      fontSize: 13,
      color: '#94a3b8',
    }}>
      <span style={{ color: '#64748b', fontSize: 12 }}>Paper Capital</span>
      <span style={{ color: '#f1f5f9', fontWeight: 600 }}>${fmt(totalValue)}</span>
      <span style={{ color: pnlPos ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
        {pnlPos ? '+' : ''}{pnlPct.toFixed(1)}%
      </span>

      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)' }} />

      <span style={{ color: '#64748b', fontSize: 12 }}>Cash</span>
      <span style={{ color: '#f1f5f9', fontWeight: 500 }}>${fmt(cash)}</span>

      <span style={{ color: '#64748b', fontSize: 12 }}>Invested</span>
      <span style={{ color: '#f1f5f9', fontWeight: 500 }}>${fmt(invested)}</span>

      <div style={{ flex: 1 }} />

      <span style={{ color: '#64748b', fontSize: 12 }}>API today</span>
      <span style={{
        color: dailyCost > 0.10 ? '#f59e0b' : '#22c55e',
        fontWeight: 600, fontFamily: 'var(--mono)',
      }}>${dailyCost.toFixed(4)}</span>

      <span style={{ color: '#64748b', fontSize: 12 }}>This month</span>
      <span style={{
        color: monthlyCost > 1.5 ? '#f59e0b' : '#94a3b8',
        fontWeight: 500, fontFamily: 'var(--mono)',
      }}>${monthlyCost.toFixed(3)}</span>
    </div>
  )
}
