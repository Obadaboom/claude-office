import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// 2z: docs/index.html is the GitHub Pages guide. README.md is the source of truth.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = readFileSync(join(ROOT, 'docs/index.html'), 'utf8')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const PROMPT = README.match(/```\n(Set up the Claude Office[^\n]+)\n```/)[1]
const text = HTML.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')

describe('guide page', () => {
  it('shows the README prompt verbatim in plain text, and the Copy button copies that element', () => {
    expect(text).toContain(PROMPT)
    expect(HTML).toMatch(/<pre id="prompt">/)
    expect(HTML).toMatch(/getElementById\('prompt'\)\.textContent/)
  })

  it('has every section, in order', () => {
    const order = ['Claude Office', 'Give Claude Code this link and say: set this up.', 'https://obadaboom.github.io/',
      'Or paste this:', PROMPT, 'Works with any Claude Code model.', 'What you need',
      'Claude Code. Claude checks and installs the rest (it asks first).', 'Works on Mac and Linux. On Windows, use WSL.',
      "What you'll see",
      'Tapping an option on a note works in demo mode only.',
      'Five things in the office open boards: the board on the wall (To-do)', 'Your own boards',
      'Status queued or building = to do. built or ready = needs you. done , live or shipped = off the board.', 'Privacy',
      'How to remove it', 'Credit', 'W17ANT', 'MIT', 'By hand', 'Download ZIP', 'rename the folder to ~/claude-office', 'git clone']
    let at = -1
    for (const s of order) {
      const i = text.indexOf(s, at + 1)
      expect(i, s).toBeGreaterThan(at)
      at = i
    }
  })

  it('never claims Anthropic made it, loads no external script', () => {
    expect(HTML).not.toMatch(/anthropic/i)
    expect(HTML).not.toMatch(/<script[^>]+src=/)
  })

  it('Copy falls back to selecting the prompt text', () => {
    expect(HTML).toMatch(/catch \{[\s\S]*selectNodeContents\(document\.getElementById\('prompt'\)\)/)
  })

  it('image path resolves inside docs/, .nojekyll exists', () => {
    expect(HTML).toContain('src="images/office-demo.png"')
    expect(existsSync(join(ROOT, 'docs/images/office-demo.png'))).toBe(true)
    expect(existsSync(join(ROOT, 'docs/.nojekyll'))).toBe(true)
  })
})
