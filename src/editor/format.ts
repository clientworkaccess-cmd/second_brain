// The desktop app's src/renderer/src/editor/format.ts, as it is. Keep it in step.
import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state'
import type { KeyBinding } from '@codemirror/view'

/** Number of consecutive `char`s starting at `from` going in `direction` (capped, runs never need more). */
function runLength(text: string, char: string, from: number, direction: -1 | 1, max = 4): number {
  let n = 0
  let i = direction === -1 ? from - 1 : from
  while (n < max && i >= 0 && i < text.length && text[i] === char) {
    n++
    i += direction
  }
  return n
}

/**
 * Toggle a run of marker characters (`*`, `**`, `~~`, `` ` ``) around each selection, markdown-aware:
 * a single `*` inside `**bold**` adds italic (`***bold***`) instead of eating a bold star, because
 * presence is judged by the length of the marker run on both sides (odd ⇒ italic, ≥2 ⇒ bold/strike).
 * The selection stays on the inner text.
 */
function toggleRun(marker: string): StateCommand {
  const char = marker[0]
  const step = marker.length
  return ({ state, dispatch }) => {
    const text = state.doc.toString()
    const tr = state.changeByRange((range) => {
      let { from, to } = range
      // A selection that includes the markers themselves is treated as its inner text.
      if (from < to) {
        const innerBefore = runLength(text, char, from, 1)
        const innerAfter = runLength(text, char, to, -1)
        if (innerBefore >= step && innerAfter >= step && to - from > innerBefore + innerAfter) {
          from += innerBefore
          to -= innerAfter
        }
      }
      const n = Math.min(runLength(text, char, from, -1), runLength(text, char, to, 1))
      const present = char === '`' ? n >= 1 : step === 1 ? n % 2 === 1 : n >= step
      if (present) {
        return {
          changes: [
            { from: from - step, to: from },
            { from: to, to: to + step }
          ],
          range: EditorSelection.range(from - step, to - step)
        }
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker }
        ],
        range: EditorSelection.range(from + step, to + step)
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/** Wrap in distinct opening/closing strings (e.g. `[[` … `]]`), unwrapping when already wrapped. */
function wrapPair(before: string, after: string): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const outerFrom = range.from - before.length
      const outerTo = range.to + after.length
      if (outerFrom >= 0 && outerTo <= state.doc.length && state.sliceDoc(outerFrom, range.from) === before && state.sliceDoc(range.to, outerTo) === after) {
        return {
          changes: [
            { from: outerFrom, to: range.from },
            { from: range.to, to: outerTo }
          ],
          range: EditorSelection.range(outerFrom, outerFrom + (range.to - range.from))
        }
      }
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after }
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length)
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

export const toggleBold = toggleRun('**')
export const toggleItalic = toggleRun('*')
export const toggleStrikethrough = toggleRun('~~')
export const toggleInlineCode = toggleRun('`')
export const insertWikilink = wrapPair('[[', ']]')

/** `[text](url)` with the url selected for typing; wraps the selection as the text. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || 'link text'
    const insert = `[${text}](url)`
    const urlFrom = range.from + text.length + 3
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlFrom, urlFrom + 3) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

/** Apply `fn` to every line touched by the selection; `fn` returns the replacement line or null to skip. */
function mapLines(fn: (line: string) => string | null): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = []
    const seen = new Set<number>()
    for (const range of state.selection.ranges) {
      for (let pos = range.from; ; ) {
        const line = state.doc.lineAt(pos)
        if (!seen.has(line.number)) {
          seen.add(line.number)
          const next = fn(line.text)
          if (next !== null && next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
        }
        if (line.to >= range.to) break
        pos = line.to + 1
      }
    }
    if (changes.length === 0) return false
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

const HEADING = /^(#{1,6})\s+/
const BULLET = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?/
const QUOTE = /^>\s?/

/** `#` → `##` → … → `######` → plain → `#`. */
export const cycleHeading = mapLines((line) => {
  const m = HEADING.exec(line)
  if (!m) return `# ${line}`
  const level = m[1].length
  const rest = line.slice(m[0].length)
  return level >= 6 ? rest : `${'#'.repeat(level + 1)} ${rest}`
})

export const toggleBulletList = mapLines((line) => {
  const m = BULLET.exec(line)
  if (m) return m[1] + line.slice(m[0].length)
  return `- ${line}`
})

export const toggleTaskList = mapLines((line) => {
  const m = BULLET.exec(line)
  if (m && m[3]) return `${m[1]}${m[2]} ${line.slice(m[0].length)}` // task -> plain bullet
  if (m) return `${m[1]}${m[2]} [ ] ${line.slice(m[0].length)}` // bullet -> task
  return `- [ ] ${line}`
})

export const toggleQuote = mapLines((line) => (QUOTE.test(line) ? line.replace(QUOTE, '') : `> ${line}`))

export const formatKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-k', run: insertLink }
]
