import { describe, it, expect } from 'vitest'
import { boardFor, boardView, BOARDS, Line } from './boards'

describe('boardFor', () => {
  it('maps the five board hotspots, nothing else', () => {
    expect(boardFor('kanban-board')).toBe('status')
    expect(boardFor('tv-monitor')).toBe('shipping')
    expect(boardFor('boss-desk')).toBe('decisions')
    expect(boardFor('ship-it-poster')).toBe('marketing')
    expect(boardFor('filing-1')).toBe('older')
    for (const id of ['whiteboard', 'coffee', 'bell', 'plant-1', '']) expect(boardFor(id), id).toBeNull()
  })

  it('each board names its endpoints and the boards_changed boards it follows', () => {
    expect(BOARDS.status).toEqual({ title: 'To-do', paths: ['/boards/status', '/boards/decisions'], watches: ['status', 'decisions'] })
    expect(BOARDS.shipping).toEqual({ title: 'Shipping board', paths: ['/boards/status', '/boards/log'], watches: ['status', 'log'] })
    expect(BOARDS.decisions).toEqual({ title: 'Decisions', paths: ['/boards/decisions'], watches: ['decisions'] })
    expect(BOARDS.marketing).toEqual({ title: 'Marketing', paths: ['/boards/marketing'], watches: ['marketing'] })
    expect(BOARDS.older).toEqual({
      title: 'Older',
      paths: ['/boards/status', '/boards/decisions', '/boards/log', '/boards/marketing'],
      watches: ['status', 'decisions', 'log', 'marketing'],
    })
  })
})

const NOW = new Date(2026, 8, 30, 12).getTime() // 2026-09-30 local: cutoff 2026-09-23
const row = (n: string, state: string, name = `Row ${n} name`, date = '2026-09-29') => ({ n, title: name, name, text: `${name}: full text of ${n}`, status: `status ${n}`, state, date })
const HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/
const PATH = /\S*\/\S*(\/|\.[a-z])/i
const texts = (ls: Line[]) => ls.map(l => l.text)

describe('To-do view', () => {
  const status = [
    { slug: 'trailhead-maps', name: 'Trailhead Maps', rows: [], notes: ['2026-09-29: 2.0.2 LIVE. Next: merge the fix', 'TestFlight next'], shortNotes: ['2.0.2 LIVE', 'TestFlight next'], noteDates: ['2026-09-29', '2026-09-29'] },
    { slug: 'harbor-coffee', name: 'Harbor Coffee', rows: [
      row('64', 'waiting'), row('71', 'waiting'), row('110', 'open'), row('135', 'waiting'), row('136', 'open'), row('139', 'waiting'), row('141', 'open'),
    ], notes: [], shortNotes: [] },
    { slug: 'empty', name: 'Empty', rows: [], notes: [], shortNotes: [] },
    { slug: 'scratch', name: 'Scratch', rows: [], notes: ['Uncommitted: x'], shortNotes: ['Uncommitted'], noteDates: ['2026-09-29'] },
    { slug: 'nimbus-notes', name: 'Nimbus Notes', rows: [row('11', 'waiting'), row('12', 'waiting'), row('4', 'open')], notes: [], shortNotes: [] },
  ]
  const decisions = [{ date: '2026-09-24', title: 'Ship?', text: 'Ship? Config only.', short: 'Ship?' }, { date: '2026-09-25', title: '', text: 'Two.', short: 'Two' }]

  it('Needs you: waiting rows as Project · name, 5 then +N more, then decisions → your desk', () => {
    const [needs] = boardView('status', [status, decisions], NOW)
    expect(needs.title).toBe('Needs you')
    expect(texts(needs.lines)).toEqual([
      'Harbor Coffee · Row 64 name', 'Harbor Coffee · Row 71 name', 'Harbor Coffee · Row 135 name', 'Harbor Coffee · Row 139 name', 'Nimbus Notes · Row 11 name',
      '+1 more', '2 decisions → your desk',
    ])
    expect(texts(needs.lines[5].children!)).toEqual(['Nimbus Notes · Row 12 name'])
    expect(needs.lines[0].detail).toBe('#64 · Row 64 name: full text of 64 — status 64')
    expect(boardView('status', [status, decisions.slice(1)], NOW)[0].lines.at(-1)!.text).toBe('1 decision → your desk')
  })

  it('no Needs you section when nothing waits and no decisions are open', () => {
    const calm = [{ ...status[1], rows: [row('110', 'open')] }]
    expect(boardView('status', [calm, []], NOW).map(s => s.title)).toEqual(['Projects'])
    expect(boardView('status', [[status[2]], []], NOW)).toEqual([])
  })

  it('Projects: one line per project with rows or notes (a project with no row table shows its notes), rows as names with full detail', () => {
    const projects = boardView('status', [status, decisions], NOW)[1]
    expect(projects.title).toBe('Projects')
    expect(texts(projects.lines)).toEqual(['Trailhead Maps · 2 notes', 'Harbor Coffee · 7', 'Scratch · 1 note', 'Nimbus Notes · 3'])
    const [trail, shop] = projects.lines
    expect(trail.children).toEqual([
      { key: 'trailhead-maps:note:0', text: '2.0.2 LIVE', detail: '2026-09-29: 2.0.2 LIVE. Next: merge the fix' },
      { key: 'trailhead-maps:note:1', text: 'TestFlight next', detail: 'TestFlight next' },
    ])
    expect(texts(shop.children!)).toEqual(['Row 64 name', 'Row 71 name', 'Row 110 name', 'Row 135 name', 'Row 136 name', '+2 more'])
    expect(shop.children![2]).toEqual({ key: 'harbor-coffee:110', text: 'Row 110 name', detail: '#110 · Row 110 name: full text of 110 — status 110' })
    expect(texts(shop.children![5].children!)).toEqual(['Row 139 name', 'Row 141 name'])
  })

  it('project list is capped at 5 too', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ slug: `p${i}`, name: `P${i}`, rows: [row('1', 'open')], notes: [], shortNotes: [] }))
    const [projects] = boardView('status', [many, []], NOW)
    expect(texts(projects.lines)).toEqual(['P0 · 1', 'P1 · 1', 'P2 · 1', 'P3 · 1', 'P4 · 1', '+2 more'])
  })
})

describe('Shipping board', () => {
  const status = [
    { slug: 'trailhead-maps', name: 'Trailhead Maps', rows: [], notes: ['Next: x'], shortNotes: ['x'] },
    { slug: 'harbor-coffee', name: 'Harbor Coffee', rows: [row('64', 'waiting'), row('110', 'open'), row('71', 'waiting'), row('136', 'open')], notes: [], shortNotes: [] },
    { slug: 'nimbus-notes', name: 'Nimbus Notes', rows: [row('11', 'waiting'), row('4', 'open')], notes: [], shortNotes: [] },
  ]
  const shipped = Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-2${9 - i}`, text: `Row ${i} LIVE on prod.`, kind: 'shipped', short: `Row ${i} LIVE` }))
  const log = [{ date: '2026-09-29', text: 'Fix on branch (not merged).', kind: 'waiting', short: 'Fix on branch' }, ...shipped]

  it('Ready to ship, Up next, Just shipped: Project · name rows in project order, newest 3 shipped, no LOG waiting', () => {
    const view = boardView('shipping', [status, log], NOW)
    expect(view.map(s => s.title)).toEqual(['Ready to ship', 'Up next', 'Just shipped'])
    const [ready, next, just] = view
    expect(texts(ready.lines)).toEqual(['Harbor Coffee · Row 64 name', 'Harbor Coffee · Row 71 name', 'Nimbus Notes · Row 11 name'])
    expect(ready.lines[0].detail).toBe('#64 · Row 64 name: full text of 64 — status 64')
    expect(texts(next.lines)).toEqual(['Harbor Coffee · Row 110 name', 'Harbor Coffee · Row 136 name', 'Nimbus Notes · Row 4 name'])
    expect(next.lines[1].detail).toBe('#136 · Row 136 name: full text of 136 — status 136')
    expect(just.lines).toEqual(shipped.slice(0, 3).map(l => ({ key: `${l.date} · ${l.text}`, text: l.short, detail: `${l.date} · ${l.text}` })))
  })

  it('5 rows then +N more; ready and next keys differ from each other', () => {
    const many = [{ slug: 's', name: 'S', rows: Array.from({ length: 7 }, (_, i) => row(String(i), 'open')), notes: [], shortNotes: [] }]
    const [next] = boardView('shipping', [many, []], NOW)
    expect(next.title).toBe('Up next')
    expect(texts(next.lines).at(-1)).toBe('+2 more')
    expect(next.lines).toHaveLength(6)
    const keys = boardView('shipping', [status, log], NOW).flatMap(s => s.lines.map(l => l.key))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('empty sections are absent', () => {
    expect(boardView('shipping', [[status[2]].map(p => ({ ...p, rows: [row('4', 'open')] })), []], NOW).map(s => s.title)).toEqual(['Up next'])
    expect(boardView('shipping', [[], log.slice(0, 1)], NOW)).toEqual([])
  })
})

const mkt = (n: string, state: string, date: string, name = `Item ${n}`, now = `${state} ${date}`) => ({ n, name, now, state, date, short: name })
const MKT = [
  mkt('1', 'running', '2026-09-29', 'Coffee reel TikTok', 'running · TikTok · $20/day (since 2026-09-29)'),
  mkt('3', 'needs', '2026-09-10', 'Trail tips motion', 'needs you · say "go" (made 2026-09-10)'),
  mkt('4', 'posted', '2026-09-27'),
  mkt('5', 'posted', '2026-09-29'),
  mkt('6', 'stopped', '2026-09-29'),
  mkt('8', 'posted', '2026-09-28'),
  mkt('9', 'posted', '2026-09-28'),
  mkt('11', 'stopped', '2026-09-14'),
  mkt('12', 'other', ''),
]
MKT[0].short = 'TikTok · Coffee reel TikTok · $20/day'

describe('log and decision boards', () => {
  const log = [
    { date: '2026-09-29', time: '19:20', text: 'Row 2a merged into `main` at c4584ff.', kind: 'shipped', short: 'merged into at' },
    { date: '2026-09-29', text: 'IG ads $15/day.', kind: 'marketing', short: 'IG ads $15/day' },
    { date: '2026-09-28', text: 'Fix on branch (not merged).', kind: 'waiting', short: 'Fix on branch' },
    { date: '2026-09-28', text: 'You said ok.', kind: 'decision', short: 'You said ok' },
    { date: '2026-09-27', text: 'Row 1 LIVE.', kind: 'shipped', short: 'LIVE' },
    { date: '2026-09-27', text: 'filler', kind: 'other', short: 'filler' },
  ]

  it('newest 5 per section, then +N more with the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ date: `2026-09-${String(29 - Math.min(i, 6)).padStart(2, '0')}`, title: '', text: `Ad ${i} long text`, short: `Ad ${i}` }))
    const [s] = boardView('decisions', [many], NOW)
    expect(texts(s.lines)).toEqual(['Ad 0', 'Ad 1', 'Ad 2', 'Ad 3', 'Ad 4', '+3 more'])
    expect(texts(s.lines[5].children!)).toEqual(['Ad 5', 'Ad 6', 'Ad 7'])
  })

  it('decisions: short titles, detail = date · text', () => {
    const d = [{ date: '2026-09-24', title: 'Ship?', text: 'Ship? Config only.', short: 'Ship?' }]
    expect(boardView('decisions', [d], NOW)).toEqual([{ lines: [{ key: '2026-09-24 · Ship? Config only.', text: 'Ship?', detail: '2026-09-24 · Ship? Config only.' }] }])
  })

  it('first-view lines: no path, no sha, ≤41 chars', () => {
    for (const b of ['shipping', 'marketing', 'decisions'] as const)
      for (const s of boardView(b, b === 'shipping' ? [[], log] : b === 'marketing' ? [MKT] : [log], NOW))
        for (const l of s.lines) {
          expect(l.text).not.toMatch(HEX)
          expect(l.text).not.toMatch(PATH)
          expect(l.text.length).toBeLessThanOrEqual(41)
        }
  })

  it('keys are stable across two builds of the same data', () => {
    const keys = (v: ReturnType<typeof boardView>) => v.flatMap(s => s.lines.flatMap(l => [l.key, ...(l.children ?? []).map(c => c.key)]))
    expect(keys(boardView('shipping', [[], log], NOW))).toEqual(keys(boardView('shipping', [[], structuredClone(log)], NOW)))
  })

  it('nothing to show → no sections (panel says "Nothing here.")', () => {
    expect(boardView('shipping', [[], [log[1], log[5]]], NOW)).toEqual([])
    expect(boardView('marketing', [[]], NOW)).toEqual([])
    expect(boardView('decisions', [[]], NOW)).toEqual([])
  })
})

describe('newest first, old to the cabinet (2l)', () => {
  const status = [
    { slug: 'a', name: 'Alpha', rows: [row('1', 'open', 'A one', '2026-09-24'), row('2', 'waiting', 'A two', '2026-09-26'), row('3', 'open', 'A three', '2026-09-22')], notes: [], shortNotes: [], noteDates: [] },
    { slug: 'b', name: 'Beta', rows: [row('7', 'waiting', 'B seven', '2026-09-23'), row('8', 'open', 'B eight', '2026-09-29'), row('9', 'open', 'B nine', '')], notes: [], shortNotes: [], noteDates: [] },
    { slug: 'c', name: 'Gamma', rows: [row('5', 'open', 'C five', '2026-09-01')], notes: [], shortNotes: [], noteDates: [] },
    { slug: 'trailhead-maps', name: 'Trailhead Maps', rows: [], notes: ['2026-09-25: fresh', 'old note', '2026-09-10 older note'], shortNotes: ['fresh', 'old note', 'older note'], noteDates: ['2026-09-25', '', '2026-09-10'] },
  ]
  const decisions = [
    { date: '2026-09-24', title: 'D24', text: 'D24 text', short: 'D24' },
    { date: '2026-09-29', title: 'D29', text: 'D29 text', short: 'D29' },
    { date: '2026-09-20', title: 'D20', text: 'D20 text', short: 'D20' },
    { date: '2026-09-16', title: 'D16', text: 'D16 text', short: 'D16' },
  ]
  const log = [
    { date: '2026-09-29', text: 'S29 LIVE.', kind: 'shipped', short: 'S29' },
    { date: '2026-09-23', text: 'S23 LIVE.', kind: 'shipped', short: 'S23' },
    { date: '2026-09-22', text: 'S22 LIVE.', kind: 'shipped', short: 'S22' },
    { date: '2026-09-21', text: 'You said ok.', kind: 'decision', short: 'You said ok' },
  ]
  const older = () => boardView('older', [status, decisions, log, MKT], NOW)
  const titled = (v: ReturnType<typeof boardView>, t: string) => v.find(s => s.title === t)!

  it('To-do: rows and Needs you newest first; projects by their newest recent row; old-only projects drop', () => {
    const [needs, projects] = boardView('status', [status, decisions], NOW)
    expect(texts(needs.lines)).toEqual(['Alpha · A two', 'Beta · B seven', '2 decisions → your desk'])
    expect(texts(projects.lines)).toEqual(['Beta · 2', 'Alpha · 2', 'Trailhead Maps · 1 note'])
    expect(texts(projects.lines[0].children!)).toEqual(['B eight', 'B seven'])
    expect(texts(projects.lines[1].children!)).toEqual(['A two', 'A one'])
    expect(projects.lines[2].children).toEqual([{ key: 'trailhead-maps:note:0', text: 'fresh', detail: '2026-09-25: fresh' }])
  })

  it('boundary = 7 days: 2026-09-23 stays, 2026-09-22 and undated leave To-do + Shipping for Older → To-do', () => {
    const shown = [...boardView('status', [status, []], NOW), ...boardView('shipping', [status, log], NOW)]
      .flatMap(s => s.lines.flatMap(l => [l.text, ...(l.children ?? []).map(c => c.text)]))
    expect(shown.join('|')).toMatch(/B seven/)
    for (const gone of ['A three', 'B nine', 'C five', 'Gamma', 'old note', 'S22']) expect(shown.join('|')).not.toMatch(gone)
    expect(texts(titled(older(), 'To-do').lines)).toEqual(['Alpha · A three', 'Trailhead Maps · older note', 'Gamma · C five', 'Beta · B nine', 'Trailhead Maps · old note'])
    expect(titled(older(), 'To-do').lines[0]).toEqual({ key: 'older:a:3', text: 'Alpha · A three', detail: '#3 · A three: full text of 3 — status 3' })
  })

  it('Shipping: Ready, Up next, Just shipped recent only, newest first', () => {
    const [ready, next, just] = boardView('shipping', [status, log], NOW)
    expect(texts(ready.lines)).toEqual(['Alpha · A two', 'Beta · B seven'])
    expect(texts(next.lines)).toEqual(['Beta · B eight', 'Alpha · A one'])
    expect(texts(just.lines)).toEqual(['S29', 'S23'])
    expect(texts(titled(older(), 'Shipped').lines)).toEqual(['S22'])
  })

  it('Decisions: recent only, newest first; To-do count = recent; old ones under Older → Decisions', () => {
    expect(texts(boardView('decisions', [decisions], NOW)[0].lines)).toEqual(['D29', 'D24'])
    expect(boardView('status', [[], decisions], NOW)[0].lines.at(-1)!.text).toBe('2 decisions → your desk')
    expect(boardView('status', [[], decisions.slice(2)], NOW)).toEqual([])
    expect(texts(titled(older(), 'Decisions').lines)).toEqual(['D20', 'D16'])
  })

  it('Marketing: Needs you, Running, Just posted (3 newest); the rest newest first under Older → Marketing', () => {
    const view = boardView('marketing', [MKT], NOW)
    expect(view.map(s => s.title)).toEqual(['Needs you', 'Running', 'Just posted'])
    const [needs, running, just] = view
    expect(needs.lines).toEqual([{ key: 'marketing:3', text: 'Trail tips motion', detail: 'Trail tips motion · needs you · say "go" (made 2026-09-10)' }])
    expect(texts(running.lines)).toEqual(['TikTok · Coffee reel TikTok · $20/day'])
    expect(texts(just.lines)).toEqual(['Item 5', 'Item 8', 'Item 9'])
    expect(texts(titled(older(), 'Marketing').lines)).toEqual(['Item 6', 'Item 4', 'Item 11', 'Item 12'])
    expect(boardView('marketing', [MKT.filter(i => i.state === 'posted')], NOW).map(s => s.title)).toEqual(['Just posted'])
  })

  it('Older: sections in order, 5 then +N more, one short line ≤41, no path/sha, stable keys, empty → none', () => {
    expect(older().map(s => s.title)).toEqual(['To-do', 'Decisions', 'Shipped', 'Marketing'])
    const long = [{ slug: 'l', name: 'Harbor Coffee', rows: Array.from({ length: 7 }, (_, i) => row(String(i), 'open', 'Orders list opens mid-page when refreshed', '')), notes: [], shortNotes: [], noteDates: [] }]
    const todo = boardView('older', [long, [], [], []], NOW)
    expect(todo).toHaveLength(1)
    expect(texts(todo[0].lines).at(-1)).toBe('+2 more')
    for (const s of [...older(), ...todo]) for (const l of s.lines) {
      expect(l.text).not.toMatch(HEX)
      expect(l.text).not.toMatch(PATH)
      expect(l.text.length).toBeLessThanOrEqual(41)
    }
    const keys = (v: ReturnType<typeof boardView>) => v.flatMap(s => s.lines.flatMap(l => [l.key, ...(l.children ?? []).map(c => c.key)]))
    expect(keys(older())).toEqual(keys(boardView('older', structuredClone([status, decisions, log, MKT]), NOW)))
    expect(new Set(keys(older())).size).toBe(keys(older()).length)
    expect(boardView('older', [[], [], [], []], NOW)).toEqual([])
  })
})
