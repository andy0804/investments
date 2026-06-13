import { useState, useCallback } from 'react'
import {
  ingestNote, runStockAnalysis, getIntelNotes,
  getAnalysisHistory, deleteIntelNote, getContradictions,
} from '../api'
import { PageInfoModal, InfoButton, usePageInfo } from '../components/PageInfoModal'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubScores {
  technical: number
  macro: number
  sentiment: number
  valuation: number
  momentum: number
  risk: number
  catalyst: number
  composite: number
  details: Record<string, any>
  reasons?: Record<string, string>
}

interface FusionBreakdown {
  composite_contribution: number
  llm_contribution: number
  evidence_contribution: number
  composite_weight: number
  llm_weight: number
  evidence_weight: number
  evidence_strength: number
  exact_note_count: number
  sub_weights: Record<string, number>
}

interface AnalysisRun {
  run_id: number
  ticker: string
  scores: SubScores
  verdict: 'BUY' | 'HOLD' | 'SELL' | 'WATCH'
  llm_confidence: number
  fusion_score: number
  fusion_breakdown: FusionBreakdown
  reasoning: string
  note_attributions: string[]
  key_strengths: string[]
  key_risks: string[]
  suggested_action: string
  evidence: EvidenceItem[]
  created_at: string
}

interface HistoryRun {
  id: number
  ticker: string
  deterministic_score: number
  llm_verdict: string
  llm_confidence: number
  fusion_score: number
  reasoning: string
  created_at: string
}

interface EvidenceItem {
  note_id: number
  ticker: string
  source_label: string
  created_at: string
  thesis: string
  signals: string[]
  risks: string[]
  timeframe: string | null
  confidence: number
  relevance: number
  raw_preview: string
}

interface IntelNote {
  id: number
  ticker: string
  raw_text: string
  source_label: string
  created_at: string
  thesis: string
  signals: string[]
  risks: string[]
  timeframe: string | null
  confidence: number
}

interface Contradiction {
  type: string
  message: string
  from_date: string
  to_date: string
}

// ── Sub-score bar ─────────────────────────────────────────────────────────────

function ScoreBar({ label, score, reason }: { label: string; score: number; reason?: string }) {
  const pct = (score / 10) * 100
  const color = score >= 7 ? '#16a34a' : score >= 5 ? '#2563eb' : '#dc2626'
  return (
    <div style={{ marginBottom: reason ? 6 : 2 }}>
      <div className="research-score-row">
        <span className="research-score-label">{label}</span>
        <div className="research-score-track">
          <div className="research-score-fill" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="research-score-val" style={{ color }}>{score.toFixed(1)}</span>
      </div>
      {reason && (
        <div style={{ fontSize: '0.67rem', color: 'var(--text-dim)', lineHeight: 1.4, paddingLeft: 84, marginTop: 1 }}>
          {reason}
        </div>
      )}
    </div>
  )
}

// ── Verdict badge ─────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict: string }) {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    BUY:   { bg: '#f0fdf4', color: '#15803d', border: 'rgba(34,197,94,0.4)' },
    HOLD:  { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
    SELL:  { bg: '#fef2f2', color: '#991b1b', border: 'rgba(239,68,68,0.4)' },
    WATCH: { bg: 'rgba(245,158,11,0.1)', color: '#FBBF24', border: 'rgba(245,158,11,0.25)' },
  }
  const s = map[verdict] || map['WATCH']
  return (
    <span style={{
      display: 'inline-block', padding: '4px 14px', borderRadius: '20px',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      fontWeight: 800, fontSize: '1rem', letterSpacing: '0.08em',
      fontFamily: 'var(--mono)',
    }}>
      {verdict}
    </span>
  )
}

// ── Source label pill ─────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  own_note: 'My Note',
  analyst: 'Analyst',
  news: 'News',
  earnings: 'Earnings',
}

// ── Score composition panel ───────────────────────────────────────────────────

const SCORE_LABELS: Record<string, string> = {
  technical: 'Technical', macro: 'Macro', sentiment: 'Sentiment (Your Notes)',
  valuation: 'Valuation', momentum: 'Momentum', risk: 'Risk', catalyst: 'Catalyst',
}

function ContribBar({ pts, maxPts, color }: { pts: number; maxPts: number; color: string }) {
  const pct = maxPts > 0 ? Math.min(100, (pts / maxPts) * 100) : 0
  return (
    <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.4s' }} />
    </div>
  )
}

function ScoreCompositionPanel({ result }: { result: AnalysisRun }) {
  const fb = result.fusion_breakdown
  const scores = result.scores
  const subW = fb.sub_weights

  // Max possible contribution per sub-score = weight × 10 × composite_weight
  const maxSubContrib = 0.50 * 10 // 5.0 if score = 10 and composite_weight = 0.5

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="card-title">How is {result.fusion_score.toFixed(1)} Calculated?</div>

      {/* Fusion formula */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Fusion formula: 50% market data + 30% AI confidence + 20% your note coverage
        </div>

        {/* Composite row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
          <div style={{ width: 160, fontSize: '0.72rem', color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            Market data ({(fb.composite_weight * 100).toFixed(0)}%)
          </div>
          <ContribBar pts={fb.composite_contribution} maxPts={5} color="#2563eb" />
          <div style={{ width: 90, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: '#2563eb', fontWeight: 700 }}>
            {scores.composite.toFixed(1)} × 0.5 = +{fb.composite_contribution.toFixed(2)}
          </div>
        </div>

        {/* LLM confidence row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
          <div style={{ width: 160, fontSize: '0.72rem', color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            AI confidence ({(fb.llm_weight * 100).toFixed(0)}%)
          </div>
          <ContribBar pts={fb.llm_contribution} maxPts={5} color="#7c3aed" />
          <div style={{ width: 90, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: '#7c3aed', fontWeight: 700 }}>
            {result.llm_confidence}/10 × 0.3 = +{fb.llm_contribution.toFixed(2)}
          </div>
        </div>

        {/* Evidence strength row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{ width: 160, fontSize: '0.72rem', color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            Note coverage ({(fb.evidence_weight * 100).toFixed(0)}%)
          </div>
          <ContribBar pts={fb.evidence_contribution} maxPts={5} color="#16a34a" />
          <div style={{ width: 90, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '0.72rem', color: '#16a34a', fontWeight: 700 }}>
            {fb.evidence_strength.toFixed(1)}/10 × 0.2 = +{fb.evidence_contribution.toFixed(2)}
          </div>
        </div>

        <div style={{
          borderTop: '1px solid var(--border)', paddingTop: 6, display: 'flex',
          justifyContent: 'flex-end', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
            {fb.composite_contribution.toFixed(2)} + {fb.llm_contribution.toFixed(2)} + {fb.evidence_contribution.toFixed(2)} =
          </span>
          <span style={{ fontSize: '1rem', fontWeight: 900, fontFamily: 'var(--mono)', color: 'var(--text-bright)' }}>
            {result.fusion_score.toFixed(2)}
          </span>
        </div>

        {fb.exact_note_count === 0 && (
          <div style={{ fontSize: '0.68rem', color: '#FBBF24', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 4, padding: '4px 8px', marginTop: 6 }}>
            ⚠ Note coverage is 0 — add research notes to increase this component by up to +2.0 pts
          </div>
        )}
      </div>

      {/* Sub-score contributions to composite */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Market data breakdown (how each factor feeds composite {scores.composite.toFixed(1)}/10)
        </div>
        {Object.entries(subW).map(([key, w]) => {
          const s = (scores as any)[key] as number
          const contrib = s * w
          const isNotes = key === 'sentiment'
          const color = isNotes ? '#16a34a' : s >= 7 ? '#2563eb' : s >= 5 ? '#6b7280' : '#dc2626'
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ width: 148, fontSize: '0.68rem', fontFamily: 'var(--mono)', color: isNotes ? '#15803d' : 'var(--text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                {isNotes && <span title="Driven by your notes">📝</span>}
                {SCORE_LABELS[key]}
              </div>
              <div style={{ width: 34, textAlign: 'right', fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                {(w * 100).toFixed(0)}%
              </div>
              <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${(s / 10) * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
              </div>
              <div style={{ width: 38, textAlign: 'right', fontSize: '0.68rem', fontFamily: 'var(--mono)', color, fontWeight: 700 }}>
                {s.toFixed(1)}
              </div>
              <div style={{ width: 52, textAlign: 'right', fontSize: '0.68rem', fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                +{contrib.toFixed(2)} pts
              </div>
            </div>
          )
        })}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 5, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>composite =</span>
          <span style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--cyan)' }}>{scores.composite.toFixed(2)}/10</span>
        </div>
      </div>
    </div>
  )
}


// ── Main component ────────────────────────────────────────────────────────────

export default function ResearchPage() {
  const [ticker, setTicker]         = useState('')
  const [activeTicker, setActiveTicker] = useState('')
  const [noteText, setNoteText]     = useState('')
  const [sourceLabel, setSourceLabel] = useState('own_note')
  const [ingesting, setIngesting]   = useState(false)
  const [ingestMsg, setIngestMsg]   = useState('')
  const [running, setRunning]       = useState(false)
  const [result, setResult]         = useState<AnalysisRun | null>(null)
  const [notes, setNotes]           = useState<IntelNote[]>([])
  const [history, setHistory]       = useState<HistoryRun[]>([])
  const [contradictions, setContradictions] = useState<Contradiction[]>([])
  const [error, setError]           = useState('')
  const [activeTab, setActiveTab]   = useState<'notes' | 'history'>('notes')
  const info = usePageInfo()

  const loadSidebar = useCallback(async (t: string) => {
    const [notesRes, histRes, contraRes] = await Promise.allSettled([
      getIntelNotes(t),
      getAnalysisHistory(t, 5),
      getContradictions(t),
    ])
    if (notesRes.status === 'fulfilled') setNotes(notesRes.value.data as IntelNote[])
    if (histRes.status === 'fulfilled')  setHistory(histRes.value.data as HistoryRun[])
    if (contraRes.status === 'fulfilled') setContradictions(contraRes.value.data as Contradiction[])
  }, [])

  async function handleRunAnalysis() {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    setError('')
    setRunning(true)
    setActiveTicker(t)
    try {
      const res = await runStockAnalysis(t)
      setResult(res.data as AnalysisRun)
      await loadSidebar(t)
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Analysis failed')
    } finally {
      setRunning(false)
    }
  }

  async function handleIngest() {
    const t = ticker.trim().toUpperCase()
    if (!t || !noteText.trim()) return
    setIngesting(true)
    setIngestMsg('')
    try {
      await ingestNote(t, noteText, sourceLabel)
      setNoteText('')
      setIngestMsg('Note saved and signals extracted.')
      await loadSidebar(t)
    } catch (e: any) {
      setIngestMsg('Failed: ' + (e.response?.data?.detail || 'Unknown error'))
    } finally {
      setIngesting(false)
    }
  }

  async function handleDelete(noteId: number) {
    await deleteIntelNote(noteId)
    setNotes(n => n.filter(x => x.id !== noteId))
  }

  const fusionColor = result
    ? result.fusion_score >= 7 ? '#16a34a' : result.fusion_score >= 5 ? '#2563eb' : '#dc2626'
    : '#6b7280'

  return (
    <div className="research-shell">
      {/* ── LEFT: Ticker + Ingest ── */}
      <div className="research-left">
        {info.show && (
          <PageInfoModal
            title="Research"
            subtitle="Your personal AI research notebook for any stock"
            benefit="Build a private, searchable knowledge base about any stock — then get a single AI-fused score that weighs your own notes alongside hard market data."
            sections={[
              { title: 'What this page does', body: 'Research is a two-part tool: a note-taking layer where you log your own observations (earnings calls, news, thesis), and an AI analysis engine that fuses those notes with 7 quantitative dimensions into a single composite score.' },
              { title: 'Adding notes', body: 'Type a ticker, write your observation, select a source type (own note, news, earnings, analyst call, SEC filing), and click Ingest. Notes are stored permanently and associated with the ticker. The AI reads them during analysis to understand your personal thesis.' },
              { title: 'The 7-dimension analysis', body: 'When you click "Analyse", the agent scores the stock across:', bullets: [
                'Technical — price momentum, RSI, MACD, ADX, volume trend',
                'Macro — VIX regime, sector rotation, market breadth',
                'Sentiment — news tone, social signals, analyst revisions',
                'Valuation — PE, revenue growth, margin quality vs sector peers',
                'Momentum — short and medium-term price momentum quality',
                'Risk — downside risk, volatility regime, drawdown history',
                'Catalyst — upcoming events, earnings proximity, sector tailwinds',
              ]},
              { title: 'Fusion scoring', body: 'The final composite score blends three inputs: the quantitative sub-scores (weighted 40%), Claude Sonnet\'s LLM reasoning (40%), and evidence strength from your ingested notes (20%). The more notes you add, the stronger the evidence contribution.' },
              { title: 'Contradictions', body: 'The engine flags when your notes contradict the quantitative data — e.g. you wrote "strong earnings" but valuation metrics are deteriorating. These are surfaced as contradictions so you can investigate before acting.' },
            ]}
            onClose={info.close}
          />
        )}
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div className="card-title" style={{ margin: 0 }}>Stock Research</div>
            <InfoButton onClick={info.open} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              className="input"
              placeholder="Ticker (e.g. AAPL)"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleRunAnalysis()}
              style={{ flex: 1, textTransform: 'uppercase' }}
            />
            <button
              className="btn primary"
              onClick={handleRunAnalysis}
              disabled={running || !ticker.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {running ? '...' : 'Analyse'}
            </button>
          </div>
          {error && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginBottom: 8 }}>{error}</div>}

          <div className="card-title" style={{ marginTop: 4 }}>Add Research Note</div>
          <select
            className="input"
            value={sourceLabel}
            onChange={e => setSourceLabel(e.target.value)}
            style={{ marginBottom: 8, fontSize: '0.78rem' }}
          >
            <option value="own_note">My Note</option>
            <option value="analyst">Analyst Report</option>
            <option value="news">News Article</option>
            <option value="earnings">Earnings Highlights</option>
          </select>
          <textarea
            className="input"
            placeholder="Paste your research note, article excerpt, analyst comment, or earnings highlights here…"
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            style={{ minHeight: 120, resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }}
          />
          <button
            className="btn"
            onClick={handleIngest}
            disabled={ingesting || !noteText.trim() || !ticker.trim()}
            style={{ marginTop: 8, width: '100%' }}
          >
            {ingesting ? 'Extracting signals…' : 'Save + Extract Signals'}
          </button>
          {ingestMsg && (
            <div style={{ fontSize: '0.72rem', color: ingestMsg.startsWith('Failed') ? '#dc2626' : '#16a34a', marginTop: 6 }}>
              {ingestMsg}
            </div>
          )}
        </div>

        {/* Stored notes / history tabs */}
        {activeTicker && (
          <div className="card">
            <div style={{ display: 'flex', gap: 0, marginBottom: 10, borderBottom: '1px solid var(--border)' }}>
              {(['notes', 'history'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setActiveTab(t)}
                  style={{
                    padding: '6px 14px', border: 'none', background: 'none', cursor: 'pointer',
                    borderBottom: activeTab === t ? '2px solid var(--cyan)' : '2px solid transparent',
                    color: activeTab === t ? 'var(--cyan)' : 'var(--text-dim)',
                    fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em',
                    textTransform: 'uppercase', fontFamily: 'var(--mono)',
                  }}
                >
                  {t === 'notes' ? `Notes (${notes.length})` : `History (${history.length})`}
                </button>
              ))}
            </div>

            {activeTab === 'notes' && (
              notes.length === 0
                ? <div className="loading">No notes for {activeTicker} yet.</div>
                : notes.map(n => (
                  <div key={n.id} style={{
                    padding: '8px 10px', marginBottom: 8,
                    background: 'var(--panel-inset)', borderRadius: 6,
                    border: '1px solid var(--border)', position: 'relative',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <span style={{
                          fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase',
                          color: n.thesis === 'bullish' ? '#15803d' : n.thesis === 'bearish' ? '#991b1b' : '#92400e',
                          marginRight: 6, fontFamily: 'var(--mono)',
                        }}>
                          {n.thesis}
                        </span>
                        <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                          {SOURCE_LABELS[n.source_label] || n.source_label} · {n.created_at.slice(0, 10)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDelete(n.id)}
                        style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px' }}
                        title="Delete note"
                      >✕</button>
                    </div>
                    <div style={{ fontSize: '0.73rem', color: 'var(--text)', marginTop: 4, lineHeight: 1.45 }}>
                      {n.raw_text.slice(0, 150)}{n.raw_text.length > 150 ? '…' : ''}
                    </div>
                    {n.signals.length > 0 && (
                      <div style={{ fontSize: '0.65rem', color: '#15803d', marginTop: 3 }}>
                        ↑ {n.signals.slice(0, 2).join(' · ')}
                      </div>
                    )}
                  </div>
                ))
            )}

            {activeTab === 'history' && (
              history.length === 0
                ? <div className="loading">No analysis runs for {activeTicker} yet.</div>
                : history.map(h => (
                  <div key={h.id} style={{
                    padding: '8px 10px', marginBottom: 8,
                    background: 'var(--panel-inset)', borderRadius: 6,
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{
                        fontSize: '0.75rem', fontWeight: 800, fontFamily: 'var(--mono)',
                        color: h.llm_verdict === 'BUY' ? '#15803d' : h.llm_verdict === 'SELL' ? '#991b1b' : '#2563eb',
                      }}>
                        {h.llm_verdict}
                      </span>
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                        {h.created_at.slice(0, 10)}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                      Score {h.deterministic_score?.toFixed(1)} · Fusion {h.fusion_score?.toFixed(1)}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}
      </div>

      {/* ── CENTER: Analysis Result ── */}
      <div className="research-center">
        {!result && !running && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-dim)', textAlign: 'center', padding: 40,
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 16, opacity: 0.3 }}>🔬</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Hybrid Stock Intelligence</div>
            <div style={{ fontSize: '0.78rem', lineHeight: 1.6, maxWidth: 340 }}>
              Enter a ticker and click <strong>Analyse</strong> to get a scored verdict combining
              live technicals, macro context, and your stored research notes.
              <br /><br />
              Add notes first to enrich the analysis with your own thesis.
            </div>
          </div>
        )}

        {running && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
            Running analysis for {ticker}… (Haiku + Sonnet)
          </div>
        )}

        {result && !running && (
          <>
            {/* Header */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '1.5rem', fontWeight: 900, color: 'var(--text-bright)', fontFamily: 'var(--mono)' }}>
                  {result.ticker}
                </span>
                <VerdictBadge verdict={result.verdict} />
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: '1.6rem', fontWeight: 900, fontFamily: 'var(--mono)', color: fusionColor, lineHeight: 1 }}>
                    {result.fusion_score.toFixed(1)}
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: 4 }}>/10</span>
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                    FUSION SCORE
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.65, marginTop: 12 }}>
                {result.reasoning}
              </div>
              {result.suggested_action && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', background: 'var(--cyan-bg)',
                  borderRadius: 6, border: '1px solid #93c5fd',
                  fontSize: '0.75rem', color: 'var(--cyan)', fontWeight: 600,
                }}>
                  → {result.suggested_action}
                </div>
              )}
            </div>

            {/* Score composition — the math behind the number */}
            {result.fusion_breakdown && <ScoreCompositionPanel result={result} />}

            {/* Score breakdown with per-score reasoning */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="card-title">Why Each Score?</div>
              <ScoreBar label="Technical"  score={result.scores.technical}  reason={result.scores.reasons?.technical}  />
              <ScoreBar label="Macro"      score={result.scores.macro}      reason={result.scores.reasons?.macro}      />
              <ScoreBar label="Sentiment"  score={result.scores.sentiment}  reason={result.scores.reasons?.sentiment}  />
              <ScoreBar label="Valuation"  score={result.scores.valuation}  reason={result.scores.reasons?.valuation}  />
              <ScoreBar label="Momentum"   score={result.scores.momentum}   reason={result.scores.reasons?.momentum}   />
              <ScoreBar label="Risk"       score={result.scores.risk}       reason={result.scores.reasons?.risk}       />
              <ScoreBar label="Catalyst"   score={result.scores.catalyst}   reason={result.scores.reasons?.catalyst}   />
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <ScoreBar label="Composite" score={result.scores.composite} />
              </div>
            </div>

            {/* Note attributions — how your research drove the verdict */}
            {result.note_attributions && result.note_attributions.length > 0 && (
              <div className="card" style={{ marginBottom: 10 }}>
                <div className="card-title" style={{ color: '#7c3aed' }}>Your Notes → Verdict</div>
                {result.note_attributions.map((attr, i) => (
                  <div key={i} style={{
                    fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.5,
                    marginBottom: 6, paddingLeft: 10,
                    borderLeft: '2px solid #c4b5fd',
                  }}>
                    {attr}
                  </div>
                ))}
              </div>
            )}

            {/* Strengths & Risks */}
            {(result.key_strengths.length > 0 || result.key_risks.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                {result.key_strengths.length > 0 && (
                  <div className="card">
                    <div className="card-title" style={{ color: '#15803d' }}>Strengths</div>
                    {result.key_strengths.map((s, i) => (
                      <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>
                        <span style={{ color: '#16a34a', marginRight: 4 }}>↑</span>{s}
                      </div>
                    ))}
                  </div>
                )}
                {result.key_risks.length > 0 && (
                  <div className="card">
                    <div className="card-title" style={{ color: '#991b1b' }}>Risks</div>
                    {result.key_risks.map((r, i) => (
                      <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>
                        <span style={{ color: '#dc2626', marginRight: 4 }}>↓</span>{r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── RIGHT: Evidence Trail ── */}
      <div className="research-right">
        <div className="card" style={{ height: '100%', overflowY: 'auto' }}>
          <div className="card-title">Evidence Trail</div>

          {contradictions.length > 0 && (
            <div style={{
              padding: '8px 10px', marginBottom: 12, borderRadius: 6,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
            }}>
              <div style={{ fontSize: '0.65rem', fontWeight: 800, color: '#FBBF24', marginBottom: 4, fontFamily: 'var(--mono)' }}>
                ⚠ THESIS DRIFT DETECTED
              </div>
              {contradictions.map((c, i) => (
                <div key={i} style={{ fontSize: '0.7rem', color: '#92400e', lineHeight: 1.4 }}>
                  {c.message} ({c.from_date} → {c.to_date})
                </div>
              ))}
            </div>
          )}

          {!result || result.evidence.length === 0 ? (
            <div className="loading">
              {result ? 'No stored notes used in this analysis.' : 'Run an analysis to see the evidence trail.'}
            </div>
          ) : (
            result.evidence.map((e, i) => (
              <div key={e.note_id} style={{
                padding: '8px 10px', marginBottom: 8,
                background: 'var(--panel-inset)', borderRadius: 6,
                border: '1px solid var(--border)',
                borderLeft: `3px solid ${e.thesis === 'bullish' ? 'rgba(34,197,94,0.4)' : e.thesis === 'bearish' ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.4)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{
                    fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase',
                    color: e.thesis === 'bullish' ? '#15803d' : e.thesis === 'bearish' ? '#991b1b' : '#92400e',
                    fontFamily: 'var(--mono)',
                  }}>
                    {e.thesis}
                  </span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    {e.created_at.slice(0, 10)}
                  </span>
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: 4, fontFamily: 'var(--mono)' }}>
                  {SOURCE_LABELS[e.source_label] || e.source_label}
                  {e.relevance > 0 && ` · relevance ${e.relevance.toFixed(2)}`}
                  {e.ticker !== result?.ticker && ` · [${e.ticker}]`}
                </div>
                {e.signals.length > 0 && (
                  <div style={{ fontSize: '0.68rem', color: '#15803d', marginBottom: 2 }}>
                    {e.signals.slice(0, 2).map((s, j) => <span key={j} style={{ marginRight: 6 }}>↑ {s}</span>)}
                  </div>
                )}
                {e.risks.length > 0 && (
                  <div style={{ fontSize: '0.68rem', color: '#dc2626' }}>
                    {e.risks.slice(0, 2).map((r, j) => <span key={j} style={{ marginRight: 6 }}>↓ {r}</span>)}
                  </div>
                )}
                <div style={{ fontSize: '0.68rem', color: 'var(--text)', marginTop: 4, lineHeight: 1.4, opacity: 0.8 }}>
                  {e.raw_preview}{e.raw_preview.length >= 200 ? '…' : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
