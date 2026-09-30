import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import {
  CONVOS, JOB_LINES, MICHAEL_LINES, CONVO_GAP_MS, pickConvo, jobLine, michaelLine, convoDelay,
  WIN_LINES, BLAME_LINES, WATCH_LINES, WAIT_LINES, MENTION_LINES, WORD_REPLIES, PRANKS, DUNDIE_JOKES,
  isErrorResult, mentionOf, wordReply, ready, dundiesDue, dundieLines, dayOf,
} from './chatter'
import { REGULARS } from './theme'
import { getInteraction } from './interactions'
import { ROOMS } from './rooms'

// Every id getInteraction's switch knows (kept in step with interactions.ts)
const INTERACTION_IDS = [
  'plant-1', 'plant-2', 'plant-3', 'plant-4', 'plant-5', 'coffee', 'filing-1', 'printer-1', 'whiteboard',
  'fire-extinguisher', 'water-cooler', 'bell', 'kanban-board', 'ship-it-poster', 'tv-monitor', 'boss-desk',
]

// Every cast member with a sprite (the @mention cast)
const SPRITE_CAST = [...new Set(readdirSync('public/sprites/office/characters').map(f => f.replace(/-(front|rear)-(left|right)\.png$/, '')))]
const TEAM = new Set<string>([...REGULARS, 'michael-scott'])
const LONG_NAME = 'Meredith Palmer'
const scenes = [WIN_LINES, BLAME_LINES, WATCH_LINES, WAIT_LINES, ...Object.values(PRANKS)]

const allLines = [
  ...CONVOS.flat().map(l => l.text),
  ...Object.values(JOB_LINES).flat(),
  ...Object.values(MICHAEL_LINES).flat(),
  ...scenes.flat().map(l => l.text.replace('{name}', LONG_NAME)),
  ...Object.values(MENTION_LINES).flat(),
  ...WORD_REPLIES.flatMap(w => w.lines),
  ...DUNDIE_JOKES.map(j => `And the ${j} Dundie goes to... ${LONG_NAME}!`),
]

describe('chatter pools', () => {
  it('convos: 2-3 lines, cast speakers only', () => {
    const cast = new Set<string>([...REGULARS, 'michael-scott'])
    expect(CONVOS.length).toBeGreaterThan(1)
    for (const c of CONVOS) {
      expect(c.length).toBeGreaterThanOrEqual(2)
      expect(c.length).toBeLessThanOrEqual(3)
      for (const l of c) expect(cast.has(l.slug), l.slug).toBe(true)
    }
  })

  it('every line is short and never looks like a real line', () => {
    for (const t of allLines) {
      expect(t.trim().length, t).toBeGreaterThan(0)
      expect(t.length, t).toBeLessThanOrEqual(90)
      expect(t.toLowerCase().startsWith('started'), t).toBe(false)
      expect(t.toLowerCase().includes('finished'), t).toBe(false)
      expect(t.includes('✅'), t).toBe(false)
    }
  })

  it('JOB_LINES: a pool per regular plus default', () => {
    for (const slug of [...REGULARS, 'default']) expect(JOB_LINES[slug]?.length, slug).toBeGreaterThan(0)
  })

  it('MICHAEL_LINES: a pool per interaction id plus default', () => {
    for (const id of ROOMS['main-office'].furniture.map(f => f.id).filter(id => getInteraction(id))) {
      expect(INTERACTION_IDS, id).toContain(id)
    }
    for (const id of [...INTERACTION_IDS, 'default']) expect(MICHAEL_LINES[id]?.length, id).toBeGreaterThan(0)
    for (const id of Object.keys(MICHAEL_LINES)) if (id !== 'default') expect(getInteraction(id), id).not.toBeNull()
  })
})

describe('pickers', () => {
  const rands = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.9999]

  it('pickConvo never returns the last one and stays in range', () => {
    for (let last = -1; last < CONVOS.length; last++) {
      for (const r of rands) {
        const i = pickConvo(last, () => r)
        expect(i).not.toBe(last)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(i).toBeLessThan(CONVOS.length)
      }
    }
  })

  it('jobLine picks from the slug pool, unknown → default', () => {
    for (const r of rands) {
      expect(JOB_LINES['dwight-schrute']).toContain(jobLine('dwight-schrute', () => r))
      expect(JOB_LINES.default).toContain(jobLine('session-xyz', () => r))
    }
  })

  it('michaelLine picks from the item pool, unknown → default', () => {
    for (const r of rands) {
      expect(MICHAEL_LINES.coffee).toContain(michaelLine('coffee', () => r))
      expect(MICHAEL_LINES.default).toContain(michaelLine('nope', () => r))
    }
  })

  it('convoDelay stays within CONVO_GAP_MS', () => {
    const [min, max] = CONVO_GAP_MS
    for (const r of rands) {
      const d = convoDelay(() => r)
      expect(d).toBeGreaterThanOrEqual(min)
      expect(d).toBeLessThanOrEqual(max)
    }
  })
})

describe('2o pools', () => {
  it('speakers are team cast slugs; prank scenes are 2-3 lines', () => {
    for (const l of scenes.flat()) expect(TEAM.has(l.slug), l.slug).toBe(true)
    for (const w of WORD_REPLIES) expect(TEAM.has(w.slug), w.slug).toBe(true)
    expect(Object.keys(PRANKS)).toHaveLength(4)
    for (const p of Object.values(PRANKS)) { expect(p.length).toBeGreaterThanOrEqual(2); expect(p.length).toBeLessThanOrEqual(3) }
    expect(WIN_LINES.map(l => l.slug)).toEqual(expect.arrayContaining(['michael-scott', 'kevin-malone', 'andy-bernard']))
    expect(new Set(BLAME_LINES.map(l => l.slug))).toEqual(new Set(['dwight-schrute']))
    for (const l of WATCH_LINES) { expect(l.slug).toBe('stanley-hudson'); expect(l.text).toContain('{name}') }
    for (const l of WAIT_LINES) { expect(l.slug).toBe('pam-beesly'); expect(l.text).toContain('{name}') }
  })

  it('MENTION_LINES: 3 lines for every cast member with a sprite, nobody else', () => {
    expect(SPRITE_CAST.length).toBeGreaterThan(20)
    expect(Object.keys(MENTION_LINES).sort()).toEqual([...SPRITE_CAST].sort())
    for (const k of SPRITE_CAST) expect(MENTION_LINES[k], k).toHaveLength(3)
  })
})

describe('isErrorResult', () => {
  it('flags errors, not passing counts', () => {
    for (const t of ['error: build failed', 'prover failed 1', 'crashed']) expect(isErrorResult(t), t).toBe(true)
    for (const t of ['0 errors, 149/149 pass', 'no failures', 'tests pass', '']) expect(isErrorResult(t), t).toBe(false)
  })
})

describe('mentionOf', () => {
  it('any cast first name with a sprite, whole word, any case, anywhere', () => {
    expect(mentionOf('@DWIGHT')).toBe('dwight-schrute')
    expect(mentionOf('hey @michael')).toBe('michael-scott')
    expect(mentionOf('yo @ryan, where are you')).toBe('ryan-howard')
    expect(mentionOf('@toby?')).toBe('toby-flenderson')
    for (const slug of SPRITE_CAST) expect(mentionOf(`hi @${slug.split('-')[0]}`), slug).toBe(slug)
  })
  it('unknown names and partial words → undefined', () => {
    for (const t of ['@nobody', '@dwightx', 'dwight', 'mail@jim', '']) expect(mentionOf(t), t).toBeUndefined()
  })
})

describe('wordReply', () => {
  const T = 1_000_000
  const hit = (text: string) => wordReply(text, new Map(), T)?.slug
  it('whole words only, mapped to the right character', () => {
    expect(hit('that was hard')).toBe('michael-scott')
    expect(hit('so HUGE')).toBe('michael-scott')
    expect(hit('new hardware')).toBeUndefined()
    expect(hit('bigger')).toBeUndefined()
    expect(hit('pretzel time')).toBe('stanley-hudson')
    expect(hit('chili cook-off')).toBe('kevin-malone')
    expect(hit('beets')).toBe('dwight-schrute')
    expect(hit('bear')).toBe('dwight-schrute')
    expect(hit('Jell-O')).toBe('dwight-schrute')
    expect(hit('jello')).toBe('dwight-schrute')
    expect(hit('my stapler')).toBe('dwight-schrute')
    expect(wordReply('stapler', new Map(), T)?.lines).toEqual(['JIM!'])
    expect(hit('cat')).toBe('angela-martin')
    expect(hit('party')).toBe('angela-martin')
    expect(hit('Cornell')).toBe('andy-bernard')
    expect(hit('Bob Vance')).toBe('phyllis-vance')
    expect(hit('happy hour?')).toBe('meredith-palmer')
    expect(hit('prison')).toBe('michael-scott')
    expect(hit('hello there')).toBeUndefined()
  })
  it('first match in list order, one reply per message', () => {
    expect(hit('pretzel was hard')).toBe('michael-scott')
    expect(hit('chili and pretzel')).toBe('stanley-hudson')
  })
  it('30 s cooldown per trigger; a group shares one', () => {
    const last = new Map<string, number>()
    expect(wordReply('hard', last, T)).toBeDefined()
    expect(wordReply('long', last, T + 29_000)).toBeUndefined()
    expect(wordReply('pretzel', last, T + 29_000)?.slug).toBe('stanley-hudson')
    expect(wordReply('big', last, T + 30_000)?.slug).toBe('michael-scott')
  })
})

describe('ready', () => {
  it('true once per window, then false until it passes', () => {
    const m = new Map<string, number>()
    expect(ready(m, 'event', 60_000, 0)).toBe(true)
    expect(ready(m, 'event', 60_000, 59_999)).toBe(false)
    expect(ready(m, 'event', 60_000, 60_000)).toBe(true)
  })
})

describe('dundies', () => {
  const at = (h: number) => new Date(2026, 8, 30, h, 5).getTime()
  it('dundiesDue: from 17:00, once per day', () => {
    expect(dundiesDue(at(16), null)).toBe(false)
    expect(dundiesDue(at(17), null)).toBe(true)
    expect(dundiesDue(at(18), dayOf(at(9)))).toBe(false)
    expect(dundiesDue(at(18), dayOf(at(18) - 86_400_000))).toBe(true)
  })
  it('dundieLines: most jobs, longest job, one joke; null seats skipped', () => {
    const lines = dundieLines([{ seat: 0, ms: 60_000 }, { seat: 0, ms: 120_000 }, { seat: 2, ms: 600_000 }, { seat: null, ms: 9e9 }], () => 0)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Dwight Schrute')
    expect(lines[0]).toContain('2')
    expect(lines[1]).toContain('Pam Beesly')
    expect(lines[1]).toContain('10 min')
    expect(lines[2]).toContain(DUNDIE_JOKES[0])
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(90)
  })
  it('dundieLines: no jobs (or only null seats) → one no-Dundies line', () => {
    expect(dundieLines([], () => 0)).toHaveLength(1)
    expect(dundieLines([{ seat: null, ms: 1 }], () => 0)).toEqual(dundieLines([], () => 0))
    expect(dundieLines([], () => 0)[0].toLowerCase()).toContain('no dundies')
  })
})
