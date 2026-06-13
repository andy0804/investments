import { useState } from 'react'

const T = {
  bg:      '#07101F',
  card:    '#0C1A2E',
  cardHi:  'rgba(255,255,255,0.035)',
  cardHi2: 'rgba(255,255,255,0.06)',
  border:  'rgba(255,255,255,0.07)',
  text:    '#CBD5E1',
  textBrt: '#F1F5F9',
  textMut: '#64748B',
  blue:    '#3B82F6',
  green:   '#22C55E',
  yellow:  '#F59E0B',
  red:     '#EF4444',
  mono:    'var(--mono)',
}

export interface PageInfoSection {
  title: string
  body: string
  bullets?: string[]
}

interface Props {
  title: string
  subtitle?: string
  benefit: string          // one-line "how you benefit" summary
  sections: PageInfoSection[]
  onClose: () => void
}

export function PageInfoModal({ title, subtitle, benefit, sections, onClose }: Props) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: '24px 16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: T.card, borderRadius: 12, width: '100%', maxWidth: 680,
        boxShadow: '0 24px 80px rgba(0,0,0,0.7)', border: `1px solid ${T.border}`,
        padding: '28px 32px',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: T.textBrt, marginBottom: 4 }}>{title}</div>
            {subtitle && <div style={{ fontSize: '0.77rem', color: T.textMut }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textMut, fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Benefit banner */}
        <div style={{ background: `${T.green}0f`, border: `1px solid ${T.green}30`, borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: '0.8rem', color: T.green, lineHeight: 1.6 }}>
          <strong>How you benefit: </strong>{benefit}
        </div>

        {/* Sections */}
        {sections.map((s, i) => (
          <div key={i} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.blue, marginBottom: 7 }}>
              {s.title}
            </div>
            <div style={{ fontSize: '0.8rem', color: T.text, lineHeight: 1.7, marginBottom: s.bullets?.length ? 8 : 0 }}>{s.body}</div>
            {s.bullets && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {s.bullets.map((b, j) => (
                  <li key={j} style={{ fontSize: '0.78rem', color: T.textMut, lineHeight: 1.7, marginBottom: 2 }}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
          <button onClick={onClose} className="btn sm">Close</button>
        </div>
      </div>
    </div>
  )
}

// Reusable info icon button
export function InfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="What is this page?"
      style={{
        background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
        color: '#3B82F6', borderRadius: 6, padding: '3px 10px',
        fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', lineHeight: 1.6,
      }}
    >
      ⓘ
    </button>
  )
}

// Hook: returns [showInfo, setShowInfo, InfoButtonEl]
export function usePageInfo() {
  const [show, setShow] = useState(false)
  return { show, open: () => setShow(true), close: () => setShow(false) }
}
