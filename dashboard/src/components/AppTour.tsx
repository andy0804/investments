import { Joyride, STATUS } from 'react-joyride'
import type { CallBackProps, Step } from 'react-joyride'

const STEPS: Step[] = [
  {
    target: 'body',
    placement: 'center',
    disableBeacon: true,
    title: 'Welcome to Investment Agent',
    content:
      'Your personal AI-powered portfolio monitor. This quick tour shows you the key features — skip any time with the × button.',
  },
  {
    target: '#header-value',
    placement: 'bottom',
    title: 'Portfolio Value',
    content:
      'Your total portfolio value across both Fidelity accounts, updated every 60 seconds from the backend.',
  },
  {
    target: '#vix-badge',
    placement: 'bottom',
    title: 'VIX — Market Stress Indicator',
    content:
      'The VIX measures market volatility. Green = calm (<15), yellow = normal (15–20), orange = elevated (20–30), red = high (30+). Your risk alerts adjust based on this.',
  },
  {
    target: '#cost-badge',
    placement: 'bottom',
    title: 'Daily AI Cost',
    content:
      'Tracks how much the Anthropic API has spent today. Budget is $0.15/day. Routine scans use cheap Haiku; deep analysis uses Sonnet.',
  },
  {
    target: '#tab-PORTFOLIO',
    placement: 'bottom',
    title: 'Portfolio Tab',
    content:
      'View all your holdings across both accounts with live gain/loss, risk status (stop/target alerts), and sector concentration chart.',
  },
  {
    target: '#tab-SIGNALS',
    placement: 'bottom',
    title: 'Signals Tab',
    content:
      'Claude-generated buy/sell/watch signals with a score out of 10. Click any row to read the full reasoning. Generate a signal for any ticker using the input at the top.',
  },
  {
    target: '#tab-EVENTS',
    placement: 'bottom',
    title: 'Events Tab',
    content:
      'Live feed of geopolitical events (GDELT), SEC filings (EDGAR), and news (RSS). Filter by source. Events are scored 1–10 for portfolio impact.',
  },
  {
    target: '#tab-ANALYSIS',
    placement: 'bottom',
    title: 'Analysis Tab',
    content:
      'Generate a morning brief, deep-dive any ticker with Sonnet, get YTD coaching — and send any brief directly to your Telegram bot.',
  },
  {
    target: '#tab-TRADE-LOG',
    placement: 'bottom',
    title: 'Trade Log Tab',
    content:
      'All logged trades. Use /bought and /sold in Telegram to record trades, or log directly from the Telegram bot commands.',
  },
  {
    target: '#tab-CONFIG',
    placement: 'bottom',
    title: 'Config Tab',
    content:
      'Manage all agent settings: risk thresholds (stop loss, targets), position limits, daily API budget, and Telegram notification preferences. Changes take effect immediately.',
  },
  {
    target: '#tour-btn',
    placement: 'bottom',
    title: 'Replay This Tour',
    content:
      'Click the ? button any time to replay this walkthrough. You can also open the README for a full usage reference.',
  },
]

const JOYRIDE_STYLES = {
  options: {
    backgroundColor: '#1e1e2e',
    textColor: '#e0e0e0',
    primaryColor: '#7eb8ff',
    arrowColor: '#1e1e2e',
    overlayColor: 'rgba(0,0,0,0.65)',
    zIndex: 9000,
  },
  tooltip: {
    borderRadius: 8,
    fontSize: '0.9rem',
  },
  tooltipTitle: {
    color: '#7eb8ff',
    fontSize: '1rem',
    fontWeight: 700,
  },
  buttonNext: {
    backgroundColor: '#7eb8ff',
    color: '#0d0d1a',
    fontWeight: 600,
    borderRadius: 6,
  },
  buttonBack: {
    color: '#888',
  },
  buttonSkip: {
    color: '#666',
  },
}

interface AppTourProps {
  run: boolean
  onTabChange: (tab: string) => void
  onFinish: () => void
}

export default function AppTour({ run, onTabChange: _onTabChange, onFinish }: AppTourProps) {
  const handleCallback = (data: CallBackProps) => {
    const { status } = data
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      localStorage.setItem('tour_done', '1')
      onFinish()
    }
  }

  return (
    <Joyride
      steps={STEPS}
      run={run}
      continuous
      showProgress
      showSkipButton
      scrollToFirstStep
      spotlightClicks={false}
      callback={handleCallback}
      styles={JOYRIDE_STYLES}
      locale={{
        back: 'Back',
        close: '×',
        last: 'Done',
        next: 'Next →',
        skip: 'Skip tour',
      }}
    />
  )
}
