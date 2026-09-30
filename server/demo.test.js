import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { request } from 'http'
import { createServer } from 'net'
import { builtinModules } from 'module'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { assertTempHome, seed, seedIfMissing, DEFAULT_TASK, LAST } from './demo.js'
import { statusBoard, parseLog, parseDecisions, parseMarketing, MARKETING } from './boards.js'
import { boardView } from '../src/boards.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'server/demo.js'), 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

describe('demo guard + source', () => {
  it('assertTempHome throws for a non-temp or missing HOME, passes under the temp dir', () => {
    expect(() => assertTempHome('/')).toThrow()
    expect(() => assertTempHome('/no/such/home-xyz')).toThrow()
    expect(() => assertTempHome(mkdtempSync(join(tmpdir(), 'demo-ok-')))).not.toThrow()
  })

  it('the server exits non-zero with DEMO on and a non-temp HOME, before listening', () => {
    const r = spawnSync('node', [join(ROOT, 'server/index.js')], { env: { ...process.env, HOME: '/', AGENT_OFFICE_DEMO: '1', AGENT_OFFICE_PORT: '1' }, timeout: 10_000 })
    expect(r.status).not.toBe(0)
    expect(r.status).not.toBe(null)
  })

  it('imports only node builtins; no fetch, no network', () => {
    const from = [...SRC.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
    expect(from.length).toBeGreaterThan(0)
    for (const m of from) expect(builtinModules.includes(m.replace(/^node:/, ''))).toBe(true)
    expect(SRC).not.toMatch(/\bfetch\(|https?:\/\/|\brequest\(/)
  })
})

describe('demo fixture boards', () => {
  const home = mkdtempSync(join(tmpdir(), 'demo-seed-'))
  const dir = join(home, '.agent-office', 'boards')
  seed(dir)
  const projects = statusBoard(dir)
  const log = parseLog(readFileSync(join(dir, 'LOG.md'), 'utf8'), projects)
  const decisions = parseDecisions(readFileSync(join(dir, 'DECISIONS.md'), 'utf8'))
  const items = parseMarketing(readFileSync(join(dir, MARKETING), 'utf8'))

  it('≥3 projects with a Needs-you row, ≥3 shipped, ≥2 decisions, ≥2 marketing, ≥2 Older', () => {
    expect(projects.length).toBeGreaterThanOrEqual(3)
    expect(projects.flatMap(p => p.rows).some(r => r.state === 'waiting')).toBe(true)
    expect(boardView('status', [projects, decisions])[0].title).toBe('Needs you')
    expect(log.filter(l => l.kind === 'shipped').length).toBeGreaterThanOrEqual(3)
    expect(decisions.length).toBeGreaterThanOrEqual(2)
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(boardView('marketing', [items]).flatMap(s => s.lines).length).toBeGreaterThanOrEqual(2)
    expect(boardView('older', [projects, decisions, log, items]).flatMap(s => s.lines).length).toBeGreaterThanOrEqual(2)
  })

  it('an existing boards folder is never seeded over; a missing one is seeded', () => {
    const root = mkdtempSync(join(tmpdir(), 'demo-own-'))
    const own = join(root, 'boards')
    mkdirSync(own)
    writeFileSync(join(own, 'PROJECTS.md'), 'my own\n')
    expect(seedIfMissing(own)).toBe(false)
    expect(readdirSync(own)).toEqual(['PROJECTS.md'])
    expect(readFileSync(join(own, 'PROJECTS.md'), 'utf8')).toBe('my own\n')
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(seedIfMissing(empty)).toBe(false)
    expect(readdirSync(empty)).toEqual([])
    const fresh = join(root, 'fresh')
    expect(seedIfMissing(fresh)).toBe(true)
    expect(existsSync(join(fresh, 'PROJECTS.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The demo server end to end (speed 20)
// ---------------------------------------------------------------------------
const freePort = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
const HOME = mkdtempSync(join(tmpdir(), 'demo-srv-'))
const SPAWNED = join(HOME, 'spawned')
const STUB = join(HOME, 'stub.sh')
const UI = 'http://localhost:39999'
let PORT, TOKEN, srv, log = ''

const call = (method, path, body, headers = {}) => new Promise((res, rej) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...(data && { 'content-type': 'application/json' }), ...headers } }, r => {
    let b = ''
    r.on('data', d => (b += d))
    r.on('end', () => res({ status: r.statusCode, body: b, json: () => JSON.parse(b) }))
  }).on('error', rej)
  req.end(data)
})
const sessions = async () => (await call('GET', '/sessions')).json()
const ui = (path, body) => call('POST', path, body, { origin: UI })
async function until(fn, ms, every = 100) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await sleep(every)
  }
}

beforeAll(async () => {
  PORT = await freePort()
  writeFileSync(STUB, `#!/bin/sh\necho "$@" >> '${SPAWNED}'\n`)
  chmodSync(STUB, 0o755)
  srv = spawn('node', [join(ROOT, 'server/index.js')], {
    env: { ...process.env, HOME, AGENT_OFFICE_DEMO: '1', AGENT_OFFICE_DEMO_SPEED: '20', AGENT_OFFICE_PORT: String(PORT), AGENT_OFFICE_UI_ORIGIN: UI, AGENT_OFFICE_BOARDS_DIR: '/must/not/be/used', AGENT_OFFICE_OPEN_CMD: STUB },
  })
  srv.stdout.on('data', d => (log += d))
  srv.stderr.on('data', d => (log += d))
  await until(async () => { try { return (await call('GET', '/health')).status === 200 } catch { return false } }, 5000)
  TOKEN = readFileSync(join(HOME, '.agent-office', 'auth-token'), 'utf8')
})
afterAll(() => new Promise(r => { srv.on('exit', r); srv.kill() }))

describe('demo server', () => {
  it('boards read the temp HOME fixtures, not AGENT_OFFICE_BOARDS_DIR', async () => {
    expect((await call('GET', '/boards/status')).json().length).toBeGreaterThanOrEqual(3)
    expect((await call('GET', '/boards/decisions')).json().length).toBeGreaterThanOrEqual(2)
  })

  it('two ambient sessions within 3 s that work and never wait', async () => {
    const amb = await until(async () => { const s = await sessions(); return s.length >= 2 && s }, 3000)
    expect(amb.length).toBe(2)
    for (let i = 0; i < 20; i++) {
      expect((await sessions()).every(s => s.state !== 'waiting')).toBe(true)
      await sleep(100)
    }
  })

  it('POST /event with the valid token is a 200 no-op', async () => {
    const before = JSON.stringify((await sessions()).map(s => s.sessionId))
    const r = await call('POST', '/event', { type: 'session_event', event: 'UserPromptSubmit', sessionId: 'real-1', transcriptPath: '/x.jsonl' }, { authorization: `Bearer ${TOKEN}` })
    expect(r.status).toBe(200)
    expect(JSON.stringify((await sessions()).map(s => s.sessionId))).toBe(before)
    expect((await call('GET', '/roster')).json().activeAgents.every(a => !a.sessionId || a.sessionId !== 'real-1')).toBe(true)
  })

  it('/new runs the story: title, build-review phases in order, report, waiting, reply → Sent → back', async () => {
    const r = await ui('/sessions/new', { q: 'Build a pricing page' })
    expect(r.status).toBe(200)
    const s = await until(async () => (await sessions()).find(x => x.title === 'Build a pricing page'), 3000)
    expect(s.state).toBe('working')
    const seen = [], states = []
    let agentId, gaps = 0
    const waiting = await until(async () => {
      const x = (await sessions()).find(y => y.sessionId === s.sessionId)
      const wf = x.workflows?.[0]
      // Once shown, the workflow stays listed until every phase is done (no blink between phases)
      if (!wf && states.length && states.at(-1) !== 'done,done,done,done') gaps++
      if (wf && states.at(-1) !== wf.phases.map(p => p.state).join()) states.push(wf.phases.map(p => p.state).join())
      if (wf) {
        expect(wf.name).toBe('build-review')
        expect(wf.phases.map(p => p.title)).toEqual(['Build', 'Review', 'Prove', 'Gate'])
        const running = wf.phases.find(p => p.state === 'running')
        if (running) { expect(running.agents[0].label).toBeTruthy(); agentId ??= running.agents[0].id; if (seen.at(-1) !== running.title) seen.push(running.title) }
        // Earlier phases are done, later ones todo
        const i = wf.phases.findIndex(p => p.state !== 'done')
        if (i >= 0) expect(wf.phases.slice(i + 1).every(p => p.state === 'todo')).toBe(true)
      }
      return x.state === 'waiting' && x
    }, 15_000, 20)
    expect(seen).toEqual(['Build', 'Review', 'Prove', 'Gate'])
    expect(states[0]).toBe('todo,todo,todo,todo')
    expect(states.at(-1)).toBe('done,done,done,done')
    expect(gaps).toBe(0)
    expect(waiting.reason).toBe('turn_ended')
    expect(waiting.lastMessage).toMatch(/pricing page/i)
    expect(waiting.lastMessage).toContain(LAST)
    expect(waiting.lastMessage).toMatch(/^1\. Ship it$/m)
    const rep = (await call('GET', `/agents/${agentId}/report`)).json()
    expect(rep.steps.length).toBeGreaterThan(0)
    expect(rep.report).toBeTruthy()

    // The note's tapped option "1. Ship it" posts its text
    const reply = await ui(`/sessions/${s.sessionId}/open`, { text: 'Ship it' })
    expect(reply.json()).toEqual({ ok: true, note: 'Sent' })
    await until(async () => (await sessions()).find(y => y.sessionId === s.sessionId)?.state === 'working', 3000)
    await until(async () => !(await sessions()).some(y => y.sessionId === s.sessionId), 10_000)
    const chat = (await call('GET', '/chat')).json().messages.map(m => m.text)
    expect(chat.filter(t => t === '✅ finished: Applied the note, all tests pass.').length).toBe(1)
  }, 40_000)

  it('Open with no text and /sessions/new never spawn open', async () => {
    const [x] = await sessions()
    expect((await ui(`/sessions/${x.sessionId}/open`, {})).status).toBe(200)
    await sleep(300)
    expect(existsSync(SPAWNED)).toBe(false)
  })

  it('the /the-office toggle lines start no story and are not stored', async () => {
    const before = (await sessions()).length
    for (const text of ['🧻 Clauder Fablin mode: ON. Identity theft is not a joke.', '🔁 Office theme: OFF'])
      expect((await ui('/chat', { sender: 'Boss', text })).json()).toEqual({ ok: true })
    await sleep(500)
    expect((await sessions()).length).toBe(before)
    expect(JSON.stringify((await call('GET', '/chat')).json())).not.toMatch(/Dunder|Mifflin|Clauder Fablin/)
    expect(JSON.stringify((await call('GET', '/chat')).json())).not.toMatch(/Office theme/)
  })

  it('plain chat text starts a story; two at once get separate seats; no errors', async () => {
    await ui('/chat', { sender: 'Boss', text: 'Write the release notes' })
    await ui('/sessions/new', { q: '' })
    const two = await until(async () => {
      const s = await sessions()
      const a = s.find(x => x.title === 'Write the release notes'), b = s.find(x => x.title === DEFAULT_TASK)
      return a && b && [a, b]
    }, 3000)
    expect(two[0].seat).not.toBe(two[1].seat)
    await until(async () => (await sessions()).filter(x => x.state === 'waiting').length === 2, 15_000)
    expect(existsSync(SPAWNED)).toBe(false)
    expect(log).not.toMatch(/error|Unhandled|TypeError/i)
    expect(JSON.stringify(await sessions()) + JSON.stringify((await call('GET', '/chat')).json())).not.toMatch(/Dunder|Mifflin/)
  }, 30_000)
})
