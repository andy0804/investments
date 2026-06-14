export type AlphaNavId =
  | 'decision-center'
  | 'trade-queue'
  | 'portfolio'
  | 'trade-journal'
  | 'lessons-learned'
  | 'market-overview'
  | 'agent-memory'
  | 'settings'

interface NavItem { id: AlphaNavId; label: string }

const NAV_ITEMS: NavItem[] = [
  { id: 'decision-center',  label: 'Decision Center'  },
  { id: 'trade-queue',      label: 'Trade Queue'      },
  { id: 'portfolio',        label: 'Portfolio'         },
  { id: 'trade-journal',    label: 'Trade Journal'    },
  { id: 'lessons-learned',  label: 'Lessons Learned'  },
  { id: 'market-overview',  label: 'Market Overview'  },
  { id: 'agent-memory',     label: 'Agent Memory'     },
  { id: 'settings',         label: 'Settings'          },
]

interface Props {
  active: AlphaNavId
  onNavigate: (id: AlphaNavId) => void
  queueCount: number
  pendingLessons: number
  isOn: boolean
}

export default function AlphaInternalNav({ active, onNavigate, queueCount, pendingLessons, isOn }: Props) {
  const badges: Partial<Record<AlphaNavId, number>> = {
    'trade-queue':     queueCount,
    'lessons-learned': pendingLessons,
  }

  return (
    <aside style={{
      width: 220,
      background: '#081225',
      borderRight: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      flexShrink: 0,
      overflowY: 'auto',
    }}>
      {/* Brand row */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: '#7c3aed',
          boxShadow: '0 0 12px rgba(124,58,237,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
          </svg>
        </div>
        <div>
          <div style={{ color: '#f8fafc', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
            Alpha Agent
          </div>
          <div style={{ color: '#475569', fontSize: 10, lineHeight: 1.2, marginTop: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
            Paper trading
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
              background: isOn ? 'rgba(34,197,94,0.15)' : 'rgba(100,116,139,0.15)',
              color: isOn ? '#22c55e' : '#64748b',
              letterSpacing: '0.05em',
            }}>
              {isOn ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav style={{ flex: 1, padding: '8px 0' }}>
        {NAV_ITEMS.map(({ id, label }) => {
          const isActive = active === id
          const badge = badges[id]
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 10px 8px 12px',
                gap: 9,
                borderRadius: 6,
                margin: '1px 6px',
                width: 'calc(100% - 12px)',
                cursor: 'pointer',
                transition: 'all 150ms ease',
                borderLeft: isActive ? '2px solid #7c3aed' : '2px solid transparent',
                paddingLeft: isActive ? 10 : 12,
                background: isActive ? 'rgba(124,58,237,0.12)' : 'transparent',
                color: isActive ? '#f8fafc' : '#94a3b8',
                border: 'none',
                textAlign: 'left',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                  e.currentTarget.style.color = '#cbd5e1'
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = '#94a3b8'
                }
              }}
            >
              <span style={{ fontSize: 13, fontWeight: isActive ? 500 : 400, flex: 1, letterSpacing: '-0.01em' }}>
                {label}
              </span>
              {badge != null && badge > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
                  background: '#7c3aed', color: '#fff', lineHeight: 1.5, minWidth: 18, textAlign: 'center',
                }}>
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Regime widget */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <RegimeIndicator />
      </div>
    </aside>
  )
}

function RegimeIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: '#64748b' }}>Market regime</span>
    </div>
  )
}
