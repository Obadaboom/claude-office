import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { plainText, shortText, boldSegments, option } from './plainText'
import { CleanText } from './components/SessionPanel'

// A real waiting message (row 2y)
const FIXTURE = `You're right. Copy-and-paste only saves you finding the session yourself.

**Options that actually do something**
1. **Your Mac types it for you (recommended).** Send opens the session, pastes your text and presses Enter.
   - It's a real message from you.
   - Risk: if you click somewhere else during that one second, the text lands in the wrong window.
2. **Handed over when its turn ends.** Your reply waits and is given to the session when it finishes.
3. **Remove the box.** Keep **Open**, which takes you to the session in one click.

Which one?`

describe('plainText', () => {
  it('2y: keeps numbers, bullets as •, bold as **; drops # marks, backticks and link urls', () => {
    const md = '## Done\n\n**Paths:**\n- `src/a.ts` changed\n* __b.ts__ too\n1. see [the docs](https://x.test/d)\n2) second\n\n\n\nEnd.'
    expect(plainText(md)).toBe('Done\n\n**Paths:**\n• src/a.ts changed\n• **b.ts** too\n1. see the docs\n2) second\n\nEnd.')
  })

  it('2y: nested items indent 2 spaces per level, whatever the source indent', () => {
    const md = '- a\n    - b\n        - c\n    - b2\n- a2\n1. one\n   - under one\n     1. deeper\n2. two\n\nPara\n  - fresh list'
    expect(plainText(md)).toBe('• a\n  • b\n    • c\n  • b2\n• a2\n1. one\n  • under one\n    1. deeper\n2. two\n\nPara\n• fresh list')
  })

  it('2y: stray ** go, paired ** stay; the fixture keeps its options', () => {
    expect(plainText('a ** b and **c** d**')).toBe('a  b and **c** d')
    expect(plainText(FIXTURE)).toBe(`You're right. Copy-and-paste only saves you finding the session yourself.

**Options that actually do something**
1. **Your Mac types it for you (recommended).** Send opens the session, pastes your text and presses Enter.
  • It's a real message from you.
  • Risk: if you click somewhere else during that one second, the text lands in the wrong window.
2. **Handed over when its turn ends.** Your reply waits and is given to the session when it finishes.
3. **Remove the box.** Keep **Open**, which takes you to the session in one click.

Which one?`)
  })

  it('plain text stays as it is', () => {
    expect(plainText('All good, nothing to do.')).toBe('All good, nothing to do.')
  })

  it('keeps dunder names, __x__ as bold only when used as bold', () => {
    expect(plainText('edit __init__.py now')).toBe('edit __init__.py now')
    expect(plainText('__init__.py')).toBe('__init__.py')
    expect(plainText('uses __dirname here')).toBe('uses __dirname here')
    expect(plainText('__dirname and __filename')).toBe('__dirname and __filename')
    expect(plainText('`__init__` stays')).toBe('__init__ stays')
    expect(plainText('__bold__')).toBe('**bold**')
    expect(plainText('this is __very bold__, ok.')).toBe('this is **very bold**, ok.')
  })
})

describe('boldSegments', () => {
  it('splits ** runs into bold segments, text only', () => {
    expect(boldSegments('Keep **Open**, one **click**.')).toEqual([
      { text: 'Keep ', bold: false }, { text: 'Open', bold: true }, { text: ', one ', bold: false }, { text: 'click', bold: true }, { text: '.', bold: false },
    ])
    expect(boldSegments('**all**')).toEqual([{ text: 'all', bold: true }])
    expect(boldSegments('<b>x</b>')).toEqual([{ text: '<b>x</b>', bold: false }])
  })
})

describe('shortText', () => {
  it('2y: a numbered list shows the lead, each item\'s first line and the closing question', () => {
    const s = shortText(plainText(FIXTURE))
    expect(s).toBe(`You're right. Copy-and-paste only saves you finding the session yourself.
1. **Your Mac types it for you (recommended)**…
2. **Handed over when its turn ends**…
3. **Remove the box.** Keep **Open**, which takes you to the session in one click.
Which one?`)
    expect(s.split('**').length % 2).toBe(1) // bold stays paired
  })

  it('2y: item lines cut at a word end ≤ ~90 chars, … only when cut; no lead when the list comes first', () => {
    const long = `1. ${'word '.repeat(30)}end\n2. short one\n${'filler text '.repeat(10)}\nDone.`
    const [one, two, ...rest] = shortText(long).split('\n')
    expect(one.endsWith('word…')).toBe(true)
    expect(one.length).toBeLessThanOrEqual(91)
    expect(two).toBe('2. short one')
    expect(rest).toEqual([]) // no lead (list first), last line is not a question
  })

  it('2y: a bold run cut mid-way is closed', () => {
    const s = shortText(`Pick:\n1. **${'long bold words '.repeat(8)}**\n2. b\n${'x '.repeat(40)}`)
    expect(s.split('\n')[1]).toMatch(/^1\. \*\*long bold words .*\w\*\*…$/)
  })

  it('2y: no numbered list keeps the 160-char cut; ** do not count toward it', () => {
    const t = `**Heads up.** ${'a'.repeat(100)}. Second sentence here! Third one keeps going and going well past the limit.\n• bullet`
    expect(shortText(t)).toBe(`**Heads up.** ${'a'.repeat(100)}. Second sentence here…`)
    expect(shortText(`**${'b'.repeat(150)}**`)).toBe(`**${'b'.repeat(150)}**`)
  })

  it('short input unchanged, no …', () => {
    expect(shortText('Short and sweet.')).toBe('Short and sweet.')
    expect(shortText('x'.repeat(160))).toBe('x'.repeat(160))
  })

  it('cuts at the last sentence end within the limit, drops its . or !, then …', () => {
    const t = `${'a'.repeat(100)}. Second sentence here! Third one keeps going and going well past the limit of the short view text.`
    expect(shortText(t)).toBe(`${'a'.repeat(100)}. Second sentence here…`)
    expect(shortText(t.replace('here!', 'here?'))).toBe(`${'a'.repeat(100)}. Second sentence here?…`)
  })

  it('no sentence end: cuts at a word end, never mid-word', () => {
    const t = `${'word '.repeat(40)}stay clean please`
    const s = shortText(t)
    expect(s.endsWith('word…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(161)
    expect(t.startsWith(s.slice(0, -1))).toBe(true)
  })

  it('one word past the limit is cut with … without throwing', () => {
    const t = 'x'.repeat(200)
    expect(() => shortText(t)).not.toThrow()
    expect(shortText(t)).toBe(`${'x'.repeat(160)}…`)
  })

  it('a sentence end too early falls back to the word end', () => {
    const t = `OK. ${'more words '.repeat(30)}`
    const s = shortText(t)
    expect(s.length).toBeGreaterThan(100)
    expect(s.endsWith('words…')).toBe(true)
  })
})

describe('2v demo: tappable note options', () => {
  const note = plainText('Done: a page. Gate green.\n\n1. Ship it\n2. **One more** review pass\n   - nested\n\nWhich one?')
  it('option() reads a top-level numbered line: number + plain text', () => {
    expect(option('1. Ship it')).toEqual({ n: '1', text: 'Ship it' })
    expect(option('2) **One more** pass')).toEqual({ n: '2', text: 'One more pass' })
    expect(option('  • nested')).toBeNull()
    expect(option('Which one?')).toBeNull()
  })
  it('the live note (no onPick) has no tappable option', () => {
    expect(renderToStaticMarkup(createElement(CleanText, { text: note }))).not.toContain('board-panel-option')
  })
  it('the demo note (onPick): only the numbered options are tappable, text unchanged', () => {
    const live = renderToStaticMarkup(createElement(CleanText, { text: note }))
    const demo = renderToStaticMarkup(createElement(CleanText, { text: note, onPick: () => {} }))
    expect(demo.match(/board-panel-option/g)).toHaveLength(2)
    expect(demo).toContain('<span class="board-panel-option">1. Ship it</span>')
    expect(demo).toContain('<span class="board-panel-option">2. <strong>One more</strong> review pass</span>')
    expect(demo.replace(/<\/?span[^>]*>|<!-- -->/g, '')).toBe(live.replace(/<!-- -->/g, ''))
  })
})
