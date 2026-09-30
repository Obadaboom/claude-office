/**
 * Demo mode (row 2v, `npm run demo`): a second office on a fresh temp HOME, fed only made-up work.
 * seed() writes fake board markdown where the board readers already look; startDemo() writes fake
 * transcripts, app files, workflow scripts and journals, and plays scripted hook events through the
 * server's own ingest() (same shapes as hooks/agent-tracker.py). Canned text only: no network, no model.
 */

import { realpathSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

/** Throws unless realpath(home) is inside the temp dir (or /private/tmp): the demo never writes a real HOME */
export function assertTempHome(home = homedir()) {
  const real = realpathSync(home)
  if (![realpathSync(tmpdir()), '/private/tmp'].some(root => real.startsWith(root + sep)))
    throw new Error(`[demo] HOME ${home} is not a temp dir: refusing to start`)
  return real
}
// index.js imports this module first, so the guard runs before chat-db or the token file write anything
if (process.env.AGENT_OFFICE_DEMO === '1') assertTempHome()

const pad = n => String(n).padStart(2, '0')
/** Local YYYY-MM-DD, n days ago (the boards' Older cutoff is 7 days, local time) */
const day = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n') + '\n'

const PROJECTS = {
  'harbor-coffee': ['Harbor Coffee app', [
    [1, '**Order-ahead button**', `done ${day(3)}`],
    [2, '**Loyalty card screen**', `built ${day(0)}`],
    [3, '**Pickup time picker**', `queued ${day(1)}`],
    [4, '**Old menu import**', `queued ${day(12)}`],
  ]],
  'trailhead-maps': ['Trailhead Maps', [
    [1, '**Offline trail tiles**', `built ${day(1)}`],
    [2, '**Elevation chart**', `building ${day(0)}`],
    [3, '**Share a route link**', `queued ${day(10)}`],
  ]],
  'nimbus-notes': ['Nimbus Notes', [
    [1, '**Dark mode**', `done ${day(2)}`],
    [2, '**Search inside notes**', `queued ${day(0)}`],
  ]],
}

/** First start only: seeds a missing boards folder; an existing one (your own files) is never touched. True when it seeded. */
export function seedIfMissing(dir) {
  if (existsSync(dir)) return false
  seed(dir)
  return true
}

/** Sample boards folder: PROJECTS.md, projects/*\/STATUS.md, LOG.md, DECISIONS.md, MARKETING.md */
export function seed(dir) {
  put(join(dir, 'PROJECTS.md'), '# Projects\n\n' + table(['Project', 'Status'], Object.entries(PROJECTS).map(([slug, [name]]) => [`[${name}](projects/${slug}/STATUS.md)`, 'active'])))
  for (const [slug, [name, rows]] of Object.entries(PROJECTS))
    put(join(dir, 'projects', slug, 'STATUS.md'), `# ${name}\n\n` + table(['#', 'Task', 'Owner', 'Status'], rows.map(([n, task, status]) => [n, task, 'Claude', status])))
  put(join(dir, 'LOG.md'), `# Log\n\n${[
    `${day(0)} 09:40 — Nimbus Notes: dark mode LIVE`,
    `${day(1)} 16:05 — Harbor Coffee: order-ahead button SHIPPED`,
    `${day(2)} 11:20 — Trailhead Maps: route sharing fix merged`,
    `${day(3)} 14:10 — Harbor Coffee: loyalty card screen BUILT, waiting on review`,
    `${day(9)} 10:00 — Nimbus Notes: note export LIVE`,
    `${day(13)} 17:30 — Trailhead Maps: trail search SHIPPED`,
  ].map(l => `- ${l}`).join('\n')}\n`)
  put(join(dir, 'DECISIONS.md'), `# Decisions\n\n${[
    `${day(0)} — **Pick the launch day** for Trailhead Maps: Friday or Monday.`,
    `${day(1)} — **Price of the pro plan** for Nimbus Notes: $4 or $6 a month.`,
    `${day(11)} — **Cafe photo style** for Harbor Coffee: bright or moody.`,
  ].map(l => `- [ ] ${l}`).join('\n')}\n`)
  put(join(dir, 'MARKETING.md'), '# Marketing\n\n## Marketing now\n\n' + table(['#', 'Item', 'Now'], [
    [1, '**Spring launch post**', `needs your ok ${day(0)}`],
    [2, '**Harbor Coffee reel**', `running · $5/day · 1.2k views ${day(1)}`],
    [3, '**Trail tips carousel**', `posted ${day(2)}`],
    [4, '**Winter recap post**', `posted ${day(15)}`],
    [5, '**Notes app teaser**', `stopped ${day(20)}`],
  ]))
}

// ---------------------------------------------------------------------------
// Scripted sessions
// ---------------------------------------------------------------------------

const NAMES = { 'fullstack-developer': 'Fullstack', 'code-reviewer': 'Reviewer', 'test-engineer': 'Tester', 'devops-engineer': 'DevOps', 'general-purpose': 'Agent', Explore: 'Explorer', 'performance-engineer': 'PerfEng' }
export const DEFAULT_TASK = 'Add a dark mode toggle'
const STEP = 3500 // ms per step at speed 1: one story ≈ 65 s
const BEAT = 2000 // a workflow phase shows todo this long after its agent starts, and done this long before it stops
const PHASES = [
  ['Build', [{ role: 'fullstack-developer', label: 'builder', job: 'Build it from the plan', steps: ['reading App.tsx', 'editing Page.tsx', 'writing page.test.ts', 'Run the unit tests'], result: 'Built it, 6 new tests pass.' }]],
  ['Review', [{ role: 'code-reviewer', label: 'reviewer', job: 'Review the diff', steps: ['reading Page.tsx', 'reading page.test.ts', 'Check the diff'], result: 'Looks clean, one small nit fixed.' }]],
  ['Prove', [
    { role: 'test-engineer', label: 'prover desktop', job: 'Prove it on desktop', steps: ['Start the dev server', 'Click through the page', 'Take a desktop screenshot'], result: 'Works on desktop.' },
    { role: 'test-engineer', label: 'prover phone', job: 'Prove it on a phone', steps: ['Open at phone size', 'Tap every button', 'Take a phone screenshot'], result: 'Works on a phone.' },
  ]],
  ['Gate', [{ role: 'devops-engineer', label: 'gate', job: 'Run the full gate', steps: ['Run the build', 'Run all tests'], result: 'Build clean, 142 tests pass.' }]],
]
const AMBIENT = [
  { title: 'Tidy the onboarding emails', main: 'reading emails.md', role: 'Explore', job: 'Find stale onboarding emails', steps: ['searching for \'welcome\'', 'reading welcome.html', 'reading day-3.html'], result: 'Found 7 emails, 2 are stale.' },
  { title: 'Speed up the map tiles', main: 'reading tiles.ts', role: 'performance-engineer', job: 'Profile the tile loader', steps: ['Run the profiler', 'reading cache.ts', 'editing cache.ts'], result: 'Tiles load 40% faster.' },
]
/** The story's note ends with numbered options (the demo note makes them tappable) */
export const LAST = 'Built, reviewed, proved on desktop and phone, gate green.\n\n1. Ship it\n2. One more review pass\n3. Park it\n\nWhich one?'
const METHOD = `export const meta = {\n  name: 'build-review',\n  phases: [\n${PHASES.map(([title]) => `    { title: '${title}' },`).join('\n')}\n  ],\n}\n`

const hex = () => randomBytes(8).toString('hex')
const jsonl = (file, ...lines) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join('')) }
const user = content => ({ type: 'user', message: { role: 'user', content } })
const said = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const ran = description => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { description } }] } })

/** Plays scripted work through ingest(body) (the POST /event pipeline). Returns { start(task), reply(sessionId, text) }. */
export function startDemo(ingest, speed = Number(process.env.AGENT_OFFICE_DEMO_SPEED) || 1) {
  const wait = ms => new Promise(r => setTimeout(r, ms / speed))
  const proj = join(homedir(), '.claude', 'projects', 'demo')
  const apps = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'demo', 'demo')
  const waiting = new Map() // story session id → session, while its note waits on you

  /** A new session: app file (title) + transcript, then UserPromptSubmit */
  function session(title) {
    const id = randomUUID(), path = join(proj, `${id}.jsonl`), appId = `local_${randomUUID()}`
    put(join(apps, `${appId}.json`), JSON.stringify({ cliSessionId: id, title, sessionId: appId }))
    const s = { id, path, sub: join(proj, id, 'subagents'), send: ev => ingest({ sessionId: id, ...ev }) }
    prompt(s, title)
    return s
  }
  const prompt = (s, text) => { jsonl(s.path, user(text)); s.send({ type: 'session_event', event: 'UserPromptSubmit', transcriptPath: s.path }) }

  /** One tool step (PreToolUse → PostToolUse) of the main thread, or of agent `a` */
  async function step(s, status, a) {
    const stepId = `toolu_${hex()}`
    const who = a ? { agentId: a.id, role: a.role, name: a.name } : { agentId: 'assistant-claude', transcriptPath: s.path }
    if (a) jsonl(a.file, ran(status))
    s.send({ type: 'agent_working', ...who, status, stepId })
    await wait(STEP)
    s.send({ type: 'agent_working', ...who, status: '', stepId })
  }

  /** SubagentStart → steps → SubagentStop; `dir` = its folder, `onStart(raw id)` before the start event, `onEnd(raw id)` awaited before the stop */
  async function agent(s, spec, dir, onStart, onEnd) {
    const raw = hex(), a = { ...spec, id: `agent-${raw}`, name: NAMES[spec.role], file: join(dir, `agent-${raw}.jsonl`) }
    jsonl(a.file, user(spec.job))
    onStart(raw)
    s.send({ type: 'agent_spawned', agent: { id: a.id, name: a.name, role: a.role, task: '' }, transcriptPath: s.path })
    for (const status of spec.steps) await step(s, status, a)
    jsonl(a.file, said(spec.result))
    await onEnd?.(raw)
    s.send({ type: 'agent_completed', agentId: a.id, result: spec.result, agentTranscriptPath: a.file })
    return raw
  }
  /** An Agent-tool agent: PreToolUse carries its description (the chat's "started: …" line) */
  const helper = (s, spec) => {
    s.send({ type: 'agent_pending', role: spec.role, task: spec.job, transcriptPath: s.path })
    return agent(s, spec, s.sub, raw => put(join(s.sub, `agent-${raw}.meta.json`), JSON.stringify({ description: spec.job })))
  }

  async function story(task) {
    const s = session(task)
    await wait(1500)
    await step(s, 'reading STATUS.md')
    await step(s, 'using /build-review')
    const wf = `wf_${hex()}`, dir = join(s.sub, 'workflows', wf), journal = join(dir, 'journal.jsonl')
    put(join(proj, s.id, 'workflows', 'scripts', `build-review-${wf}.js`), METHOD)
    put(journal, '')
    // /sessions lists a workflow only while one of its agents is live: phases chain with no gap, and each agent
    // is live a BEAT before its journal `started` (phase todo) and a BEAT after its `result` (phase done)
    for (const [phase, specs] of PHASES)
      await Promise.all(specs.map(spec => agent(s, spec, dir,
        raw => bg(wait(BEAT).then(() => jsonl(journal, { type: 'started', agentId: raw, key: spec.label, phase, label: spec.label }))),
        raw => { jsonl(journal, { type: 'result', agentId: raw, key: spec.label }); return wait(BEAT) })))
    jsonl(s.path, said(`Done: ${task}. ${LAST}`))
    s.send({ type: 'agent_working', agentId: 'assistant-claude', status: '', turnEnd: true, transcriptPath: s.path })
    waiting.set(s.id, s)
  }

  async function answer(s, text) {
    prompt(s, text)
    await step(s, 'reading the note')
    await helper(s, { role: 'general-purpose', job: 'Apply the note', steps: ['editing Page.tsx', 'Run the unit tests'], result: 'Applied the note, all tests pass.' })
    await wait(1500)
    s.send({ type: 'session_event', event: 'SessionEnd', transcriptPath: s.path })
  }

  async function ambient(spec, delay) {
    await wait(delay)
    const s = session(spec.title)
    for (;;) {
      await step(s, spec.main)
      await helper(s, spec)
      await wait(8000)
    }
  }

  const bg = p => p.catch(err => console.warn('[demo]', err.message))
  AMBIENT.forEach((spec, i) => bg(ambient(spec, 300 + i * 600)))
  return {
    start: task => bg(story(task.trim() || DEFAULT_TASK)),
    reply: (id, text) => { const s = waiting.get(id); if (s) { waiting.delete(id); bg(answer(s, text)) } },
  }
}
