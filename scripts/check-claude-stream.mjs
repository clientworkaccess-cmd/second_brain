#!/usr/bin/env node
/**
 * The stream parser, held against streams captured from the real binary
 * (scripts/fixtures/) and against what the local fake emits.
 *
 *   npm run check:stream
 *
 * The fake is written by us, from our reading of the format. The fixtures are
 * what the binary actually printed. When the two disagree the fixtures are
 * right, and this is where that shows.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();
const { parseStream, classify, describeTool } = await import(pathToFileURL(path.join(OUT_DIR, 'claude-stream.js')).href);

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  — ${why}`);

const resultOf = (events) => events.find((e) => e.kind === 'result')?.result ?? null;
const toolLines = (events) => events.filter((e) => e.kind === 'tool').map((e) => e.line);

// ------------------------------------------------------------ real captures
const CWD = '/var/brain-data/ops';
{
  const events = parseStream(await fs.readFile(path.join(here, 'fixtures', 'stream-logged-out.jsonl'), 'utf8'), CWD);
  const init = events.find((e) => e.kind === 'init');
  const result = resultOf(events);
  check('signed out: the session starts with the tools that were asked for', init?.tools.join(',') === 'Glob,Grep,Read', init?.tools.join(','));
  check('signed out: nothing the app did not ask for is loaded', init?.leaked.length === 0, init?.leaked.join(', '));
  check('signed out: is an error even though the binary calls it "success"', result?.ok === false && result?.error === 'logged_out', `${result?.ok} ${result?.error}`);
  check('signed out: the message is kept', /not logged in/i.test(result?.errorDetail ?? ''), result?.errorDetail ?? '');
  const text = events.find((e) => e.kind === 'text');
  check('signed out: the notice arrives as text that was not streamed', text?.streamed === false);
}

for (const name of ['plan', 'execute', 'chat']) {
  const file = path.join(here, 'fixtures', `stream-${name}.jsonl`);
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    skip(`real ${name} run`, 'not captured yet: needs a signed-in claude, see docs/claude-contract.md');
    continue;
  }
  const events = parseStream(raw, CWD);
  const result = resultOf(events);
  check(`real ${name} run: ends with a result`, !!result, result ? `${result.turns} turns` : 'no result line');
  check(`real ${name} run: succeeded`, result?.ok === true, result?.errorDetail ?? '');
  check(`real ${name} run: used tools the app can describe`, toolLines(events).every((l) => !l.startsWith('Using ')), toolLines(events).filter((l) => l.startsWith('Using ')).join(', '));
  if (name === 'chat') check('real chat run: the answer was streamed', events.some((e) => e.kind === 'delta'));
}

// ------------------------------------------------------------------ the fake
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-'));
const cluster = path.join(root, 'operations');
await fs.mkdir(path.join(cluster, 'source'), { recursive: true });
await fs.writeFile(path.join(cluster, 'SCHEMA.md'), '# Operations\n');
await fs.writeFile(path.join(cluster, 'index.md'), '# Wiki Index\n');
await fs.writeFile(path.join(cluster, 'log.md'), '# Wiki Log\n');
await fs.writeFile(path.join(cluster, 'source', 'note.md'), 'A note.\n');

function fake(prompt, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'fake-claude.mjs'), ...extraArgs, '-p', '--tools', 'Read,Glob,Grep'], { cwd: cluster });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.end(prompt);
  });
}

{
  const { out, code } = await fake('What is this cluster about?');
  const result = resultOf(parseStream(out, cluster));
  check('fake chat, empty wiki: says that nothing is filed, and names no sources', code === 0 && result?.ok === true && /does not cover/i.test(result.text) && !/SOURCES/.test(result.text), result?.text ?? '');
}

{
  await fs.writeFile(
    path.join(cluster, 'index.md'),
    '# Wiki Index\n\n## Entities\n- [[Warehouse Team]]: picks, packs, and inspects returns\n- [[Returns Portal]] — where a return is logged\n\n## Concepts\n',
  );
  const { out, code } = await fake('What is this cluster about?');
  const events = parseStream(out, cluster);
  const streamed = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('');
  const result = resultOf(events);
  check('fake chat: exits cleanly with a result', code === 0 && result?.ok === true, `exit ${code}`);
  check('fake chat: the streamed pieces add up to the answer', streamed.trim() === result?.text, `${streamed.length} characters`);
  check('fake chat: the complete message is marked as already streamed', events.filter((e) => e.kind === 'text').every((e) => e.streamed));
  check('fake chat: reading and searching are described in words', toolLines(events).includes('Reading index.md') && toolLines(events).includes('Searching for "Warehouse Team"'), toolLines(events).join(' | '));
  check('fake chat: the sources are the pages the index lists', /^SOURCES: \[\[Warehouse Team\]\], \[\[Returns Portal\]\]$/m.test(result?.text ?? ''), result?.text.split('\n').pop() ?? '');
  await fs.writeFile(path.join(cluster, 'index.md'), '# Wiki Index\n');
}

{
  const planFile = path.join(cluster, 'plan.json');
  const { out, code } = await fake(`TASK: PLAN\n\nThe document to assess is at: source/note.md\n\nWrite your answer as JSON to this exact path: ${planFile}\n`);
  const events = parseStream(out, cluster);
  check('fake plan: exits cleanly and writes the plan', code === 0 && resultOf(events)?.ok === true && !!(await fs.readFile(planFile, 'utf8').catch(() => null)));
  check('fake plan: paths are shown relative to the wiki', toolLines(events).includes('Reading source/note.md') && toolLines(events).includes('Writing plan.json'), toolLines(events).join(' | '));
}

{
  const { out, code } = await fake('TASK: EXECUTE\n\nThe source document is at raw/note.md.\n');
  const events = parseStream(out, cluster);
  check('fake execute: exits cleanly', code === 0 && resultOf(events)?.ok === true, `exit ${code}`);
  check('fake execute: the source is read by its full name', toolLines(events).includes('Reading raw/note.md'), toolLines(events).join(' | '));
  check('fake execute: every page written is named', ['Writing entities/warehouse-team.md', 'Writing entities/returns-portal.md', 'Writing concepts/refund-policy.md', 'Writing index.md', 'Updating log.md'].every((l) => toolLines(events).includes(l)), toolLines(events).join(' | '));
}

for (const [mode, kind] of [['auth', 'logged_out'], ['limit', 'limit']]) {
  const { out, code } = await fake('What is this cluster about?', ['--fail', mode]);
  const result = resultOf(parseStream(out, cluster));
  check(`fake --fail ${mode}: non-zero exit, sorted as ${kind}`, code !== 0 && result?.ok === false && result?.error === kind, `exit ${code}, ${result?.error}`);
}

await fs.rm(root, { recursive: true, force: true });

// ------------------------------------------------------------ odd input
{
  const events = parseStream('warning: something the binary printed\n{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"subagent chatter"}]}}\n{not json\n\n', CWD);
  check('a line that is not JSON is shown, not dropped', events.some((e) => e.kind === 'text' && e.text.startsWith('warning:')));
  check('a broken line does not stop the parser', events.some((e) => e.kind === 'text' && e.text === '{not json'));
  check('subagent traffic is left out', !events.some((e) => e.kind === 'text' && e.text.includes('subagent')));
}
{
  const events = parseStream('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"ls"}},{"tool_name":"Write","tool_input":{"file_path":"/etc/passwd"}}]}', CWD);
  const result = resultOf(events);
  check('running out of steps is sorted as max_turns', result?.error === 'max_turns');
  check('refusals are listed with what they were aimed at', result?.denials.map((d) => `${d.tool}:${d.target}`).join(',') === 'Bash:ls,Write:passwd', JSON.stringify(result?.denials));
}
check('a path outside the wiki is shown by file name only', describeTool('Read', { file_path: '/opt/brain-app/.env' }, CWD) === 'Reading .env', describeTool('Read', { file_path: '/opt/brain-app/.env' }, CWD));
check('classify: signed out', classify('success', 'authentication_failed api_error Not logged in') === 'logged_out');
check('classify: usage limit', classify('success', 'Claude usage limit reached') === 'limit');
check('classify: anything else', classify('error_during_execution', 'it broke') === 'agent_error');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
