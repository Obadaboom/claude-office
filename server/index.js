/**
 * Agent Office - WebSocket + HTTP Event Server
 *
 * Runs on port 3334 (AGENT_OFFICE_PORT overrides; UI origin AGENT_OFFICE_UI_ORIGIN).
 * - React frontend connects via ws://localhost:3334/ws
 * - Claude Code hook script POSTs to http://localhost:3334/event
 * - GET /roster returns discovered MCP servers
 */

// First import: with AGENT_OFFICE_DEMO=1 its temp-HOME guard runs before any module below writes a file
import { seedIfMissing, startDemo } from './demo.js'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction } from './chat-db.js'
import db from './chat-db.js'
import { mountBoards, boardsDir } from './boards.js'
import { mountTranscripts, noteEvent, syncSessions, sessionViews } from './transcripts.js'
import { openDundies } from './dundies.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const NOTIFY_SCRIPT = join(__dirname, '..', 'scripts', 'notify.sh')

function sendNotification(title, msg) {
  try {
    const child = execFile('bash', [NOTIFY_SCRIPT, title, msg], { timeout: 3000 })
    child.unref()
  } catch {}
}

const PORT = Number(process.env.AGENT_OFFICE_PORT) || 3334
const UI_ORIGIN = process.env.AGENT_OFFICE_UI_ORIGIN || 'http://localhost:3333'

// ---------------------------------------------------------------------------
// Auth token — generated on startup, written to /tmp/agent-office-token
// ---------------------------------------------------------------------------

const AUTH_TOKEN = randomBytes(32).toString('hex')
const RUNTIME_DIR = join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

try {
  writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 })
} catch (err) {
  console.warn('[auth] Could not write token file:', err.message)
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  UI_ORIGIN,
  `http://localhost:${PORT}`,
])

function isAllowedOrigin(origin) {
  if (!origin) return true  // null origin (Electron, file://, curl)
  return ALLOWED_ORIGINS.has(origin)
}

// ---------------------------------------------------------------------------
// MCP server discovery
// ---------------------------------------------------------------------------

/**
 * Read ~/.claude/settings.json and any .claude.json in cwd to discover
 * configured MCP servers. Returns an array of server-name strings.
 */
function discoverMcpServers() {
  const servers = new Set()

  const candidates = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude.json'),
    join(process.cwd(), '.claude.json'),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf8')
      const data = JSON.parse(raw)
      const mcpServers = data.mcpServers ?? data.mcp_servers ?? {}
      for (const name of Object.keys(mcpServers)) {
        servers.add(name)
      }
    } catch {
      // Malformed JSON or unreadable file — skip silently
    }
  }

  return Array.from(servers)
}

// ---------------------------------------------------------------------------
// Agent state tracking
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} agentId -> agent object */
const activeAgents = new Map()

/** Agent tool calls waiting for their SubagentStart: { role, task, at } (task text only) */
const pendingTasks = []
const PENDING_MS = 60_000

/** Ids that already got SubagentStop — later events for them create nothing (no ghosts) */
const stoppedIds = new Set()

/** Open steps per agent (Jim included): agentId -> Map(tool_use_id -> { status, sessionId, at }), oldest first */
const openSteps = new Map()
/** Steps older than this (the client's 10-min backstop) are dropped: a dead or interrupted session's step never returns as a fake bubble */
const STEP_MS = Number(process.env.AGENT_OFFICE_STEP_MS) || 10 * 60_000
/** Head bubble = the latest step still open, or '' */
function bubbleOf(id) {
  const open = openSteps.get(id) ?? new Map()
  for (const [k, s] of open) if (Date.now() - s.at > STEP_MS) open.delete(k)
  return [...open.values()].pop()?.status ?? ''
}

/** A session's current step (2c): the newest open step of its main thread or any of its agents, or '' */
function stepOf(sessionId) {
  let best
  for (const open of openSteps.values()) for (const s of open.values())
    if (s.sessionId === sessionId && Date.now() - s.at <= STEP_MS && !(best?.at > s.at)) best = s
  return best?.status ?? ''
}

/** An agent with no event for this long is completed by the sweep */
const STALE_MS = Number(process.env.AGENT_OFFICE_STALE_MS) || 20 * 60_000

/**
 * Generate a stable agent ID from the event payload.
 * Uses the provided id, or derives one from name+role.
 */
function resolveAgentId(agent) {
  if (agent.id) return agent.id
  const slug = `${agent.name ?? 'agent'}-${agent.role ?? 'worker'}`
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  'agent_pending',
  'agent_spawned',
  'agent_working',
  'agent_seen',
  'agent_completed',
])

const MAX_STRING_LEN = 200

function clampString(val, max = MAX_STRING_LEN) {
  if (typeof val !== 'string') return undefined
  return val.slice(0, max)
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Missing body'
  if (!body.type || typeof body.type !== 'string') return 'Missing event type'
  if (!KNOWN_EVENT_TYPES.has(body.type)) return `Unknown event type: ${body.type}`
  return null
}

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '10kb' }))

// CORS for local dev — only allow known localhost origins
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' })
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  next()
})

app.options('*', (_req, res) => res.sendStatus(204))

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: activeAgents.size, clients: wss?.clients.size ?? 0 })
})

// MCP server roster
app.get('/roster', (_req, res) => {
  const mcpServers = discoverMcpServers()
  res.json({
    mcpServers,
    activeAgents: Array.from(activeAgents.values()),
  })
})
// 2o: today's real finishes per seat, for Michael's Dundies
const dundies = openDundies()
app.get('/dundies', (_req, res) => res.json({ jobs: dundies.todayJobs() }))

// 2v demo: boards under the temp HOME (never AGENT_OFFICE_BOARDS_DIR), scripted work through ingest()
let demo = null
if (process.env.AGENT_OFFICE_DEMO === '1') {
  delete process.env.AGENT_OFFICE_BOARDS_DIR
  demo = startDemo(ingest)
}
// First start: sample boards to look at; an existing folder (your own files) is never touched
seedIfMissing(boardsDir())
mountBoards(app, broadcast)
mountTranscripts(app, broadcast, stepOf, demo)

/**
 * POST /event — receives hook events from agent-tracker.sh
 *
 * Requires Authorization: Bearer <token> header (token is in /tmp/agent-office-token).
 *
 * Accepted body shapes:
 *   { type: "agent_spawned",   agent: { name, role, task, id? } }
 *   { type: "agent_working",   agentId, status, stepId, sessionId }   (status '' = step stepId ended;
 *                                turnEnd = the main session's Stop: that session's steps ended)
 *   { type: "agent_completed", agentId, result }
 */
app.post('/event', (req, res) => {
  // Auth check
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (demo) return res.json({ ok: true }) // 2v: real hook events never reach the demo
  const error = ingest(req.body)
  if (error) return res.status(400).json({ error })
  res.json({ ok: true })
})

/** One hook event through the office (POST /event after auth, and the demo's scripted events). Returns an error or null. */
function ingest(body) {
  if (noteEvent(body)) { syncSessions(); return null }

  // Validate event type
  const validationError = validateEvent(body)
  if (validationError) return validationError

  // Clamp string fields to prevent oversized payloads reaching the frontend
  const sanitised = {
    ...body,
    agent: body.agent ? {
      ...body.agent,
      name:   clampString(body.agent.name),
      role:   clampString(body.agent.role),
      task:   clampString(body.agent.task),
      id:     clampString(body.agent.id),
    } : undefined,
    agentId: clampString(body.agentId),
    role:    clampString(body.role),
    name:    clampString(body.name),
    task:    clampString(body.task),
    status:  clampString(body.status),
    result:  clampString(body.result),
    stepId:    clampString(body.stepId),
    sessionId: clampString(body.sessionId),
  }

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
  }
  syncSessions()
  return null
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function handleSlashCommand(cmd) {
  switch (cmd) {
    case '/status': {
      const agentCount = activeAgents.size
      const working = Array.from(activeAgents.values()).filter(a => a.state === 'working').length
      const clients = wss?.clients?.size ?? 0
      return `📊 ${agentCount} agents active, ${working} working, ${clients} clients connected`
    }
    case '/agents': {
      const agents = Array.from(activeAgents.values())
      if (agents.length === 0) return '🏢 Office is quiet — no agents active'
      return agents.map(a => `${a.name} (${a.role}) — ${a.state}`).join(', ')
    }
    case '/clear': {
      db.prepare('DELETE FROM messages').run()
      return '🧹 Chat cleared'
    }
    case '/help':
      return '📋 Commands: /status — office stats, /agents — list agents, /clear — wipe chat history, /help — this message'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Chat — user messages from the office UI
// ---------------------------------------------------------------------------

/**
 * POST /chat — receives a message typed in the office Slack panel
 * No auth required (comes from the UI, not hooks)
 */
app.post('/chat', (req, res) => {
  const { sender, text } = req.body ?? {}
  if (!sender || !text) {
    return res.status(400).json({ error: 'Missing sender or text' })
  }
  // 2v demo: the /the-office toggle line (🧻 … / 🔁 …) is neither a task nor stored
  if (demo && /^(🧻|🔁)/u.test(text)) return res.json({ ok: true })

  // Slash command detection — handle before saving as normal message
  if (typeof text === 'string' && text.startsWith('/')) {
    const parts = text.split(' ')
    const cmd = parts[0]
    const cmdResult = handleSlashCommand(cmd)
    if (cmdResult) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const sysMsg = addMessage({ sender: 'system', text: cmdResult, isSystem: true })
      broadcast({ type: 'chat_message', ...sysMsg, isSystem: true })
      return res.json({ ok: true })
    }
  }

  const msg = addMessage({
    sender: clampString(sender),
    text: clampString(text, 2000),
  })

  // Broadcast to all WS clients
  broadcast({ type: 'chat_message', ...msg })

  // 2v demo: plain chat text (no /command, no @name) is a task: a fake session starts
  if (demo && typeof text === 'string' && !/^[/@]/.test(text)) demo.start(clampString(text))

  // Smart notification — ping when "claude" or "@claude" is mentioned
  if (!demo && /claude/i.test(text)) {
    sendNotification('Office Chat', clampString(sender) + ': ' + text.slice(0, 50))
  }

  // Write to webhook file so Claude can detect new messages
  try {
    const webhookPath = join(homedir(), '.agent-office', 'last-chat')
    writeFileSync(webhookPath, JSON.stringify(msg), 'utf8')
  } catch {}

  console.log(`[chat] ${msg.sender}: ${msg.text}`)
  res.json({ ok: true })
})

/**
 * GET /chat — read recent chat messages (for Claude to read via terminal)
 * ?since=<timestamp> returns only messages after that time
 */
app.get('/chat', (req, res) => {
  const since = parseInt(req.query.since) || 0
  res.json({ messages: getMessages({ since, limit: 50 }) })
})

/**
 * POST /chat/reply — Claude replies as an agent in the office Slack
 * Body: { sender: "AgentName", role: "code-reviewer", text: "message" }
 */
app.post('/chat/reply', (req, res) => {
  const { sender, role, text } = req.body ?? {}
  if (!text) {
    return res.status(400).json({ error: 'Missing text' })
  }

  const msg = addMessage({
    sender: clampString(sender || 'Claude'),
    role: clampString(role || 'default'),
    text: clampString(text, 2000),
  })

  // Broadcast as a chat message — the frontend will attribute it to an agent
  broadcast({ type: 'chat_message', ...msg })

  console.log(`[reply] ${msg.sender}: ${msg.text}`)
  res.json({ ok: true })
})

/**
 * POST /chat/seen — mark a message as seen
 * Body: { messageId: number }
 */
app.post('/chat/seen', (req, res) => {
  const { messageId } = req.body ?? {}
  if (!messageId) {
    return res.status(400).json({ error: 'Missing messageId' })
  }
  markSeen(messageId)
  broadcast({ type: 'chat_seen', messageId })
  res.json({ ok: true })
})

/**
 * POST /chat/react — add or toggle an emoji reaction on a message
 * Body: { messageId: number, emoji: string }
 */
app.post('/chat/react', (req, res) => {
  const { messageId, emoji } = req.body ?? {}
  if (!messageId || !emoji) {
    return res.status(400).json({ error: 'Missing messageId or emoji' })
  }
  const reactions = addReaction(messageId, clampString(emoji, 10))
  broadcast({ type: 'chat_reaction', messageId, reactions })
  res.json({ ok: true, reactions })
})

/**
 * POST /chat/typing — broadcast a typing indicator
 * Body: { sender: string }
 */
app.post('/chat/typing', (req, res) => {
  const { sender } = req.body ?? {}
  if (!sender) {
    return res.status(400).json({ error: 'Missing sender' })
  }
  broadcast({ type: 'chat_typing', sender: clampString(sender) })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Cron/chat-monitor state — read-only (chat-bridge.sh reads it; the UI switch is gone)
// ---------------------------------------------------------------------------

const cronStatePath = join(homedir(), '.agent-office', 'chat-poll-state')

app.get('/chat/cron-state', (_req, res) => {
  try {
    const data = readFileSync(cronStatePath, 'utf8')
    res.json(JSON.parse(data))
  } catch {
    res.json({ paused: true, consecutive_idle_count: 0, last_seen_timestamp: 0 })
  }
})

// ---------------------------------------------------------------------------
// Event processing — normalise incoming hook payloads
// ---------------------------------------------------------------------------

function processEvent(body) {
  // Any event naming a known agent keeps it off the stale sweep
  const seen = body.agentId && activeAgents.get(body.agentId)
  if (seen) seen.lastEventAt = Date.now()

  switch (body.type) {
    case 'agent_pending': {
      // Agent tool PreToolUse: keep the task text for the next SubagentStart of this role
      pendingTasks.push({ role: body.role ?? 'general-purpose', task: body.task ?? '', at: Date.now() })
      return null
    }

    case 'agent_spawned': {
      const agent = body.agent ?? {}
      const id = resolveAgentId(agent)
      if (stoppedIds.has(id) || activeAgents.has(id)) return null
      const role = agent.role ?? 'general-purpose'
      let task = agent.task || agent.description || ''
      if (!task) {
        const now = Date.now()
        while (pendingTasks.length && now - pendingTasks[0].at > PENDING_MS) pendingTasks.shift()
        const i = pendingTasks.findIndex(p => p.role === role)
        if (i >= 0) task = pendingTasks.splice(i, 1)[0].task
      }
      const record = {
        id,
        name:   agent.name  ?? 'Agent',
        role,
        task,
        state:  'new-hire',
        spawnedAt: Date.now(),
        lastEventAt: Date.now(),
        sessionId: body.sessionId, // 2c: its lines are its session's
      }
      activeAgents.set(id, record)
      console.log(`[+] Agent spawned: ${record.name} (${record.role}) — ${id}`)

      // Spawn goes out before its chat line, so clients know the agent (and its
      // cast member) when the line arrives
      broadcast({ type: 'agent_spawned', agent: record, timestamp: Date.now() })

      // The one start line (real SubagentStart only): the real job (Agent tool description), or none known
      if (body.quiet) return null
      const chatMsg = addMessage({ sender: record.name, role: record.role, text: record.task ? `started: ${record.task}` : 'started' })
      broadcast({ type: 'chat_message', ...chatMsg, agentId: id, sessionId: record.sessionId })
      return null
    }

    case 'agent_seen': // hook heartbeat: any other tool call inside a subagent
    case 'agent_working': {
      const id = body.agentId
      if (id && stoppedIds.has(id)) return null
      // A subagent we never saw start (missed SubagentStart, office restart, swept): spawn it once, quietly
      if (id?.startsWith('agent-') && !activeAgents.has(id)) {
        processEvent({ type: 'agent_spawned', agent: { id, name: body.name, role: body.role }, quiet: true, sessionId: body.sessionId })
      }
      if (body.type === 'agent_seen') return null
      // PreToolUse opens its step, PostToolUse(Failure) closes only its own id, the main
      // session's Stop closes that session's steps; parallel steps never clear each other
      const open = openSteps.get(id) ?? new Map()
      openSteps.set(id, open)
      if (body.turnEnd) { for (const [k, s] of open) if (s.sessionId === body.sessionId) open.delete(k) }
      else if (body.status) open.set(body.stepId, { status: body.status, sessionId: body.sessionId, at: Date.now() })
      else open.delete(body.stepId)
      return { type: 'agent_working', agentId: id, status: bubbleOf(id), timestamp: Date.now() }
    }

    case 'agent_completed': {
      const id = body.agentId
      openSteps.delete(id)
      if (id?.startsWith('agent-')) {
        stoppedIds.add(id)
        // ponytail: bounded memory of stopped ids, oldest forgotten first
        if (stoppedIds.size > 5000) stoppedIds.delete(stoppedIds.values().next().value)
      }
      if (id && activeAgents.has(id) && activeAgents.get(id).state !== 'completed') {
        const agent = activeAgents.get(id)
        agent.state = 'completed'
        activeAgents.set(id, agent)
        // Remove after a short grace period so frontends can animate exit
        // (unless the id came back meanwhile: a swept agent that spoke again)
        setTimeout(() => activeAgents.get(id) === agent && activeAgents.delete(id), 10_000)

        // The one finish line: the real result (first line of the final message). A sweep leaves quietly.
        if (!body.quiet) {
          const sid = agent.sessionId ?? body.sessionId
          dundies.noteJob(sessionViews().find(v => v.sessionId === sid)?.seat ?? null, Date.now() - agent.spawnedAt)
          const chatMsg = addMessage({ sender: agent.name, role: agent.role, text: body.result ? `✅ finished: ${body.result}` : '✅ finished' })
          broadcast({ type: 'chat_message', ...chatMsg, agentId: id, sessionId: sid })
        }
      }
      console.log(`[-] Agent completed: ${id}`)
      return { type: 'agent_completed', agentId: id, timestamp: Date.now() }
    }

    default:
      console.warn(`[?] Unknown event type: ${body.type}`)
      return null
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  // Origin validation — allow localhost origins and null (Electron/file://)
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`)
    ws.close(1008, 'Forbidden origin')
    return
  }

  const ip = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected from ${ip} (total: ${wss.clients.size})`)

  // Send current state snapshot immediately on connect
  // Completed agents are on their way out: replaying them would re-hire a ghost
  const live = Array.from(activeAgents.values()).filter(a => a.state !== 'completed')
  const snapshot = {
    type: 'snapshot',
    activeAgents: live,
    // The current bubbles (Jim's too): a fresh page shows them before the next step
    bubbles: Object.fromEntries(['assistant-claude', ...live.map(a => a.id)].map(id => [id, bubbleOf(id)])),
    sessions: sessionViews(), // 2c: one view per live session (seat, busy, currentStep)
    mcpServers: discoverMcpServers(),
    timestamp: Date.now(),
  }
  ws.send(JSON.stringify(snapshot))

  ws.on('close', () => {
    console.log(`[ws] Client disconnected (remaining: ${wss.clients.size})`)
  })

  ws.on('error', (err) => {
    console.error(`[ws] Client error:`, err.message)
  })
})

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 */
function broadcast(payload) {
  const msg = JSON.stringify(payload)
  let sent = 0
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
      sent++
    }
  }
  if (sent > 0) {
    console.log(`[broadcast] ${payload.type} -> ${sent} client(s)`)
  }
}

// ---------------------------------------------------------------------------
// Stale sweep — a subagent silent for STALE_MS is completed (boss and Jim are
// client-side only and never swept)
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now()
  for (const a of activeAgents.values()) {
    if (a.id.startsWith('agent-') && a.state !== 'completed' && now - a.lastEventAt > STALE_MS) {
      const ev = processEvent({ type: 'agent_completed', agentId: a.id, quiet: true })
      if (ev) broadcast(ev)
      // Swept is not stopped: its next event brings it back (only SubagentStop is final)
      stoppedIds.delete(a.id)
      activeAgents.delete(a.id)
    }
  }
}, Math.min(STALE_MS / 2, 60_000)).unref()

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

httpServer.listen(PORT, '127.0.0.1', () => {
  const mcpServers = discoverMcpServers()
  console.log(`
╔═══════════════════════════════════════════╗
║         Agent Office Server v1.0          ║
╠═══════════════════════════════════════════╣
║  HTTP  http://localhost:${PORT}              ║
║  WS    ws://localhost:${PORT}/ws             ║
║  POST  http://localhost:${PORT}/event        ║
║  GET   http://localhost:${PORT}/roster       ║
╚═══════════════════════════════════════════╝`)

  console.log(`  Auth token written to: ${TOKEN_FILE}`)

  if (mcpServers.length > 0) {
    console.log(`  MCP servers discovered: ${mcpServers.join(', ')}`)
  } else {
    console.log('  No MCP servers found in ~/.claude/settings.json')
  }
  console.log()
})

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[error] Port ${PORT} is already in use. Is the server already running?`)
  } else {
    console.error('[error]', err)
  }
  process.exit(1)
})
