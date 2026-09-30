// The desktop app's src/renderer/src/editor/theme.ts, as it is. Keep it in step.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/** Chrome of the editor, bound to the app's CSS variables so theme switches need no re-render. */
export const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-primary)', color: 'var(--text-normal)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-text)',
    fontSize: 'var(--font-size-text)',
    lineHeight: '1.6',
    overflow: 'auto'
  },
  '.cm-content': {
    maxWidth: 'var(--content-width)',
    margin: '0 auto',
    padding: '32px 24px 45vh',
    caretColor: 'var(--text-normal)'
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-normal)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection)'
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-normal)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size-ui)',
    maxHeight: '260px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--bg-active)',
    color: 'var(--text-normal)'
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-normal)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size-ui)'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button': {
    font: 'inherit',
    color: 'inherit',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: '4px'
  },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-selected)' },
  '.cm-wikilink': { color: 'var(--link)' },
  '.cm-ctrl-held .cm-wikilink': { textDecoration: 'underline', cursor: 'pointer' },
  '.cm-tag': { color: 'var(--accent)' }
})

/** Markdown structure plus a compact palette for fenced code. */
export const markdownHighlight = HighlightStyle.define([
  // Heading sizes come from the per-line classes (cm-lp-h1..6) so the marks scale with the text.
  { tag: [t.heading1, t.heading2], fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.documentMeta, color: 'var(--text-muted)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  { tag: t.labelName, color: 'var(--text-muted)' },
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: t.propertyName, color: 'var(--syn-property)' },
  { tag: t.operator, color: 'var(--text-muted)' }
])

export const editorHighlighting = syntaxHighlighting(markdownHighlight)
