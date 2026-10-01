import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plainer, plainOn, askHaiku } from './plain.js'
import { BOARDS, PLAIN, MARKETING } from './boards.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = () => mkdtempSync(join(tmpdir(), 'office-plain-test-'))
/** ask stub: answers `Plain <text>` for every id, records each batch, flags overlapping calls */
function stubAsk() {
  const batches = []
  let inFlight = 0
  const ask = async items => {
    if (inFlight++) batches.overlap = true
    batches.push(items)
    await sleep(20)
    inFlight--
    return Object.fromEntries(Object.entries(items).map(([k, v]) => [k, `Plain ${v}`]))
  }
  return { ask, batches }
}

describe('plainOn', () => {
  it('off unless AGENT_OFFICE_PLAIN=1, and never in the demo office', () => {
    expect(plainOn({})).toBe(false)
    expect(plainOn({ AGENT_OFFICE_PLAIN: '0' })).toBe(false)
    expect(plainOn({ AGENT_OFFICE_PLAIN: '1' })).toBe(true)
    expect(plainOn({ AGENT_OFFICE_PLAIN: '1', AGENT_OFFICE_DEMO: '1' })).toBe(false)
  })
})

describe('plainer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('miss → queued, one batch call, then a hit from memory and from the disk cache', async () => {
    const file = join(tmp(), 'cache.json'), { ask, batches } = stubAsk(), onBatch = vi.fn()
    const say = plainer({ ask, file, onBatch, wait: 10 })
    expect(say('a')).toBeUndefined()
    expect(say('b')).toBeUndefined()
    await sleep(80)
    expect(batches).toEqual([{ 1: 'a', 2: 'b' }])
    expect(onBatch).toHaveBeenCalledTimes(1)
    expect(say('a')).toBe('Plain a')
    const again = stubAsk()
    const say2 = plainer({ ask: again.ask, file, wait: 10 })
    expect(say2('b')).toBe('Plain b')
    await sleep(40)
    expect(again.batches).toEqual([]) // summarized once, ever
    expect(say2('b changed')).toBeUndefined() // new raw text → summarized again
    await sleep(80)
    expect(say2('b changed')).toBe('Plain b changed')
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toHaveLength(3)
  })

  it('batches 40 per call, one call in flight, the rest right after', async () => {
    const { ask, batches } = stubAsk()
    const say = plainer({ ask, file: join(tmp(), 'c.json'), wait: 10 })
    for (let i = 0; i < 45; i++) say(`t${i}`)
    say('t0') // already queued: not twice
    await sleep(15)
    for (let i = 0; i < 45; i++) say(`t${i}`) // read again mid-call: not queued twice
    await sleep(150)
    expect(batches.map(b => Object.keys(b).length)).toEqual([40, 5])
    expect(batches.overlap).toBeUndefined()
    expect(say('t44')).toBe('Plain t44')
  })

  it('hourly cap: past perHour calls the queue waits', async () => {
    const { ask, batches } = stubAsk()
    const say = plainer({ ask, file: join(tmp(), 'c.json'), wait: 10, batch: 1, perHour: 2 })
    for (const t of ['x', 'y', 'z']) say(t)
    await sleep(150)
    expect(batches).toHaveLength(2)
    expect(say('z')).toBeUndefined()
  })

  it('a failed call logs once and keeps the raw detail; a missing id stays unsummarized and queues again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let n = 0
    const ask = async () => { if (n++ < 2) throw new Error('claude: command not found'); return { 1: 'ok' } }
    const say = plainer({ ask, file: join(tmp(), 'c.json'), wait: 10 })
    say('a')
    await sleep(40)
    expect(say('a')).toBeUndefined() // read again → queued again → fails again
    await sleep(40)
    expect(warn).toHaveBeenCalledTimes(1)
    say('a'), say('b')
    await sleep(40)
    expect([say('a'), say('b')]).toEqual(['ok', undefined])
  })
})

describe('askHaiku (stubbed claude)', () => {
  afterEach(() => { delete process.env.AGENT_OFFICE_CLAUDE_CMD })

  it('sends the items as JSON on stdin and reads a fenced JSON reply', async () => {
    const stub = join(tmp(), 'claude')
    writeFileSync(stub, `#!/bin/sh\nexec node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const k in JSON.parse(s))o[k]="Plain "+k;console.log("\`\`\`json\\n"+JSON.stringify(o)+"\\n\`\`\`")})'\n`)
    chmodSync(stub, 0o755)
    process.env.AGENT_OFFICE_CLAUDE_CMD = stub
    expect(await askHaiku({ 1: 'a', 2: 'b' })).toEqual({ 1: 'Plain 1', 2: 'Plain 2' })
  })

  it('a missing binary rejects, never throws', async () => {
    process.env.AGENT_OFFICE_CLAUDE_CMD = join(tmp(), 'no-claude')
    await expect(askHaiku({ 1: 'a' })).rejects.toThrow()
  })
})

describe('PLAIN payloads', () => {
  const dir = tmp()
  mkdirSync(join(dir, 'projects', 'harbor-coffee'), { recursive: true })
  writeFileSync(join(dir, 'PROJECTS.md'), '| Project | Status |\n|---|---|\n| [Harbor Coffee](projects/harbor-coffee/STATUS.md) | active |\n')
  writeFileSync(join(dir, 'projects', 'harbor-coffee', 'STATUS.md'), '| # | Task | Status |\n|---|---|---|\n| 3 | **Pickup times** `a/b.tsx` | queued |\n| 4 | **Old menu** | done |\n')
  writeFileSync(join(dir, 'LOG.md'), '- 2026-09-30 09:00 — Harbor Coffee row 3 LIVE\n- 2026-09-30 — note only\n')
  writeFileSync(join(dir, 'DECISIONS.md'), '- [ ] 2026-09-30 — **A?** raw a\n  - In short: Pick A.\n- [ ] 2026-09-29 — **B?** raw b\n')
  writeFileSync(join(dir, MARKETING), '## Marketing now\n| # | Item | Now |\n|---|---|---|\n| 1 | **Ad** | running · IG |\n')
  const asked = []
  const say = raw => { asked.push(raw); return raw === 'B? raw b' ? 'Sentence B' : undefined }
  const build = board => PLAIN[board](BOARDS[board](dir), say)

  it('In short wins over Haiku; every other shown item asks; no sentence → no plain', () => {
    const [p] = build('status')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0].plain).toBeUndefined()
    const log = build('log')
    expect(build('decisions').map(d => d.plain)).toEqual(['Pick A.', 'Sentence B'])
    build('marketing')
    expect(asked).toEqual(['Harbor Coffee: Pickup times `a/b.tsx` — queued', 'Harbor Coffee row 3 LIVE', 'B? raw b', 'Ad · running · IG']) // not the unshipped LOG line, not In short
    expect(log.map(l => 'plain' in l)).toEqual([true, false])
  })
})
