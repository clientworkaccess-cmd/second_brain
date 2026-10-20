/**
 * Diagrams in an answer: a ```mermaid block, drawn as a picture in the chat
 * (components/MermaidDiagram.tsx). Pure, so the check scripts can drive it.
 *
 * The model writes the diagram, and the model reads documents that someone
 * else wrote, so a diagram is treated like any other text from it: anything
 * that would make it act rather than show is taken out before it is drawn.
 * Mermaid's own strict mode does the same; this is the second layer.
 */

/** Longer than any diagram the prompts ask for; past it, it is shown as code. */
export const DIAGRAM_MAX_CHARS = 8000;

/** The fence language that is drawn. */
export function isDiagram(className: unknown): boolean {
  return typeof className === 'string' && /(^|\s)language-mermaid(\s|$)/.test(className);
}

/**
 * The diagram as it is drawn, or null when there is nothing safe to draw:
 * without `click` lines (links and calls), `%%{...}%%` directives (which can
 * change the configuration) and comments.
 */
export function safeDiagram(code: string): string | null {
  if (code.length > DIAGRAM_MAX_CHARS) return null;
  const kept = code
    .replace(/\r\n?/g, '\n')
    .replace(/%%\{[\s\S]*?\}%%/g, '')
    .split('\n')
    .filter((line) => !/^\s*(click|href|callback)\b/i.test(line) && !/^\s*%%/.test(line))
    .join('\n')
    .trim();
  return kept ? kept : null;
}

/** Dark when the page says so, or when it says nothing and the system is dark. */
export function darkTheme(attribute: string | null, systemDark: boolean): boolean {
  return attribute === 'dark' || (attribute !== 'light' && systemDark);
}
