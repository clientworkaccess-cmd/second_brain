/**
 * The question, as the agent is given it.
 *
 * In lib rather than in the route so that the check scripts ask the real binary
 * the same thing the app does.
 */
export function chatPrompt(question: string): string {
  return [
    `Answer this question using only the wiki in your working directory: "${question}"`,
    ``,
    `Start from index.md and follow [[wikilinks]] to the pages that matter. Do not guess —`,
    `if the wiki does not cover it, say so plainly.`,
    ``,
    `Reply with the answer only. Do not describe what you are doing or which files you opened.`,
    ``,
    `End your answer with a line of the form:`,
    `SOURCES: [[Page Name]], [[Other Page]]`,
  ].join('\n');
}
