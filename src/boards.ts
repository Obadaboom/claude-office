/**
 * boards.ts — which furniture opens which board, and what the panel lists.
 * Data comes from the server's read-only /boards routes (server/boards.js).
 */

export type BoardId = 'status' | 'shipping' | 'decisions' | 'marketing' | 'older'
export type Line = { key: string; text: string; detail?: string; children?: Line[] }
export type Section = { title?: string; lines: Line[] }

/** `paths[i]` feeds `data[i]` of boardView; a `boards_changed` for any of `watches` refetches. */
export const BOARDS: Record<BoardId, { title: string; paths: string[]; watches: string[] }> = {
  status: { title: 'To-do', paths: ['/boards/status', '/boards/decisions'], watches: ['status', 'decisions'] },
  shipping: { title: 'Shipping board', paths: ['/boards/status', '/boards/log'], watches: ['status', 'log'] },
  decisions: { title: 'Decisions', paths: ['/boards/decisions'], watches: ['decisions'] },
  marketing: { title: 'Marketing', paths: ['/boards/marketing'], watches: ['marketing'] },
  older: { title: 'Older', paths: ['/boards/status', '/boards/decisions', '/boards/log', '/boards/marketing'], watches: ['status', 'decisions', 'log', 'marketing'] },
}

const BY_FURNITURE: Record<string, BoardId> = {
  'kanban-board': 'status',
  'tv-monitor': 'shipping',
  'boss-desk': 'decisions',
  'ship-it-poster': 'marketing',
  'filing-1': 'older',
}

export const boardFor = (furnitureId: string): BoardId | null => BY_FURNITURE[furnitureId] ?? null

type Row = { n: string; name: string; text: string; status: string; state: string; date?: string }
type Project = { slug: string; name: string; rows: Row[]; notes: string[]; shortNotes: string[]; noteDates?: string[] }
type Dated = { date?: string; time?: string; text: string; short: string; kind?: string }
type Item = { n: string; name: string; now: string; state: string; date: string; short: string }

/** Anything whose latest date is older than this many days (or has no date) moves to the Older board. */
export const OLD_DAYS = 7
const pad = (n: number) => String(n).padStart(2, '0')
const cutoff = (now: number) => {
  const d = new Date(now)
  d.setDate(d.getDate() - OLD_DAYS)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Newest first (stable), then split at the cutoff: [recent, old]; no date = old. */
function split<T extends { date?: string }>(xs: T[], cut: string): [T[], T[]] {
  const s = [...xs].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  return [s.filter(x => (x.date ?? '') >= cut), s.filter(x => !((x.date ?? '') >= cut))]
}

const CAP = 5
/** One cap for every list: the first 5, then a tappable `+N more` holding the rest. */
const cap = (lines: Line[], key: string): Line[] =>
  lines.length <= CAP ? lines : [...lines.slice(0, CAP), { key: `${key}:more`, text: `+${lines.length - CAP} more`, children: lines.slice(CAP) }]

/** `Project · name` can outgrow one line: cut at a word to ≤40 + …, like the server's short(). */
const clip = (s: string) => {
  if (s.length <= 41) return s
  const head = s.slice(0, 41), sp = head.lastIndexOf(' ')
  return (sp > 0 ? head.slice(0, sp) : head.slice(0, 40)).replace(/[\s,;:.·—–-]+$/, '') + '…'
}

const rowLine = (p: Project, r: Row, prefix = ''): Line =>
  ({ key: `${prefix}${p.slug}:${r.n}`, text: prefix ? clip(`${p.name} · ${r.name}`) : r.name, detail: `#${r.n} · ${r.text} — ${r.status}` })
const noteLine = (p: Project, i: number, prefix = ''): Line =>
  ({ key: `${prefix}${p.slug}:note:${i}`, text: prefix ? clip(`${p.name} · ${p.shortNotes[i]}`) : p.shortNotes[i], detail: p.notes[i] })
const itemLine = (i: Item, key: string): Line => ({ key: `${key}:${i.n}`, text: i.short, detail: `${i.name} · ${i.now}` })

const dated = (items: Dated[], key: string): Line[] => cap(items.map(i => {
  const detail = `${i.date}${i.time ? ` ${i.time}` : ''} · ${i.text}`
  return { key: detail, text: i.short, detail }
}), key)

type PR = { p: Project; r: Row; date?: string }
const allRows = (ps: Project[]): PR[] => ps.flatMap(p => p.rows.map(r => ({ p, r, date: r.date })))
/** A project with no row table: its `## Now` notes stand in (the server sends notes only then). */
const notesOf = (ps: Project[]) => ps.flatMap(p => p.notes.map((_, i) => ({ p, i, date: p.noteDates?.[i] })))
/** Rows in `state` across projects, newest first, as `Project · name`, capped. */
const rowsIn = (rows: PR[], state: string, key: string): Line[] =>
  cap(rows.filter(x => x.r.state === state).map(x => rowLine(x.p, x.r, `${key}:`)), key)
const section = (title: string, lines: Line[]): Section[] => (lines.length ? [{ title, lines }] : [])
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function todo(projects: Project[], decisions: Dated[], cut: string): Section[] {
  const [rows] = split(allRows(projects), cut)
  const [notes] = split(notesOf(projects), cut)
  const d = split(decisions, cut)[0].length
  const needs = [...rowsIn(rows, 'waiting', 'needs'), ...(d ? [{ key: 'decisions', text: `${plural(d, 'decision')} → your desk` }] : [])]
  const list = split(projects.flatMap(p => {
    const rs = rows.filter(x => x.p === p), ns = notes.filter(x => x.p === p)
    return rs.length ? [{ date: rs[0].date, line: { key: p.slug, text: `${p.name} · ${rs.length}`, children: cap(rs.map(x => rowLine(p, x.r)), p.slug) } }]
      : ns.length ? [{ date: ns[0].date, line: { key: p.slug, text: `${p.name} · ${plural(ns.length, 'note')}`, children: ns.map(x => noteLine(p, x.i)) } }]
      : []
  }), cut)[0].map(x => x.line)
  return [...section('Needs you', needs), ...section('Projects', cap(list, 'projects'))]
}

const shipped = (log: Dated[], cut: string) => split(log.filter(l => l.kind === 'shipped'), cut)
/** Posted, newest 3 of the last OLD_DAYS; everything else past needs/running goes to Older. */
const justPosted = (items: Item[], cut: string) => split(items.filter(i => i.state === 'posted'), cut)[0].slice(0, 3)

function marketing(items: Item[], cut: string): Section[] {
  const inState = (s: string) => split(items.filter(i => i.state === s), cut).flat() // current state: never ages out
  return [
    ...section('Needs you', cap(inState('needs').map(i => itemLine(i, 'marketing')), 'marketing:needs')),
    ...section('Running', cap(inState('running').map(i => itemLine(i, 'marketing')), 'marketing:running')),
    ...section('Just posted', justPosted(items, cut).map(i => itemLine(i, 'marketing'))),
  ]
}

function older([projects, decisions, log, items]: [Project[], Dated[], Dated[], Item[]], cut: string): Section[] {
  const todoOld = split([
    ...allRows(projects).map(x => ({ date: x.date, line: rowLine(x.p, x.r, 'older:') })),
    ...notesOf(projects).map(x => ({ date: x.date, line: noteLine(x.p, x.i, 'older:') })),
  ], cut)[1].map(x => x.line)
  const just = justPosted(items, cut)
  const mkt = split(items.filter(i => i.state !== 'needs' && i.state !== 'running' && !just.includes(i)), cut).flat()
  return [
    ...section('To-do', cap(todoOld, 'older:todo')),
    ...section('Decisions', dated(split(decisions, cut)[1], 'older:decisions')),
    ...section('Shipped', dated(shipped(log, cut)[1], 'older:shipped')),
    ...section('Marketing', cap(mkt.map(i => itemLine(i, 'older:marketing')), 'older:marketing')),
  ]
}

export function boardView(board: BoardId, data: any[][], now = Date.now()): Section[] {
  const cut = cutoff(now)
  switch (board) {
    case 'status':
      return todo(data[0], data[1], cut)
    case 'shipping': {
      const [rows] = split(allRows(data[0]), cut)
      return [...section('Ready to ship', rowsIn(rows, 'waiting', 'ready')), ...section('Up next', rowsIn(rows, 'open', 'next')), ...section('Just shipped', dated(shipped(data[1], cut)[0].slice(0, 3), 'shipped'))]
    }
    case 'marketing':
      return marketing(data[0], cut)
    case 'decisions': {
      const lines = dated(split(data[0], cut)[0], 'decisions')
      return lines.length ? [{ lines }] : []
    }
    case 'older':
      return older(data as [Project[], Dated[], Dated[], Item[]], cut)
  }
}
