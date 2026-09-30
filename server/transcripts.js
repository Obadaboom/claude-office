/**
 * Transcripts — read-only views of Claude Code JSONL transcripts for the office.
 * GET /agents/:id/report: a subagent's job, steps, files and final report (row 2d).
 * GET /sessions + `session_changed` WS: main sessions working / waiting / back (row 2e).
 * Paths come only from hook events, never from a request, and are read only when
 * their realpath sits under ~/.claude/projects. Never writes.
 */

import { realpathSync, readFileSync, readdirSync, openSync, readSync, fstatSync, closeSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, sep, dirname, basename } from 'path'
import { loopbackOnly } from './boards.js'

const AGENT_ID = /^agent-[A-Za-z0-9_-]{1,80}$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
const SESSION_MS = Number(process.env.AGENT_OFFICE_SESSION_MS) || 30 * 60_000
const UI_ORIGIN = process.env.AGENT_OFFICE_UI_ORIGIN || 'http://localhost:3333'

/** realpath of p when it is under ~/.claude/projects (symlinks and `..` resolved), else null */
function guard(p) {
  try {
    const real = realpathSync(p)
    return real.startsWith(realpathSync(join(homedir(), '.claude', 'projects')) + sep) ? real : null
  } catch { return null }
}
const guardFile = p => { const real = guard(p); return real?.endsWith('.jsonl') ? real : null }

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '')

// ---------------------------------------------------------------------------
// 2d: agent reports
// ---------------------------------------------------------------------------

const agents = new Map() // office id → { session, file, done }

function remember(id, patch) {
  if (typeof id !== 'string' || !AGENT_ID.test(id)) return
  const a = agents.get(id)
  agents.delete(id)
  agents.set(id, { ...a, ...patch })
  if (agents.size > 500) agents.delete(agents.keys().next().value)
}

/** A running agent's file: <session>/subagents/**\/<name>, depth ≤3, never through a symlinked dir */
function findLive(session, name) {
  const root = typeof session === 'string' && session.endsWith('.jsonl') && guard(join(session.slice(0, -6), 'subagents'))
  const find = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    if (entries.some(e => e.isFile() && e.name === name)) return join(dir, name)
    for (const e of entries) {
      const f = depth < 3 && e.isDirectory() && find(join(dir, e.name), depth + 1)
      if (f) return f
    }
    return null
  }
  return root ? find(root, 0) : null
}

// Same labels as hooks/agent-tracker.py: Bash shows its description, never the command;
// MCP shows the tool name (split('__', 2)[-1], '_' → ' ', 60 chars), never the server id
const base = p => String(p ?? '').split('/').pop()
const LABEL = {
  Read: i => `reading ${base(i.file_path)}`,
  Write: i => `writing ${base(i.file_path)}`,
  Edit: i => `editing ${base(i.file_path)}`,
  Bash: i => String(i.description || 'running a command').slice(0, 60),
  Grep: i => `searching for '${String(i.pattern ?? '').slice(0, 30)}'`,
  Glob: i => `finding files: ${String(i.pattern ?? '').slice(0, 40)}`,
  Skill: i => `using /${i.skill || 'skill'}`,
}
const label = (tool, i) =>
  tool.startsWith('mcp__') ? tool.replace(/^mcp__(.*?__)?/, '').replaceAll('_', ' ').slice(0, 60)
    : Object.hasOwn(LABEL, tool) ? LABEL[tool](i) : tool
const READS = new Set(['Read', 'Grep', 'Glob'])
const CHANGES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function parseAgent(jsonl) {
  let job = '', report = ''
  const steps = [], filesRead = new Set(), filesChanged = new Set()
  for (const line of jsonl.split('\n')) {
    // Tool results are the bulk: parse only assistant lines and the first user line
    if (!line.includes('"assistant"') && (job || !line.includes('"user"'))) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    const content = m?.message?.content
    if (m.type === 'user') { job = textOf(content); continue }
    if (m.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'text' && b.text?.trim()) report = b.text
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      const i = b.input && typeof b.input === 'object' ? b.input : {}
      steps.push({ tool: b.name, label: label(b.name, i) })
      if (b.name === 'StructuredOutput') report = JSON.stringify(i)
      const read = READS.has(b.name) && (i.file_path || i.path)
      const changed = CHANGES.has(b.name) && (i.file_path || i.notebook_path)
      if (typeof read === 'string') filesRead.add(read)
      if (typeof changed === 'string') filesChanged.add(changed)
    }
  }
  return { job: job.slice(0, 600), steps: steps.slice(-50), filesRead: [...filesRead], filesChanged: [...filesChanged], report: report.slice(0, 4000) }
}

// ---------------------------------------------------------------------------
// 2s: workflow phases (script text + journal.jsonl; the script is never run)
// ---------------------------------------------------------------------------

const str = key => new RegExp(`\\b${key}:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g')

/** { name, phases: [{ title, state, agents: running [{ id, label }] }] } in meta order, extra journal phases after, untitled last */
export function parseWorkflow(js, journal) {
  const at = js.indexOf('export const meta = {')
  const meta = at < 0 ? '' : js.slice(at).split(/\n(?=})/)[0]
  const groups = new Map([...meta.matchAll(str('title'))].map(m => [m[2], []]))
  // A retry re-`started`s the same key with a new agentId; only the latest attempt counts (older ones may never end)
  const untitled = [], byKey = new Map(), ends = new Map()
  for (const line of journal.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e?.agentId !== 'string') continue
    const key = typeof e.key === 'string' ? e.key : e.agentId, id = `agent-${e.agentId}`
    if (e.type === 'started') {
      const old = byKey.get(key)
      if (old) old.list.splice(old.list.indexOf(old.agent), 1)
      const list = typeof e.phase === 'string' ? (groups.get(e.phase) ?? groups.set(e.phase, []).get(e.phase)) : untitled
      const agent = { id, label: String(e.label ?? '') }
      list.push(agent)
      byKey.set(key, { agent, list })
    } else if ((e.type === 'result' || e.type === 'failed') && byKey.get(key)?.agent.id === id) ends.set(id, e.type)
  }
  if (untitled.length) groups.set('', untitled)
  return {
    name: meta.matchAll(str('name')).next().value?.[2] ?? '',
    phases: [...groups].map(([title, all]) => {
      const agents = all.filter(a => !ends.has(a.id))
      const state = agents.length ? 'running' : all.some(a => ends.get(a.id) === 'failed') ? 'failed' : all.length ? 'done' : 'todo'
      return { title, state, agents }
    }),
  }
}

const WF_DIR = /^wf_[A-Za-z0-9_-]{1,80}$/
/** A file's text when it passes guard() and is ≤2 MB, else null */
const readSmall = p => {
  const f = guard(p)
  try { return f && statSync(f).size <= 2 << 20 ? readFileSync(f, 'utf8') : null } catch { return null }
}

/** `<name>-<wf>.js` text: own project dir first, then any ~/.claude/projects/*\/<sid>/workflows/scripts (a session that cd'd saves it there); '' when none */
function scriptOf(path, wf) {
  const sid = basename(path, '.jsonl'), root = join(homedir(), '.claude', 'projects')
  if (!SESSION_ID.test(sid)) return ''
  let projects = []
  try { projects = readdirSync(root) } catch {}
  for (const dir of [dirname(path), ...projects.map(p => join(root, p))]) {
    const scripts = guard(join(dir, sid, 'workflows', 'scripts'))
    let name
    try { name = scripts && readdirSync(scripts).find(f => f.endsWith(`-${wf}.js`)) } catch {}
    const js = name && readSmall(join(scripts, name))
    if (js) return js
  }
  return ''
}

/** GET /sessions: one workflow per wf dir holding a live agent of s; meta descriptions of its other live agents */
function workflowsOf(s) {
  const path = s.path ?? [...s.agents.keys()].map(a => agents.get(a)?.session).find(p => p?.endsWith('.jsonl'))
  const sub = path && guard(join(path.slice(0, -6), 'subagents'))
  const workflows = new Map(), labels = {}
  if (!sub) return { workflows: [], labels }
  const workflow = (dir, wf) => {
    if (!workflows.has(wf)) {
      const journal = readSmall(join(dir, 'journal.jsonl'))
      const w = journal !== null ? parseWorkflow(scriptOf(path, wf), journal) : null
      for (const a of w?.phases.flatMap(p => p.agents) ?? []) {
        try { a.since = statSync(guardFile(join(dir, `${a.id}.jsonl`))).birthtimeMs } catch {}
      }
      workflows.set(wf, w?.phases.length ? w : null)
    }
    return workflows.get(wf)
  }
  for (const id of s.agents.keys()) {
    const file = findLive(path, `${id}.jsonl`)
    if (!file) continue
    const dir = dirname(file), wf = basename(dir)
    if (dir === join(sub, 'workflows', wf) && WF_DIR.test(wf) && workflow(dir, wf)) continue
    let d
    try { d = JSON.parse(readSmall(`${file.slice(0, -6)}.meta.json`))?.description } catch {}
    if (typeof d === 'string' && d) labels[id] = d.slice(0, 80)
  }
  return { workflows: [...workflows.values()].filter(Boolean), labels }
}

// ---------------------------------------------------------------------------
// 2e: main sessions
// ---------------------------------------------------------------------------

const STALE_MS = Number(process.env.AGENT_OFFICE_STALE_MS) || 20 * 60_000
const SEATS = 11 // the regulars' desks; past 11 live sessions → an overflow walker (seat null)
// session id → { state, reason, since, seen, path, seat, agents: Map(agent id → last event), turnOver, sent }
const sessions = new Map()
const TRANSITIONS = new Map([
  ['UserPromptSubmit', ['working']],
  ['Notification', ['waiting', 'needs_input']],
  ['SessionEnd', ['back']],
])
let broadcast = () => {}
let stepOf = () => ''

/** The one view of a session: GET /sessions, the WS snapshot and session_changed */
const view = (id, s) => ({
  sessionId: id, state: s.state, ...(s.reason && { reason: s.reason }), seat: s.seat, ...s.app?.view,
  busy: s.state === 'working' || s.agents.size > 0, runningAgents: s.agents.size, currentStep: stepOf(id),
})
export const sessionViews = () => [...sessions].map(([id, s]) => view(id, s))

/** The session record, created on first sight in state `state` at the lowest free seat */
function open(id, state, path) {
  let s = sessions.get(id)
  if (!s) {
    const taken = new Set([...sessions.values()].map(x => x.seat))
    const seat = Array.from({ length: SEATS }, (_, i) => i).find(i => !taken.has(i)) ?? null
    s = { state, since: Date.now(), seat, agents: new Map() }
    findApp(id, s)
    sessions.set(id, s)
    if (sessions.size > 100) end(sessions.keys().next().value)
  }
  if (typeof path === 'string') s.path = path
  s.seen = Date.now()
  return s
}

function set(s, state, reason) {
  if (s.state !== state || s.reason !== reason) Object.assign(s, { state, reason, since: Date.now() })
}

function end(id) {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  broadcast({ type: 'session_changed', sessionId: id, state: 'back', seat: s.seat, busy: false, runningAgents: 0, currentStep: '' })
}

/** The last agent gone after the turn ended: idle (never waiting: nobody asked you anything) */
function settle(s) {
  if (s.state === 'working' && s.turnOver && !s.agents.size) set(s, 'idle')
}

/** Broadcast every session whose view changed since it was last sent (call after processEvent: steps are fresh) */
export function syncSessions() {
  for (const [id, s] of sessions) {
    const v = view(id, s), json = JSON.stringify(v)
    // 2i: a real prompt (UserPromptSubmit) rides its one broadcast as `prompt`, even when the view is unchanged
    if (s.sent !== json || s.prompt) { s.sent = json; broadcast({ type: 'session_changed', ...v, ...(s.prompt && { prompt: true }) }); s.prompt = false }
  }
}

/** Last assistant text of a session transcript, ≤4000 chars: tail 64 KB, then 1 MB once */
function lastMessage(path) {
  const file = guardFile(path)
  if (!file) return undefined
  let fd
  try {
    fd = openSync(file, 'r')
    const total = fstatSync(fd).size
    for (const size of [64 << 10, 1 << 20]) {
      const len = Math.min(size, total)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, total - len)
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes('"assistant"')) continue
        try {
          const m = JSON.parse(line)
          const t = m.type === 'assistant' && textOf(m.message?.content)
          if (t?.trim()) return t.slice(0, 4000)
        } catch {}
      }
      if (len === total) break
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd) }
  return undefined
}

// ---------------------------------------------------------------------------
// 2n: the app's own session file → title + appId (read-only)
// ---------------------------------------------------------------------------

const APP_ID = /^local_[A-Za-z0-9-]{1,64}$/ // the app's own check on code/continue?session=
const appDir = () => join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
/** Parses the file; with `needle`, skips the parse unless the raw text contains it (app files are ~444 KB) */
const readJson = (f, needle) => { try { const t = readFileSync(f, 'utf8'); return needle && !t.includes(needle) ? null : JSON.parse(t) } catch { return null } }
const appView = j => ({ ...(typeof j.title === 'string' && j.title && { title: j.title.slice(0, 200) }), ...(typeof j.sessionId === 'string' && { appId: j.sessionId.slice(0, 100) }) })

/** The app file whose cliSessionId is this hook session id: files changed since the last try, newest first, ≤40 reads */
function findApp(id, s) {
  const since = s.appTried ?? 0
  s.appTried = Date.now()
  const files = []
  try {
    for (const a of readdirSync(appDir())) for (const b of readdirSync(join(appDir(), a))) for (const f of readdirSync(join(appDir(), a, b))) {
      if (!/^local_.*\.json$/.test(f)) continue
      const file = join(appDir(), a, b, f)
      try { const { mtimeMs } = statSync(file); if (mtimeMs >= since) files.push({ file, mtimeMs }) } catch {}
    }
  } catch {}
  for (const { file, mtimeMs } of files.sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, 40)) {
    const j = readJson(file, id)
    if (j?.cliSessionId === id) return (s.app = { file, mtimeMs, view: appView(j) })
  }
}

/** Sweep tick: re-read a known file when its mtime moved (retitle); retry a session not matched yet */
function refreshApp(id, s) {
  if (!s.app) return findApp(id, s)
  let mtimeMs
  try { mtimeMs = statSync(s.app.file).mtimeMs } catch { return }
  const j = mtimeMs !== s.app.mtimeMs && readJson(s.app.file)
  if (j?.cliSessionId === id) s.app = { ...s.app, mtimeMs, view: appView(j) }
}

const OPEN_CMD = process.env.AGENT_OFFICE_OPEN_CMD || 'open'
/** Runs `open <url>` (no shell, 5 s cap; a timeout is an error); the URL is one of three fixed shapes */
const openUrl = (url, res) => execFile(OPEN_CMD, [url], { timeout: 5000 }, err => res.status(err ? 500 : 200).json({ ok: !err }))

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Called from POST /event after auth, before processEvent; syncSessions() after it. True = a session_event, consumed. */
export function noteEvent(body) {
  if (!body || typeof body !== 'object') return false
  const { sessionId: id } = body
  const valid = typeof id === 'string' && SESSION_ID.test(id)
  if (body.type === 'session_event') {
    const [state, reason] = TRANSITIONS.get(body.event) ?? []
    if (valid && state === 'back') end(id)
    else if (valid && state) { const s = open(id, state, body.transcriptPath); s.turnOver = false; s.prompt = body.event === 'UserPromptSubmit'; set(s, state, reason) }
    return true
  }
  if (body.type === 'agent_spawned') remember(body.agent?.id, { session: body.transcriptPath })
  if (body.type === 'agent_completed') remember(body.agentId, { file: body.agentTranscriptPath, done: true })
  if (!valid) return false
  const agentId = body.agentId ?? body.agent?.id
  if (typeof agentId === 'string' && agentId.startsWith('agent-')) {
    // A session's agent: counts as its work (busy), never moves its state; an unknown session starts idle (office restart)
    const s = open(id, 'idle')
    if (body.type === 'agent_completed') { s.agents.delete(agentId); settle(s) }
    else if (!agents.get(agentId)?.done) s.agents.set(agentId, Date.now()) // a late hook event after SubagentStop adds nothing
    return false
  }
  // Main thread. 2a2's turn end (Stop): observed only, processEvent still clears its steps
  if (body.type === 'agent_working' && body.turnEnd) {
    const s = open(id, 'waiting', body.transcriptPath)
    s.turnOver = true
    if (s.agents.size) set(s, 'working')
    else set(s, 'waiting', 'turn_ended')
    return false
  }
  const s = open(id, 'working', body.transcriptPath)
  s.turnOver = false
  set(s, 'working')
  return false
}

/** `demo` (2v) = { start(task), reply(id, text) }: Open and /new then play fake work and never run `open` */
export function mountTranscripts(app, send, step, demo) {
  broadcast = send
  stepOf = step
  app.use(['/agents', '/sessions'], loopbackOnly)

  app.get('/agents/:id/report', (req, res) => {
    const { id } = req.params
    const a = AGENT_ID.test(id) && agents.get(id)
    const file = a && guardFile(a.file || findLive(a.session, `${id}.jsonl`))
    let jsonl
    try { jsonl = file && readFileSync(file, 'utf8') } catch {}
    if (!jsonl) return res.status(404).json({ error: 'Unknown agent' })
    res.json({ id, state: a.done ? 'done' : 'running', ...parseAgent(jsonl) })
  })

  app.get('/sessions', (_req, res) => {
    res.json([...sessions].map(([id, s]) => ({
      ...view(id, s), since: s.since, agents: [...s.agents.keys()], ...workflowsOf(s),
      ...(s.state === 'waiting' && { lastMessage: lastMessage(s.path) }),
    })))
  })

  // 2j Send back: the office UI only; a waiting session goes idle (back to its desk). Nothing reaches Claude.
  app.post('/sessions/:id/dismiss', (req, res) => {
    if (req.headers.origin !== UI_ORIGIN) return res.status(403).json({ error: 'Forbidden origin' })
    const s = SESSION_ID.test(req.params.id) && sessions.get(req.params.id)
    if (!s) return res.status(404).json({ error: 'Unknown session' })
    if (s.state === 'waiting') { set(s, 'idle'); syncSessions() }
    res.json({ ok: true })
  })

  // 2n Open: the app shows this session (needs-input when it has no valid app id). Nothing reaches Claude.
  app.post('/sessions/:id/open', (req, res) => {
    if (req.headers.origin !== UI_ORIGIN) return res.status(403).json({ error: 'Forbidden origin' })
    const s = SESSION_ID.test(req.params.id) && sessions.get(req.params.id)
    if (!s) return res.status(404).json({ error: 'Unknown session' })
    // 2v demo: body {text} (a tapped option in the note) is the reply; nothing is opened
    if (demo) {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 2000) : ''
      if (text) demo.reply(req.params.id, text)
      return res.json({ ok: true, ...(text && { note: 'Sent' }) })
    }
    const appId = s.app?.view.appId
    openUrl(APP_ID.test(appId) ? `claude://code/continue?session=${appId}` : 'claude://code/needs-input', res)
  })

  // 2n /new: a new app session in your home folder, prompt pre-filled; you press Enter yourself
  // 2q: kept as is. The app's claude://code/new handler (app.asar) reads only q|prompt, folder, file, ssh_*, source
  // and forwards folder= unchanged to /epitaxy?folder=…&src=external; the scratch-at-send choice is in the remote renderer.
  app.post('/sessions/new', (req, res) => {
    if (req.headers.origin !== UI_ORIGIN) return res.status(403).json({ error: 'Forbidden origin' })
    const q = req.body?.q === undefined ? '' : req.body.q
    if (typeof q !== 'string' || q.length > 2000) return res.status(400).json({ error: 'q must be a string ≤2000 chars' })
    if (demo) { demo.start(q.slice(0, 200)); return res.json({ ok: true }) }
    openUrl(`claude://code/new?${new URLSearchParams({ folder: homedir(), ...(q && { q }) })}`, res)
  })

  // Silent sessions go back (seat freed), silent agents leave their session; steps age out of currentStep
  setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.seen > SESSION_MS) { end(id); continue }
      for (const [a, at] of s.agents) if (now - at > STALE_MS) s.agents.delete(a)
      settle(s)
      refreshApp(id, s)
    }
    syncSessions()
  }, Math.min(SESSION_MS, STALE_MS, 120_000) / 2).unref()
}
