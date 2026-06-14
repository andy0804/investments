export default function LiveBadge({ label = 'LIVE' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      {label}
    </span>
  )
}
