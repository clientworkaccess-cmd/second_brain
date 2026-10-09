#!/usr/bin/env node
/**
 * Conversations: the record the app keeps of each one, the recap an agent is
 * given when it has forgotten, and the lock a turn that may write takes.
 *
 *   npm run check:conversations
 *
 * lib/conversations.ts, lib/chat.ts and the lock in lib/jobs.ts, called
 * directly on a throwaway wiki root.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-conv-'));
process.env.WIKI_ROOT = wikiRoot;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const conv = await import(lib('conversations'));
const { recapPrompt, sourcesOf, workPrompt, chatPrompt } = await import(lib('chat'));
const { acquireBusy, releaseBusy, isBusy } = await import(lib('jobs'));
const { CLUSTER, BRAIN } = await import(lib('layout'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const status = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.status ?? err.message;
  }
};

const turn = (question, answer, extra = {}) => ({
  at: new Date().toISOString(),
  question,
  answer,
  sources: [],
  mode: 'discuss',
  model: null,
  answeredBy: null,
  wrote: [],
  commit: null,
  undoCommit: null,
  findings: [],
  error: null,
  ...extra,
});

try {
  // ------------------------------------------------------------------ store
  const a = await conv.createConversation('ops', new Date('2026-10-01T10:00:00Z'));
  check('a new conversation has an id, a placeholder name and its own session', conv.isConversationId(a.id) && a.title === conv.UNTITLED && conv.isConversationId(a.session.id) && a.session.id !== a.id && !a.session.started);
  const file = path.join(wikiRoot, '.dashboard', 'conversations', 'ops', `${a.id}.json`);
  check('it is kept under the dashboard, out of the wiki', await fs.stat(file).then(() => true, () => false));

  await conv.appendTurn(a, turn('What is our refund policy for damaged goods arriving late?', 'Refunds take five days.\n\nSOURCES: [[Refunds]]', { at: '2026-10-01T10:01:00Z' }));
  const read = await conv.readConversation('ops', a.id);
  check('a turn is kept, and the first question names the conversation', read.turns.length === 1 && read.title === 'What is our refund policy for damaged goods arriving late?', read.title);
  check('a long first question is cut at a word', conv.titleFrom('word '.repeat(40)).endsWith('…') && conv.titleFrom('word '.repeat(40)).length <= 62);
  await conv.appendTurn(read, turn('And for returns?', 'Same.', { at: '2026-10-01T10:02:00Z' }));
  check('a second question does not rename it', (await conv.readConversation('ops', a.id)).title.startsWith('What is our refund policy'));

  const b = await conv.createConversation('ops', new Date('2026-10-02T09:00:00Z'));
  await conv.appendTurn(b, turn('Plan the Q4 push', 'Here is a plan.', { at: '2026-10-02T09:05:00Z', mode: 'work', wrote: ['queries/q4'], commit: 'abc1234' }));
  const list = await conv.listConversations('ops');
  check('the list is newest first, with what each one did', list.length === 2 && list[0].id === b.id && list[0].wrote === true && list[1].wrote === false && list[0].turns === 1 && list[0].mode === 'work', JSON.stringify(list.map((c) => [c.title, c.wrote])));
  check('the newest is the one /ask opens', (await conv.latestConversation('ops')) === b.id && (await conv.latestConversation('nothing-here')) === null);

  await conv.renameConversation('ops', a.id, '  Refunds,   late goods  ');
  const renamed = await conv.readConversation('ops', a.id);
  check('a name a person gives is kept, tidied, and not replaced by a question', renamed.title === 'Refunds, late goods' && renamed.named === true);
  await conv.appendTurn(renamed, turn('One more', 'Sure.'));
  check('…even after another question', (await conv.readConversation('ops', a.id)).title === 'Refunds, late goods');
  check('an empty name is refused', (await status(() => conv.renameConversation('ops', a.id, '   '))) === 400);
  check('renaming one that is not there is 404', (await status(() => conv.renameConversation('ops', '11111111-2222-4333-8444-555555555555', 'x'))) === 404);

  await fs.writeFile(path.join(wikiRoot, '.dashboard', 'conversations', 'ops', '22222222-2222-4333-8444-555555555555.json'), '{ not json');
  await fs.writeFile(path.join(wikiRoot, '.dashboard', 'conversations', 'ops', 'notes.txt'), 'stray');
  check('a damaged file or a stray one is passed over, not thrown on', (await conv.listConversations('ops')).length === 2 && (await conv.readConversation('ops', '22222222-2222-4333-8444-555555555555')) === null);
  check('a file whose id does not match its name is not taken', conv.parseRecord(JSON.stringify({ id: b.id }), 'ops', a.id) === null);
  const odd = conv.parseRecord(JSON.stringify({ id: a.id, turns: [{ question: 'q', findings: [{ severity: 'loud', detail: 'd' }], wrote: [1, 'x'] }, { no: 'question' }], mode: 'chaos' }), 'ops', a.id);
  check('what is read is checked field by field', odd.turns.length === 1 && odd.turns[0].findings[0].severity === 'warning' && odd.turns[0].wrote.join() === 'x' && odd.mode === 'discuss');
  check('an id that is not one is refused before the disk is touched', (await status(() => conv.readConversation('ops', '../../etc/passwd'))) === 400 && (await status(() => conv.readConversation('../ops', a.id))) !== null);

  check('deleting one removes it', (await conv.deleteConversation('ops', a.id)) === true && (await conv.readConversation('ops', a.id)) === null && (await conv.deleteConversation('ops', a.id)) === false);
  check('what is written leaves no temporary files', (await fs.readdir(path.join(wikiRoot, '.dashboard', 'conversations', 'ops'))).every((n) => !n.endsWith('.tmp')));

  // A conversation answers one question at a time.
  conv.beginTurn(b.id);
  check('a second question to the same conversation, while it answers, is 409', (await status(() => conv.beginTurn(b.id))) === 409);
  conv.endTurn(b.id);
  check('…and is let in once it is done', (await status(() => conv.beginTurn(b.id))) === null);
  conv.endTurn(b.id);

  // ------------------------------------------------------------------ recap
  check('nothing to recall, no recap', recapPrompt([]) === '' && recapPrompt([turn('q', '', { error: 'failed' })]) === '');
  const recap = recapPrompt([turn('First?', 'One.\nSOURCES: [[A]]'), turn('Broken?', 'x', { error: 'it failed' }), turn('Second?', 'Two.\nWROTE: [[B]]')]);
  check('the recap is the questions and answers, oldest first, without the failures', recap.indexOf('Q: First?') < recap.indexOf('Q: Second?') && !recap.includes('Broken?') && recap.includes('(end of the earlier conversation)'));
  check('…and without the SOURCES and WROTE lines', !/SOURCES:|WROTE:/.test(recap));
  const long = recapPrompt([turn('Long?', 'x'.repeat(5000))]);
  check('a long answer is cut', long.length < 2000 && long.includes('…'), String(long.length));
  const many = recapPrompt(Array.from({ length: 30 }, (_, i) => turn(`Question ${i}?`, 'y'.repeat(1400))));
  check('a long conversation keeps its latest turns, within bounds', many.length <= 12400 && many.includes('Question 29?') && !many.includes('Question 0?'), String(many.length));

  check('the sources are read off the answer', JSON.stringify(sourcesOf('Text\nSOURCES: [[A]], [[B c]]')) === '["A","B c"]' && sourcesOf('nothing').length === 0);
  for (const layout of [CLUSTER, BRAIN]) {
    const w = workPrompt('Write it down', layout);
    check(`a question that may write says so, and asks for a WROTE line (${layout.id})`, w.startsWith(chatPrompt('Write it down', layout)) && /may change the wiki/.test(w) && /WROTE:/.test(w) && w.includes(layout.id === 'brain' ? 'wiki/index.md' : 'index.md'));
  }

  // ------------------------------------------------------------------- lock
  acquireBusy('ops', 'conversation:x');
  check('a turn that may write holds the wiki', isBusy('ops') === 'conversation:x');
  check('a filing meanwhile is refused with 409', (await status(() => acquireBusy('ops', 'job-1'))) === 409);
  check('the holder may claim it again', (await status(() => acquireBusy('ops', 'conversation:x'))) === null);
  releaseBusy('ops', 'job-1');
  check('someone else cannot let it go', isBusy('ops') === 'conversation:x');
  releaseBusy('ops', 'conversation:x');
  check('the holder can', isBusy('ops') === null && (await status(() => acquireBusy('ops', 'job-1'))) === null);
  releaseBusy('ops', 'job-1');
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
