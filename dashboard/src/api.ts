import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export const getHealth          = () => api.get('/health')
export const getPortfolioSummary = () => api.get('/portfolio/summary')
export const getMacro           = () => api.get('/macro')
export const getSignals         = (limit = 20) => api.get(`/signals?limit=${limit}`)
export const getRisk            = () => api.get('/risk')
export const getDailyCost       = () => api.get('/analysis/daily-cost')
export const reloadCSV          = () => api.post('/portfolio/reload-csv')
export const postSignal         = (symbol: string) => api.post(`/analysis/signal?symbol=${symbol}`)
export const getConfig          = () => api.get('/config')
export const putConfig          = (updates: Record<string, string>) => api.put('/config', updates)

// V2 SOTD pipeline
export const getSotdFull        = (forceRefresh = false) =>
  api.get(`/analysis/sotd/full${forceRefresh ? '?force_refresh=true' : ''}`)

export const getSotdHistory     = () => api.get('/analysis/sotd/history')
export const getSotdRepeatHits  = () => api.get('/analysis/sotd/repeat-hits')

// Price history for mini chart
export const getPriceHistory    = (symbol: string, days = 30) =>
  api.get(`/analysis/price-history/${symbol}?days=${days}`)

// Portfolio intelligence
export const getPortfolioIntelligence = () => api.get('/analysis/portfolio-intelligence')

// Scheduler
export const getSchedules       = () => api.get('/scheduler/schedules')
export const toggleSchedule     = (jobId: string) => api.put(`/scheduler/schedules/${jobId}/toggle`)
export const runJobNow          = (jobId: string) => api.post(`/scheduler/schedules/${jobId}/run-now`)
export const deleteSchedule     = (jobId: string) => api.delete(`/scheduler/schedules/${jobId}`)

// Signal outcomes (feedback loop)
export const getSignalOutcomes  = () => api.get('/performance/signal-outcomes')
export const computeOutcomes    = () => api.post('/performance/compute-outcomes')

// Reinforcement / self-improvement
export const getPerformanceSeries      = () => api.get('/performance/series')
export const getAttribution            = () => api.get('/performance/attribution')
export const getCorrectionProposals    = (status = 'all') => api.get(`/performance/correction-proposals?proposal_status=${status}`)
export const generateProposals         = () => api.post('/performance/correction-proposals/generate')
export const approveProposal           = (id: number) => api.post(`/performance/correction-proposals/${id}/approve`)
export const rejectProposal            = (id: number, reason = '') => api.post(`/performance/correction-proposals/${id}/reject?reason=${encodeURIComponent(reason)}`)

// Deep Dive
export const runDeepDive        = (symbol: string, save = false) => api.post(`/analysis/deep-dive?symbol=${symbol}&save=${save}`)
export const saveDeepDive       = (id: number) => api.post(`/analysis/deep-dive/${id}/save`)
export const getSavedDeepDives  = () => api.get('/analysis/deep-dive/saved')
export const getSavedDeepDive   = (id: number) => api.get(`/analysis/deep-dive/saved/${id}`)

// Filter presets
export const getFilterPresets   = () => api.get('/config/filter-presets')
export const getActivePreset    = () => api.get('/config/filter-presets/active')
export const createFilterPreset = (data: Record<string, any>) => api.post('/config/filter-presets', data)
export const activatePreset     = (id: number) => api.put(`/config/filter-presets/${id}/activate`)
export const updateFilterPreset = (id: number, data: Record<string, any>) => api.put(`/config/filter-presets/${id}`, data)
export const deleteFilterPreset = (id: number) => api.delete(`/config/filter-presets/${id}`)

// Schedule builder
export const createSchedule      = (data: Record<string, any>) => api.post('/scheduler/schedules', data)
export const updateSchedule      = (jobId: string, data: Record<string, any>) => api.put(`/scheduler/schedules/${jobId}`, data)
export const setScheduleTelegram = (jobId: string, enabled: boolean) => api.put(`/scheduler/schedules/${jobId}`, { telegram_enabled: enabled ? 1 : 0 })

// Top Performers
export const getTopPerformers   = () => api.get('/analysis/top-performers')

// Live market quotes
export const getMarketQuotes    = (symbols: string) => api.get(`/market/quotes?symbols=${symbols}`)

// Virtual Portfolio
export const getVirtualSummary    = () => api.get('/virtual/summary')
export const getVirtualPositions  = () => api.get('/virtual/positions')
export const getVirtualTrades     = (limit = 50) => api.get(`/virtual/trades?limit=${limit}`)
export const getVirtualClosed     = (limit = 50) => api.get(`/virtual/closed?limit=${limit}`)
export const getVirtualDecisions  = (params?: { action?: string; ticker?: string; limit?: number }) =>
  api.get('/virtual/decisions', { params })
export const getVirtualPerformance = () => api.get('/virtual/performance')
export const postVirtualReload    = (amount: number) => api.post(`/virtual/reload?amount=${amount}`)
export const postVirtualBackfill  = () => api.post('/virtual/backfill')
export const postVirtualEvaluate  = () => api.post('/virtual/evaluate')

// Daemon control
export const getDaemonStatus    = () => api.get('/system/daemon')
export const startDaemon        = () => api.post('/system/daemon/start')
export const stopDaemon         = () => api.post('/system/daemon/stop')
export const restartDaemon      = () => api.post('/system/daemon/restart')

// SSE stream URL (not axios — used with native EventSource)
export const sotdStreamUrl = (forceRefresh = true) =>
  `/api/analysis/sotd/stream?force_refresh=${forceRefresh}`

// Fundamental Intelligence
export const getFundamentals = (
  symbol: string,
  model: 'haiku' | 'sonnet' = 'haiku',
  forceRefresh = false,
  signalType?: string,
  confidenceScore?: number,
  regime?: string,
) => {
  const params = new URLSearchParams({ model, force_refresh: String(forceRefresh) })
  if (signalType)       params.set('signal_type', signalType)
  if (confidenceScore)  params.set('confidence_score', String(confidenceScore))
  if (regime)           params.set('regime', regime)
  return api.get(`/analysis/fundamentals/${symbol}?${params}`)
}

// Strategy Lab
export const getStrategies       = () => api.get('/strategy/strategies')
export const getStrategyRuns     = (limit = 20) => api.get(`/strategy/runs?limit=${limit}`)
export const getStrategyRun      = (runId: string) => api.get(`/strategy/run/${runId}`)
export const getStrategyResults  = (runId: string) => api.get(`/strategy/results/${runId}`)
export const cancelStrategyRun   = (runId: string) => api.post(`/strategy/run/${runId}/cancel`)
export const promoteStrategy     = (runId: string, strategyName: string) =>
  api.post(`/strategy/promote/${runId}/${encodeURIComponent(strategyName)}`)
export const startStrategyRun    = (body: Record<string, any>) => api.post('/strategy/run', body)

// Daily Decision Log
export const getDailyDecisions   = (date?: string) =>
  api.get(`/decisions/daily${date ? `?date=${date}` : ''}`)

// Best Bet / Strategy Comparison
export const getBestBet = (forceRefresh = false) =>
  api.get(`/performance/best-bet${forceRefresh ? '?force_refresh=true' : ''}`)
export const getStrategyComparison  = () => api.get('/performance/strategy-comparison')
export const runStrategyPicks       = (backfill = false) => api.post(`/performance/strategy-comparison/run?backfill=${backfill}`)
export const computeStrategyOutcomes = () => api.post('/performance/strategy-comparison/outcomes')

// Universe Cooldown
export const getCooldownList      = () => api.get('/performance/cooldown')
export const updateCooldown       = () => api.post('/performance/cooldown/update')
export const removeCooldown       = (ticker: string) => api.delete(`/performance/cooldown/${ticker}`)

// Stock Intelligence / Research
export const ingestNote           = (ticker: string, text: string, source_label: string) =>
  api.post('/stock-analysis/ingest', { ticker, text, source_label })
export const runStockAnalysis     = (ticker: string) => api.get(`/stock-analysis/run/${ticker}`)
export const getAnalysisHistory   = (ticker: string, limit = 10) =>
  api.get(`/stock-analysis/history/${ticker}?limit=${limit}`)
export const getIntelNotes        = (ticker: string) => api.get(`/stock-analysis/notes/${ticker}`)
export const deleteIntelNote      = (noteId: number) => api.delete(`/stock-analysis/notes/${noteId}`)
export const getContradictions    = (ticker: string) => api.get(`/stock-analysis/contradictions/${ticker}`)

// Options Desk
export const getOptionsAccount    = () => api.get('/options-desk/account')
export const resetOptionsAccount  = () => api.post('/options-desk/account/reset')
export const getOptionExpirations = (ticker: string) => api.get(`/options-desk/chain/${ticker}/expirations`)
export const getOptionChain       = (ticker: string, expiry: string) => api.get(`/options-desk/chain/${ticker}/${expiry}`)
export const getUnderlying        = (ticker: string) => api.get(`/options-desk/underlying/${ticker}`)
export const getOpenPositions     = () => api.get('/options-desk/positions')
export const getClosedPositions   = () => api.get('/options-desk/positions/closed')
export const openOptionsPosition  = (body: Record<string, any>) => api.post('/options-desk/positions/open', body)
export const closeOptionsPosition = (positionId: number, note?: string) =>
  api.post(`/options-desk/positions/${positionId}/close`, { note: note ?? '' })
export const triggerRevalue       = () => api.post('/options-desk/revalue')
export const scenarioFromLeg      = (body: Record<string, any>) => api.post('/options-desk/scenario/from-leg', body)
export const scenarioLive         = (body: Record<string, any>) => api.post('/options-desk/scenario/live', body)
export const getOptionsAICommentary = (positionId: number, question?: string) =>
  api.post('/options-desk/ai-commentary', { position_id: positionId, question: question ?? '' })
export const getOptionsRisk       = () => api.get('/options-desk/risk')
export const openMultiLegPosition = (body: Record<string, any>) => api.post('/options-desk/positions/open-multi', body)
export const getOptionsAlerts     = () => api.get('/options-desk/alerts')
export const getOptionsPerformance  = (days = 30) => api.get(`/options-desk/performance?days=${days}`)
export const getOptionsBenchmark    = (days = 30) => api.get(`/options-desk/benchmark?days=${days}`)
export const getMarketStatus        = () => api.get('/options-desk/market-status')

// Live Portfolio
export const getLivePositions       = () => api.get('/live-portfolio/positions')
export const getLiveClosedPositions = () => api.get('/live-portfolio/positions/closed')
export const openLivePosition       = (body: Record<string, any>) => api.post('/live-portfolio/positions', body)
export const closeLivePosition      = (id: number, body: Record<string, any>) => api.post(`/live-portfolio/positions/${id}/close`, body)
export const deleteLivePosition     = (id: number) => api.delete(`/live-portfolio/positions/${id}`)

// Options Scanner
export const getScannerSetups  = (force = false) => api.get(`/options-scanner/setups${force ? '?force=true' : ''}`)
export const triggerScan       = () => api.post('/options-scanner/run')
export const getScannerStatus  = () => api.get('/options-scanner/status')

// ARIA AI Agent
export const getAriaAccount    = () => api.get('/options-desk/aria/account')
export const getAriaPositions  = (status = 'OPEN') => api.get(`/options-desk/aria/positions?status=${status}`)
export const getAriaDecisions  = (limit = 50) => api.get(`/options-desk/aria/decisions?limit=${limit}`)
export const getAriaScoreboard = () => api.get('/options-desk/aria/scoreboard')
export const triggerAriaExits  = () => api.post('/options-desk/aria/check-exits')
export const resetAria         = () => api.post('/options-desk/aria/reset')
