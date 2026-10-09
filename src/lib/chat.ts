import { indexFile, logFile, type Layout } from './layout';

/**
 * The question, as the agent is given it.
 *
 * In lib rather than in the route so that the check scripts ask the real binary
 * the same thing the app does.
 */
export function chatPrompt(question: string, layout: Layout): string {
  const example = layout.links === 'slug' ? '[[page-file-name]], [[other-page]]' : '[[Page Name]], [[Other Page]]';
  return [
    `Answer this question using only the wiki in your working directory: "${question}"`,
    ``,
    `Start from ${indexFile(layout)} and follow [[wikilinks]] to the pages that matter. Do not guess —`,
    `if the wiki does not cover it, say so plainly.`,
    ``,
    `Reply with the answer only. Do not describe what you are doing or which files you opened.`,
    ``,
    `End your answer with a line of the form:`,
    `SOURCES: ${example}`,
  ].join('\n');
}

/**
 * The question, in a conversation that may change the wiki. The agent answers
 * as above, and writes only when the question asks it to; what it writes the
 * app checks and commits afterwards, as it does a filing.
 */
export function workPrompt(question: string, layout: Layout): string {
  const example = layout.links === 'slug' ? '[[page-file-name]]' : '[[Page Name]]';
  return [
    chatPrompt(question, layout),
    ``,
    `In this conversation you may change the wiki. Do so only when the question asks for it: to write something down,`,
    `add a page, or change one. If the question is only a question, answer it and write nothing.`,
    `When you write, follow the wiki's rules as a filing does: keep ${indexFile(layout)} and ${logFile(layout)} in step.`,
    `Then end with a line of the form:`,
    `WROTE: ${example}, ...`,
  ].join('\n');
}

export interface RecapTurn {
  question: string;
  answer: string;
  error?: string | null;
}

const RECAP_ANSWER_MAX = 1500;
const RECAP_MAX = 12000;

/** An answer as it is recalled: its SOURCES and WROTE lines dropped, and long ones cut. */
function recalled(answer: string): string {
  const text = answer.replace(/^(SOURCES|WROTE):.*$/gm, '').trim();
  return text.length > RECAP_ANSWER_MAX ? `${text.slice(0, RECAP_ANSWER_MAX)}…` : text;
}

/**
 * What was said so far, for an agent that has forgotten: Claude Code's own
 * session for the conversation is gone (cleaned up, or the server moved), so
 * the next question is given the conversation from the app's record. Oldest
 * first; when it is long, the oldest go first. Empty when there is nothing to
 * recall.
 */
export function recapPrompt(turns: RecapTurn[]): string {
  const said = turns.filter((t) => !t.error && t.answer.trim()).map((t) => `Q: ${t.question.trim()}\nA: ${recalled(t.answer)}`);
  while (said.length > 0 && said.join('\n\n').length > RECAP_MAX) said.shift();
  if (said.length === 0) return '';
  return [
    'This question continues a conversation about this wiki. What was said so far, oldest first:',
    '',
    said.join('\n\n'),
    '',
    '(end of the earlier conversation)',
    '',
  ].join('\n');
}

/** The pages an answer names on its SOURCES line. */
export function sourcesOf(answer: string): string[] {
  const line = answer.match(/^SOURCES:\s*(.+)$/m)?.[1] ?? '';
  return [...line.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
}
