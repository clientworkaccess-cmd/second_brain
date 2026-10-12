import { indexFile, logFile, type Layout } from './layout';

/**
 * The reader's message, as the agent is given it.
 *
 * It is a message in a conversation, not a query to a search box: a greeting
 * is answered as a greeting, a question about the conversation as that, and
 * only a question about what the pages might hold sends the agent to read
 * them. An earlier wording ("answer using only the wiki; if it does not cover
 * it, say so") had it reply to "hello" that the wiki did not cover greetings.
 *
 * To the reader it is their brain, never "the wiki", and a reply carries no
 * citations in its text: the pages it drew on go on a SOURCES line, which the
 * app shows apart from the reply.
 *
 * In lib rather than in the route so that the check scripts ask the real binary
 * the same thing the app does.
 */
export function chatPrompt(question: string, layout: Layout): string {
  const example = layout.links === 'slug' ? '[[page-file-name]], [[other-page]]' : '[[Page Name]], [[Other Page]]';
  return [
    `The reader's message, in a conversation with you about their brain (the knowledge base in your working directory): "${question}"`,
    ``,
    `Reply as you naturally would in a conversation. A greeting, small talk, or a question about you or about this`,
    `conversation: just answer it, briefly. You do remember what was said earlier in this conversation.`,
    ``,
    `When the message asks about anything the brain might hold (their businesses, people, plans, decisions), look first.`,
    `Start from ${indexFile(layout)} and follow [[wikilinks]] to the pages that matter. Say what is there and do not guess facts.`,
    `If it is not there, say so in one sentence and offer what you can do instead. When they are thinking something`,
    `through, think with them: the facts come from the brain, the reasoning is yours.`,
    ``,
    `To the reader it is "the brain" or "your brain"; do not call it "the wiki". Do not describe what you opened or`,
    `searched. Do not cite sources inside the reply: no page references in brackets after a sentence, no footnotes.`,
    ``,
    `If you drew on pages, end with a line of this form, and leave it out if you drew on none:`,
    `SOURCES: ${example}`,
  ].join('\n');
}

/**
 * The question, in a conversation that may change the wiki. The agent answers
 * as above, and writes only when the question asks it to; what it writes the
 * app checks and commits afterwards, as it does a filing.
 */
export function workPrompt(question: string, layout: Layout, source: string | null = null): string {
  const example = layout.links === 'slug' ? '[[page-file-name]]' : '[[Page Name]]';
  return [
    chatPrompt(question, layout),
    ``,
    // What the reader says here is something to write from. The app has kept it
    // where sources are kept, because the wiki's rules ask for a source and the
    // agent may not write there itself.
    ...(source
      ? [
          `What has been said in this conversation is a source, and the app has kept it for you at ${source}.`,
          `What the reader said there is first-hand, like a note or an email from them. You may write the wiki from it:`,
          `treat that file as the source document, exactly as in a filing, and cite it the way this wiki cites its sources.`,
          `No other document is needed, and none is missing. The answer above may draw on it as well as on the pages.`,
          ``,
        ]
      : []),
    `In this conversation you may change the brain's pages. Do so only when the message asks for it: to write something`,
    `down, add a page, or change one. If it is only a question, answer it and write nothing.`,
    `When you write, follow the rules for pages as a filing does (citations belong in pages, though not in your reply):`,
    `keep ${indexFile(layout)} and ${logFile(layout)} in step.`,
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
    'This message continues a conversation you have been having with the reader. What was said so far, oldest first:',
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
