import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, placeholder, rectangularSelection } from '@codemirror/view';
import { formatKeymap } from './format';
import { frontmatterParser } from './frontmatterParser';
import { hasFollowModifier } from './links';
import { imagePaste } from './imagePaste';
import { headingLines, imageResolver, livePreview } from './livePreview';
import { editorHighlighting, editorTheme } from './theme';
import { linkTargets, wikilinkCompletion, type targetsOf } from './wikilinkCompletion';
import { wikilinkAt, wikilinkDecorations } from './wikilinkDecorations';

/**
 * The desktop app's editor (src/renderer/src/editor/ there), in the web app.
 * livePreview.ts, wikilinkDecorations.ts, frontmatterParser.ts, theme.ts and
 * format.ts are that app's files as they are. This one differs in what it is
 * given: the desktop app's editor reads its vault from a store, this one is
 * handed the link targets and the hooks by the page it is on.
 */

export interface EditorHooks {
  onSave: () => void;
  onOpenLink: (target: string) => void;
  /** Image target inside a note -> URL the browser can load (null when the file is unknown). */
  resolveImage: (target: string) => string | null;
  /** What `[[` offers: see targetsOf(). */
  targets: ReturnType<typeof targetsOf>;
  /** An image pasted or dropped in -> the embed to write for it, once it is in the wiki (null when it was not added). */
  onImage?: (file: File) => Promise<string | null>;
}

/** Live preview is switched on and off at runtime through this compartment. */
export const livePreviewCompartment = new Compartment();

export const livePreviewExtension = (on: boolean): Extension => (on ? livePreview() : []);

/** Everything a note editor needs except the document itself and the update listener. */
export function baseExtensions(hooks: EditorHooks, live: boolean): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [frontmatterParser] }),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [wikilinkCompletion], activateOnTyping: true, icons: false }),
    linkTargets.of(hooks.targets),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    editorTheme,
    editorHighlighting,
    headingLines,
    wikilinkDecorations,
    imageResolver.of(hooks.resolveImage),
    hooks.onImage ? imagePaste(hooks.onImage) : [],
    livePreviewCompartment.of(livePreviewExtension(live)),
    placeholder('Start writing…'),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!hasFollowModifier(e) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const target = wikilinkAt(view.state.doc, pos);
        if (!target) return false;
        e.preventDefault();
        hooks.onOpenLink(target);
        return true;
      },
    }),
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          hooks.onSave();
          return true;
        },
      },
      ...formatKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
  ];
}
