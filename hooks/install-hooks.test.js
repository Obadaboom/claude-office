import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'UserPromptSubmit', 'Notification', 'SessionEnd']
const install = HOME => spawnSync('bash', [join(HOOKS, 'install-hooks.sh')], { env: { ...process.env, HOME }, encoding: 'utf8' })

describe('install-hooks.sh (temp HOME only)', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'hooks-home-'))
  const file = join(HOME, '.claude', 'settings.json')
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [mine] } }))
  const backups = () => readdirSync(dirname(file)).filter(f => f.startsWith('settings.json.backup'))
  const cmd = `bash "${join(HOOKS, 'agent-tracker.sh')}"`

  it('backs up, keeps other settings and hooks, adds all 9 events pointing at this copy', () => {
    const r = install(HOME)
    expect(r.status, r.stderr).toBe(0)
    expect(backups()).toHaveLength(1)
    expect(readdirSync(dirname(file)).filter(f => f.endsWith('.tmp'))).toEqual([]) // atomic write left no temp file
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.PreToolUse[0]).toEqual(mine)
    expect(Object.keys(s.hooks).sort()).toEqual([...EVENTS].sort())
    for (const e of EVENTS) {
      const ours = s.hooks[e].filter(g => g.hooks.some(h => h.command === cmd))
      expect(ours, e).toHaveLength(1)
    }
    expect(s.hooks.Notification.at(-1).matcher).toBe('permission_prompt|idle_prompt|elicitation_dialog')
  })

  it('a second run adds nothing and writes nothing', () => {
    const before = readFileSync(file, 'utf8')
    const r = install(HOME)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(backups()).toHaveLength(1)
  })

  it('no settings file yet: creates it', () => {
    const home = mkdtempSync(join(tmpdir(), 'hooks-home-'))
    expect(install(home).status).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks)).toHaveLength(9)
  })
})
