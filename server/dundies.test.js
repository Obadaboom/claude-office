import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDundies } from './dundies.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'dundies-')), 'dundies.json')
const NOON = new Date(2026, 8, 30, 12).getTime()
const NEXT_DAY = new Date(2026, 9, 1, 9).getTime()

describe('dundies tally', () => {
  it('a noted job shows in today\'s jobs', () => {
    const d = openDundies(tmp())
    d.noteJob(2, 90_000, NOON)
    d.noteJob(null, 5_000, NOON)
    expect(d.todayJobs(NOON)).toEqual([{ seat: 2, ms: 90_000 }, { seat: null, ms: 5_000 }])
  })

  it('a new local day starts empty', () => {
    const d = openDundies(tmp())
    d.noteJob(1, 1000, NOON)
    expect(d.todayJobs(NEXT_DAY)).toEqual([])
  })

  it('a fresh module reads back the saved file', () => {
    const file = tmp()
    openDundies(file).noteJob(3, 42_000, NOON)
    expect(openDundies(file).todayJobs(NOON)).toEqual([{ seat: 3, ms: 42_000 }])
  })

  it('a missing or broken file is an empty day', () => {
    expect(openDundies(join(tmpdir(), 'no-such-dir-xyz', 'd.json')).todayJobs(NOON)).toEqual([])
  })

  it('a saved file without a jobs array starts empty and never throws', () => {
    const file = tmp()
    writeFileSync(file, JSON.stringify({ day: new Date(NOON).toDateString(), jobs: 'x' }))
    const d = openDundies(file)
    expect(() => d.noteJob(1, 1000, NOON)).not.toThrow()
    expect(d.todayJobs(NOON)).toEqual([{ seat: 1, ms: 1000 }])
    writeFileSync(file, 'null')
    expect(openDundies(file).todayJobs(NOON)).toEqual([])
  })
})
