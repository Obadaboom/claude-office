import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync, symlinkSync, chmodSync, utimesSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { request } from 'http'
import { createServer } from 'net'
import WebSocket from 'ws'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseWorkflow } from './transcripts.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Hook: python3 hooks/agent-tracker.py with stdin JSON
// ---------------------------------------------------------------------------
const hook = input => {
  const out = spawnSync('python3', [join(ROOT, 'hooks/agent-tracker.py')], { input: JSON.stringify(input) }).stdout.toString()
  return { raw: out, ev: out.trim() ? JSON.parse(out) : null }
}
const main = { session_id: 's1', transcript_path: '/p/s1.jsonl' }

describe('hook session events', () => {
  it('sends only type/event/sessionId/transcriptPath, never prompt or message text', () => {
    for (const [event, extra] of [
      ['UserPromptSubmit', { prompt: 'SECRET-P' }],
      ['Notification', { message: 'SECRET-N', notification_type: 'permission_prompt' }],
      ['SessionEnd', { reason: 'exit' }],
    ]) {
      const { raw, ev } = hook({ hook_event_name: event, ...main, ...extra })
      expect(raw).not.toContain('SECRET')
      expect(ev).toEqual({ type: 'session_event', event, sessionId: 's1', transcriptPath: '/p/s1.jsonl' })
    }
  })

  it("Stop is 2a2's turn end, with sessionId + transcriptPath, never the message", () => {
    const { raw, ev } = hook({ hook_event_name: 'Stop', ...main, last_assistant_message: 'SECRET-M' })
    expect(raw).not.toContain('SECRET')
    expect(ev).toEqual({ type: 'agent_working', agentId: 'assistant-claude', status: '', turnEnd: true, sessionId: 's1', transcriptPath: '/p/s1.jsonl' })
  })

  it('main-thread tool events carry sessionId + transcriptPath, never the command; no ids when the hook has none', () => {
    const { raw, ev } = hook({ hook_event_name: 'PreToolUse', ...main, tool_name: 'Bash', tool_input: { command: 'SECRET-C', description: 'list' } })
    expect(raw).not.toContain('SECRET')
    expect(ev).toMatchObject({ type: 'agent_working', agentId: 'assistant-claude', sessionId: 's1', transcriptPath: '/p/s1.jsonl' })
    const bare = hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x' } }).ev
    expect(Object.keys(bare)).not.toContain('sessionId')
    expect(Object.keys(bare)).not.toContain('transcriptPath')
  })

  it('subagent events carry the parent sessionId (2c); SubagentStart transcriptPath, SubagentStop agentTranscriptPath, subagent tools no transcriptPath', () => {
    const sub = { ...main, agent_id: 'abc', agent_type: 'Explore' }
    const start = hook({ hook_event_name: 'SubagentStart', ...sub }).ev
    expect(start).toMatchObject({ type: 'agent_spawned', transcriptPath: '/p/s1.jsonl', sessionId: 's1' })
    const stop = hook({ hook_event_name: 'SubagentStop', ...sub, agent_transcript_path: '/p/s1/subagents/agent-abc.jsonl', last_assistant_message: 'all done' })
    expect(stop.ev).toEqual({ type: 'agent_completed', agentId: 'agent-abc', result: 'all done', agentTranscriptPath: '/p/s1/subagents/agent-abc.jsonl', sessionId: 's1' })
    for (const [event, extra] of [['PreToolUse', { tool_input: { file_path: '/a/x.ts' } }], ['PostToolUse', {}]]) {
      const tool = hook({ hook_event_name: event, ...sub, tool_name: 'Read', ...extra }).ev
      expect(tool).toMatchObject({ agentId: 'agent-abc', sessionId: 's1' }) // 2a2: the parent session
      expect(tool.transcriptPath).toBeUndefined()
    }
    const seen = hook({ hook_event_name: 'PreToolUse', ...sub, tool_name: 'WebFetch', tool_input: { url: 'SECRET-U' } })
    expect(seen.raw).not.toContain('SECRET')
    expect(seen.ev).toEqual({ type: 'agent_seen', agentId: 'agent-abc', role: 'Explore', name: 'Explorer', sessionId: 's1' })
  })

  it('agent-tracker.sh prints nothing to stdout', () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
    for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse']) {
      const r = spawnSync('bash', [join(ROOT, 'hooks/agent-tracker.sh')], {
        input: JSON.stringify({ hook_event_name: ev, ...main, agent_id: ev.startsWith('Subagent') ? 'abc' : undefined, prompt: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }),
        env: { ...process.env, HOME: home, AGENT_OFFICE_URL: 'http://127.0.0.1:1' },
      })
      expect(r.stdout.toString(), ev).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// 2s: parseWorkflow (pure; the script is text, never run)
// ---------------------------------------------------------------------------
const SCRIPT = `import x from 'y'
export const meta = {
  name: 'ship-prod',
  description: "Ship a branch, then smoke it",
  phases: [
    { title: 'Pre-flight' },
    { title: "Apply + deploy" },
    { title: \`Smoke\` },
    { title: 'Verify' },
  ],
}
process.exit(1)
throw new Error('ran')
`
const jl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

describe('parseWorkflow', () => {
  it("name + titles in order from ' \" ` strings; code after meta never runs", () => {
    const w = parseWorkflow(SCRIPT, '')
    expect(w.name).toBe('ship-prod')
    expect(w.phases.map(p => p.title)).toEqual(['Pre-flight', 'Apply + deploy', 'Smoke', 'Verify'])
    expect(w.phases.every(p => p.state === 'todo' && p.agents.length === 0)).toBe(true)
  })

  it('done / running / failed / todo; extra journal phase appended; untitled group last', () => {
    const w = parseWorkflow(SCRIPT, jl([
      { type: 'launched' },
      { type: 'started', agentId: 'a1', label: 'preflight', phase: 'Pre-flight' },
      { type: 'result', agentId: 'a1', result: { ok: true } },
      { type: 'started', agentId: 'old', label: 'legacy' },
      { type: 'started', agentId: 'a2', label: 'deployer', phase: 'Apply + deploy' },
      { type: 'failed', agentId: 'a2' },
      { type: 'started', agentId: 'a3', label: 'smoke', phase: 'Smoke' },
      { type: 'started', agentId: 'a4', label: 'extra', phase: 'Bonus' },
      { type: 'result', agentId: 'a4' },
    ]) + 'not json\n')
    expect(w.phases).toEqual([
      { title: 'Pre-flight', state: 'done', agents: [] },
      { title: 'Apply + deploy', state: 'failed', agents: [] },
      { title: 'Smoke', state: 'running', agents: [{ id: 'agent-a3', label: 'smoke' }] },
      { title: 'Verify', state: 'todo', agents: [] },
      { title: 'Bonus', state: 'done', agents: [] },
      { title: '', state: 'running', agents: [{ id: 'agent-old', label: 'legacy' }] },
    ])
  })

  it('retried key: only the latest attempt shows; its outcome alone sets the state', () => {
    const w = parseWorkflow(SCRIPT, jl([
      { type: 'started', key: 'k1', agentId: 's1', label: 'smoke', phase: 'Smoke' },
      { type: 'failed', key: 'k1', agentId: 's1' },
      { type: 'started', key: 'k1', agentId: 's2', label: 'smoke', phase: 'Smoke' },
      { type: 'result', key: 'k1', agentId: 's2' },
      { type: 'started', key: 'k2', agentId: 'v1', label: 'verifier', phase: 'Verify' },
      { type: 'started', key: 'k2', agentId: 'v2', label: 'verifier', phase: 'Verify' },
      { type: 'started', key: 'k2', agentId: 'v3', label: 'verifier', phase: 'Verify' },
      { type: 'result', key: 'k2', agentId: 'v1' },
    ]))
    expect(w.phases.slice(2)).toEqual([
      { title: 'Smoke', state: 'done', agents: [] },
      { title: 'Verify', state: 'running', agents: [{ id: 'agent-v3', label: 'verifier' }] },
    ])
    const done = parseWorkflow(SCRIPT, jl([
      { type: 'started', key: 'k2', agentId: 'v1', label: 'verifier', phase: 'Verify' },
      { type: 'started', key: 'k2', agentId: 'v2', label: 'verifier', phase: 'Verify' },
      { type: 'failed', key: 'k2', agentId: 'v2' },
      { type: 'started', key: 'k2', agentId: 'v3', label: 'verifier', phase: 'Verify' },
      { type: 'result', key: 'k2', agentId: 'v3' },
    ]))
    expect(done.phases[3]).toEqual({ title: 'Verify', state: 'done', agents: [] })
  })

  it('no meta block → no name, journal phases only', () => {
    const w = parseWorkflow('process.exit(1)', jl([{ type: 'started', agentId: 'b', label: 'l', phase: 'P' }]))
    expect(w.name).toBe('')
    expect(w.phases).toEqual([{ title: 'P', state: 'running', agents: [{ id: 'agent-b', label: 'l' }] }])
  })
})

// ---------------------------------------------------------------------------
// Server: node server/index.js on a free port with HOME=<scratch>
// ---------------------------------------------------------------------------
const freePort = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
const HOME = mkdtempSync(join(tmpdir(), 'office-2de-'))
const PROJ = join(HOME, '.claude', 'projects', 'p')
let PORT, TOKEN, srv

const call = (method, path, { headers = {}, body } = {}) => new Promise((res, rej) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...(data && { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }), ...headers } }, r => {
    let b = ''
    r.on('data', d => (b += d))
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b, json: () => JSON.parse(b) }))
  }).on('error', rej)
  req.end(data)
})
const get = (path, headers) => call('GET', path, { headers })
const post = body => call('POST', '/event', { body })

const w = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n') }
const userLine = content => ({ type: 'user', message: { role: 'user', content } })
const asst = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
const tool = (name, input = {}) => ({ type: 'tool_use', id: 't', name, input })
const text = t => ({ type: 'text', text: t })

const SID = 'sess-1'
const SESSION = join(PROJ, `${SID}.jsonl`)
const LIVE = join(PROJ, SID, 'subagents', 'workflows', 'wf_x', 'agent-r1.jsonl')
const OPENED = join(HOME, 'opened.txt') // 2n: the stub OPEN_CMD appends each URL here; the real `open` never runs
const OPEN_STUB = join(HOME, 'open-stub.sh')
const APP_FILE = join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'a', 'b', 'local_x.json')

beforeAll(async () => {
  PORT = await freePort()
  writeFileSync(OPEN_STUB, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${OPENED}'\n`)
  chmodSync(OPEN_STUB, 0o755)
  w(SESSION, [userLine('hi'), asst(text('first answer'))])
  w(LIVE, [
    userLine('Build the thing'),
    asst(tool('Bash', { command: 'rm -rf SECRET-CMD', description: 'list files' })),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'big output' }] } },
    asst(tool('Read', { file_path: '/a/b/read.ts' }), tool('Read', { file_path: '/a/b/read.ts' })),
    asst(tool('Edit', { file_path: '/a/b/edit.ts' }), tool('Grep', { pattern: 'foo', path: '/a/src' })),
    asst(tool('mcp__srv__do_thing', { q: 1 }), tool('NotebookEdit', { notebook_path: '/a/n.ipynb' })),
    asst(tool('Bash', { command: 'ls SECRET-CMD2' }), tool('mcp__claude_ai_Vercel__list_projects', {})),
    asst(tool(`mcp__srv__${'x_'.repeat(40)}`, {})),
    asst(text('Interim note')),
  ])
  srv = spawn('node', [join(ROOT, 'server/index.js')], {
    env: { ...process.env, HOME, AGENT_OFFICE_PORT: String(PORT), AGENT_OFFICE_SESSION_MS: '1500', AGENT_OFFICE_STALE_MS: '800', AGENT_OFFICE_OPEN_CMD: OPEN_STUB }, stdio: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try { if ((await get('/health')).status === 200) break } catch {}
    await sleep(100)
  }
  TOKEN = readFileSync(join(HOME, '.agent-office', 'auth-token'), 'utf8')
})
afterAll(() => new Promise(r => { srv.on('exit', r); srv.kill() }))

const spawnAgent = (raw, extra = {}) => post({ type: 'agent_spawned', agent: { id: `agent-${raw}`, name: 'Agent', role: 'general-purpose', task: '' }, transcriptPath: SESSION, ...extra })
const stopAgent = (raw, agentTranscriptPath) => post({ type: 'agent_completed', agentId: `agent-${raw}`, result: 'done', agentTranscriptPath })
const report = raw => get(`/agents/agent-${raw}/report`)

// ---------------------------------------------------------------------------
// 2s: GET /sessions workflows + labels (before the report tests: agent-r1 still running)
// ---------------------------------------------------------------------------
describe('2s workflows on GET /sessions', () => {
  const wj = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)) }
  const script = (name, ...titles) => `export const meta = {\n  name: '${name}',\n  phases: [${titles.map(t => `{ title: "${t}" }`).join(', ')}],\n}\nprocess.exit(1)\n`
  const journal = (...started) => started.map(([agentId, label, phase]) => JSON.stringify({ type: 'started', agentId, label, phase })).join('\n') + '\n'
  const live = (sessionId, transcriptPath, ...raws) => Promise.all(raws.map(raw => post({ type: 'agent_spawned', agent: { id: `agent-${raw}`, name: 'Agent', role: 'general-purpose', task: '' }, transcriptPath, sessionId })))
  const start = (sessionId, transcriptPath) => post({ type: 'session_event', event: 'UserPromptSubmit', sessionId, transcriptPath })
  const end = sessionId => post({ type: 'session_event', event: 'SessionEnd', sessionId })
  const sessionsBody = async () => (await get('/sessions')).body
  const one = async id => JSON.parse(await sessionsBody()).find(x => x.sessionId === id)

  it('a live workflow agent → its workflow name, phases in meta order, the running phase lists it with since', async () => {
    const wf = join(PROJ, SID, 'subagents', 'workflows', 'wf_x')
    wj(join(wf, 'agent-r1.meta.json'), { description: 'builder', workflowPhase: 'Build' })
    wj(join(wf, 'journal.jsonl'), '{"type":"launched"}\n' + journal(['r0', 'planner', 'Plan']) + '{"type":"result","agentId":"r0"}\n' + journal(['r1', 'builder', 'Build']))
    wj(join(PROJ, SID, 'workflows', 'scripts', 'build-review-wf_x.js'), script('build-review', 'Plan', 'Build', 'Review'))
    wj(join(PROJ, SID, 'workflows', 'scripts', 'plan-wf_other.js'), script('plan', 'Nope'))
    await start(SID, SESSION)
    await live(SID, SESSION, 'r1')
    const s = await one(SID)
    expect(s.workflows).toHaveLength(1)
    expect(s.workflows[0].name).toBe('build-review')
    expect(s.workflows[0].phases.map(p => [p.title, p.state])).toEqual([['Plan', 'done'], ['Build', 'running'], ['Review', 'todo']])
    expect(s.workflows[0].phases[1].agents).toEqual([{ id: 'agent-r1', label: 'builder', since: expect.any(Number) }])
    expect(s.labels).toEqual({})
    await end(SID)
  })

  it('a live plain agent → labels[id] = its meta description; never its job text', async () => {
    const f = join(PROJ, 'pl', 'subagents', 'agent-pl1.jsonl')
    w(f, [userLine('Build the thing'), asst(text('ok'))])
    wj(f.replace('.jsonl', '.meta.json'), { agentType: 'general-purpose', description: 'Run gate once' })
    w(join(PROJ, 'pl', 'subagents', 'agent-pl2.jsonl'), [userLine('Build the thing')]) // no meta.json
    await start('pl', join(PROJ, 'pl.jsonl'))
    await live('pl', join(PROJ, 'pl.jsonl'), 'pl1', 'pl2')
    const s = await one('pl')
    expect(s.labels).toEqual({ 'agent-pl1': 'Run gate once' })
    expect(s.workflows).toEqual([])
    const body = await sessionsBody()
    expect(body).not.toContain('Build the thing')
    expect(body).not.toMatch(/prompt/)
    await end('pl')
  })

  it("script saved under a sibling project's <sid> dir (session cd'd) → found; a sibling scripts dir symlinked out is skipped", async () => {
    const cx = join(PROJ, 'cx'), out = join(HOME, 'outside-2s-cx')
    w(join(cx, 'subagents', 'workflows', 'wf_c', 'agent-c1.jsonl'), [userLine('job')])
    wj(join(cx, 'subagents', 'workflows', 'wf_c', 'journal.jsonl'), journal(['c1', 'reviewer r1', 'Review']))
    wj(join(cx, 'workflows', 'scripts', 'plan-wf_other.js'), script('plan', 'Nope')) // own dir: not this wf
    wj(join(out, 'z-wf_c.js'), script('OUTSIDE-NAME', 'OUTSIDE-TITLE'))
    mkdirSync(join(HOME, '.claude', 'projects', 'p-evil', 'cx', 'workflows'), { recursive: true }) // sorts before p-projects-x
    symlinkSync(out, join(HOME, '.claude', 'projects', 'p-evil', 'cx', 'workflows', 'scripts'))
    wj(join(HOME, '.claude', 'projects', 'p-projects-x', 'cx', 'workflows', 'scripts', 'build-review-wf_c.js'), script('build-review', 'Build', 'Review', 'Fix', 'Gate'))
    await start('cx', `${cx}.jsonl`); await live('cx', `${cx}.jsonl`, 'c1')
    const s = await one('cx')
    expect(s.workflows).toHaveLength(1)
    expect(s.workflows[0].name).toBe('build-review')
    expect(s.workflows[0].phases.map(p => [p.title, p.state])).toEqual([['Build', 'todo'], ['Review', 'running'], ['Fix', 'todo'], ['Gate', 'todo']])
    expect(await sessionsBody()).not.toMatch(/OUTSIDE/)
    await end('cx')
  })

  it('no script anywhere (ship-prod-tworun) → journal phases, no name; an empty journal → no workflow, meta label instead', async () => {
    const ns = join(PROJ, 'ns')
    w(join(ns, 'subagents', 'workflows', 'wf_n', 'agent-n1.jsonl'), [userLine('job')])
    wj(join(ns, 'subagents', 'workflows', 'wf_n', 'journal.jsonl'), '{"type":"launched"}\n' + journal(['n1', 'smoke', 'Smoke']))
    w(join(ns, 'subagents', 'workflows', 'wf_e', 'agent-e1.jsonl'), [userLine('job')])
    wj(join(ns, 'subagents', 'workflows', 'wf_e', 'agent-e1.meta.json'), { description: 'verifier' })
    wj(join(ns, 'subagents', 'workflows', 'wf_e', 'journal.jsonl'), '{"type":"launched"}\n')
    await start('ns', `${ns}.jsonl`); await live('ns', `${ns}.jsonl`, 'n1', 'e1')
    const s = await one('ns')
    expect(s.workflows).toEqual([{ name: '', phases: [{ title: 'Smoke', state: 'running', agents: [{ id: 'agent-n1', label: 'smoke', since: expect.any(Number) }] }] }])
    expect(s.labels).toEqual({ 'agent-e1': 'verifier' })
    await end('ns')
  })

  it('symlinks out of projects and bad wf dir names give no workflow and no outside text; server stays up', async () => {
    const out = join(HOME, 'outside-2s')
    wj(join(out, 'journal.jsonl'), journal(['j1', 'OUTSIDE-LABEL', 'OUTSIDE-PHASE']))
    wj(join(out, 'agent-m1.meta.json'), { description: 'OUTSIDE-DESC' })
    wj(join(out, 'scripts', 'x-wf_s.js'), script('OUTSIDE-NAME', 'OUTSIDE-TITLE'))
    // session sx: symlinked journal, symlinked plain meta.json, dirs `nope` and `wf_..`
    const sx = join(PROJ, 'sx'), wfs = join(sx, 'subagents', 'workflows')
    w(join(wfs, 'wf_j', 'agent-j1.jsonl'), [userLine('job')])
    symlinkSync(join(out, 'journal.jsonl'), join(wfs, 'wf_j', 'journal.jsonl'))
    wj(join(sx, 'workflows', 'scripts', 'a-wf_j.js'), script('jname', 'J'))
    w(join(sx, 'subagents', 'agent-m1.jsonl'), [userLine('job')])
    symlinkSync(join(out, 'agent-m1.meta.json'), join(sx, 'subagents', 'agent-m1.meta.json'))
    for (const [dir, raw] of [['nope', 'n1'], ['wf_..', 'n2']]) {
      w(join(wfs, dir, `agent-${raw}.jsonl`), [userLine('job')])
      wj(join(wfs, dir, 'journal.jsonl'), journal([raw, 'BAD-LABEL', 'BAD-PHASE']))
      wj(join(sx, 'workflows', 'scripts', `b-${dir}.js`), script('BAD-NAME', 'BAD-TITLE'))
    }
    // session sy: scripts dir symlinked out
    const sy = join(PROJ, 'sy')
    w(join(sy, 'subagents', 'workflows', 'wf_s', 'agent-s1.jsonl'), [userLine('job')])
    wj(join(sy, 'subagents', 'workflows', 'wf_s', 'journal.jsonl'), journal(['s1', 'fine', 'S']))
    mkdirSync(join(sy, 'workflows'), { recursive: true })
    symlinkSync(join(out, 'scripts'), join(sy, 'workflows', 'scripts'))
    await start('sx', `${sx}.jsonl`); await live('sx', `${sx}.jsonl`, 'j1', 'm1', 'n1', 'n2')
    await start('sy', `${sy}.jsonl`); await live('sy', `${sy}.jsonl`, 's1')
    const r = await get('/sessions')
    expect(r.status).toBe(200)
    const list = r.json()
    expect(list.find(x => x.sessionId === 'sx').workflows).toEqual([])
    // sy: the symlinked script is never read; the in-projects journal alone still gives its phases
    expect(list.find(x => x.sessionId === 'sy').workflows).toEqual([{ name: '', phases: [{ title: 'S', state: 'running', agents: [{ id: 'agent-s1', label: 'fine', since: expect.any(Number) }] }] }])
    expect(r.body).not.toMatch(/OUTSIDE|BAD-/)
    expect((await get('/health')).status).toBe(200)
    await end('sx'); await end('sy')
  })
})

describe('GET /agents/:id/report', () => {
  it('live report for a running agent, then done with the final text', async () => {
    await spawnAgent('r1')
    await post({ type: 'agent_working', agentId: 'agent-r1', status: 'reading x' })
    const r = await report('r1')
    expect(r.status).toBe(200)
    const j = r.json()
    expect(j).toMatchObject({ id: 'agent-r1', state: 'running', job: 'Build the thing', report: 'Interim note' })
    expect(j.steps).toEqual([
      { tool: 'Bash', label: 'list files' },
      { tool: 'Read', label: 'reading read.ts' },
      { tool: 'Read', label: 'reading read.ts' },
      { tool: 'Edit', label: 'editing edit.ts' },
      { tool: 'Grep', label: "searching for 'foo'" },
      { tool: 'mcp__srv__do_thing', label: 'do thing' },
      { tool: 'NotebookEdit', label: 'NotebookEdit' },
      { tool: 'Bash', label: 'running a command' },
      { tool: 'mcp__claude_ai_Vercel__list_projects', label: 'list projects' },
      { tool: `mcp__srv__${'x_'.repeat(40)}`, label: 'x '.repeat(30) },
    ])
    expect(j.filesRead).toEqual(['/a/b/read.ts', '/a/src'])
    expect(j.filesChanged).toEqual(['/a/b/edit.ts', '/a/n.ipynb'])
    expect(r.body).not.toContain('SECRET')

    appendFileSync(LIVE, JSON.stringify(asst(text('All done.'))) + '\n')
    await stopAgent('r1', LIVE)
    expect((await report('r1')).json()).toMatchObject({ state: 'done', report: 'All done.' })
  })

  it('StructuredOutput is the report when it comes last', async () => {
    const f = join(PROJ, SID, 'subagents', 'agent-r2.jsonl')
    w(f, [userLine([text('Do it')]), asst(text('Let me look.')), asst(tool('StructuredOutput', { summary: 'x', files: ['a'] }))])
    await spawnAgent('r2')
    await stopAgent('r2', f)
    expect((await report('r2')).json()).toMatchObject({ state: 'done', job: 'Do it', report: JSON.stringify({ summary: 'x', files: ['a'] }) })
  })

  it('caps job 600, steps 50 (newest), report 4000', async () => {
    const f = join(PROJ, SID, 'subagents', 'agent-r3.jsonl')
    w(f, [userLine('j'.repeat(1000)), ...Array.from({ length: 70 }, (_, i) => asst(tool('Read', { file_path: `/f${i}.ts` }))), asst(text('r'.repeat(5000)))])
    await spawnAgent('r3')
    const j = (await report('r3')).json()
    expect(j.job).toHaveLength(600)
    expect(j.steps).toHaveLength(50)
    expect(j.steps.at(-1).label).toBe('reading f69.ts')
    expect(j.report).toHaveLength(4000)
  })

  it('404 for paths outside ~/.claude/projects, symlinks out, unknown ids; query paths ignored', async () => {
    const outside = join(HOME, 'outside', 'agent-r4.jsonl')
    w(outside, [userLine('OUTSIDE-JOB'), asst(text('OUTSIDE'))])
    await spawnAgent('r4'); await stopAgent('r4', outside)
    await spawnAgent('r5'); await stopAgent('r5', join(HOME, '.claude', 'projects', '..', 'outside', 'agent-r4.jsonl'))
    await spawnAgent('r6'); await stopAgent('r6', '/etc/passwd')
    const link = join(PROJ, 'link.jsonl')
    symlinkSync(outside, link)
    await spawnAgent('r7'); await stopAgent('r7', link)
    // live lookup never follows a symlinked dir out of projects
    w(join(HOME, 'outside', 'dir', 'agent-r8.jsonl'), [userLine('OUTSIDE-JOB')])
    symlinkSync(join(HOME, 'outside', 'dir'), join(PROJ, SID, 'subagents', 'workflows', 'wf_link'))
    await spawnAgent('r8')
    for (const raw of ['r4', 'r5', 'r6', 'r7', 'r8', 'nope']) {
      const r = await report(raw)
      expect(r.status, raw).toBe(404)
      expect(r.body).not.toContain('OUTSIDE')
    }
    expect((await get(`/agents/agent-r4/report?path=${encodeURIComponent(outside)}`)).status).toBe(404)
    expect((await get('/agents/agent-..%2F..%2Fx/report')).status).toBe(404)
  })
})

describe('sessions', () => {
  const ws = () => new Promise(r => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const msgs = [], all = []
    s.on('message', d => { const m = JSON.parse(d.toString()); all.push(m); if (m.type === 'session_changed') msgs.push(m) })
    s.on('open', () => r({ s, msgs, all }))
  })
  const sev = (event, sessionId, transcriptPath = SESSION) => post(event === 'Stop'
    ? { type: 'agent_working', agentId: 'assistant-claude', status: '', turnEnd: true, sessionId, transcriptPath } // 2a2's turn end
    : { type: 'session_event', event, sessionId, transcriptPath })
  const find = async id => (await get('/sessions')).json().find(x => x.sessionId === id)
  // state[/reason] changes only (2c also sends seat / busy / step changes)
  const states = (msgs, id) => msgs.filter(m => !id || m.sessionId === id).map(m => m.state + (m.reason ? `/${m.reason}` : '')).filter((x, i, a) => x !== a[i - 1])
  const VIEW_KEYS = ['type', 'sessionId', 'state', 'reason', 'seat', 'busy', 'runningAgents', 'currentStep', 'prompt']
  const agentEv = (type, raw, sessionId, extra = {}) => post(type === 'agent_spawned'
    ? { type, agent: { id: `agent-${raw}`, name: 'Agent', role: 'general-purpose', task: '' }, transcriptPath: SESSION, sessionId, ...extra }
    : { type, agentId: `agent-${raw}`, sessionId, role: 'Explore', name: 'Explorer', ...extra })

  it('working / waiting / back over WS, GET /sessions with lastMessage', async () => {
    writeFileSync(SESSION, [userLine('hi'), asst(text('SECRET-OLD')), asst(tool('Bash', {}), text('L'.repeat(5000))), userLine([{ type: 'tool_result', content: 'x' }])].map(l => JSON.stringify(l)).join('\n') + '\n')
    const { s, msgs, all } = await ws()
    const step = async (fn, expected) => { await fn(); await sleep(80); expect(states(msgs)).toEqual(expected) }
    const e = []
    e.push('working')
    await step(() => sev('UserPromptSubmit', 's1'), e)
    let got = await find('s1')
    expect(got).toMatchObject({ state: 'working' })
    expect(got.lastMessage).toBeUndefined()
    await post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading y', stepId: 'j1', sessionId: 's1' })
    e.push('waiting/turn_ended')
    await step(() => sev('Stop', 's1'), e)
    // the turn end is observed, not consumed: 2a2 still clears Jim's steps of that session
    expect(all.filter(m => m.type === 'agent_working' && m.agentId === 'assistant-claude').map(m => m.status)).toEqual(['reading y', ''])
    const n = msgs.length
    await step(() => sev('Stop', 's1'), e)
    expect(msgs).toHaveLength(n) // same view: no repeat
    // a subagent's step never changes a session's state (2c: busy covers it)
    await step(() => agentEv('agent_working', 'bg1', 's1', { status: 'reading z', stepId: 'k1' }), e)
    await step(() => agentEv('agent_seen', 'bg1', 's1'), e)
    got = await find('s1')
    expect(got).toMatchObject({ state: 'waiting', reason: 'turn_ended', busy: true, lastMessage: 'L'.repeat(4000) })
    e.push('working')
    await step(() => post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading x', sessionId: 's1' }), e)
    e.push('waiting/needs_input')
    await step(() => sev('Notification', 's1'), e)
    e.push('back')
    await step(() => sev('SessionEnd', 's1'), e)
    expect(await find('s1')).toBeUndefined()
    expect(msgs.every(m => m.sessionId === 's1' && Object.keys(m).every(k => VIEW_KEYS.includes(k)))).toBe(true)
    expect(JSON.stringify(msgs)).not.toMatch(/SECRET|LLL/)
    s.close()
  })

  it('Send back: dismiss a waiting session → idle + one broadcast; 403 bad Origin / Host; 404 unknown; later Stop → waiting, prompt → working', async () => {
    const { s, msgs } = await ws()
    const UI = { origin: 'http://localhost:3333' }
    const dismiss = (id, headers = UI) => call('POST', `/sessions/${id}/dismiss`, { headers })
    const mine = () => msgs.filter(m => m.sessionId === 'W')
    await sev('UserPromptSubmit', 'W'); await sev('Stop', 'W'); await sleep(60)
    const n = mine().length
    for (const h of [{}, { origin: `http://localhost:${PORT}` }, { origin: 'http://evil.test' }, { ...UI, host: `evil.test:${PORT}` }]) {
      expect((await dismiss('W', h)).status, JSON.stringify(h)).toBe(403)
    }
    for (const id of ['nope', 'bad%20id', '..']) expect((await dismiss(id)).status, id).toBe(404)
    await sleep(60)
    expect(mine()).toHaveLength(n)
    expect(await find('W')).toMatchObject({ state: 'waiting', reason: 'turn_ended' })
    const r = await dismiss('W')
    expect(r.status).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3333')
    await sleep(500) // past one sync tick: nothing flips it back
    expect(mine().slice(n)).toEqual([expect.objectContaining({ state: 'idle', busy: false })])
    expect(mine().at(-1).reason).toBeUndefined()
    const got = await find('W')
    expect(got.state).toBe('idle')
    expect(got.lastMessage).toBeUndefined()
    await sev('Stop', 'W'); await sleep(60)
    expect(await find('W')).toMatchObject({ state: 'waiting', reason: 'turn_ended' })
    await dismiss('W')
    await sev('UserPromptSubmit', 'W'); await sleep(60)
    expect((await find('W')).state).toBe('working')
    expect((await dismiss('W')).status).toBe(200) // only a waiting session is sent back
    expect((await find('W')).state).toBe('working')
    expect(states(msgs, 'W')).toEqual(['working', 'waiting/turn_ended', 'idle', 'waiting/turn_ended', 'idle', 'working'])
    await sev('SessionEnd', 'W')
    s.close()
  })

  it('lastMessage found past a 64 KB tail of tool output', async () => {
    const f = join(PROJ, 'big.jsonl')
    w(f, [asst(text('the answer')), userLine([{ type: 'tool_result', content: 'z'.repeat(200_000) }])])
    await sev('Stop', 's2', f)
    expect(await find('s2')).toMatchObject({ state: 'waiting', lastMessage: 'the answer' })
    await sev('SessionEnd', 's2', f)
  })

  it('a session transcript outside projects gives no lastMessage', async () => {
    const f = join(HOME, 'outside', 's3.jsonl')
    w(f, [asst(text('OUTSIDE'))])
    await sev('Stop', 's3', f)
    const got = await find('s3')
    expect(got.state).toBe('waiting')
    expect(got.lastMessage).toBeUndefined()
    await sev('SessionEnd', 's3', f)
  })

  it('a silent session expires to back', async () => {
    const { s, msgs } = await ws()
    await sev('UserPromptSubmit', 's4')
    await sleep(3000)
    expect(states(msgs, 's4')).toEqual(['working', 'back'])
    expect(await find('s4')).toBeUndefined()
    s.close()
  })

  it('prompt: only UserPromptSubmit flags its one session_changed (2i "on it"); never snapshot, GET or any other event', async () => {
    const { s, msgs } = await ws()
    const prompts = () => msgs.filter(m => m.sessionId === 'p1' && m.prompt).length
    await sev('UserPromptSubmit', 'p1'); await sleep(80)
    expect(prompts()).toBe(1)
    await sev('UserPromptSubmit', 'p1'); await sleep(80) // same view (already working): still you asking again
    expect(prompts()).toBe(2)
    for (const fn of [
      () => post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading x', stepId: 'p1s', sessionId: 'p1' }),
      () => agentEv('agent_spawned', 'pa1', 'p1'),
      () => agentEv('agent_working', 'pa1', 'p1', { status: 'y', stepId: 'p1a' }),
      () => agentEv('agent_completed', 'pa1', 'p1'),
      () => sev('Stop', 'p1'),
      () => sev('Notification', 'p1'),
      () => post({ type: 'agent_working', agentId: 'assistant-claude', status: 'z', stepId: 'p1t', sessionId: 'p1' }),
    ]) { await fn(); await sleep(80) }
    expect(prompts()).toBe(2)
    expect(msgs.filter(m => m.sessionId === 'p1' && 'prompt' in m).every(m => m.prompt === true)).toBe(true)
    expect(JSON.stringify((await get('/sessions')).json())).not.toMatch(/prompt/)
    const snap = await new Promise(r => {
      const c = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
      c.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'snapshot') { c.close(); r(m) } })
    })
    expect(JSON.stringify(snap.sessions)).not.toMatch(/prompt/)
    await sev('SessionEnd', 'p1'); await sleep(80)
    expect(prompts()).toBe(2)
    s.close()
  })

  it("an agent's steps keep its session alive; a main-thread step re-creates an unknown one", async () => {
    const { s, msgs } = await ws()
    await sev('UserPromptSubmit', 's5')
    for (let i = 0; i < 12; i++) {
      await agentEv('agent_working', 'w1', 's5', { status: 'x', stepId: `w${i}` })
      await sleep(250)
    }
    expect(states(msgs, 's5')).toEqual(['working'])
    expect(await find('s5')).toMatchObject({ state: 'working', runningAgents: 1, busy: true })
    // office restarted mid-turn (or expired): the next main-thread step brings it back as working
    await post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading x', stepId: 'm1', sessionId: 's6' })
    await sleep(80)
    expect(await find('s6')).toMatchObject({ state: 'working' })
    await sev('SessionEnd', 's5'); await sev('SessionEnd', 's6')
    s.close()
  })

  // -------------------------------------------------------------------------
  // 2n: app session names, Open, /new
  // -------------------------------------------------------------------------

  const UI = { origin: 'http://localhost:3333' }
  const opened = () => { try { return readFileSync(OPENED, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const appFile = (title, extra = {}) => { mkdirSync(dirname(APP_FILE), { recursive: true }); writeFileSync(APP_FILE, JSON.stringify({ sessionId: 'local_x', cliSessionId: 's1', title, ...extra })) }

  it('title + appId from the app session file whose cliSessionId matches; a retitle reaches the next sweep; no file → neither field', async () => {
    appFile('Row 2h')
    const { s, msgs } = await ws()
    await sev('UserPromptSubmit', 's1'); await sev('UserPromptSubmit', 'n1'); await sleep(80)
    expect(await find('s1')).toMatchObject({ title: 'Row 2h', appId: 'local_x' })
    expect(msgs.filter(m => m.sessionId === 's1').at(-1)).toMatchObject({ title: 'Row 2h', appId: 'local_x' })
    const n1 = await find('n1')
    expect('title' in n1 || 'appId' in n1).toBe(false)
    appFile('Row 2h renamed')
    utimesSync(APP_FILE, new Date(), new Date(Date.now() + 5000))
    await sleep(600) // one sweep tick (400 ms here)
    expect(msgs.filter(m => m.sessionId === 's1').at(-1)).toMatchObject({ type: 'session_changed', title: 'Row 2h renamed', appId: 'local_x' })
    await sev('SessionEnd', 'n1')
    s.close()
  })

  it('Open: continue URL for a valid appId, needs-input otherwise; 404 unknown; 403 wrong origin with nothing opened', async () => {
    const open = (id, headers = UI) => call('POST', `/sessions/${id}/open`, { headers })
    await sev('UserPromptSubmit', 's1'); await sev('UserPromptSubmit', 'n2')
    const before = opened().length
    for (const h of [{}, { origin: 'http://evil.test' }, { ...UI, host: `evil.test:${PORT}` }]) expect((await open('s1', h)).status, JSON.stringify(h)).toBe(403)
    expect((await open('nope')).status).toBe(404)
    expect(opened()).toHaveLength(before)
    expect((await open('s1')).status).toBe(200)
    expect((await open('n2')).status).toBe(200)
    expect(opened().slice(before)).toEqual(['claude://code/continue?session=local_x', 'claude://code/needs-input'])
    await sev('SessionEnd', 's1')
    appFile('Bad', { sessionId: 'bad id' })
    await sev('UserPromptSubmit', 's1')
    expect(await find('s1')).toMatchObject({ appId: 'bad id' })
    expect((await open('s1')).status).toBe(200)
    expect(opened().at(-1)).toBe('claude://code/needs-input')
    await sev('SessionEnd', 's1'); await sev('SessionEnd', 'n2')
  })

  it('/new: opens code/new with the home folder and q; 400 on a bad q; 403 wrong origin; nothing opened on any error', async () => {
    const neu = (body, headers = UI) => call('POST', '/sessions/new', { headers, body })
    const before = opened().length
    expect((await neu({ q: 'x' }, { origin: 'http://evil.test' })).status).toBe(403)
    expect((await neu({ q: 'x' }, { ...UI, host: `evil.test:${PORT}` })).status).toBe(403)
    for (const q of [5, null, ['a'], { a: 1 }, 'y'.repeat(2001)]) expect((await neu({ q })).status, JSON.stringify(q)?.slice(0, 20)).toBe(400)
    expect(opened()).toHaveLength(before)
    expect((await neu({ q: 'fix the & bug' })).status).toBe(200)
    expect((await neu({})).status).toBe(200)
    const folder = new URLSearchParams({ folder: HOME }).toString()
    expect(opened().slice(before)).toEqual([`claude://code/new?${folder}&q=fix+the+%26+bug`, `claude://code/new?${folder}`])
  })

  it('2q /new: only params the app\'s code/new handler reads (folder is its one folder form)', async () => {
    const before = opened().length
    expect((await call('POST', '/sessions/new', { headers: UI, body: { q: 'hi' } })).status).toBe(200)
    const url = new URL(opened()[before])
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('claude://code/new')
    expect([...url.searchParams.keys()]).toEqual(['folder', 'q'])
    expect(url.searchParams.get('folder')).toBe(HOME)
  })

  // -------------------------------------------------------------------------
  // 2c: one seat per session; its agents fold into it
  // -------------------------------------------------------------------------

  it('seats: lowest free 0-10, freed on back, the 12th is overflow (null); GET = snapshot view', async () => {
    const ids = ['A', 'B', 'C']
    for (const id of ids) await sev('UserPromptSubmit', id)
    expect(await Promise.all(ids.map(async id => (await find(id)).seat))).toEqual([0, 1, 2])
    await sev('SessionEnd', 'B')
    await sev('UserPromptSubmit', 'D')
    expect((await find('D')).seat).toBe(1)
    const more = Array.from({ length: 8 }, (_, i) => `E${i}`)
    for (const id of more) await sev('UserPromptSubmit', id)
    expect(new Set((await get('/sessions')).json().map(x => x.seat))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    await sev('UserPromptSubmit', 'L')
    expect((await find('L')).seat).toBeNull()
    await sev('SessionEnd', 'E0') // a freed desk never moves an overflow session
    await sev('Stop', 'L')
    expect((await find('L')).seat).toBeNull()
    const list = (await get('/sessions')).json()
    const snap = await new Promise(r => {
      const c = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
      c.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'snapshot') { c.close(); r(m) } })
    })
    expect(snap.sessions).toEqual(list.map(({ since, lastMessage, agents, workflows, labels, ...v }) => v))
    expect(snap.sessions.find(v => v.sessionId === 'L')).toEqual({ sessionId: 'L', state: 'waiting', reason: 'turn_ended', seat: null, busy: false, runningAgents: 0, currentStep: '' })
    for (const id of ['A', 'C', 'D', ...more, 'L']) await sev('SessionEnd', id)
    expect((await get('/sessions')).json()).toEqual([])
  })

  it('agents keep a session busy: Stop while one runs stays working, its stop → idle; Notification stays waiting', async () => {
    const { s, msgs } = await ws()
    const last = () => { const m = msgs.filter(x => x.sessionId === 'P').at(-1); return { state: m.state, reason: m.reason, busy: m.busy, runningAgents: m.runningAgents } }
    const at = async (fn, want) => { await fn(); await sleep(60); expect(last()).toEqual(want) }
    await at(() => sev('UserPromptSubmit', 'P'), { state: 'working', reason: undefined, busy: true, runningAgents: 0 })
    await at(() => agentEv('agent_spawned', 'p1', 'P'), { state: 'working', reason: undefined, busy: true, runningAgents: 1 })
    await at(() => sev('Stop', 'P'), { state: 'working', reason: undefined, busy: true, runningAgents: 1 })
    expect((await find('P')).agents).toEqual(['agent-p1'])
    await at(() => agentEv('agent_completed', 'p1', 'P', { result: 'ok' }), { state: 'idle', reason: undefined, busy: false, runningAgents: 0 })
    expect((await find('P')).agents).toEqual([])
    await agentEv('agent_working', 'p1', 'P', { status: '', stepId: 'late' }) // a late hook event after SubagentStop
    await sleep(60)
    expect(await find('P')).toMatchObject({ state: 'idle', busy: false, runningAgents: 0 })
    await at(() => sev('UserPromptSubmit', 'P'), { state: 'working', reason: undefined, busy: true, runningAgents: 0 })
    await at(() => sev('Stop', 'P'), { state: 'waiting', reason: 'turn_ended', busy: false, runningAgents: 0 })
    await at(() => sev('Notification', 'P'), { state: 'waiting', reason: 'needs_input', busy: false, runningAgents: 0 })
    await at(() => agentEv('agent_spawned', 'p2', 'P'), { state: 'waiting', reason: 'needs_input', busy: true, runningAgents: 1 })
    await at(() => agentEv('agent_working', 'p2', 'P', { status: 'reading q', stepId: 'q1' }), { state: 'waiting', reason: 'needs_input', busy: true, runningAgents: 1 })
    expect(states(msgs, 'P').indexOf('idle')).toBe(1) // working → idle, never waiting in between
    expect((await find('P')).agents).toEqual(['agent-p2']) // 2d: GET /sessions lists running agent ids
    expect(msgs.every(m => !('agents' in m))).toBe(true) // session_changed keys unchanged
    // an agent under an unknown session (office restart) creates it idle and busy
    await at(() => agentEv('agent_working', 'p3', 'Q', { status: 'reading r', stepId: 'r1' }), { state: 'waiting', reason: 'needs_input', busy: true, runningAgents: 1 })
    expect(await find('Q')).toMatchObject({ state: 'idle', busy: true, runningAgents: 1, currentStep: 'reading r' })
    await sev('SessionEnd', 'P'); await sev('SessionEnd', 'Q')
    s.close()
  })

  it('an agent silent past AGENT_OFFICE_STALE_MS leaves runningAgents; the silent session then goes back and frees its seat', async () => {
    const { s, msgs } = await ws()
    await agentEv('agent_spawned', 'z1', 'Z')
    await sleep(60)
    const seat = (await find('Z')).seat
    expect(seat).not.toBeNull()
    await sleep(3200)
    const z = msgs.filter(m => m.sessionId === 'Z')
    expect(z.map(m => m.runningAgents)).toEqual([1, 0, 0])
    expect(z.at(-1)).toMatchObject({ state: 'back', seat })
    expect(await find('Z')).toBeUndefined()
    await sev('UserPromptSubmit', 'Z2')
    expect((await find('Z2')).seat).toBe(seat)
    await sev('SessionEnd', 'Z2')
    s.close()
  })

  it('currentStep = newest open step of the main thread or its agents; other sessions never leak; no text beyond labels', async () => {
    const { s, msgs } = await ws()
    const step = async () => { await sleep(60); return (await find('S')).currentStep }
    await post({ type: 'session_event', event: 'UserPromptSubmit', sessionId: 'S', transcriptPath: SESSION, prompt: 'SECRET-P' })
    await post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading a', stepId: 's-m1', sessionId: 'S' })
    expect(await step()).toBe('reading a')
    await agentEv('agent_working', 's1a', 'S', { status: 'reading b', stepId: 's-a1' })
    expect(await step()).toBe('reading b')
    await post({ type: 'agent_working', agentId: 'assistant-claude', status: 'reading c', stepId: 's-m2', sessionId: 'T' })
    expect(await step()).toBe('reading b')
    expect((await find('T')).currentStep).toBe('reading c')
    const n = msgs.filter(m => m.sessionId === 'S').length
    await agentEv('agent_seen', 's1a', 'S') // same view: nothing sent
    await sleep(60)
    expect(msgs.filter(m => m.sessionId === 'S')).toHaveLength(n)
    await agentEv('agent_working', 's1a', 'S', { status: '', stepId: 's-a1' })
    expect(await step()).toBe('reading a')
    await sev('Stop', 'S')
    expect(await step()).toBe('')
    expect(msgs.filter(m => m.sessionId === 'S').map(m => m.currentStep)).toEqual(['', 'reading a', 'reading b', 'reading a', ''])
    expect(msgs.every(m => Object.keys(m).every(k => VIEW_KEYS.includes(k)))).toBe(true)
    expect(JSON.stringify(msgs)).not.toContain('SECRET')
    await sev('SessionEnd', 'S'); await sev('SessionEnd', 'T')
    s.close()
  })
})
describe('Host guard + CORS', () => {
  it('403 on a foreign Host, CORS only for the UI origin', async () => {
    for (const p of ['/sessions', '/agents/agent-r1/report']) {
      expect((await get(p, { host: `evil.test:${PORT}` })).status, p).toBe(403)
      const ui = await get(p, { origin: 'http://localhost:3333' })
      expect(ui.status, p).toBe(200)
      expect(ui.headers['access-control-allow-origin']).toBe('http://localhost:3333')
      expect((await get(p, { origin: 'http://evil.test' })).headers['access-control-allow-origin']).toBeUndefined()
    }
  })
})
