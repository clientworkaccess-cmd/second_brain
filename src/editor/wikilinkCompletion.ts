import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { Facet } from '@codemirror/state';

/**
 * `[[` completion: the pages of the wiki, by what a link to them is written
 * as. The desktop app takes the list from its vault store; here the page gives
 * it to the editor through this facet.
 */
export const linkTargets = Facet.define<Completion[], Completion[]>({
  combine: (values) => values[0] ?? [],
});

const apply: Completion['apply'] = (view, completion, from, to) => {
  const alreadyClosed = view.state.sliceDoc(to, to + 2) === ']]';
  const insert = alreadyClosed ? completion.label : `${completion.label}]]`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length + (alreadyClosed ? 2 : 0) },
  });
};

/** The completions for a list of pages: what a link is written as, and the page's title beside it. */
export function targetsOf(pages: { link: string; title: string }[]): Completion[] {
  return pages
    .map((page) => ({ label: page.link, detail: page.title !== page.link ? page.title : undefined, apply }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function wikilinkCompletion(context: CompletionContext): CompletionResult | null {
  const m = context.matchBefore(/\[\[([^\]\[|#\n]*)$/);
  if (!m) return null;
  return {
    from: m.from + 2,
    options: context.state.facet(linkTargets),
    validFor: /^[^\]\[|#\n]*$/,
  };
}
