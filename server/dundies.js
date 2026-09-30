/**
 * dundies.js — today's real finishes per seat (2o), for Michael's Dundies. Kept in memory,
 * saved to ~/.agent-office/dundies.json so an office restart keeps today's counts.
 */
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const dayOf = now => new Date(now).toDateString() // local date

export function openDundies(file = join(homedir(), '.agent-office', 'dundies.json')) {
  let s = { day: '', jobs: [] }
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(saved?.jobs)) s = saved // a bad file never throws inside agent_completed
  } catch {}
  const today = now => {
    if (s.day !== dayOf(now)) s = { day: dayOf(now), jobs: [] }
    return s.jobs
  }
  return {
    noteJob(seat, ms, now = Date.now()) {
      today(now).push({ seat, ms })
      try { writeFileSync(file, JSON.stringify(s)) } catch {}
    },
    todayJobs: (now = Date.now()) => today(now),
  }
}
