// The desktop app's src/renderer/src/editor/frontmatterParser.ts, as it is. Keep it in step.
import { styleTags, tags as t } from '@lezer/highlight'
import type { BlockContext, Element, Line, MarkdownConfig } from '@lezer/markdown'

const FENCE = /^---\s*$/
const CLOSE = /^(---|\.\.\.)\s*$/

/**
 * YAML frontmatter as a proper block node. Without this, `title: X` followed by `---` parses as a
 * Setext heading and the whole block gets random formatting.
 */
export const frontmatterParser: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }, 'FrontmatterMark'],
  props: [styleTags({ Frontmatter: t.documentMeta, FrontmatterMark: t.processingInstruction })],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line): boolean {
        if (cx.lineStart !== 0 || !FENCE.test(line.text)) return false
        const marks: Element[] = [cx.elt('FrontmatterMark', 0, line.text.length)]
        while (cx.nextLine()) {
          if (CLOSE.test(line.text)) {
            const to = cx.lineStart + line.text.length
            marks.push(cx.elt('FrontmatterMark', cx.lineStart, to))
            cx.nextLine()
            cx.addElement(cx.elt('Frontmatter', 0, to, marks))
            return true
          }
        }
        // Unterminated: treat the rest of the note as frontmatter rather than as headings.
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), marks))
        return true
      }
    }
  ]
}
