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
  { id: 'default', label: 'Default', hint: 'What the server is set to' },
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
