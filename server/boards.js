/**
 * Boards — read-only views of the markdown in ~/.agent-office/boards for the office.
 * GET /boards/status | /boards/log | /boards/decisions | /boards/marketing, plus a
 * `boards_changed` WS nudge when the files change. Reads PROJECTS.md, projects/<slug>/STATUS.md,
 * LOG.md, DECISIONS.md and MARKETING.md only; never writes.
 */

import { readFileSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const boardsDir = () => process.env.AGENT_OFFICE_BOARDS_DIR || join(homedir(), '.agent-office', 'boards')
const read = file => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const plain = s => s.replace(/\*\*/g, '').trim()
const cut = (s, n) => plain(s).slice(0, n)
/** Latest YYYY-MM-DD in the text, '' when none. ponytail: no future-date clamp, a future date keeps a row "new". */
const latest = s => (s.match(/\d{4}-\d{2}-\d{2}/g) ?? ['']).sort().at(-1)
const unparen = s => { for (let t = ''; t !== s;) { t = s; s = s.replace(/\([^()]*\)/g, '') } return s.replace(/\([^)]*$/, '') }

/**
 * One plain line ≤40 chars (+ …) for a first view: no bold, (…), backtick spans, hex shas,
 * paths or `row <id>` tokens.
 * ponytail: regex heuristic; a sha with no digit or a bare path with no second / or .ext slips through.
 */
export function short(s) {
  s = unparen(plain(s))
    .replace(/`[^`]*(`|$)/g, '')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, '')
    .replace(/\S*\/\S*(\/|\.[a-z])\S*/gi, '')
    .replace(/\brows? \d[\w-]*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,;:.!?])/g, '$1')
    .replace(/^[\s,;:.—–-]+|[\s,;:.—–-]+$/g, '')
  if (s.length <= 40) return s
  const head = s.slice(0, 41)
  return head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : 40).replace(/[\s,;:.—–-]+$/, '') + '…'
}

/** Row name: the cell's leading **bold**, else the whole cell. */
export const rowName = cell => short(cell.match(/^\*\*(.+?)\*\*/)?.[1] ?? cell)
const lead = s => unparen(s).split(/: |\. /)[0]

export function normaliseStatus(cell) {
  const s = plain(cell).toLowerCase()
  if (/^(done|live|shipped|smoked clean|resolved|see history|cancelled|dropped|superseded|closed)/.test(s)) return 'done'
  if (/^(built|part \d+ built|ready)/.test(s)) return 'waiting'
  return 'open'
}

/** Markdown tables as { header, rows } with cells split on | but not \| */
function tables(md) {
  const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
  const lines = md.split('\n')
  const out = []
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue
    const t = { header: cells(lines[i]).map(plain), rows: [] }
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) t.rows.push(cells(lines[i]))
    out.push(t)
  }
  return out
}

export function parseStatus(md) {
  const table = tables(md).find(t => t.header[0] === '#' && t.header.some(h => /^status$/i.test(h)))
  if (!table) {
    const now = md.split(/^## /m).find(s => s.startsWith('Now')) ?? ''
    const full = now.split('\n').filter(l => l.startsWith('- ')).slice(0, 3)
    const notes = full.map(l => cut(l.slice(2), 140))
    return { rows: [], done: 0, skipped: 0, notes, shortNotes: notes.map(short), noteDates: full.map(latest) }
  }
  const { header } = table
  const si = header.findIndex(h => /^status$/i.test(h))
  const oi = header.findIndex(h => /^owner$/i.test(h))
  const rows = []
  const names = {} // rows with a **bold** name, incl. done, for the LOG's `row <id>` lines
  let done = 0, skipped = 0
  for (const c of table.rows) {
    if (c.length < header.length) { skipped++; continue } // no status cell: never guess
    if (c[1].startsWith('**')) names[plain(c[0])] = rowName(c[1])
    // Extra cells (stray `| |` or unescaped `|`) shift the status right: take the first
    // done/waiting cell from the status column on; none found → skip, never a false open.
    const sc = c.length === header.length ? c[si] : c.slice(si).find(x => normaliseStatus(x) !== 'open')
    if (sc === undefined) { skipped++; continue }
    const state = normaliseStatus(sc)
    if (state === 'done') { done++; continue }
    const n = plain(c[0])
    rows.push({ n, title: cut(c[1], 140), ...(oi > 0 && { owner: plain(c[oi]) }), status: cut(sc, 140), state, name: rowName(c[1]) || `#${n}`, text: cut(c[1], 600), date: latest(`${c[1]} ${sc}`) })
  }
  return { rows, done, skipped, notes: [], shortNotes: [], noteDates: [], names }
}

export function statusBoard(dir) {
  const seen = new Map()
  for (const t of tables(read(join(dir, 'PROJECTS.md')))) {
    const si = t.header.findIndex(h => /^status$/i.test(h))
    for (const c of t.rows) {
      const m = c[0]?.match(/^\[([^\]]+)\]\(projects\/([a-z0-9-]+)\/STATUS\.md\)/)
      if (m && !seen.has(m[2])) seen.set(m[2], { slug: m[2], name: plain(m[1]), registryStatus: si < 0 ? '' : plain(c[si] ?? '') })
    }
  }
  return [...seen.values()].map(p => ({ ...p, ...parseStatus(read(join(dir, 'projects', p.slug, 'STATUS.md'))) }))
}

// ponytail: keyword heuristic, first match wins; tune when a board shows a wrong class.
function logKind(t) {
  if (/\b(tiktok|campaign|ads)\b|\$\d+(\.\d+)?\/day/i.test(t)) return 'marketing'
  if (/\bnot (yet )?merged\b/i.test(t)) return 'waiting'
  if (/\b(LIVE|SHIPPED|DONE)\b|\bmerged\b/.test(t)) return 'shipped'
  if (/\bBUILT\b|READY TO SHIP/.test(t) || /waiting on you|not deployed/i.test(t)) return 'waiting'
  if (/\(you\b/i.test(t)) return 'decision' // `(you "ship")`: your call, logged
  return 'other'
}

/** `<Project> · <row name>` when the lead starts with a project and names exactly one of its bold-named rows. */
function rowShort(head, projects) {
  const ids = [...head.matchAll(/\brow (\d[\w-]*)/gi)]
  if (ids.length !== 1) return
  const p = projects.find(p => head.startsWith(p.name + ' '))
  const name = p?.names?.[ids[0][1]]
  return name && short(`${p.name} · ${name}`)
}

/** Every LOG line, no count cap: the boards split by date (Older → Shipped needs lines past a week).
 * `projects` = statusBoard(), so a single-row line reads as that row's name. */
export function parseLog(md, projects = []) {
  const out = []
  for (const line of md.split('\n')) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2})(?: [A-Z]{2,4})?)?\s*(?:[—–-]\s+)?(.*)$/)
    if (!m) continue
    const text = m[3].trim().slice(0, 200)
    const head = lead(text)
    out.push({ date: m[1], ...(m[2] && { time: m[2] }), text, kind: logKind(text), short: rowShort(head, projects) || short(head) })
  }
  return out
}

export function parseDecisions(md) {
  return md.split('\n').flatMap(line => {
    const m = line.match(/^- \[ \] (\d{4}-\d{2}-\d{2})\s*(?:[—–-]\s+)?(.*)$/)
    if (!m) return []
    const title = m[2].match(/\*\*(.+?)\*\*/)?.[1] ?? ''
    return [{ date: m[1], title, text: cut(m[2], 200), short: short(title || lead(plain(m[2]))) }]
  })
}

export const MARKETING = 'MARKETING.md' // fixed: not in PROJECTS.md
const MKT_STATES = ['needs', 'running', 'posted', 'stopped']

/** `| # | Item | Now |` under `## Marketing now`: one item per line, latest state only. */
export function parseMarketing(md) {
  const sec = md.split(/^## /m).find(s => s.startsWith('Marketing now')) ?? ''
  const t = tables(sec).find(t => t.header[0] === '#' && t.header[2] === 'Now')
  return (t?.rows ?? []).filter(c => c.length >= 3).map(c => {
    const name = rowName(c[1]), now = plain(c[2])
    const word = now.split(/\s/)[0].toLowerCase()
    const state = MKT_STATES.includes(word) ? word : 'other'
    const parts = unparen(now).split(' · ')
    return { n: plain(c[0]), name, now, state, date: latest(`${c[1]} ${c[2]}`), short: state === 'running' && parts.length >= 3 ? short(`${parts[1]} · ${name} · ${parts[2]}`) : name }
  })
}

/** Non-recursive watches only: scratch/ and edits/ see 100k+ writes in bursts. */
function watchBoards(dir, broadcast) {
  const ROOT_FILES = { 'LOG.md': 'log', 'DECISIONS.md': 'decisions', 'PROJECTS.md': 'status', [MARKETING]: 'marketing' }
  const timers = {}
  const fire = board => {
    clearTimeout(timers[board])
    timers[board] = setTimeout(() => broadcast({ type: 'boards_changed', board }), 300)
  }
  let warned = false
  const safeWatch = (path, fn) => {
    const warn = err => { if (!warned) { warned = true; console.warn(`[boards] not watching ${path}: ${err.message}`) } }
    try { return watch(path, fn).on('error', warn) } catch (err) { warn(err) }
  }
  const projectDirs = new Map()
  const scan = () => {
    for (const { slug } of statusBoard(dir)) {
      if (projectDirs.has(slug)) continue
      const w = safeWatch(join(dir, 'projects', slug), (_, f) => { if (f === 'STATUS.md') fire('status') })
      if (w) projectDirs.set(slug, w)
    }
  }
  safeWatch(dir, (_, f) => {
    if (f === 'PROJECTS.md') scan()
    if (ROOT_FILES[f]) fire(ROOT_FILES[f])
  })
  scan()
}

// DNS-rebinding guard: this data is private, only a loopback Host may read it
export function loopbackOnly(req, res, next) {
  const port = req.socket.localPort
  if (req.headers.host === `localhost:${port}` || req.headers.host === `127.0.0.1:${port}`) return next()
  res.status(403).json({ error: 'Forbidden host' })
}

export function mountBoards(app, broadcast) {
  app.use('/boards', loopbackOnly)
  app.get('/boards/status', (_req, res) => res.json(statusBoard(boardsDir())))
  app.get('/boards/log', (_req, res) => res.json(parseLog(read(join(boardsDir(), 'LOG.md')), statusBoard(boardsDir()))))
  app.get('/boards/decisions', (_req, res) => res.json(parseDecisions(read(join(boardsDir(), 'DECISIONS.md')))))
  app.get('/boards/marketing', (_req, res) => res.json(parseMarketing(read(join(boardsDir(), MARKETING)))))
  watchBoards(boardsDir(), broadcast)
}
