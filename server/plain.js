/**
 * Plain sentences (opt-in, AGENT_OFFICE_PLAIN=1): one short everyday sentence per board item, so an
 * opened item reads like a person wrote it, not a changelog. Haiku writes them through your own
 * `claude -p`, one batch call at a time; a disk cache keyed by a hash of the raw text means each text
 * is summarized once, ever. Off (the default) or in the demo office: never called.
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'

/** On only when you switch it on, and never on the demo office's made-up boards. */
export const plainOn = (env = process.env) => env.AGENT_OFFICE_PLAIN === '1' && env.AGENT_OFFICE_DEMO !== '1'

const SYSTEM = `You turn work notes into plain sentences for the owner of these projects, who may not be technical.
Input: a JSON object of id -> note. Output ONLY a JSON object with the same ids -> one sentence each.
Rules for each sentence:
- At most 15 words, everyday words.
- Say what the work means for the owner, their users or the project, not how it was built.
- Keep the status true: future tense for work not done yet, "paused" for paused or parked work, "now" only for live or done work.
- Only when the note says it waits on the owner, say what they must do, and call them "you".
- Never write ids of rows or tasks ("row 12", "#4", "2a"): leave the reference out or say "after an earlier step".
- Never write code, file names, paths, commit ids, times, time zones or tech words.
- Banned words: test, tests, CI, merge, commit, deploy, row, branch, migration, server, servers.
- Never say how the work was checked or shipped, only what changed for the owner or their users.
- If the work is only internal tooling with nothing for the owner, say so in plain words, e.g. "Our own checks now run faster."
Examples:
"Harbor Coffee app: Loyalty card screen — stamp card on the home tab (\`src/screens/Loyalty.tsx\`) — built 2026-10-01"
-> "The loyalty card screen is ready for you to look at."
"Nimbus Notes row 2 done: merged into \`main\` (a1b2c3d); dark mode toggle, 12/12 tests"
-> "Notes can now be read in dark mode."
"Trailhead Maps: Share a route link — queued, after row 1"
-> "Sharing a route as a link comes after an earlier step."`

/** One Haiku call: { id: note } in, { id: sentence } out. Empty cwd, no settings files, hooks, tools, MCP
 * or saved session, so it never loads a project's CLAUDE.md and never shows up in the office. */
export function askHaiku(items) {
  const cwd = mkdtempSync(join(tmpdir(), 'office-plain-'))
  const args = ['-p', '--model', 'haiku', '--system-prompt', SYSTEM, '--settings', '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
    '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--max-turns', '1', '--no-session-persistence']
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.AGENT_OFFICE_CLAUDE_CMD || 'claude', args, { cwd, timeout: 180_000 }, (err, out) => {
      rmSync(cwd, { recursive: true, force: true })
      if (err) return reject(err)
      try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))) } catch (e) { reject(e) }
    })
    child.stdin.on('error', () => {}) // a missing binary rejects through the callback
    child.stdin.end(JSON.stringify(items))
  })
}

/**
 * say(raw) → the cached sentence, or undefined and raw is queued. Queued texts go out `batch` per call,
 * one call in flight, `wait` ms after the last new text, at most `perHour` calls an hour. A failed call
 * logs once; its texts queue again the next time a board reads them.
 * ponytail: the cache is never pruned (~150 bytes per text ever shown).
 */
export function plainer({ ask = askHaiku, file = join(homedir(), '.agent-office', 'plain-cache.json'), onBatch = () => {}, batch = 40, perHour = 20, wait = 2000 } = {}) {
  let cache = {}
  try { cache = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const queue = new Map(), calls = []
  let busy = false, warned = false, timer
  const later = ms => { clearTimeout(timer); timer = setTimeout(run, ms) }

  async function run() {
    while (calls.length && calls[0] <= Date.now() - 36e5) calls.shift()
    if (busy || !queue.size) return
    if (calls.length >= perHour) return later(calls[0] + 36e5 - Date.now())
    busy = true
    calls.push(Date.now())
    const keys = [...queue.keys()].slice(0, batch) // short ids 1..n: Haiku echoes them back reliably
    const items = Object.fromEntries(keys.map((k, i) => [i + 1, queue.get(k)]))
    let ok = true
    try {
      const out = await ask(items)
      keys.forEach((k, i) => { const s = out[i + 1]; if (typeof s === 'string' && s.trim()) cache[k] = s.trim() })
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(cache))
    } catch (err) {
      ok = false
      if (!warned) { warned = true; console.warn(`[plain] no plain sentences, boards keep the raw detail: ${err.message.split('\n')[0]}`) }
    }
    keys.forEach(k => queue.delete(k)) // only now: a board read mid-call must not queue them twice
    busy = false
    if (ok) { onBatch(); run() } // backfill: the next batch right away
  }

  return raw => {
    if (!raw) return
    const k = createHash('sha1').update(raw).digest('hex')
    if (!(k in cache) && !queue.has(k)) { queue.set(k, raw); later(wait) }
    return cache[k]
  }
}
