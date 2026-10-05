// The desktop app's src/renderer/src/editor/wikilinkDecorations.ts, as it is. Keep it in step.
import type { Text } from '@codemirror/state'
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

export const WIKILINK_RE = /\[\[[^\]\n]+\]\]/g
// A tag is "#" + letters/digits/_/-// with at least one non-digit, preceded by start of line or whitespace.
export const TAG_RE = /(^|\s)(#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu

const wikilinkMatcher = new MatchDecorator({
  regexp: WIKILINK_RE,
  decoration: Decoration.mark({ class: 'cm-wikilink' })
})

const tagMatcher = new MatchDecorator({
  regexp: TAG_RE,
  decorate: (add, from, to, match) => add(from + match[1].length, to, Decoration.mark({ class: 'cm-tag' }))
})

function matcherPlugin(matcher: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet
      constructor(view: EditorView) {
        this.deco = matcher.createDeco(view)
      }
      update(u: ViewUpdate): void {
        this.deco = matcher.updateDeco(u, this.deco)
      }
    },
    { decorations: (v) => v.deco }
  )
}

export const wikilinkDecorations = [matcherPlugin(wikilinkMatcher), matcherPlugin(tagMatcher)]

/** The `[[target]]` (inner text, alias/heading stripped) that spans document position `pos`, if any. */
export function wikilinkAt(doc: Text, pos: number): string | null {
  const line = doc.lineAt(pos)
  const col = pos - line.from
  for (const m of line.text.matchAll(WIKILINK_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (col >= start && col <= end) {
      const inner = m[0].slice(2, -2)
      return inner.split('|')[0].split('#')[0].trim() || null
    }
  }
  return null
}
