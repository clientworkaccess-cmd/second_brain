/**
 * The models a question can be asked of. Claude Code's own aliases, which
 * follow the newest of each family; "default" is whatever the server is set
 * to (CLAUDE_MODEL), or Claude Code's own default when it is not. Pure, no
 * Node imports: the chat panel and the chat route both read it.
 */

export interface ModelChoice {
  /** What goes after `--model`, or `default` for none. */
  id: 'default' | 'opus' | 'sonnet' | 'haiku';
  label: string;
  hint: string;
}

export const MODELS: readonly ModelChoice[] = [
  { id: 'default', label: 'Default', hint: 'Opus for analysis and advice; otherwise what the server is set to' },
  { id: 'opus', label: 'Opus', hint: 'The most capable; slower' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Capable and quick' },
  { id: 'haiku', label: 'Haiku', hint: 'The quickest; for simple questions' },
];

export const DEFAULT_MODEL: ModelChoice['id'] = 'default';

/**
 * The model to pass, from what a request or a browser kept: an alias from the
 * list, or null for the server's default. Anything else is null too, never an
 * error: the question is still answered, by the default.
 */
export function modelChoice(value: unknown): Exclude<ModelChoice['id'], 'default'> | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  const known = MODELS.find((m) => m.id === id);
  return known && known.id !== 'default' ? known.id : null;
}

/** A model id as the binary reports it (`claude-opus-5-5`), as the family it belongs to, for showing. */
export function familyOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const family of ['opus', 'sonnet', 'haiku']) if (lower.includes(family)) return family.charAt(0).toUpperCase() + family.slice(1);
  return model;
}

/**
 * Whether a message asks for thinking rather than a lookup: analysis, strategy,
 * a plan, advice, risks, a comparison. Such a message, left to the default, is
 * asked of Opus; a lookup goes to the server's default. A guess from the words,
 * so it errs towards Opus only on words that rarely come in a plain lookup.
 */
const THINKING = /\b(should\s+(i|we)|shall\s+we|what\s+would\s+you|what\s+do\s+you\s+(think|recommend|suggest)|strateg\w*|recommend\w*|advi[cs]e|analy[sz]\w*|assess\w*|evaluat\w*|compar\w*|pros\s+and\s+cons|trade-?offs?|risks?|priorit\w*|decid\w*|forecast\w*|scenario\w*|what\s+if|how\s+(can|could|do|should)\s+(i|we)|improve\w*|grow\w*|plan\s+for|what\s+am\s+i\s+missing|opportunit\w*|weak\w*)\b/i;

export function asksForThinking(question: string): boolean {
  return THINKING.test(question);
}

/** The model for a question: what the reader chose, or, left to the default, Opus for thinking and the server's for the rest. */
export function modelFor(choice: unknown, question: string): Exclude<ModelChoice['id'], 'default'> | null {
  return modelChoice(choice) ?? (asksForThinking(question) ? 'opus' : null);
}
