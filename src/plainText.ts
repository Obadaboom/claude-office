/** __x__ as bold only: markers at non-word boundaries around text, so __init__.py and __dirname stay */
const UNDERSCORE_BOLD = /(^|[\s([{"'])__([^\s_](?:[^\n]*?[^\s_])?)__(?=[.,;:!?)\]}"']*(?:\s|$))/gm
/** **x** on one line, no space just inside the markers */
const STAR_BOLD = /\*\*(\S(?:[^\n]*?\S)??)\*\*/g
const LIST = /^(\s*)([-*]|\d+[.)])\s+(.*)$/
const ITEM = /^\d+[.)] / // a top-level numbered line in plainText output

/**
 * Markdown → display lines for the panels (2y). Kept: `1.`/`2)` numbers, `-`/`*` bullets as `• `,
 * nesting as 2 spaces per level, bold as paired `**x**` (boldSegments renders it). Gone: # marks,
 * backticks, stray `**`; links keep their text.
 */
export function plainText(md: string) {
  const stack: number[] = [] // indents of the open list levels
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(UNDERSCORE_BOLD, '$1\u0001$2\u0002')
    .replace(STAR_BOLD, '\u0001$1\u0002')
    .replace(/\*\*|`/g, '')
    .replace(/[\u0001\u0002]/g, '**')
    .split('\n')
    .map(raw => {
      const l = raw.replace(/\t/g, '    '), m = l.match(LIST)
      if (!m) {
        if (/^\S/.test(l)) stack.length = 0 // a top-level paragraph ends any list
        return l.replace(/^\s*#+\s+/, '').trim()
      }
      const at = m[1].length
      while (stack.length && stack[stack.length - 1] > at) stack.pop()
      if (!stack.length || stack[stack.length - 1] < at) stack.push(at)
      return `${'  '.repeat(stack.length - 1)}${/\d/.test(m[2]) ? m[2] : '•'} ${m[3].trim()}`
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** plainText output as text runs; `**` marks bold. Render as React nodes, never as HTML. */
export const boldSegments = (t: string) =>
  t.split('**').map((text, i) => ({ text, bold: i % 2 === 1 })).filter(s => s.text)

const visible = (t: string) => t.replace(/\*\*/g, '')

/** 2v demo: a top-level numbered line of plainText output → its number and plain text (no number, no bold marks), else null */
export function option(line: string) {
  const m = line.match(/^(\d+)[.)] (.*)$/)
  return m ? { n: m[1], text: visible(m[2]).trim() } : null
}

/** The start of t holding n visible chars; a bold cut open is closed */
function head(t: string, n: number) {
  let i = 0, seen = 0, open = false
  while (i < t.length && seen < n) {
    if (t.startsWith('**', i)) { open = !open; i += 2 } else { i++; seen++ }
  }
  if (open && t.startsWith('**', i)) { open = false; i += 2 }
  return t.slice(0, i) + (open ? '**' : '')
}

/** ≤ n visible chars cut at the last sentence end (longer than `min`, its . or ! dropped), else a word end, + … only when cut. Never mid-word. */
function cut(t: string, n: number, min: number) {
  const v = visible(t)
  if (v.length <= n) return t
  const h = v.slice(0, n + 1) // the char after the limit shows whether the cut lands on a boundary
  const sentence = h.match(/^[\s\S]*[.!?](?=\s)/)?.[0]
  const kept = sentence && sentence.length > min ? sentence.replace(/[.!]$/, '') : (h.match(/^[\s\S]*\S(?=\s)/)?.[0] ?? v.slice(0, n)).trimEnd()
  return `${head(t, kept.length)}…`
}

/**
 * Short view. Over n chars with a numbered list: the lead line, each top-level numbered item's
 * first line (≤ ~90 chars each) and a closing `?` line. Else ≤ n chars at a sentence end (past
 * half, . or ! dropped) or a word end, + … only when cut.
 */
export function shortText(t: string, n = 160) {
  if (visible(t).length <= n) return t
  const lines = t.split('\n').filter(l => l.trim())
  if (!lines.some(l => ITEM.test(l))) return cut(t, n, n / 2)
  const line = (l: string) => cut(l, 90, 22)
  const last = lines[lines.length - 1]
  const out = [
    ...(ITEM.test(lines[0]) ? [] : [line(lines[0])]),
    ...lines.filter(l => ITEM.test(l)).map(line),
    ...(!ITEM.test(last) && visible(last).endsWith('?') ? [last] : []),
  ].join('\n')
  return out === lines.join('\n') ? t : out
}
