/**
 * Callouts: a quote that starts with `[!type] Title` is drawn as a box of that
 * type, the way the desktop app draws it.
 *
 *   > [!conflict]
 *   > An earlier note gave the window as fourteen days. This one gives thirty.
 *
 * A remark plugin, in the shape react-markdown takes them. Pure, so the browser
 * can use it for a chat answer as well as the server for a page.
 */

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
}

const MARK = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/;

export function remarkCallouts() {
  return (tree: Node): void => {
    visit(tree);
  };
}

function visit(node: Node): void {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') asCallout(child);
    visit(child);
  }
}

function asCallout(quote: Node): void {
  const first = quote.children?.[0];
  const text = first?.type === 'paragraph' ? first.children?.[0] : undefined;
  if (!first || !text || text.type !== 'text' || typeof text.value !== 'string') return;
  const found = MARK.exec(text.value);
  if (!found) return;

  const type = found[1].toLowerCase();
  const title = found[3].trim() || type[0].toUpperCase() + type.slice(1);
  quote.data = { ...quote.data, hName: 'div', hProperties: { className: ['callout', `callout-${type}`], 'data-callout': type } };

  const heading: Node = {
    type: 'paragraph',
    data: { hName: 'div', hProperties: { className: ['callout-title'] } },
    children: [{ type: 'text', value: title }],
  };
  const rest = text.value.slice(found[0].length);
  if (rest.trim() === '' && (first.children?.length ?? 0) === 1) {
    quote.children!.splice(0, 1, heading); // the marker was the whole paragraph
  } else {
    text.value = rest;
    quote.children!.unshift(heading);
  }
}
