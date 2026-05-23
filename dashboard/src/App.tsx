import { useState, useEffect } from 'react'
import { getMacro, getDailyCost } from './api'
import IntelligenceTab from './tabs/IntelligenceTab'
import PortfolioIntelligenceTab from './tabs/PortfolioIntelligenceTab'
import SignalsTab from './tabs/SignalsTab'
import SchedulesTab from './tabs/SchedulesTab'
import ConfigTab from './tabs/ConfigTab'
import DeepDiveTab from './tabs/DeepDiveTab'
import UniverseTab from './tabs/UniverseTab'
import VirtualPortfolioTab from './tabs/VirtualPortfolioTab'
import StrategyLabTab from './tabs/StrategyLabTab'
import SOTDHistoryTab from './tabs/SOTDHistoryTab'
import DailyDecisionLogTab from './tabs/DailyDecisionLogTab'
import BestBetTab from './tabs/BestBetTab'
import ResearchPage from './pages/ResearchPage'
import './App.css'

// ── Home tabs ─────────────────────────────────────────────────────────────────
const HOME_TABS = [
  'INTELLIGENCE', 'DEEP DIVE', 'BEST BET', 'PICK HISTORY', 'UNIVERSE',
  'PORTFOLIO', 'AI PORTFOLIO', 'DAILY LOG', 'STRATEGY LAB', 'SIGNALS',
  'SCHEDULES', 'CONFIG',
] as const
type HomeTab = typeof HOME_TABS[number]

// ── Top-level pages (sidebar) ─────────────────────────────────────────────────
type Page = 'home' | 'research'

const SIDEBAR_ITEMS: { page: Page; label: string; icon: string }[] = [
  { page: 'home',     label: 'Home',     icon: '⌂' },
  { page: 'research', label: 'Research', icon: '🔬' },
]

export default function App() {
  const [page,      setPage]      = useState<Page>('home')
  const [tab,       setTab]       = useState<HomeTab>('INTELLIGENCE')
  const [visited,   setVisited]   = useState<Set<HomeTab>>(new Set<HomeTab>(['INTELLIGENCE']))
  const [macro,     setMacro]     = useState<any>(null)
  const [dailyCost, setDailyCost] = useState<number>(0)

  useEffect(() => {
    getMacro().then(r => setMacro(r.data.macro)).catch(() => {})
    getDailyCost().then(r => setDailyCost(r.data.today_usd ?? 0)).catch(() => {})
  }, [])

  function handleTabChange(t: HomeTab) {
    setTab(t)
    setVisited(prev => { const s = new Set(prev); s.add(t); return s })
  }

  const regime = (macro?.regime ?? '').toLowerCase()
  const vix    = macro?.vix
  const spy10d = macro?.spy_10d ?? null

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">▲</div>
        {SIDEBAR_ITEMS.map(item => (
          <button
            key={item.page}
            className={`sidebar-item ${page === item.page ? 'active' : ''}`}
            onClick={() => setPage(item.page)}
            title={item.label}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
      </aside>

      {/* ── Main area ── */}
      <div className="app-main">
        {/* ── Bloomberg Header ── */}
        <header className="header">
          <div className="header-left">
            <span className="logo">
              {page === 'research' ? '▲ Research' : '▲ Investment Agent'}
            </span>
            {page === 'home' && macro?.regime && (
              <span className={`hbadge ${regime}`}>{macro.regime} REGIME</span>
            )}
            {page === 'home' && vix != null && (
              <span className={`hbadge ${vix < 20 ? 'bull' : vix < 30 ? 'chop' : 'bear'}`}>
                VIX {vix.toFixed(1)}
              </span>
            )}
            {page === 'home' && spy10d != null && (
              <span className={`hbadge ${spy10d >= 0 ? 'bull' : 'bear'}`}>
                SPY {spy10d >= 0 ? '+' : ''}{spy10d.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="header-right">
            <span className="hbadge neutral" style={{ fontFamily: 'var(--mono)' }}>
              API ${dailyCost.toFixed(3)}/day
            </span>
          </div>
        </header>

        {/* ── Home: tab nav + content ── */}
        {page === 'home' && (
          <>
            <nav className="tabs">
              {HOME_TABS.map(t => (
                <button
                  key={t}
                  className={`tab-btn ${tab === t ? 'active' : ''}`}
                  onClick={() => handleTabChange(t)}
                >
                  {t}
                </button>
              ))}
            </nav>
            <main className="content">
              {visited.has('INTELLIGENCE')  && <div style={{ display: tab === 'INTELLIGENCE'  ? 'contents' : 'none' }}><IntelligenceTab /></div>}
              {visited.has('DEEP DIVE')     && <div style={{ display: tab === 'DEEP DIVE'     ? 'contents' : 'none' }}><DeepDiveTab /></div>}
              {visited.has('BEST BET')      && <div style={{ display: tab === 'BEST BET'      ? 'contents' : 'none' }}><BestBetTab /></div>}
              {visited.has('PICK HISTORY')  && <div style={{ display: tab === 'PICK HISTORY'  ? 'contents' : 'none' }}><SOTDHistoryTab /></div>}
              {visited.has('UNIVERSE')      && <div style={{ display: tab === 'UNIVERSE'      ? 'contents' : 'none' }}><UniverseTab /></div>}
              {visited.has('PORTFOLIO')     && <div style={{ display: tab === 'PORTFOLIO'     ? 'contents' : 'none' }}><PortfolioIntelligenceTab /></div>}
              {visited.has('AI PORTFOLIO')  && <div style={{ display: tab === 'AI PORTFOLIO'  ? 'contents' : 'none' }}><VirtualPortfolioTab /></div>}
              {visited.has('DAILY LOG')     && <div style={{ display: tab === 'DAILY LOG'     ? 'contents' : 'none' }}><DailyDecisionLogTab /></div>}
              {visited.has('STRATEGY LAB')  && <div style={{ display: tab === 'STRATEGY LAB'  ? 'contents' : 'none' }}><StrategyLabTab /></div>}
              {visited.has('SIGNALS')       && <div style={{ display: tab === 'SIGNALS'       ? 'contents' : 'none' }}><SignalsTab /></div>}
              {visited.has('SCHEDULES')     && <div style={{ display: tab === 'SCHEDULES'     ? 'contents' : 'none' }}><SchedulesTab /></div>}
              {visited.has('CONFIG')        && <div style={{ display: tab === 'CONFIG'        ? 'contents' : 'none' }}><ConfigTab /></div>}
            </main>
          </>
        )}

        {/* ── Research page ── */}
        {page === 'research' && (
          <main className="content research-content">
            <ResearchPage />
          </main>
        )}
      </div>
    </div>
  )
}
