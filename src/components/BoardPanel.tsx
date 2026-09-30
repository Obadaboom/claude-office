import React, { useEffect, useRef, useState } from 'react'
import { SERVER_URL } from '../config'
import { BOARDS, BoardId, Line, Section, boardView } from '../boards'
import './BoardPanel.css'

/** Slim read-only card for one board. Refetches on the server's boards_changed nudge. */
export default function BoardPanel({ board, onClose }: { board: BoardId; onClose: () => void }) {
  const { title, paths, watches } = BOARDS[board]
  const [sections, setSections] = useState<Section[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set()) // keys are stable, so a live refresh keeps lines open
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const seq = useRef(0) // only the newest load may set state: a slow older response never overwrites a newer one

  useEffect(() => {
    const load = () => {
      const id = ++seq.current
      Promise.all(paths.map(p => fetch(`${SERVER_URL}${p}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })))
        .then(d => { if (id !== seq.current) return; setSections(boardView(board, d)); setFailed(false) })
        .catch(() => { if (id === seq.current) setFailed(true) })
    }
    const onChange = (e: Event) => { if (watches.includes((e as CustomEvent).detail)) load() }
    load()
    window.addEventListener('boards_changed', onChange)
    return () => window.removeEventListener('boards_changed', onChange)
  }, [board, paths, watches])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  const toggle = (key: string) => setOpen(o => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })
  const lines = (ls: Line[]) => ls.map(l => {
    if (!l.detail && !l.children) return <div key={l.key} className="board-panel-line board-panel-one">{l.text}</div>
    const on = open.has(l.key)
    return (
      <div key={l.key}>
        <button className="board-panel-line board-panel-one board-panel-tap" aria-expanded={on} onClick={() => toggle(l.key)}>{l.text}</button>
        {on && l.detail && <div className="board-panel-detail">{l.detail}</div>}
        {on && l.children && <div className="board-panel-children">{lines(l.children)}</div>}
      </div>
    )
  })

  return (
    <div className="board-panel" ref={ref} role="dialog" aria-label={title}>
      <div className="board-panel-header">
        <span>{title}</span>
        <button className="board-panel-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="board-panel-body">
        {failed ? <div className="board-panel-muted">Boards offline.</div>
          : sections?.length === 0 ? <div className="board-panel-muted">Nothing here.</div>
          : sections?.map((s, i) => (
            <div key={i} className="board-panel-section">
              {s.title && <div className="board-panel-title">{s.title}</div>}
              {lines(s.lines)}
            </div>
          ))}
      </div>
    </div>
  )
}
