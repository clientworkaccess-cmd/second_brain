#!/usr/bin/env node
/**
 * Questions before an answer: how a ```questions block is found in a reply,
 * what of it is kept, and the message the reader's answers are sent as.
 *
 *   npm run check:questions
 *
 * lib/questions.ts, called directly. check:live sees the card in the chat and
 * the answers go on as the next message.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();
const { splitQuestions, parseQuestions, answersMessage, SKIP_MESSAGE, MAX_QUESTIONS, MAX_OPTIONS } = await import(pathToFileURL(path.join(OUT_DIR, 'questions.js')).href);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const is = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const period = { question: 'Which period?', options: ['Last quarter', 'This year'], multi: false };
const focus = { question: 'What matters most?', options: ['Cost', 'Speed', 'Risk'], multi: true };
const block = (data) => `\`\`\`questions\n${JSON.stringify(data)}\n\`\`\``;

// ---------------------------------------------------------- finding them
const reply = `Two things change the answer.\n\n${block({ questions: [period, focus] })}\n`;
is('the questions are read from the block', splitQuestions(reply).questions, [period, focus]);
is('and the block leaves the text', splitQuestions(reply).text, 'Two things change the answer.');
is('a reply without a block is left as it is', splitQuestions('Five days.'), { text: 'Five days.', questions: null });
is('a block still arriving is hidden, and asks nothing yet', splitQuestions('Let me ask.\n\n```questions\n{"questions": [{"quest'), { text: 'Let me ask.', questions: null });
is('a bare list is read too', parseQuestions(JSON.stringify([period])), [period]);
is('a block that is not JSON asks nothing', splitQuestions('Hm.\n\n```questions\nWhich period?\n```').questions, null);
is('other code is not taken for questions', splitQuestions('```json\n{"questions": []}\n```').questions, null);

// ---------------------------------------------------------- what is kept
is(`at most ${MAX_QUESTIONS} questions`, parseQuestions(JSON.stringify({ questions: [period, period, period, period, period] }))?.length, MAX_QUESTIONS);
is(`at most ${MAX_OPTIONS} options, without repeats or blanks`, parseQuestions(JSON.stringify([{ question: 'Q?', options: ['a', 'a', ' ', 'b', 'c', 'd', 'e', 'f'] }]))?.[0].options, ['a', 'b', 'c', 'd', 'e']);
is('an option that is not text is dropped', parseQuestions(JSON.stringify([{ question: 'Q?', options: ['a', 3, null] }]))?.[0].options, ['a']);
is('a question with no options is kept, to answer in words', parseQuestions(JSON.stringify([{ question: 'What is the budget?' }])), [{ question: 'What is the budget?', options: [], multi: false }]);
is('a question without words is dropped', parseQuestions(JSON.stringify([{ question: '  ', options: ['a'] }, period])), [period]);
is('several answers only when it says so', parseQuestions(JSON.stringify([{ question: 'Q?', options: ['a'], multi: 'yes' }]))?.[0].multi, false);
is('nothing usable is no questions', parseQuestions(JSON.stringify({ questions: [] })), null);

// ---------------------------------------------------------- the answers
is('one line per question, the choice after it', answersMessage([period, focus], [{ chosen: ['Last quarter'], other: '' }, { chosen: ['Cost', 'Risk'], other: '' }]), 'Which period? Last quarter.\nWhat matters most? Cost, Risk.');
is('what the reader wrote is added', answersMessage([focus], [{ chosen: ['Cost'], other: 'and staff morale' }]), 'What matters most? Cost, and staff morale.');
is('a question left open is left out', answersMessage([period, focus], [{ chosen: [], other: '' }, { chosen: ['Speed'], other: '' }]), 'What matters most? Speed.');
is('no answers, no message', answersMessage([period], [{ chosen: [], other: ' ' }]), '');
is('a choice that was not offered is not sent', answersMessage([period], [{ chosen: ['Forever'], other: '' }]), '');
is('an answer ending in a full stop gets no second one', answersMessage([period], [{ chosen: [], other: 'Since March.' }]), 'Which period? Since March.');
check('skipping asks it to answer on its own assumptions', /assumptions/.test(SKIP_MESSAGE));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
