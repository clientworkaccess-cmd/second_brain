// The desktop app's src/renderer/src/editor/livePreview.ts, as it is. Keep it in step.
import { syntaxTree } from '@codemirror/language'
import { Facet, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { isExternalHref, isImageFile, splitWikilink } from './links'

/** Resolves an image target (`[[img.png]]`, `![](path)`) to a loadable URL, or null when unknown. */
export const imageResolver = Facet.define<(target: string) => string | null, (target: string) => string | null>({
  combine: (values) => values[0] ?? (() => null)
})

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+)\]\]/g
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'Frontmatter'])

// ---- widgets ----

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-bullet'
    el.textContent = '•'
    return el
  }
  eq(): boolean {
    return true
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Offset of the `[` of the task marker. */
    readonly markerPos: number
  ) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.markerPos === this.markerPos
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'cm-lp-checkbox'
    input.checked = this.checked
    input.addEventListener('mousedown', (e) => e.preventDefault())
    input.addEventListener('click', (e) => {
      e.preventDefault()
      view.dispatch({ changes: { from: this.markerPos + 1, to: this.markerPos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return input
  }
}

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-hr'
    return el
  }
  eq(): boolean {
    return true
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string | null,
    readonly alt: string,
    readonly width?: number
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.width === this.width
  }
  toDOM(): HTMLElement {
    if (!this.src) {
      const el = document.createElement('span')
      el.className = 'cm-lp-image-missing'
      el.textContent = this.alt
      return el
    }
    const img = document.createElement('img')
    img.className = 'cm-lp-image'
    img.src = this.src
    img.alt = this.alt
    if (this.width) img.width = this.width
    return img
  }
}

// ---- decoration builders ----

const hide = Decoration.replace({})
const lineClass = (cls: string): Decoration => Decoration.line({ class: cls })

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Heading lines get a size class so the whole line (marks included) scales together. Used in both editor modes. */
function buildHeadingLines(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const doc = view.state.doc
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const m = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
        if (!m) return
        const level = m[1]
        const first = doc.lineAt(node.from)
        ranges.push(lineClass(`cm-lp-h${level}`).range(first.from))
        return false
      }
    })
  }
  return Decoration.set(ranges, true)
}

/** The parser works incrementally in the background, so a tree change alone must trigger a rebuild. */
const treeChanged = (u: ViewUpdate): boolean => syntaxTree(u.state) !== syntaxTree(u.startState)

export const headingLines = ViewPlugin.fromClass(
  class {
    deco: DecorationSet
    constructor(view: EditorView) {
      this.deco = buildHeadingLines(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || treeChanged(u)) this.deco = buildHeadingLines(u.view)
    }
  },
  { decorations: (v) => v.deco }
)

function buildLivePreview(view: EditorView): DecorationSet {
  const state: EditorState = view.state
  const doc = state.doc
  const sel = state.selection
  const resolveImage = state.facet(imageResolver)
  const ranges: Range<Decoration>[] = []
  const add = (from: number, to: number, deco: Decoration): void => {
    ranges.push(deco.range(from, to))
  }
  // A selection touching a range (inclusive) reveals its raw markup, like Obsidian's live preview.
  const touches = (from: number, to: number): boolean => sel.ranges.some((r) => r.to >= from && r.from <= to)
  const lineActive = (pos: number): boolean => {
    const line = doc.lineAt(pos)
    return touches(line.from, line.to)
  }
  const eachLine = (from: number, to: number, cls: string): void => {
    let pos = from
    while (pos <= to) {
      const line = doc.lineAt(pos)
      ranges.push(lineClass(cls).range(line.from))
      if (line.to >= to) break
      pos = line.to + 1
    }
  }
  const charAt = (pos: number): string => doc.sliceString(pos, pos + 1)

  const tree = syntaxTree(state)
  let quoteUntil = -1
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'Frontmatter':
            eachLine(node.from, node.to, 'cm-lp-frontmatter')
            return false
          case 'FencedCode':
          case 'CodeBlock':
            eachLine(node.from, node.to, 'cm-lp-codeblock')
            return false
          case 'HorizontalRule':
            if (!lineActive(node.from)) add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }))
            return false
          case 'Blockquote':
            if (node.from >= quoteUntil) {
              eachLine(node.from, node.to, 'cm-lp-quote')
              quoteUntil = node.to
            }
            return
          case 'QuoteMark':
            if (!lineActive(node.from)) add(node.from, node.to + (charAt(node.to) === ' ' ? 1 : 0), hide)
            return
          case 'HeaderMark': {
            const atLineStart = doc.lineAt(node.from).from === node.from
            if (!lineActive(node.from)) add(node.from, atLineStart && charAt(node.to) === ' ' ? node.to + 1 : node.to, hide)
            return
          }
          case 'ListMark': {
            const text = doc.sliceString(node.from, node.to)
            if (!/^[-*+]$/.test(text)) return
            const next = node.node.nextSibling
            if (next?.name === 'Task') {
              const marker = next.getChild('TaskMarker')
              if (marker) {
                const checked = doc.sliceString(marker.from, marker.to).toLowerCase() !== '[ ]'
                const end = marker.to + (charAt(marker.to) === ' ' ? 1 : 0)
                add(node.from, end, Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }))
              }
              return
            }
            add(node.from, node.to + (charAt(node.to) === ' ' ? 1 : 0), Decoration.replace({ widget: new BulletWidget() }))
            return
          }
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const parent = node.node.parent
            if (parent && !touches(parent.from, parent.to)) add(node.from, node.to, hide)
            return
          }
          case 'InlineCode': {
            add(node.from, node.to, Decoration.mark({ class: 'cm-lp-inline-code' }))
            if (!touches(node.from, node.to)) {
              for (const mark of node.node.getChildren('CodeMark')) add(mark.from, mark.to, hide)
            }
            return false
          }
          case 'Link': {
            if (touches(node.from, node.to)) return
            const marks = node.node.getChildren('LinkMark')
            if (marks.length >= 2) {
              add(marks[0].from, marks[0].to, hide)
              add(marks[1].from, node.to, hide)
            }
            return false
          }
          case 'Image': {
            if (touches(node.from, node.to)) return
            const url = node.node.getChild('URL')
            const src = url ? doc.sliceString(url.from, url.to) : ''
            const alt = imageAlt(node.node, doc.sliceString.bind(doc))
            const resolved = isExternalHref(src) ? src : resolveImage(safeDecode(src))
            add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(resolved, alt) }))
            return false
          }
          default:
            return
        }
      }
    })

    // [[wikilinks]] and ![[embeds]] are not syntax-tree nodes: scan the visible text.
    const text = doc.sliceString(from, to)
    for (const m of text.matchAll(WIKILINK_RE)) {
      const start = from + m.index
      const end = start + m[0].length
      if (touches(start, end) || CODE_NODES.has(tree.resolveInner(start, 1).name)) continue
      const { target, alias } = splitWikilink(m[2])
      if (m[1] === '!' && isImageFile(target)) {
        const width = /^\d+$/.test(alias ?? '') ? Number(alias) : undefined
        add(start, end, Decoration.replace({ widget: new ImageWidget(resolveImage(target), target, width) }))
        continue
      }
      const open = start + m[1].length
      const pipe = alias !== undefined ? m[0].lastIndexOf('|') : -1
      if (pipe !== -1) add(open, start + pipe + 1, hide) // "[[target#heading|" -> show the alias only
      else add(open, open + 2, hide)
      add(end - 2, end, hide)
    }
  }
  return Decoration.set(ranges, true)
}

function imageAlt(node: SyntaxNode, slice: (from: number, to: number) => string): string {
  const marks = node.getChildren('LinkMark')
  // ![alt](src): alt sits between the first "[" mark and the "]" mark.
  if (marks.length >= 2) return slice(marks[0].to, marks[1].from)
  return ''
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet
    constructor(view: EditorView) {
      this.deco = buildLivePreview(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet || treeChanged(u)) this.deco = buildLivePreview(u.view)
    }
  },
  { decorations: (v) => v.deco }
)

/** Obsidian-style live preview: markup is hidden except where the cursor is; lists, tasks, rules and images render inline. */
export function livePreview(): Extension {
  return [livePreviewPlugin]
}
