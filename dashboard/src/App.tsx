import { useState, useEffect } from 'react'
import { clsx } from 'clsx'
import { getMacro, getDailyCost } from './api'
import IntelligenceTab from './tabs/IntelligenceTab'
import PortfolioIntelligenceTab from './tabs/PortfolioIntelligenceTab'
import SchedulesTab from './tabs/SchedulesTab'
import ConfigTab from './tabs/ConfigTab'
import DeepDiveTab from './tabs/DeepDiveTab'
import UniverseTab from './tabs/UniverseTab'
import VirtualPortfolioTab from './tabs/VirtualPortfolioTab'
import SOTDHistoryTab from './tabs/SOTDHistoryTab'
import PickLabTab from './tabs/PickLabTab'
import BestBetTab from './tabs/BestBetTab'
import AlphaLabTab from './tabs/AlphaLabTab'
import ResearchPage from './pages/ResearchPage'
import OptionsDeskPage from './pages/OptionsDeskPage'
import './App.css'

// ── Types ─────────────────────────────────────────────────────────────────────
type NavId =
  | 'intelligence' | 'deep-dive' | 'best-bet' | 'pick-history' | 'pick-lab' | 'universe'
  | 'portfolio'    | 'ai-portfolio'
  | 'options-desk' | 'schedules' | 'config'
  | 'research'     | 'alpha-agent' | 'alpha-lab'

interface NavItem   { id: NavId; label: string; badge?: string }
interface NavSection { title: string; items: NavItem[] }

// ── Navigation ────────────────────────────────────────────────────────────────
const NAV: NavSection[] = [
  {
    title: 'Intelligence',
    items: [
      { id: 'intelligence',  label: 'Dashboard'    },
      { id: 'best-bet',      label: 'Best Ideas',  badge: 'AI' },
      { id: 'deep-dive',     label: 'Deep Dive'    },
      { id: 'universe',      label: 'Universe'     },
      { id: 'research',      label: 'Research'     },
    ],
  },
  {
    title: 'Portfolio',
    items: [
      { id: 'portfolio',     label: 'Portfolio'    },
      { id: 'ai-portfolio',  label: 'AI Portfolio', badge: 'AI' },
      { id: 'pick-history',  label: 'History'      },
      { id: 'pick-lab',      label: 'Pick Lab'     },
    ],
  },
  {
    title: 'Alpha',
    items: [
      { id: 'alpha-agent',   label: 'Alpha Agent',  badge: 'AI' },
      { id: 'alpha-lab',     label: 'Alpha Lab',    badge: 'NEW' },
    ],
  },
  {
    title: 'Trading',
    items: [
      { id: 'options-desk',  label: 'Options Desk' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'schedules',     label: 'Schedules'    },
      { id: 'config',        label: 'Settings'     },
    ],
  },
]

// ── Icons (Lucide-style, 16px viewBox) ────────────────────────────────────────
const IC: Record<NavId, React.FC<{ className?: string }>> = {
  'intelligence':  p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z"/></svg>,
  'best-bet':      p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"/></svg>,
  'deep-dive':     p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>,
  'pick-history':  p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>,
  'pick-lab':      p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.893.384a2.25 2.25 0 011.357 2.059V19.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 19.5v-1.607a2.25 2.25 0 011.357-2.059l.893-.384a2.25 2.25 0 001.357-2.059V8.818m5.143-5.714a24.302 24.302 0 00-4.5 0"/></svg>,
  'alpha-lab':     p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"/></svg>,
  'universe':      p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><circle cx="12" cy="12" r="9"/><path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>,
  'portfolio':     p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75"/></svg>,
  'ai-portfolio':  p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/><path strokeLinecap="round" strokeLinejoin="round" d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>,
  'schedules':     p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>,
  'config':        p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>,
  'research':      p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/></svg>,
  'options-desk':  p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/></svg>,
  'alpha-agent':   p => <svg {...p} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>,
}

// ── Sidebar component ─────────────────────────────────────────────────────────
function Sidebar({ active, onNavigate, dailyCost, collapsed, onToggle }: {
  active: NavId
  onNavigate: (id: NavId) => void
  dailyCost: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <aside
      style={{
        width: collapsed ? 60 : 260,
        background: '#081225',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        transition: 'width 180ms cubic-bezier(0.4,0,0.2,1)',
      }}
      className="flex flex-col h-screen sticky top-0 shrink-0 overflow-hidden z-30"
    >
      {/* Brand */}
      <div
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', minHeight: 52 }}
        className={clsx('flex items-center shrink-0', collapsed ? 'justify-center px-0 py-3' : 'px-4 py-3 gap-2.5')}
      >
        <div
          style={{ background: '#1d4ed8', boxShadow: '0 0 12px rgba(59,130,246,0.4)' }}
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
        >
          <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/>
          </svg>
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p style={{ color: '#f8fafc', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              Investment Agent
            </p>
            <p style={{ color: '#475569', fontSize: 10, lineHeight: 1.2, marginTop: 1 }}>AI Research Platform</p>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={onToggle}
            style={{ color: '#475569' }}
            className="shrink-0 p-1 rounded hover:bg-white/5 transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/>
            </svg>
          </button>
        )}
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto py-3" style={{ scrollbarWidth: 'none' }}>
        {NAV.map((section, si) => (
          <div key={section.title} className={clsx(si > 0 && 'mt-4')}>
            {/* Section header */}
            {!collapsed && (
              <p style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'rgba(148,163,184,0.5)',
                padding: '0 14px',
                marginBottom: 4,
              }}>
                {section.title}
              </p>
            )}
            {collapsed && si > 0 && (
              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '8px 10px' }} />
            )}

            {/* Items */}
            {section.items.map(({ id, label, badge }) => {
              const Icon = IC[id]
              const isActive = active === id
              return (
                <button
                  key={id}
                  onClick={() => onNavigate(id)}
                  title={collapsed ? label : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: collapsed ? '9px 0' : '8px 10px 8px 12px',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    gap: collapsed ? 0 : 9,
                    borderRadius: 6,
                    margin: '1px 6px',
                    width: 'calc(100% - 12px)',
                    cursor: 'pointer',
                    transition: 'all 150ms ease',
                    position: 'relative',
                    // Active left bar
                    borderLeft: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                    paddingLeft: isActive && !collapsed ? 10 : (collapsed ? 0 : 12),
                    background: isActive ? 'rgba(59,130,246,0.1)' : 'transparent',
                    color: isActive ? '#f8fafc' : '#94a3b8',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'
                      ;(e.currentTarget as HTMLButtonElement).style.color = '#cbd5e1'
                      ;(e.currentTarget as HTMLButtonElement).style.transform = collapsed ? '' : 'translateX(2px)'
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                      ;(e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'
                      ;(e.currentTarget as HTMLButtonElement).style.transform = ''
                    }
                  }}
                >
                  <Icon className="w-4 h-4 shrink-0 flex-none" />
                  {!collapsed && (
                    <>
                      <span style={{ fontSize: 13, fontWeight: isActive ? 500 : 400, flex: 1, textAlign: 'left', letterSpacing: '-0.01em' }}>
                        {label}
                      </span>
                      {badge && (
                        <span style={{
                          fontSize: 9,
                          fontWeight: 600,
                          letterSpacing: '0.05em',
                          padding: '2px 5px',
                          borderRadius: 4,
                          background: badge === 'AI' ? 'rgba(59,130,246,0.2)' : 'rgba(148,163,184,0.15)',
                          color: badge === 'AI' ? '#60a5fa' : '#94a3b8',
                          lineHeight: 1.4,
                        }}>
                          {badge}
                        </span>
                      )}
                    </>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: collapsed ? '10px 0' : '10px 14px' }}
        className={clsx('shrink-0', collapsed && 'flex justify-center')}
      >
        {collapsed ? (
          <button onClick={onToggle} style={{ color: '#475569' }} className="p-1.5 rounded hover:bg-white/5 transition-colors">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
            </svg>
          </button>
        ) : (
          <div className="flex items-center gap-2.5">
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>IA</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 500, color: '#cbd5e1', lineHeight: 1.2 }}>Portfolio AI</p>
              <p style={{ fontSize: 10, color: '#475569', lineHeight: 1.2, marginTop: 1, fontFamily: 'monospace' }}>${dailyCost.toFixed(3)}/day</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [active,         setActive]         = useState<NavId>('intelligence')
  const [visited,        setVisited]        = useState<Set<NavId>>(new Set(['intelligence']))
  const [collapsed,      setCollapsed]      = useState(false)
  const [macro,          setMacro]          = useState<any>(null)
  const [dailyCost,      setDailyCost]      = useState<number>(0)
  const [deepDiveTicker, setDeepDiveTicker] = useState('')
  const [deepDiveSeq,    setDeepDiveSeq]    = useState(0)

  function openInDeepDive(ticker: string) {
    setDeepDiveTicker(ticker)
    setDeepDiveSeq(s => s + 1)
    setVisited(prev => { const s = new Set(prev); s.add('intelligence'); return s })
    setActive('intelligence')
  }

  useEffect(() => {
    getMacro().then(r => setMacro(r.data.macro)).catch(() => {})
    getDailyCost().then(r => setDailyCost(r.data.today_usd ?? 0)).catch(() => {})
  }, [])

  function navigate(id: NavId) {
    if (id === 'alpha-agent') { window.location.href = '/alpha-agent'; return }
    setActive(id)
    setVisited(prev => { const s = new Set(prev); s.add(id); return s })
  }

  const regime  = (macro?.regime ?? '').toLowerCase()
  const vix     = macro?.vix
  const spy10d  = macro?.spy_10d ?? null
  const section = NAV.find(s => s.items.some(i => i.id === active))
  const label   = section?.items.find(i => i.id === active)?.label ?? ''

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#07101F' }}>
      <Sidebar
        active={active}
        onNavigate={navigate}
        dailyCost={dailyCost}
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
      />

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Topbar */}
        <header className="flex items-center justify-between h-[52px] min-h-[52px] shrink-0 px-5"
          style={{ background: '#0C1A2E', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2">
            <span style={{ color: '#475569', fontSize: 12 }}>{section?.title}</span>
            <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 12 }}>/</span>
            <span style={{ color: '#F1F5F9', fontSize: 13, fontWeight: 600 }}>{label}</span>

            {macro?.regime && (
              <span style={{
                marginLeft: 4, display: 'inline-flex', alignItems: 'center',
                padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                background: regime === 'bull' ? 'rgba(34,197,94,0.15)' : regime === 'bear' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                color: regime === 'bull' ? '#4ADE80' : regime === 'bear' ? '#F87171' : '#FBBF24',
              }}>{macro.regime}</span>
            )}
            {vix != null && (
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                background: vix < 20 ? 'rgba(34,197,94,0.15)' : vix < 30 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                color: vix < 20 ? '#4ADE80' : vix < 30 ? '#FBBF24' : '#F87171',
              }}>VIX {vix.toFixed(1)}</span>
            )}
            {spy10d != null && (
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                background: spy10d >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: spy10d >= 0 ? '#4ADE80' : '#F87171',
              }}>SPY {spy10d >= 0 ? '+' : ''}{spy10d.toFixed(1)}%</span>
            )}
          </div>
          <span style={{
            fontSize: 10, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 5,
            color: '#475569', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
          }}>
            API ${dailyCost.toFixed(3)}/day
          </span>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-hidden" style={{ background: '#07101F' }}>
          {visited.has('intelligence')  && <div className={clsx('h-full overflow-y-auto', active !== 'intelligence'  && 'hidden')} style={{ background: '#07101F' }}><IntelligenceTab onGoToConfig={() => setActive('config')} prefillTicker={deepDiveTicker} prefillSeq={deepDiveSeq} /></div>}
          {visited.has('deep-dive')     && <div className={clsx('h-full overflow-y-auto', active !== 'deep-dive'     && 'hidden')} style={{ background: '#07101F' }}><div className="content"><DeepDiveTab prefillTicker={deepDiveTicker} prefillSeq={deepDiveSeq} /></div></div>}
          {visited.has('best-bet')      && <div className={clsx('h-full overflow-y-auto', active !== 'best-bet'      && 'hidden')} style={{ background: '#07101F' }}><div className="content"><BestBetTab /></div></div>}
          {visited.has('pick-history')  && <div className={clsx('h-full overflow-y-auto', active !== 'pick-history'  && 'hidden')} style={{ background: '#07101F' }}><div className="content"><SOTDHistoryTab /></div></div>}
          {visited.has('pick-lab')      && <div className={clsx('h-full overflow-y-auto', active !== 'pick-lab'      && 'hidden')} style={{ background: '#07101F' }}><div className="content"><PickLabTab onDeepDive={openInDeepDive} /></div></div>}
          {visited.has('alpha-lab')     && <div className={clsx('h-full overflow-hidden',  active !== 'alpha-lab'     && 'hidden')} style={{ background: '#07101F' }}><AlphaLabTab onOpenDashboard={openInDeepDive} /></div>}
          {visited.has('universe')      && <div className={clsx('h-full overflow-y-auto', active !== 'universe'      && 'hidden')} style={{ background: '#07101F' }}><div className="content"><UniverseTab /></div></div>}
          {visited.has('portfolio')     && <div className={clsx('h-full overflow-y-auto', active !== 'portfolio'     && 'hidden')} style={{ background: '#07101F' }}><div className="content"><PortfolioIntelligenceTab /></div></div>}
          {visited.has('ai-portfolio')  && <div className={clsx('h-full overflow-y-auto', active !== 'ai-portfolio'  && 'hidden')} style={{ background: '#07101F' }}><div className="content"><VirtualPortfolioTab /></div></div>}
          {visited.has('schedules')     && <div className={clsx('h-full overflow-y-auto', active !== 'schedules'     && 'hidden')} style={{ background: '#07101F' }}><div className="content"><SchedulesTab /></div></div>}
          {visited.has('config')        && <div className={clsx('h-full overflow-y-auto', active !== 'config'        && 'hidden')} style={{ background: '#07101F' }}><div className="content"><ConfigTab /></div></div>}
          {visited.has('research')      && <div className={clsx('h-full overflow-hidden',  active !== 'research'      && 'hidden')} style={{ background: '#07101F' }}><div className="research-content h-full"><ResearchPage /></div></div>}
          {visited.has('options-desk')  && <div className={clsx('h-full overflow-hidden flex flex-col', active !== 'options-desk' && 'hidden')} style={{ background: '#07101F' }}><OptionsDeskPage /></div>}
        </main>
      </div>
    </div>
  )
}
