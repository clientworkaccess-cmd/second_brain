#!/usr/bin/env node
/**
 * The owner's memory: how it is kept on disk, how a learning run's answer
 * changes it, what a conversation turn is told of it, and a learning run end
 * to end against the local stand-in for the binary.
 *
 *   npm run check:memory
 *
 * lib/memory.ts and lib/learn.ts, on a throwaway wiki root.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-memory-'));
process.env.WIKI_ROOT = wikiRoot;
process.env.CLAUDE_CMD = 'node';
process.env.CLAUDE_ARGS = 'scripts/fake-claude.mjs';
delete process.env.MEMORY;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const mem = await import(lib('memory'));
const learn = await import(lib('learn'));
const { asksForThinking, modelFor } = await import(lib('models'));
const { agentArgs } = await import(lib('claude'));
const { MEMORY_DIR, PROFILE_FILE } = await import(lib('config'));
const { BRAIN } = await import(lib('layout'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const entry = (text, kind = 'preference', date = '2026-10-01') => ({ date, kind, text });

try {
  // ----------------------------------------------------------------- format
  const memory = {
    core: [entry('Lead with cash position.'), entry('Keep answers short.', 'feedback')],
    topics: [{ slug: 'acquisitions', about: 'How deals are weighed', entries: [entry('Show cap rate first.')] }],
  };
  const core = mem.renderCore(memory);
  check('core is Markdown, one dated line per entry', core.includes('- 2026-10-01 · preference · Lead with cash position.') && core.includes('- topic · acquisitions · How deals are weighed'));
  check('core reads back as it was written', JSON.stringify(mem.parseEntries(core)) === JSON.stringify(memory.core) && mem.parseTopicIndex(core)[0].slug === 'acquisitions');
  check('a topic file reads back', JSON.stringify(mem.parseEntries(mem.renderTopic(memory.topics[0]))) === JSON.stringify(memory.topics[0].entries));
  check('an entry is kept to one line, and cannot forge a separator', mem.cleanText('  - two\nlines · here ') === 'two lines - here');

  // ------------------------------------------------------------- operations
  check('the first JSON object in the output is read, fenced or not', mem.parseOps('Sure.\n```json\n{"ops":[{"op":"add","kind":"feedback","text":"Too long."}]}\n```').length === 1);
  check('output that is not JSON changes nothing', mem.parseOps('I could not decide.').length === 0 && mem.parseOps('{"ops": "no"}').length === 0);
  check('a bad topic name, an unknown op and an index of 0 are dropped', mem.parseOps('{"ops":[{"op":"add","topic":"../x","text":"a"},{"op":"rm","index":1},{"op":"delete","index":0}]}').length === 0);
  check('an unknown kind is a preference', mem.parseOps('{"ops":[{"op":"add","kind":"secret","text":"a"}]}')[0].kind === 'preference');

  const today = '2026-10-14';
  let r = mem.applyOps(memory, [{ op: 'add', kind: 'preference', text: 'lead with CASH position' }], today);
  check('an entry already there in other case and punctuation is not added twice', r.changed === 0 && r.memory.core.length === 2);
  r = mem.applyOps(memory, [{ op: 'update', index: 2, text: 'Keep answers to five lines.' }, { op: 'delete', index: 1 }, { op: 'add', kind: 'correction', text: 'Fund means the newer fund.' }], today);
  check('updates and deletions use the numbers shown, before adds', r.changed === 3 && r.memory.core.map((e) => e.text).join('|') === 'Keep answers to five lines.|Fund means the newer fund.' && r.memory.core[0].date === today && r.memory.core[0].kind === 'feedback');
  r = mem.applyOps(memory, [{ op: 'delete', topic: 'acquisitions', index: 1 }], today);
  check('a topic left empty is dropped', r.memory.topics.length === 0);
  r = mem.applyOps(memory, [{ op: 'topic', topic: 'investors', about: 'How investor matters are handled' }, { op: 'add', topic: 'investors', kind: 'preference', text: 'Draft investor emails formally.' }], today);
  check('a new topic can be described and filled in one answer', r.memory.topics.find((t) => t.slug === 'investors')?.entries.length === 1);
  r = mem.applyOps(memory, [{ op: 'update', index: 9, text: 'x' }, { op: 'delete', topic: 'nope', index: 1 }], today);
  check('numbers that are not there change nothing', r.changed === 0);
  const big = { core: Array.from({ length: mem.CORE_MAX + 1 }, (_, i) => entry(`Rule ${i}`)), topics: [] };
  check('past the core limit it asks to be consolidated', mem.needsConsolidating(big) && !mem.needsConsolidating(memory));

  // ---------------------------------------------------------- what is given
  check('an empty memory adds nothing to a turn', mem.memoryContext(mem.emptyMemory()) === '');
  const given = mem.memoryContext(memory, '/m/topics');
  check('a turn is given the core entries and where each topic is', given.includes('- Lead with cash position. (preference, 2026-10-01)') && given.includes(`How deals are weighed: ${path.join('/m/topics', 'acquisitions.md')}`));
  check('it is told the pages win over memory on facts', /the brain wins/.test(given));
  const shown = mem.memoryForLearner(memory, ['acquisitions']);
  check('the learning run sees numbered entries', shown.includes('1. [preference, 2026-10-01] Lead with cash position.') && shown.includes('    1. [preference, 2026-10-01] Show cap rate first.'));

  // ------------------------------------------------------------------ store
  check('a memory never written reads as empty', JSON.stringify(await mem.readMemory()) === JSON.stringify(mem.emptyMemory()));
  await mem.writeMemory(memory, new Date('2026-10-14T10:00:00Z'));
  check('written and read back whole', JSON.stringify(await mem.readMemory()) === JSON.stringify(memory));
  await mem.writeMemory({ core: memory.core.slice(0, 1), topics: [] }, new Date('2026-10-14T11:00:00Z'));
  const history = await fs.readdir(path.join(MEMORY_DIR, 'history'));
  const topicsLeft = await fs.readdir(path.join(MEMORY_DIR, 'topics'));
  check('the version before is kept, and a dropped topic file removed', history.some((n) => n.endsWith('-core.md')) && history.some((n) => n.endsWith('topic-acquisitions.md')) && topicsLeft.length === 0, history.join(', '));

  // ----------------------------------------------------- the turn's context
  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  let context = await learn.turnContext();
  check('without a profile on the server, a general line stands in', context.includes('the owner of the businesses this brain is about') && !context.includes('{{PROFILE}}'));
  check('the turn is told how to think and how to write', context.includes('## Thinking, not only looking up') && context.includes('## How to write') && context.includes('Never "the wiki"'));
  check('an empty memory says nothing', !context.includes('What the owner has told you before'));
  await fs.writeFile(PROFILE_FILE, 'You are talking directly with Sam Example, who owns a test business.\n');
  context = await learn.turnContext();
  check('the profile on the server is used', context.includes('You are talking directly with Sam Example'));

  // -------------------------------------------------------- the learning run
  const prompt = learn.learnPrompt(mem.emptyMemory(), { question: 'From now on, lead with cash.', answer: 'Noted.\nSOURCES: [[x]]' });
  check('the learning run is marked, shown the message apart from the reply', /^TASK: LEARN$/m.test(prompt) && prompt.includes("THE OWNER'S MESSAGE") && prompt.includes('"""\nFrom now on, lead with cash.\n"""') && !prompt.includes('SOURCES:'));
  const args = agentArgs('learn', BRAIN);
  check('it runs with no tools, its own rules and nothing kept', args[args.indexOf('--tools') + 1] === '' && args[args.indexOf('--append-system-prompt-file') + 1].endsWith('learn.md') && args.includes('--no-session-persistence'));
  let threw = false;
  try {
    agentArgs('learn', BRAIN, { id: '6f1c2f8e-1d5b-4b1e-9c33-1c2a3b4c5d6e', resume: false });
  } catch {
    threw = true;
  }
  check('it cannot be part of a conversation', threw);
  const chatArgs = agentArgs('chat', BRAIN);
  check('a conversation turn may read the memory topics and nothing else of it', chatArgs.some((a) => a.startsWith('Read(') && a.includes('memory') && a.endsWith('topics/**)')) && !chatArgs.some((a) => a.startsWith('Edit(') && a.includes('memory')));

  await learn.learnFrom({ question: 'Hello there', answer: 'Hi.', layout: BRAIN });
  check('a message that teaches nothing writes nothing', JSON.stringify(await mem.readMemory()) === JSON.stringify(mem.emptyMemory()));
  await learn.learnFrom({ question: 'From now on, always put the cash position first.', answer: 'Will do.', layout: BRAIN });
  let now = await mem.readMemory();
  check('a lasting preference is learned', now.core.length === 1 && now.core[0].text === 'From now on, always put the cash position first.', JSON.stringify(now));
  await learn.learnFrom({ question: 'From now on, always put the cash position first.', answer: 'Will do.', layout: BRAIN });
  check('the same thing said again is not kept twice', (await mem.readMemory()).core.length === 1);
  await learn.learnFrom({ question: 'Actually, forget that.', answer: 'Done.', layout: BRAIN });
  check('taking it back removes it', (await mem.readMemory()).core.length === 0);
  const audit = await fs.readFile(path.join(wikiRoot, '.dashboard', 'audit.log'), 'utf8').catch(() => '');
  check('each change is in the audit log', (audit.match(/memory-changed/g) ?? []).length === 2, audit.trim().split('\n').length + ' lines');
  process.env.MEMORY = 'off';
  await learn.learnFrom({ question: 'I prefer tables.', answer: 'Sure.', layout: BRAIN });
  check('MEMORY=off learns nothing', (await mem.readMemory()).core.length === 0);
  delete process.env.MEMORY;

  // -------------------------------------------------------------- the model
  check('a question asking for thinking is asked of Opus when left to the default', asksForThinking('What should we do about the vacancy rate?') && modelFor(null, 'Compare the two offers') === 'opus');
  check('a lookup is left to the server', !asksForThinking('What is the address of the office?') && modelFor('default', 'Who is our lender?') === null);
  check("the reader's own choice wins", modelFor('haiku', 'What should we do?') === 'haiku');
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
