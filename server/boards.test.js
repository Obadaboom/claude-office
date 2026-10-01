import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync, chmodSync, existsSync } from 'fs'
import { spawn } from 'child_process'
import { request } from 'http'
import WebSocket from 'ws'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { boardView } from '../src/boards.ts'
import { normaliseStatus, parseStatus, parseLog, parseDecisions, parseMarketing, statusBoard, short, rowName } from './boards.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

describe('normaliseStatus', () => {
  it('maps status cells to done / waiting / open', () => {
    for (const s of ['**LIVE ON PROD** 2026-09-20', 'done 2026-09-23', 'see history', '**SMOKED CLEAN 5/5', 'resolved by row 9', '**cancelled**'])
      expect(normaliseStatus(s), s).toBe('done')
    for (const s of ['**built** 2026-09-28', '**READY TO SHIP f53d55c**', '**PART 1 BUILT 2026-09-01', 'ready_to_ship'])
      expect(normaliseStatus(s), s).toBe('waiting')
    for (const s of ['todo, after 2a2', '**QUEUED', '**BUILDING', '**PLANNED', 'after 4', '**in progress**', 'proposed'])
      expect(normaliseStatus(s), s).toBe('open')
  })
})

describe('parseStatus', () => {
  it('reads owner + status from the right columns', () => {
    const md = `## Rows\n| # | Row | Owner | Status |\n|---|---|---|---|\n| 1 | **Make it** | Claude | **QUEUED** |\n`
    expect(parseStatus(md).rows).toEqual([{ n: '1', title: 'Make it', owner: 'Claude', status: 'QUEUED', state: 'open', name: 'Make it', text: 'Make it', date: '' }])
  })

  it('parses a "## Tasks" table and keeps an escaped pipe in one cell', () => {
    const md = `## Tasks — x\n| # | Task | Status |\n|---|---|---|\n| 7 | Agent\\|Task split | built 2026-09-28 |\n`
    const { rows } = parseStatus(md)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ n: '7', title: 'Agent|Task split', state: 'waiting' })
    expect(rows[0].owner).toBeUndefined()
  })

  it('returns only open/waiting rows, counts done and skipped', () => {
    const md = `| # | Item | Status |\n|---|---|---|\n| 1 | a | LIVE |\n| 2 | b | **LIVE** x |\n| 3 | c | LIVE ON PROD |\n| 4 | d | **QUEUED** |\n| 5 | e |\n| 6 | f | **cancelled** |\n`
    const r = parseStatus(md)
    expect(r.rows.map(x => x.n)).toEqual(['4'])
    expect(r.done).toBe(4)
    expect(r.skipped).toBe(1)
  })

  it('reads the status past extra cells, and skips an extra-cell row with no done/waiting cell', () => {
    const md = `| # | Item | Status |\n|---|---|---|\n| 144 | x | | **LIVE 2026-09-25** |\n| 147 | a | b | **BUILT** ready |\n| 81 | a | **LIVE** | Key in |\n| 9 | a | b | todo |\n`
    const r = parseStatus(md)
    expect(r.rows).toEqual([{ n: '147', title: 'a', status: 'BUILT ready', state: 'waiting', name: 'a', text: 'a', date: '' }])
    expect(r.done).toBe(2)
    expect(r.skipped).toBe(1)
  })

  it('cuts title and status to 140 chars', () => {
    const md = `| # | Row | Status |\n|---|---|---|\n| 1 | ${'t'.repeat(300)} | todo ${'s'.repeat(300)} |\n`
    const [row] = parseStatus(md).rows
    expect(row.title.length).toBe(140)
    expect(row.status.length).toBe(140)
  })

  it('no row table: up to 3 top-level notes from ## Now', () => {
    const md = `# X\n## Now\n- **one** thing\n  - sub bullet\n- two\n- three\n- four\n## Later\n- nope\n`
    const r = parseStatus(md)
    expect(r.rows).toEqual([])
    expect(r.notes).toEqual(['one thing', 'two', 'three'])
    expect(r.shortNotes).toEqual(['one thing', 'two', 'three'])
  })
})


describe('row dates (2l)', () => {
  it('date = latest YYYY-MM-DD in the full Row + Status cells, even past the 140 cut; none → ""', () => {
    const md = `| # | Row | Status |\n|---|---|---|\n| 1 | **A** 2026-09-20 | todo ${'x'.repeat(200)} 2026-09-29 |\n| 2 | **B** | todo |\n| 3 | 2026-09-25 C | built 2026-09-21 |\n`
    expect(parseStatus(md).rows.map(r => r.date)).toEqual(['2026-09-29', '', '2026-09-25'])
  })

  it('## Now notes get parallel noteDates', () => {
    const r = parseStatus('## Now\n- 2026-09-20: one, then 2026-09-28\n- two\n- 2026-09-27 three\n')
    expect(r.noteDates).toEqual(['2026-09-28', '', '2026-09-27'])
    expect(parseStatus('| # | Row | Status |\n|---|---|---|\n| 1 | a | todo |\n').noteDates).toEqual([])
  })
})

const MARKETING = `# Marketing

## Marketing now
Latest state only.

| # | Item | Now |
|---|---|---|
| 1 | **Coffee reel TikTok** | running · TikTok · $20/day (since 2026-09-29) |
| 2 | **Latte reel Instagram** | running · Meta IG · $15/day (since 2026-09-29) |
| 3 | **Trail tips motion** | needs you · say "go" to post it, or drop it (made 2026-09-27) |
| 4 | **Menu carousel** | posted 2026-09-29 · IG + FB |
| 5 | **Pickup reel** | posted 2026-09-29 · IG + FB + TikTok |
| 6 | **Newsletter ads** | stopped 2026-09-29 |
| 7 | **TikTok teaser ads** | stopped 2026-09-29 |
| 8 | **Loyalty card post** | posted 2026-09-28 · IG + FB |
| 9 | **Elevation chart ad** | posted 2026-09-28 · IG + FB |
| 10 | **Launch posts 1-4** | posted 2026-09-27 · IG + FB |
| 11 | **Winter TikTok ads** | stopped 2026-09-14 |

## RESUME — ad queue
| # | Row | Status |
|---|---|---|
| 1 | **Old** | todo |
`

describe('parseMarketing (2l)', () => {
  it('reads the Marketing now table: 11 items, states, dates, short lines', () => {
    const m = parseMarketing(MARKETING)
    expect(m).toHaveLength(11)
    expect(m.map(i => i.state)).toEqual(['running', 'running', 'needs', 'posted', 'posted', 'stopped', 'stopped', 'posted', 'posted', 'posted', 'stopped'])
    expect(m[0]).toEqual({ n: '1', name: 'Coffee reel TikTok', now: 'running · TikTok · $20/day (since 2026-09-29)', state: 'running', date: '2026-09-29', short: 'TikTok · Coffee reel TikTok · $20/day' })
    expect(m[1].short).toBe('Meta IG · Latte reel Instagram · $15/day')
    expect(m[2]).toMatchObject({ name: 'Trail tips motion', date: '2026-09-27', short: 'Trail tips motion' })
    expect(m[3]).toMatchObject({ date: '2026-09-29', short: 'Menu carousel' })
    expect(m[10]).toMatchObject({ date: '2026-09-14', state: 'stopped' })
    for (const i of m) expect(i.short.length).toBeLessThanOrEqual(41)
  })

  it('odd first words → other; Status header or no section → []', () => {
    expect(parseMarketing('## Marketing now\n| # | Item | Now |\n|---|---|---|\n| 1 | **X** | paused |\n')[0].state).toBe('other')
    expect(parseMarketing('## Marketing now\n| # | Item | Status |\n|---|---|---|\n| 1 | **X** | running · a · b |\n')).toEqual([])
    expect(parseMarketing(MARKETING.replace('## Marketing now', '## Other'))).toEqual([])
    expect(parseMarketing('')).toEqual([])
  })

  it('To-do never reads the Marketing now table', () => {
    const only = MARKETING.split('## RESUME')[0]
    expect(parseStatus(only).rows).toEqual([])
  })
})

const HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/
const PATH = /\S*\/\S*(\/|\.[a-z])/i

describe('short names (2g)', () => {
  it('name = leading bold, minus (…) and a trailing : or .', () => {
    expect(rowName("**Movement feels right (your #1, 2026-09-29):** walk and turn")).toBe('Movement feels right')
    expect(rowName('**To-do board (you 2026-09-29: "why white board: so much text?")**: short names on every board')).toBe('To-do board')
    expect(rowName('**Fix the gate.** then more')).toBe('Fix the gate')
  })

  it('no bold lead → the whole cell, cut at a word to ≤40 + …', () => {
    const n = rowName('Chat panel shows the whole conversation history with timestamps and avatars for everyone')
    expect(n.length).toBeLessThanOrEqual(41)
    expect(n).toMatch(/…$/)
    expect(n).toBe('Chat panel shows the whole conversation…')
  })

  it('never keeps a backtick path, a hex sha or a row id', () => {
    for (const s of [
      'Merged `server/boards.js` into local main at c4584ff today',
      '**Ship c4584ff0 (row 2d)** via `projects/x/STATUS.md`',
      'Rows 82 fixed in 1e0a588 on branch `row-2g-todo`',
    ]) {
      const out = rowName(s)
      expect(out, s).not.toMatch(HEX)
      expect(out, s).not.toMatch(/`/)
      expect(out, s).not.toMatch(PATH)
      expect(out, s).not.toMatch(/\brows? \d/i)
      expect(out.length, s).toBeLessThanOrEqual(41)
      expect(out.length, s).toBeGreaterThan(0)
    }
    expect(short('Merged server/index.js and ~/notes/boards/LOG.md, $15/day kept')).toBe('Merged and $15/day kept')
    expect(short('Fix defaced sign')).toBe('Fix defaced sign')
  })

  it('status rows gain name + full text (cut to 600), log and decisions gain short', () => {
    const long = `**Tidy boards (you):** ${'word '.repeat(200)}`
    const md = `| # | Row | Status |\n|---|---|---|\n| 9 | ${long} | todo |\n`
    const [row] = parseStatus(md).rows
    expect(row).toMatchObject({ n: '9', name: 'Tidy boards', state: 'open' })
    expect(row.text.length).toBe(600)
    expect(row.text.startsWith('Tidy boards (you):')).toBe(true)
    const log = parseLog([
      '- 2026-09-29 — Constitution: light asks may chain (you "sure").',
      '- 2026-09-29 — Trailhead launch hang FIXED on branch (not merged: x). More here.',
      '- 2026-09-29 — Harbor Coffee row 170 BUILT, waiting on you.',
    ].join('\n'))
    expect(log.map(l => l.short)).toEqual(['Constitution', 'Trailhead launch hang FIXED on branch', 'Harbor Coffee BUILT, waiting on you'])
    for (const l of log) expect(l.short.length).toBeLessThanOrEqual(41)
  })

  it('a LOG lead naming one bold-named row of a known project reads as that row, done rows too; else the old rule', () => {
    const projects = [
      { slug: 'nimbus-notes', name: 'Nimbus Notes', ...parseStatus('| # | Row | Status |\n|---|---|---|\n| 2f | **Chat is fun again (you 21:15):** convos | done |\n| 2g | **To-do board**: x | todo |\n') },
      { slug: 'harbor-coffee', name: 'Harbor Coffee', ...parseStatus('| # | Item | Status |\n|---|---|---|\n| 171 | **Orders list opens mid-page when the admin refreshes:** x | LIVE |\n| 170 | Claude 2026-09-28 (x): **Sizes** y | LIVE |\n') },
    ]
    const md = [
      '- 2026-09-29 22:24 PDT — Nimbus Notes row 2f done: chat is fun again, merged (bd88863).',
      '- 2026-09-29 — Harbor Coffee row 171 LIVE (you "ship"): main bb6c71d.',
      '- 2026-09-29 — Nimbus Notes lane C done (rows 2d + 2e server side): merged.',
      '- 2026-09-29 — Harbor Coffee row 170 LIVE: row cell has no leading bold name.',
      '- 2026-09-29 — Nimbus Notes row 2f + row 2g done: both merged.',
      '- 2026-09-29 — Nimbus Notes rows 2f + 2g done: both merged.',
      '- 2026-09-29 — Nimbus Notes row 2b-data done: merged.',
      '- 2026-09-29 — Trailhead row 2f done: not a known project.',
      '- 2026-09-29 — Merged Nimbus Notes row 2f: project not first.',
    ].join('\n')
    const now = parseLog(md, projects).map(l => l.short)
    const old = parseLog(md).map(l => l.short)
    expect(old[0]).toBe('Nimbus Notes done')
    expect(now.slice(0, 2)).toEqual(['Nimbus Notes · Chat is fun again', 'Harbor Coffee · Orders list opens…'])
    expect(now.slice(2)).toEqual(old.slice(2))
    for (const s of now) expect(s.length).toBeLessThanOrEqual(41)
  })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'boards-fx-'))
  const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s) }
  w('PROJECTS.md', [
    '| Project | Folder | Type | Status | Priority |', '|---|---|---|---|---|',
    '| [Office](projects/nimbus-notes/STATUS.md) | x | y | active | 3 |',
    '| [X](projects/x/STATUS.md) | x | y | paused | 4 |',
    '| [Harbor Coffee](projects/harbor-coffee/STATUS.md) | x | y | **active** | 1 |',
    '| [Evil](projects/../.secrets/STATUS.md) | x | y | active | 1 |',
    '| [Trailhead Maps](projects/trailhead-maps/STATUS.md) | x | y | **active** | 1 |',
  ].join('\n'))
  w('projects/nimbus-notes/STATUS.md', '| # | Row | Status |\n|---|---|---|\n| 2b | boards | todo |\n')
  w('projects/harbor-coffee/STATUS.md', '| # | Item | Status |\n|---|---|---|\n| 1 | a | LIVE |\n| 2 | **b** | **READY TO SHIP** |\n')
  w('projects/trailhead-maps/STATUS.md', '## Now\n- 2.0.2 live\n')
  w('projects/x/STATUS.md', '# nothing\n')
  w('MARKETING.md', MARKETING)
  const log = [
    '# Log', '',
    '- 2026-09-29 19:20 PDT — Nimbus Notes row 2a done: merged into local `main`.',
    '- 2026-09-29 — Harbor Coffee IG ads → Traffic, $15/day.',
    '- 2026-09-29 Harbor Coffee row 2 BUILT, waiting on you.',
    '- 2026-09-28 — Constitution: light asks may chain (you "sure").',
    '- 2026-09-28 — Reboot recovery notes.',
    ...Array.from({ length: 40 }, (_, i) => `- 2026-08-${String(28 - (i % 28)).padStart(2, '0')} — filler ${i}`),
  ]
  w('LOG.md', log.join('\n') + '\n')
  w('DECISIONS.md', [
    '# Decision Queue', '',
    '- [ ] 2026-09-24 — **Ship the CI fix?** Config only.',
    '  - [ ] 2026-09-25 — **sub item** ignored',
    'Format: `- [ ] 2026-09-16 — **x** y`',
    '- [ ] YYYY-MM-DD — <decision needed> — context — urgency`',
    '- [ ] 2026-09-10 — **Three small things.** (a) reports',
    '- [x] 2026-09-01 — **closed**',
  ].join('\n'))
  return dir
}

describe('boards from files', () => {
  const dir = fixture()

  it('keeps PROJECTS.md order (no hoist), no path from text, every field present', () => {
    const board = statusBoard(dir)
    expect(board.map(p => p.slug)).toEqual(['nimbus-notes', 'x', 'harbor-coffee', 'trailhead-maps'])
    const [office, x, shop, trail] = board
    expect(trail).toMatchObject({ name: 'Trailhead Maps', registryStatus: 'active', rows: [], notes: ['2.0.2 live'], shortNotes: ['2.0.2 live'], noteDates: [''] })
    expect(shop).toMatchObject({ done: 1, skipped: 0, rows: [{ n: '2', state: 'waiting', date: '' }], names: { 2: 'b' } })
    expect(office.rows[0]).toEqual({ n: '2b', title: 'boards', status: 'todo', state: 'open', name: 'boards', text: 'boards', date: '' })
    expect(Object.keys(x).sort()).toEqual(['done', 'name', 'noteDates', 'notes', 'registryStatus', 'rows', 'shortNotes', 'skipped', 'slug'])
  })

  it('parses LOG shapes and kinds, every line (no count cap)', () => {
    const log = parseLog(readFileSync(join(dir, 'LOG.md'), 'utf8'))
    expect(log).toHaveLength(45)
    expect(log[0]).toEqual({ date: '2026-09-29', time: '19:20', text: 'Nimbus Notes row 2a done: merged into local `main`.', kind: 'shipped', short: 'Nimbus Notes done' })
    expect(log[1]).toMatchObject({ date: '2026-09-29', text: 'Harbor Coffee IG ads → Traffic, $15/day.', kind: 'marketing' })
    expect(log[1].time).toBeUndefined()
    expect(log[2]).toMatchObject({ text: 'Harbor Coffee row 2 BUILT, waiting on you.', kind: 'waiting', short: 'Harbor Coffee BUILT, waiting on you' })
    expect(log[3].kind).toBe('decision')
    expect(log[4].kind).toBe('other')
    expect(log[39].text).toBe('filler 34')
    expect(log[44].text).toBe('filler 39')
  })

  it('a shipped line below the newest 40 still reaches Older → Shipped (real LOG: 40+ lines a day)', () => {
    const md = [
      ...Array.from({ length: 60 }, (_, i) => `- 2026-09-30 — busy day note ${i}.`),
      '- 2026-09-25 — Harbor Coffee row 160 LIVE: old ship.',
      '- 2026-09-24 — Nimbus Notes row 2a done: merged.',
    ].join('\n')
    const log = parseLog(md)
    expect(log).toHaveLength(62)
    const shipped = boardView('older', [[], [], log, []], new Date(2026, 9, 3, 12).getTime()).find(s => s.title === 'Shipped')
    expect(shipped?.lines.map(l => l.text)).toEqual(['Harbor Coffee LIVE', 'Nimbus Notes done'])
  })

  it('"not merged" is waiting, not shipped', () => {
    const kinds = parseLog([
      '- 2026-09-29 — Trailhead launch hang FIXED on branch (not merged): x.',
      '- 2026-09-29 — Trailhead row 2 pushed (origin, not merged): y.',
      '- 2026-09-29 — Row 5 not yet merged, DONE on branch.',
      '- 2026-09-29 — Nimbus Notes row 2a done: merged into local `main`.',
    ].join('\n')).map(l => l.kind)
    expect(kinds).toEqual(['waiting', 'waiting', 'waiting', 'shipped'])
  })

  it('parses only real open decisions', () => {
    const d = parseDecisions(readFileSync(join(dir, 'DECISIONS.md'), 'utf8'))
    expect(d.map(x => x.title)).toEqual(['Ship the CI fix?', 'Three small things.'])
    expect(d[0]).toMatchObject({ date: '2026-09-24', text: 'Ship the CI fix? Config only.', short: 'Ship the CI fix?' })
    expect(d[1].short).toBe('Three small things')
  })

  it('expanded text = the plain "In short:" sub-bullet when there is one', () => {
    const d = parseDecisions([
      '- [ ] 2026-09-30 — **Move the launch?** Store review is slow, `release/2.1` waits on row 4.',
      '  - Context: the review queue.',
      '  - in short: The launch may slip a **week**; pick a new day. ',
      '- [ ] 2026-09-29 — **Ship it?** Config only.',
      '  - Context: no plain line.',
      '',
      '  - In short: belongs to nobody.',
    ].join('\n'))
    expect(d[0]).toMatchObject({ date: '2026-09-30', title: 'Move the launch?', text: 'The launch may slip a week; pick a new day.', plain: 'The launch may slip a week; pick a new day.', short: 'Move the launch?' })
    expect(d[1]).toMatchObject({ title: 'Ship it?', text: 'Ship it? Config only.' })
    expect(d[1]).not.toHaveProperty('plain')
  })

  it('missing files → empty lists', () => {
    const none = join(dir, 'nope')
    expect(statusBoard(none)).toEqual([])
    expect(parseLog('')).toEqual([])
    expect(parseDecisions('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Server: node server/index.js on 3597 with HOME=<scratch>
// ---------------------------------------------------------------------------
const PORT = 3597
const get = (path, headers = {}) => new Promise((res, rej) => {
  request({ host: '127.0.0.1', port: PORT, path, headers }, r => {
    let body = ''
    r.on('data', d => (body += d))
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }))
  }).on('error', rej).end()
})

/** boardsDir undefined = the default ~/.agent-office/boards under `home`; plain sentences off unless `extra` turns them on */
function startServer(boardsDir, home = mkdtempSync(join(tmpdir(), 'office-srv-')), extra = {}) {
  const env = { ...process.env, HOME: home, AGENT_OFFICE_PORT: String(PORT), AGENT_OFFICE_BOARDS_DIR: boardsDir, ...extra }
  if (!boardsDir) delete env.AGENT_OFFICE_BOARDS_DIR
  if (!extra.AGENT_OFFICE_PLAIN) delete env.AGENT_OFFICE_PLAIN
  return spawn('node', [join(ROOT, 'server/index.js')], { env, stdio: 'ignore' })
}
const stop = srv => new Promise(r => { srv.on('exit', r); srv.kill() })
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await get('/health')).status === 200) return } catch {}
    await sleep(100)
  }
}

describe('server /boards', () => {
  const dir = fixture()
  let srv
  beforeAll(async () => { srv = startServer(dir); await waitUp() })
  afterAll(() => new Promise(r => { srv.on('exit', r); srv.kill() }))

  it('serves the three boards as JSON', async () => {
    const host = { host: `localhost:${PORT}` }
    const s = await get('/boards/status', host)
    expect(s.status).toBe(200)
    expect(JSON.parse(s.body)[0].slug).toBe('nimbus-notes')
    const log = JSON.parse((await get('/boards/log', host)).body)
    expect(log).toHaveLength(45) // every line, past the old 40 cap
    expect(log[2].short).toBe('Harbor Coffee · b') // the route passes the STATUS rows
    expect(JSON.parse((await get('/boards/decisions', { host: `127.0.0.1:${PORT}` })).body)).toHaveLength(2)
    const m = await get('/boards/marketing', host)
    expect(m.status).toBe(200)
    expect(JSON.parse(m.body)).toEqual(parseMarketing(MARKETING))
  })

  it('403 on a foreign Host, 200 + CORS for the UI', async () => {
    expect((await get('/boards/status', { host: 'evil.test' })).status).toBe(403)
    expect((await get('/boards/log', { host: `evil.test:${PORT}` })).status).toBe(403)
    expect((await get('/boards/marketing', { host: `evil.test:${PORT}` })).status).toBe(403)
    const ui = await get('/boards/log', { host: `localhost:${PORT}`, origin: 'http://localhost:3333' })
    expect(ui.status).toBe(200)
    expect(ui.headers['access-control-allow-origin']).toBe('http://localhost:3333')
  })

  it('broadcasts boards_changed once per burst', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const msgs = []
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'boards_changed') msgs.push(m) })
    await new Promise(r => ws.on('open', r))
    await sleep(300)
    for (let i = 0; i < 3; i++) { appendFileSync(join(dir, 'LOG.md'), `- 2026-09-30 — burst ${i}\n`); await sleep(40) }
    await sleep(1500)
    expect(msgs).toEqual([{ type: 'boards_changed', board: 'log' }])
    msgs.length = 0
    appendFileSync(join(dir, 'projects/x/STATUS.md'), '- edit\n')
    await sleep(1500)
    expect(msgs).toEqual([{ type: 'boards_changed', board: 'status' }])
    msgs.length = 0
    for (let i = 0; i < 3; i++) { appendFileSync(join(dir, 'MARKETING.md'), `- edit ${i}\n`); await sleep(40) }
    await sleep(1500)
    expect(msgs).toEqual([{ type: 'boards_changed', board: 'marketing' }])
    ws.close()
  }, 10000)
})

describe('server /boards with an empty boards dir', () => {
  let srv
  beforeAll(async () => { srv = startServer(mkdtempSync(join(tmpdir(), 'empty-boards-'))); await waitUp() })
  afterAll(() => new Promise(r => { srv.on('exit', r); srv.kill() }))

  it('returns empty lists and keeps running', async () => {
    for (const b of ['status', 'log', 'decisions', 'marketing']) {
      const r = await get(`/boards/${b}`, { host: `localhost:${PORT}` })
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body)).toEqual([])
    }
    expect(JSON.parse((await get('/health')).body).status).toBe('ok')
  })

  it('chat AI switch is gone: POST cron-state 404, GET still says paused', async () => {
    const post = await new Promise((res, rej) => {
      request({ host: '127.0.0.1', port: PORT, path: '/chat/cron-state', method: 'POST', headers: { 'content-type': 'application/json' } },
        r => { r.resume(); r.on('end', () => res(r.statusCode)) }).on('error', rej).end('{"paused":false}')
    })
    expect(post).toBe(404)
    expect(JSON.parse((await get('/chat/cron-state')).body).paused).toBe(true)
  })
})

describe('server default boards dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'office-home-'))
  const boards = join(home, '.agent-office', 'boards')
  const host = { host: `localhost:${PORT}` }

  it('first start seeds ~/.agent-office/boards with the 3 sample projects; a restart keeps your edits', async () => {
    let srv = startServer(undefined, home); await waitUp()
    const status = JSON.parse((await get('/boards/status', host)).body)
    expect(status.map(p => p.name)).toEqual(['Harbor Coffee app', 'Trailhead Maps', 'Nimbus Notes'])
    for (const b of ['log', 'decisions', 'marketing']) expect(JSON.parse((await get(`/boards/${b}`, host)).body).length, b).toBeGreaterThan(0)
    await stop(srv)
    const file = join(boards, 'projects', 'nimbus-notes', 'STATUS.md')
    writeFileSync(file, readFileSync(file, 'utf8') + '| 9 | **My own task** | Claude | queued |\n')
    srv = startServer(undefined, home); await waitUp()
    const nimbus = JSON.parse((await get('/boards/status', host)).body).find(p => p.slug === 'nimbus-notes')
    expect(nimbus.rows.map(r => r.name)).toContain('My own task')
    await stop(srv)
  }, 15000)
})

/** `claude` stub: notes each call in `<dir>/called`, answers `Plain <id>` per item */
function claudeStub() {
  const dir = mkdtempSync(join(tmpdir(), 'office-claude-'))
  const stub = join(dir, 'claude')
  writeFileSync(stub, `#!/bin/sh\necho x >> "${join(dir, 'called')}"\nexec node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const k in JSON.parse(s))o[k]="Plain "+k;console.log(JSON.stringify(o))})'\n`)
  chmodSync(stub, 0o755)
  return { stub, called: () => existsSync(join(dir, 'called')) }
}
const host = { host: `localhost:${PORT}` }
const board = async b => JSON.parse((await get(`/boards/${b}`, host)).body)

describe('server plain sentences: off by default', () => {
  const claude = claudeStub()
  let srv
  beforeAll(async () => { srv = startServer(fixture(), undefined, { AGENT_OFFICE_CLAUDE_CMD: claude.stub }); await waitUp() })
  afterAll(() => stop(srv))

  it('never calls claude; no plain field anywhere', async () => {
    await sleep(2500) // past the 2 s debounce
    expect(claude.called()).toBe(false)
    const all = await Promise.all(['status', 'log', 'decisions', 'marketing'].map(board))
    expect(JSON.stringify(all)).not.toMatch(/"plain/)
  }, 10000)
})

describe('server plain sentences: AGENT_OFFICE_PLAIN=1', () => {
  const claude = claudeStub()
  const home = mkdtempSync(join(tmpdir(), 'office-srv-'))
  const msgs = []
  let srv
  beforeAll(async () => {
    srv = startServer(fixture(), home, { AGENT_OFFICE_PLAIN: '1', AGENT_OFFICE_CLAUDE_CMD: claude.stub })
    await waitUp()
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'boards_changed') msgs.push(m.board) })
  })
  afterAll(() => stop(srv))

  it('backfills at startup without a board open, caches under ~/.agent-office, then nudges every board', async () => {
    await sleep(3000) // 2 s debounce + the stub call
    expect(claude.called()).toBe(true)
    const rows = (await board('status')).flatMap(p => p.rows)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.plain).toMatch(/^Plain \d+$/)
    const log = await board('log')
    expect(log.filter(l => l.kind === 'shipped').every(l => l.plain)).toBe(true)
    expect(log.filter(l => l.kind !== 'shipped').some(l => l.plain)).toBe(false)
    expect((await board('decisions')).every(d => d.plain)).toBe(true)
    expect(existsSync(join(home, '.agent-office', 'plain-cache.json'))).toBe(true)
    expect(msgs).toEqual(expect.arrayContaining(['status', 'log', 'decisions', 'marketing']))
  }, 10000)
})
