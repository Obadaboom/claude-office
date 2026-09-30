import React, { useEffect, useRef, useState } from 'react'
import { SERVER_URL, DEMO } from '../config'
import { Agent } from '../types'
import { plainText, shortText, boldSegments, option } from '../plainText'
import { PRANKS } from '../chatter'
import { castOf, castKey, slugToName, REGULARS } from '../theme'
import './BoardPanel.css'

/** A session's state in plain words. Busy with only agents running (main turn over) still reads as Working. */
export const stateWords = (state?: string, reason?: string, busy?: boolean, runningAgents = 0) =>
  state === 'waiting' ? (reason === 'needs_input' ? 'Needs your OK' : 'Waiting on you: turn ended')
    : state === 'working' ? 'Working'
    : !busy ? 'Idle'
    : runningAgents > 0 ? `Working · ${runningAgents} agent${runningAgents === 1 ? '' : 's'}` : 'Working'

/** Panel header: the first name ("Jim") for a cast regular or Michael (office theme), else the name only */
export function caption(a: Agent): string {
  const slug = castOf(castKey(a.id, a.role))
  return slug && (slug === 'michael-scott' || (REGULARS as readonly string[]).includes(slug)) ? slugToName(slug.split('-')[0]) : a.name
}

interface Report { job: string; steps: { label: string }[]; filesChanged: string[]; report: string }
interface Workflow { name: string; phases: { title: string; state: 'done' | 'running' | 'todo' | 'failed'; agents: { id: string; label: string; since?: number }[] }[] }
interface Info { lastMessage?: string; agents: string[]; workflows: Workflow[]; labels: Record<string, string> }
/** 2s: a running phase's age, "3m 33s" / "5s" */
export const elapsed = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${t % 60}s` }
const MARK = { done: '✓', running: '●', todo: '○', failed: '✗' }
const inline: React.CSSProperties = { display: 'inline', width: 'auto' }
const scrollBox: React.CSSProperties = { maxHeight: 140, overflowY: 'auto', whiteSpace: 'pre-wrap', marginTop: 4 }

const bold = (t: string) => boldSegments(t).map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <React.Fragment key={i}>{s.text}</React.Fragment>))

/**
 * Markdown-free text (numbers, bullets, bold kept), short until tapped, full (in the scroll box) until tapped again.
 * `onPick` (2v, demo only): each top-level numbered option is tappable and picks its text.
 */
export function CleanText({ text, onPick }: { text: string; onPick?: (option: string) => void }) {
  const [full, setFull] = useState(false)
  const clean = plainText(text), short = shortText(clean), shown = full ? clean : short
  return (
    <div className="board-panel-line" style={{ ...scrollBox, ...(short !== clean && { cursor: 'pointer' }) }} onClick={() => setFull(f => !f)}>
      {!onPick ? bold(shown) : shown.split('\n').map((l, i) => {
        const o = option(l)
        return <React.Fragment key={i}>{i > 0 && '\n'}{o
          ? <span className="board-panel-option" onClick={e => { e.stopPropagation(); onPick(o.text) }}>{bold(l)}</span>
          : bold(l)}</React.Fragment>
      })}
    </div>
  )
}

/**
 * Slim card for one character's live session (row 2d), the BoardPanel look. State and step
 * come live from the character; GET /sessions (last message, running agents) refetches when
 * the state or agent count changes, an open agent report when the step changes. No polling.
 */
export default function SessionPanel({ agent, onClose, onPrank }: { agent: Agent; onClose: () => void; onPrank?: (prank: string) => void }) {
  const { session, sessionState, sessionReason, runningAgents, statusText, busy, sessionTitle } = agent
  const [info, setInfo] = useState<Info | null>(null)
  const [offline, setOffline] = useState(false)
  const [reports, setReports] = useState<Record<string, Report | null>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [pranks, setPranks] = useState(false)
  const [picked, setPicked] = useState('')
  const [, tick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const loadReport = (id: string) => fetch(`${SERVER_URL}/agents/${encodeURIComponent(id)}/report`)
    .then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(r => setReports(m => ({ ...m, [id]: r })))

  useEffect(() => {
    if (!session) return
    let live = true // only the newest load may set state
    fetch(`${SERVER_URL}/sessions`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((list: ({ sessionId: string } & Partial<Info>)[]) => {
        if (!live) return
        const s = list.find(x => x.sessionId === session)
        setInfo({ lastMessage: s?.lastMessage, agents: s?.agents ?? [], workflows: s?.workflows ?? [], labels: s?.labels ?? {} })
        setOffline(false)
      })
      .catch(() => { if (live) setOffline(true) })
    return () => { live = false }
  }, [session, sessionState, sessionReason, runningAgents])

  useEffect(() => { if (open) loadReport(open) }, [open, statusText])

  // Elapsed ticks each second only while a running agent is shown
  const running = info?.workflows.some(w => w.phases.some(p => p.agents.some(a => a.since))) ?? false
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  // Send back (2j): the character goes back to its desk; nothing is sent to the session
  const sendBack = () => fetch(`${SERVER_URL}/sessions/${encodeURIComponent(session!)}/dismiss`, { method: 'POST' })
    .then(r => { if (r.ok) onClose() }).catch(() => {})
  // Open (2n): the app shows this session; the office sends it nothing
  const openInApp = () => fetch(`${SERVER_URL}/sessions/${encodeURIComponent(session!)}/open`, { method: 'POST' }).catch(() => {})
  // 2v demo: a tapped option in the note is the reply; the demo server plays it and answers `note: 'Sent'`
  const pick = (text: string) => fetch(`${SERVER_URL}/sessions/${encodeURIComponent(session!)}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json()).then(r => setPicked(r.note || '')).catch(() => {})
  useEffect(() => { if (sessionState === 'waiting') setPicked('') }, [sessionState])

  /** A tappable agent label; its steps + report show under `line` while open */
  const tap = (id: string, text: string, style?: React.CSSProperties) => (
    <button key={id} className="board-panel-line board-panel-tap" style={style} onClick={() => setOpen(o => (o === id ? null : id))}>{text}</button>
  )
  const details = (id: string) => {
    if (open !== id) return null
    const r = reports[id]
    return r ? <>
      {r.steps.slice(-8).map((s, i) => <div key={i} className="board-panel-muted" style={{ display: 'block' }}>{s.label}</div>)}
      {r.filesChanged.length > 0 && <div className="board-panel-muted">Changed: {r.filesChanged.map(f => f.split('/').pop()).join(', ')}</div>}
      {r.report && <CleanText text={r.report} />}
    </> : <div className="board-panel-muted">No report yet.</div>
  }
  const inWorkflow = new Set(info?.workflows.flatMap(w => w.phases.flatMap(p => p.agents.map(a => a.id))))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // A character click toggles or moves the panel itself (App)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('[data-agent-id]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  return (
    <div className="board-panel" ref={ref} role="dialog" aria-label={agent.name}>
      <div className="board-panel-header">
        <span>{caption(agent)}{session && sessionTitle && <span className="board-panel-muted" style={{ display: 'block', fontWeight: 400 }}>{sessionTitle}</span>}</span>
        <span style={{ whiteSpace: 'nowrap' }}>
          {onPrank && <button className="board-panel-close" style={{ fontSize: 12, marginRight: 8 }} onClick={() => setPranks(p => !p)}>Prank</button>}
          {session && <button className="board-panel-close" style={{ fontSize: 12, marginRight: 8 }} onClick={openInApp}>Open</button>}
          {session && sessionState === 'waiting' && <button className="board-panel-close" style={{ fontSize: 12, marginRight: 8 }} onClick={sendBack}>Send back</button>}
          <button className="board-panel-close" onClick={onClose} aria-label="Close">×</button>
        </span>
      </div>
      <div className="board-panel-body">
        {onPrank && pranks && (
          <div className="board-panel-section">
            {Object.keys(PRANKS).map(k => (
              <button key={k} className="board-panel-close" style={{ fontSize: 12, marginRight: 8 }} onClick={() => { setPranks(false); onPrank(k) }}>{k}</button>
            ))}
          </div>
        )}
        {!session ? <div className="board-panel-muted">No live session.</div>
          : offline ? <div className="board-panel-muted">Office offline.</div>
          : <>
            <div className="board-panel-title">{stateWords(sessionState, sessionReason, busy, runningAgents)}</div>
            {statusText && <div className="board-panel-line">Now: {statusText}</div>}
            {sessionState === 'waiting' && info?.lastMessage && <CleanText key={info.lastMessage} text={info.lastMessage} onPick={DEMO && !picked ? pick : undefined} />}
            {picked && <div className="board-panel-muted">{picked}</div>}
            {info?.workflows.map((w, i) => (
              <div key={i} className="board-panel-section">
                {w.name && <div className="board-panel-title">{w.name}</div>}
                {w.phases.map((p, j) => (
                  <React.Fragment key={j}>
                    <div className={p.state === 'todo' ? 'board-panel-muted' : 'board-panel-line'}>
                      {MARK[p.state]} {p.title || 'Other'}
                      {p.agents.map(a => <React.Fragment key={a.id}> · {tap(a.id, `${a.label || 'Agent'}${a.since ? ` ${elapsed(Date.now() - a.since)}` : ''}`, inline)}</React.Fragment>)}
                    </div>
                    {p.agents.map(a => <React.Fragment key={a.id}>{details(a.id)}</React.Fragment>)}
                  </React.Fragment>
                ))}
              </div>
            ))}
            {info?.agents.filter(id => !inWorkflow.has(id)).map(id => (
              <div key={id} className="board-panel-section">
                {tap(id, info.labels[id] || 'Agent')}
                {details(id)}
              </div>
            ))}
          </>}
      </div>
    </div>
  )
}
