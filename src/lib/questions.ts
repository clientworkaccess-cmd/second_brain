/**
 * Questions a reply asks before it answers: a ```questions block at the end of
 * the reply, which the chat shows as a card the reader answers in one go
 * (components/QuestionCard.tsx). Pure, so the check scripts can drive it.
 *
 * The block is JSON:
 *
 *   {"questions": [{"question": "Which period?", "options": ["Last quarter", "This year"], "multi": false}]}
 *
 * Anything that does not fit is dropped rather than shown half right: the
 * reply still reads as text, and the reader can answer in the composer.
 * The answers go back as an ordinary next message, so nothing else changes.
 */

export const MAX_QUESTIONS = 3;
export const MAX_OPTIONS = 5;
const MAX_QUESTION_CHARS = 200;
const MAX_OPTION_CHARS = 80;

export type Question = { question: string; options: string[]; multi: boolean };

/** What the reader chose for one question, and anything they wrote themselves. */
export type Pick = { chosen: string[]; other: string };

/** What is sent when the reader would rather not answer. */
export const SKIP_MESSAGE = 'Answer with your best assumptions, and say what you assumed.';

const BLOCK = /```questions[^\n]*\n([\s\S]*?)(```|$)/;

/**
 * The reply without its questions block, and the questions in it. A block
 * still arriving is taken out of the text all the same, and gives no
 * questions until it is whole.
 */
export function splitQuestions(answer: string): { text: string; questions: Question[] | null } {
  const match = BLOCK.exec(answer);
  if (!match) return { text: answer, questions: null };
  const text = (answer.slice(0, match.index) + answer.slice(match.index + match[0].length)).trim();
  if (match[2] !== '```') return { text, questions: null };
  return { text, questions: parseQuestions(match[1]) };
}

/** The questions in a block's JSON, or null when there are none worth showing. */
export function parseQuestions(json: string): Question[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;
  const questions: Question[] = [];
  for (const item of list.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const { question, options, multi } = item as Record<string, unknown>;
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) continue;
    const kept = Array.isArray(options)
      ? [...new Set(options.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter((o) => o && o.length <= MAX_OPTION_CHARS))].slice(0, MAX_OPTIONS)
      : [];
    questions.push({ question: question.trim(), options: kept, multi: multi === true });
  }
  return questions.length ? questions : null;
}

/** The message the answers are sent as, one line per question answered; empty when none is. */
export function answersMessage(questions: Question[], picks: Pick[]): string {
  return questions
    .map((q, i) => {
      const pick = picks[i] ?? { chosen: [], other: '' };
      const said = [...pick.chosen.filter((c) => q.options.includes(c)), pick.other.trim()].filter(Boolean);
      return said.length ? `${q.question} ${said.join(', ')}.`.replace(/([.?!])\.$/, '$1') : '';
    })
    .filter(Boolean)
    .join('\n');
}
