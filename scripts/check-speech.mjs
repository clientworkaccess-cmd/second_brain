#!/usr/bin/env node
/**
 * Speech: what of an answer is said aloud, where it is cut into sentences
 * while it is still arriving, which voice is chosen, and how dictated words
 * join what is typed.
 *
 *   npm run check:speech
 *
 * lib/speech.ts, called directly. The listening and the speaking themselves
 * are the browser's, and are tried in one (see the PR that added this).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();
const { speakable, takeSentences, pickVoice, joinDictation, listenProblem, withoutCitations } = await import(pathToFileURL(path.join(OUT_DIR, 'speech.js')).href);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const is = (name, got, want) => check(name, got === want, got === want ? '' : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ---------------------------------------------------------- what is said
is('plain words are said as they are', speakable('Refunds take five days.'), 'Refunds take five days.');
is('a page link is said by its name', speakable('See [[Refunds]] and [[warehouse-team|the warehouse team]].'), 'See Refunds and the warehouse team.');
is('a web link is said by its text, a bare address not at all', speakable('Read [the policy](https://example.com/p) at https://example.com/x now.'), 'Read the policy at now.');
is('the SOURCES and WROTE lines are not said', speakable('Five days.\n\nSOURCES: [[Refunds]], [[Returns]]\nWROTE: [[Note]]'), 'Five days.');
is('headings, bullets and numbers lose their marks', speakable('## Steps\n\n- First thing\n- Second thing\n1. Third\n2) Fourth\n> Quoted'), 'Steps First thing Second thing Third Fourth Quoted');
is('emphasis marks are dropped', speakable('This is **very** important, _really_, and `code` too. ~~Old~~'), 'This is very important, really, and code too. Old');
is('a code block is not read out', speakable('Run this:\n\n```bash\nnpm run check\n```\n\nThen wait.'), 'Run this: Then wait.');
is('a table is said as its cells', speakable('| Name | Days |\n| --- | --- |\n| Refund | 5 |'), 'Name, Days, Refund, 5');
is('an image is not said', speakable('Here ![a chart](raw/assets/c.png) it is.'), 'Here it is.');
is('nothing gives nothing', speakable('\n\nSOURCES: [[A]]\n'), '');

// ------------------------------------------- citations are not in a reply
is('a citation after a sentence is taken out', withoutCitations('Refunds take five days ([[2026-09-22-q3-board-pack]]).'), 'Refunds take five days.');
is('several at once, and with a word in front', withoutCitations('It moved to November ([[a]], [[b]]). Costs rose (see [[c]]) and fell (Source: [[d]] and [[e]]).'), 'It moved to November. Costs rose and fell.');
is('the footnote form too', withoutCitations('Paid in arrears.^[raw/q4-forecast-notes.md] Next.'), 'Paid in arrears. Next.');
is('a page named in the sentence is not a citation', withoutCitations('Ask [[Mark Chen]] about ([[Refunds]] policy) first.'), 'Ask [[Mark Chen]] about ([[Refunds]] policy) first.');
is('ordinary brackets are left alone', withoutCitations('Refunds (five days) and returns (two).'), 'Refunds (five days) and returns (two).');
is('what is said aloud has no citations either', speakable('Refunds take five days ([[2026-09-22-q3-board-pack]]). See [[Refunds]].'), 'Refunds take five days. See Refunds.');

// ------------------------------------------------------ cutting sentences
const cut = (text, from, final) => takeSentences(text, from, final);
let r = cut('Refunds take five days. Returns take', 0, false);
check('a whole sentence is taken, the unfinished one is left', r.sentences.join('|') === 'Refunds take five days.' && 'Refunds take five days. Returns take'.slice(r.next).trim() === 'Returns take', JSON.stringify(r));
r = cut('Refunds take five days. Returns take two.', r.next, true);
check('when nothing more is coming, the rest is one', r.sentences.join('|') === 'Returns take two.' && r.next === 41, JSON.stringify(r));
r = cut('First line\nSecond line\nThird', 0, false);
check('a line break ends a sentence', r.sentences.join('|') === 'First line|Second line', JSON.stringify(r.sentences));
r = cut('Is it done? Yes! Good.', 0, true);
check('question and exclamation marks end one too', r.sentences.join('|') === 'Is it done?|Yes!|Good.', JSON.stringify(r.sentences));
r = cut('There are 3. items here, e.g. this one. And Dr. Chen agreed. Done.', 0, true);
check('a number, an abbreviation or an initial is not an end', r.sentences.join('|') === 'There are 3. items here, e.g. this one.|And Dr. Chen agreed.|Done.', JSON.stringify(r.sentences));
r = cut('Version 2.5 is out. It costs 3.50 dollars.', 0, true);
check('a point inside a number is not an end', r.sentences.length === 2, JSON.stringify(r.sentences));
r = cut('Run this:\n```\nnpm run check. Then\n', 0, false);
check('an open code block is waited out', r.sentences.join('|') === 'Run this:', JSON.stringify(r));
const whole = 'Run this:\n```\nnpm run check. Then\n```\nAfter that, wait.';
r = cut(whole, 0, true);
check('a closed code block comes as one piece, and is then not said', r.sentences.map(speakable).filter(Boolean).join('|') === 'Run this:|After that, wait.', JSON.stringify(r.sentences));
r = cut('Before.\n```\nnever closed', 0, true);
check('a block that never closes does not hold the rest back for ever', r.sentences.join('|') === 'Before.' && r.next === 'Before.\n```\nnever closed'.length, JSON.stringify(r));
// Fed a few characters at a time, as an answer arrives, the pieces are the same as all at once.
const answer = 'Refunds go out in five days. Is that fast? It depends, e.g. on the bank.\n\n- One item\n- Another\n\nSOURCES: [[Refunds]]';
const streamed = [];
let offset = 0;
for (let end = 3; end < answer.length + 3; end += 3) {
  const part = cut(answer.slice(0, Math.min(end, answer.length)), offset, end >= answer.length);
  streamed.push(...part.sentences);
  offset = part.next;
}
check('arriving in pieces, the sentences are the same as all at once', streamed.join('|') === cut(answer, 0, true).sentences.join('|'), streamed.join(' | '));
check('…and what is said of them leaves out the sources', streamed.map(speakable).filter(Boolean).join(' ') === 'Refunds go out in five days. Is that fast? It depends, e.g. on the bank. One item Another');
check('nothing is said twice or lost', streamed.join(' ').replace(/\s+/g, ' ') === answer.replace(/\s+/g, ' ').trim());

// ------------------------------------------------------------- the voice
const voices = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true, default: true },
  { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'Google US English', lang: 'en-US' },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
  { name: 'Google Deutsch', lang: 'de-DE' },
  { name: 'Microsoft Katja Online (Natural) - German (Germany)', lang: 'de-DE' },
];
is('a natural voice in the reader\'s language is chosen first', voices[pickVoice(voices, 'en-US')].name, 'Microsoft Aria Online (Natural) - English (United States)');
is('without one, a Google voice in that language', voices.slice(0, 3)[pickVoice(voices.slice(0, 3), 'en-US')].name, 'Google US English');
is('the same language from another country beats another language', voices.slice(0, 2)[pickVoice(voices.slice(0, 2), 'en-AU')].name, 'Google UK English Female');
is('another language picks its own', voices[pickVoice(voices, 'de-DE')].name, 'Microsoft Katja Online (Natural) - German (Germany)');
is('a language nobody speaks here falls back to English', voices[pickVoice(voices, 'xx-XX')].lang.slice(0, 2), 'en');
is('an underscore in the language is read as a dash', pickVoice([{ name: 'A', lang: 'fr_FR' }, { name: 'B', lang: 'en_US' }], 'en-US'), 1);
is('no voices, no choice', pickVoice([], 'en-US'), -1);

// ---------------------------------------------------------- dictation
is('dictation into an empty box begins with a capital', joinDictation('', 'how long do refunds take'), 'How long do refunds take');
is('it is added to what is typed, with one space', joinDictation('About refunds:  ', '  how long   do they take '), 'About refunds: how long do they take');
is('after a full stop it begins a sentence', joinDictation('First point.', 'second point'), 'First point. Second point');
is('silence changes nothing', joinDictation('Typed', '   '), 'Typed');
check('a blocked microphone is said in words a reader can act on', /blocked/.test(listenProblem('not-allowed')) && /microphone/i.test(listenProblem('audio-capture')) && listenProblem('whatever').length > 0);

const failed = results.filter((r2) => !r2.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
