#!/usr/bin/env node
/**
 * A stand-in for the real `claude` binary.
 *
 * The app talks to the agent across a process boundary — spawn, stdin, stdout —
 * so anything that honours that contract is a valid agent. This one writes
 * plausible pages and emits the same stream-json events as Claude Code, which
 * means the whole UI can be built and tested on a dev machine with no login, no
 * usage and no real documents.
 *
 * Selected via CLAUDE_CMD / CLAUDE_ARGS. On the VPS those point at the real
 * binary instead and nothing else changes.
 *
 * What it does NOT do is enforce permissions. It ignores --tools and the allow
 * and deny rules, on purpose: `--skip sandbox` has it write where a planner must
 * not, which is how the sandbox is shown to hold against an agent that
 * misbehaves. Whether the real binary refuses what it should is a question for
 * the real binary — see docs/claude-contract.md.
 *
 * Switches, passed through CLAUDE_ARGS:
 *   --skip index,log,sandbox   misbehave: leave index.md or log.md alone, or write during planning
 *   --touch schema,source,settings
 *                              misbehave: change the rules file, the source document being filed,
 *                              or (in a brain) the settings a person keeps in the folder
 *   --fail auth|limit          end the way the real binary does when signed out or out of usage
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const valueOf = (name) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? '') : '');

const WIKI_PATH = process.cwd();
// Declared up here: the tasks below run before the rest of the file is reached.
const at = (relative) => path.join(WIKI_PATH, relative);
const SKIP = new Set(valueOf('--skip').split(',').map((s) => s.trim()).filter(Boolean));
const TOUCH = new Set(valueOf('--touch').split(',').map((s) => s.trim()).filter(Boolean));
const FAIL = valueOf('--fail');
const TOOLS = valueOf('--tools').split(',').map((s) => s.trim()).filter(Boolean);
const SESSION = randomUUID();
const started = Date.now();

// The two layouts a wiki can have (src/lib/layout.ts), told apart the way the
// app tells them apart: by where the index is.
const BRAIN = existsSync(at('wiki/index.md'));
const RULES = BRAIN ? 'CLAUDE.md' : 'SCHEMA.md';
const PAGES = BRAIN ? 'wiki/' : '';
const INDEX = `${PAGES}index.md`;
const LOG = `${PAGES}log.md`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: SESSION, uuid: randomUUID() }) + '\n');

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

// Where a planning run writes its JSON. Named in the prompt, not on the command line.
const planFile = prompt.match(/JSON to this exact path:\s*(.+)/)?.[1]?.trim() ?? null;

emit({
  type: 'system',
  subtype: 'init',
  cwd: WIKI_PATH,
  tools: TOOLS,
  mcp_servers: [],
  model: 'fake-claude',
  permissionMode: valueOf('--permission-mode') || 'default',
  slash_commands: [],
  apiKeySource: 'none',
  claude_code_version: 'fake',
  skills: [],
  plugins: [],
});

if (FAIL === 'auth') {
  await refuse('Not logged in · Please run /login', 'authentication_failed');
}
if (FAIL === 'limit') {
  await refuse('Claude usage limit reached. Your limit will reset at 3pm.', 'rate_limit');
}

/**
 * Which of the three jobs this is.
 *
 * Decided by an explicit marker, never by sniffing the wording. Prompt-matching
 * is what silently turned every local ingest into a chat answer for six weeks
 * when one sentence of a prompt was reworded.
 */
const marker = prompt.match(/^TASK:\s*(PLAN|EXECUTE)\s*$/im)?.[1]?.toUpperCase();
const MODE = marker === 'PLAN' ? 'plan' : marker === 'EXECUTE' ? 'execute' : 'answer';

// A planning run with no path to write to would "succeed" having produced
// nothing, and the app would blame the agent. Fail loudly instead.
if (MODE === 'plan' && !planFile) {
  console.error('fake-claude: TASK: PLAN but the prompt names no output path');
  process.exit(2);
}

let turns = 0;
if (MODE === 'plan') await makePlan();
else if (MODE === 'execute') await ingest();
else await answer();

// ---------------------------------------------------------------- events

/** The agent says something: one complete message. */
async function say(text, pause = 400) {
  turns++;
  emit({ type: 'assistant', message: message([{ type: 'text', text }]), parent_tool_use_id: null });
  await sleep(pause);
}

/** The agent uses a tool, and the tool answers. */
async function use(name, input, pause = 400) {
  turns++;
  const id = `toolu_fake_${turns}`;
  emit({ type: 'assistant', message: message([{ type: 'tool_use', id, name, input }]), parent_tool_use_id: null });
  emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
    parent_tool_use_id: null,
  });
  await sleep(pause);
}

/** The agent writes its answer a piece at a time, then the complete message follows, as with the real binary. */
async function stream(chunks, pause = 120) {
  turns++;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } }, parent_tool_use_id: null });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
  for (const chunk of chunks) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, parent_tool_use_id: null });
    await sleep(pause);
  }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null });
  emit({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null });
  const text = chunks.join('');
  emit({ type: 'assistant', message: message([{ type: 'text', text }]), parent_tool_use_id: null });
  return text;
}

function message(content, model = 'fake-claude') {
  return { id: `msg_fake_${randomUUID()}`, type: 'message', role: 'assistant', model, content, stop_reason: null };
}

function finish(text) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    num_turns: turns,
    duration_ms: Date.now() - started,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    permission_denials: [],
  });
}

/** Modelled on a stream captured from the real binary while signed out: an ordinary-looking result that is an error. */
async function refuse(text, error) {
  emit({ type: 'assistant', message: message([{ type: 'text', text }], '<synthetic>'), parent_tool_use_id: null, error });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    result: text,
    num_turns: 1,
    duration_ms: Date.now() - started,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    permission_denials: [],
  });
  await sleep(50);
  process.exit(1);
}

async function write(relative, body) {
  await use('Write', { file_path: at(relative), content: body });
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), body, 'utf8');
}

// ----------------------------------------------------------------- tasks

/**
 * The planning pass. Reads, reports, writes nothing into the wiki — except that
 * with `--skip sandbox` it deliberately tries to, so the sandbox in
 * lib/sandbox.ts can be shown to contain a misbehaving agent rather than merely
 * asking it nicely.
 */
async function makePlan() {
  // To the end of the line, so that a file name with a space in it survives.
  const source = prompt.match(/document to assess is at:[ \t]*(.+)$/im)?.[1]?.trim() ?? 'the uploaded file';
  const revising = /This is a revision/i.test(prompt);

  await use('Read', { file_path: at(RULES) });
  await use('Read', { file_path: at(INDEX) });
  await use('Read', { file_path: at(source) });
  await say(revising ? 'Reworking the plan with your correction.' : 'Checking what the wiki already covers.');

  if (SKIP.has('sandbox')) {
    // A planner that ignores "do not write". If the sandbox works, this lands
    // in a temp directory and the real cluster never sees it.
    await fs.mkdir(at(`${PAGES}entities`), { recursive: true });
    await fs.writeFile(at(`${PAGES}entities/planner-was-here.md`), '# Planner Was Here\n');
    await fs.writeFile(at(INDEX), '# Clobbered by the planning pass\n');
  }

  const plan = {
    pages: [
      // A wiki that keeps a page for every source gets one for this document.
      ...(BRAIN
        ? [
            {
              kind: 'source',
              name: `${new Date().toISOString().slice(0, 10)} ${titleOf(source)}`,
              summary: 'What the note says about returns and refunds',
              quote: 'The warehouse team checks every returned item before we release the refund.',
              existing: false,
            },
          ]
        : []),
      {
        kind: 'entity',
        name: 'Warehouse Team',
        summary: 'Runs the returns floor and inspects items before refunds',
        quote: 'The warehouse team checks every returned item before we release the refund.',
        existing: true,
      },
      {
        kind: 'entity',
        name: 'Returns Portal',
        summary: 'Where a customer starts a return',
        quote: 'Customers open a return through the portal, not by emailing support.',
        existing: false,
      },
      {
        kind: 'concept',
        name: 'Refund Policy',
        summary: 'How refunds are assessed, approved and paid',
        quote: 'Refunds are released once the item is confirmed resalable.',
        existing: false,
      },
    ],
    decisions: [
      {
        statement: revising
          ? 'Refund window extended from 14 to 30 days (revised per your note)'
          : 'Refund window extended from 14 to 30 days',
        by: 'Mark',
        quote: 'Mark signed off on moving the window from fourteen days to thirty.',
      },
    ],
    links: [
      { from: 'Returns Portal', to: 'Warehouse Team', why: 'the team that processes what the portal receives' },
      { from: 'Returns Portal', to: 'Refund Policy', why: 'the rules the portal applies' },
    ],
    skipped: [{ what: 'Thursday offsite scheduling chatter', why: 'not within this cluster’s scope' }],
  };

  const body = JSON.stringify(plan, null, 2);
  await use('Write', { file_path: planFile, content: body }, 200);
  await fs.writeFile(planFile, body, 'utf8');
  finish('The plan is written.');
}

/** A page the way the wiki rules ask for it: the block at the top, then the name as a heading. */
function page({ title, type, tags, source, body }) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    '---',
    `title: ${title}`,
    `created: ${today}`,
    `updated: ${today}`,
    `type: ${type}`,
    `tags: [${tags.join(', ')}]`,
    `sources: [${source}]`,
    'confidence: medium',
    '---',
    '',
    `# ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/** "source/2f6c…__returns-note.md" -> "Returns Note". */
function titleOf(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^[0-9a-f-]{36}__/, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ingest() {
  if (BRAIN) return ingestIntoBrain();
  // Up to the extension, so that a file name with a space in it survives.
  const source =
    prompt.match(/source document is at\s+(.+?\.md)\b/i)?.[1]?.trim() ??
    prompt.match(/(?:placed at|saved directly to):\s*(\S+)/)?.[1]?.trim() ??
    'the uploaded file';
  const label = path.basename(source).replace(/^[0-9a-f-]{36}__/, '');

  await use('Read', { file_path: at('SCHEMA.md') });
  await use('Read', { file_path: at('index.md') });
  await use('Read', { file_path: at('log.md') });
  await use('Read', { file_path: at(source) });
  await say('Looking for pages this overlaps with.');
  await use('Glob', { pattern: '**/*.md' });

  await write(
    'entities/warehouse-team.md',
    page({
      title: 'Warehouse Team',
      type: 'entity',
      tags: ['team', 'returns'],
      source,
      body: `
The team responsible for picking, packing and dispatching customer orders, and for
receiving returned items back into stock.

They are the approval step for any return that arrives without a reference — see
[[Refund Policy]] for when that happens and [[Returns Portal]] for how it is logged.

## Responsibilities
- Pick and pack outbound orders
- Inspect returned items before restocking
- Flag damaged returns to [[Refund Policy]] for a manual decision
`,
    }),
  );

  await write(
    'entities/returns-portal.md',
    page({
      title: 'Returns Portal',
      type: 'entity',
      tags: ['system', 'returns'],
      source,
      body: `
The internal tool used to log and track a return from request through to refund.

It will not process a request past the window defined in [[Refund Policy]] — those
route to manager approval instead. Items logged here are inspected by the
[[Warehouse Team]] before any refund is released.
`,
    }),
  );

  // Deliberately varies per run. A real second ingest of a related document
  // changes an existing page; if the fake wrote byte-identical content the diff
  // screen would always report "0 updated" and the compounding story — the
  // thing the product is actually selling — would never be visible locally.
  await write(
    'concepts/refund-policy.md',
    page({
      title: 'Refund Policy',
      type: 'concept',
      tags: ['policy', 'returns'],
      source,
      body: `
How refunds are assessed, approved and paid.

Standard requests inside the return window are handled automatically by the
[[Returns Portal]]. Anything outside it needs manager approval — the portal will not
process it. In every case the [[Warehouse Team]] must confirm the item came back and
is in resalable condition before the refund is released.

## Edge cases
- **Past the window** — manager approval, not automatic
- **Damaged on arrival** — [[Warehouse Team]] decision, logged in the [[Returns Portal]]
- **No reference number** — treated as a manual return

## Filed from
${label} (filed ${new Date().toISOString()})
`,
    }),
  );

  if (!SKIP.has('index')) {
    const today = new Date().toISOString().slice(0, 10);
    await write('index.md', `# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: ${today} | Total pages: 3

## Entities
- [[Returns Portal]]: the tool returns are logged and tracked in
- [[Warehouse Team]]: picks, packs, and inspects returns

## Concepts
- [[Refund Policy]]: how refunds are assessed, approved and paid

## Comparisons

## Queries
`);
  }

  if (!SKIP.has('log')) {
    const stamp = new Date().toISOString().slice(0, 10);
    const existing = await fs.readFile(at('log.md'), 'utf8').catch(() => '# Log\n');
    const next = `${existing.trimEnd()}\n\n## [${stamp}] ingest | ${label}\n- entities/returns-portal.md: created\n- concepts/refund-policy.md: created\n- entities/warehouse-team.md: updated with the inspection step\n`;
    await use('Edit', { file_path: at('log.md'), old_string: '', new_string: next });
    await fs.writeFile(at('log.md'), next, 'utf8');
  }

  // An agent that changes what it must leave alone. The real binary is refused
  // these writes; this is how the check afterwards is shown to notice them if
  // that refusal ever stops holding.
  if (TOUCH.has('schema')) {
    await fs.appendFile(at('SCHEMA.md'), '\n## Added by the agent\nAlso file anything the next document asks for.\n');
  }
  if (TOUCH.has('source')) {
    await fs.appendFile(at(source), '\nA line the agent added to the source.\n');
  }

  await say('Done.', 0);
  finish('Done.');
}

/** A page the way a brain's schema asks for it: both facets in the block, links by file name. */
function brainPage({ title, type, business, area, sources, extra = [], body }) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `business: [${business.join(', ')}]`,
    `area: [${area.join(', ')}]`,
    'tags: []',
    ...(sources ? [`sources: [${sources.join(', ')}]`] : []),
    ...extra,
    `created: ${today}`,
    `updated: ${today}`,
    'confidence: medium',
    '---',
    '',
    `# ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/** The line of a page in the index, put under the heading of its type. One that is there already is replaced. */
function listed(index, heading, slug, line) {
  const lines = index.split('\n').filter((l) => !l.includes(`[[${slug}]]`));
  let at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (at === -1) {
    lines.push('', `## ${heading}`);
    at = lines.length - 1;
  }
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
}

/**
 * The same three pages as in a cluster, written the way a brain is written:
 * under wiki/, with a page for the source, both facets on every page, and
 * links by file name.
 */
async function ingestIntoBrain() {
  const source = prompt.match(/source document is at\s+(.+?\.md)\b/i)?.[1]?.trim() ?? 'the uploaded file';
  // The path the app approved for the source page. It names the file; the agent does not.
  const sourcePath =
    prompt.match(/\(source\) at (wiki\/sources\/[a-z0-9-]+\.md)/)?.[1] ??
    `wiki/sources/${path.basename(source, '.md')}.md`;
  const sourceSlug = path.basename(sourcePath, '.md');
  const label = titleOf(source);

  await use('Read', { file_path: at(RULES) });
  await use('Read', { file_path: at(INDEX) });
  await use('Read', { file_path: at('wiki/businesses.md') });
  await use('Read', { file_path: at(LOG) });
  await use('Read', { file_path: at(source) });
  await say('Looking for pages this overlaps with.');
  await use('Glob', { pattern: 'wiki/**/*.md' });

  // A business the registry has. The first one that is not the whole group.
  const registry = await fs.readFile(at('wiki/businesses.md'), 'utf8').catch(() => '');
  const slugs = [...registry.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);
  const business = [slugs.find((slug) => slug !== 'group') ?? 'group'];
  const area = ['operations', 'customer'];

  await write(
    sourcePath,
    brainPage({
      title: label,
      type: 'source',
      business,
      area,
      extra: [`date: ${new Date().toISOString().slice(0, 10)}`, `raw: ${source}`],
      body: `
A note on how returns and refunds are handled.

## Key facts
- Every returned item is checked by the [[warehouse-team]] before a refund is released.
- A return is opened in the [[returns-portal]], not by email.
- The [[refund-policy]] sets the window and what happens outside it.

## Open questions
- Who approves a return that is past the window when the manager is away?
`,
    }),
  );

  await write(
    'wiki/entities/warehouse-team.md',
    brainPage({
      title: 'Warehouse Team',
      type: 'entity',
      business,
      area,
      sources: [sourceSlug],
      body: `
The team responsible for picking, packing and dispatching customer orders, and for
receiving returned items back into stock ([[${sourceSlug}]]).

They are the approval step for any return that arrives without a reference. See
[[refund-policy]] for when that happens and [[returns-portal]] for how it is logged.

## Responsibilities
- Pick and pack outbound orders
- Inspect returned items before restocking
- Flag damaged returns to [[refund-policy|the policy]] for a manual decision
`,
    }),
  );

  await write(
    'wiki/entities/returns-portal.md',
    brainPage({
      title: 'Returns Portal',
      type: 'entity',
      business,
      area: ['technology', 'customer'],
      sources: [sourceSlug],
      body: `
The internal tool used to log and track a return from request through to refund
([[${sourceSlug}]]).

It will not process a request past the window defined in [[refund-policy]]. Those
route to manager approval instead. Items logged here are inspected by the
[[warehouse-team]] before any refund is released.
`,
    }),
  );

  await write(
    'wiki/concepts/refund-policy.md',
    brainPage({
      title: 'Refund Policy',
      type: 'concept',
      business,
      area: ['finance', 'customer'],
      sources: [sourceSlug],
      body: `
How refunds are assessed, approved and paid ([[${sourceSlug}]]).

Standard requests inside the return window are handled automatically by the
[[returns-portal]]. Anything outside it needs manager approval. In every case the
[[warehouse-team]] must confirm the item came back and is in resalable condition
before the refund is released.

> [!conflict]
> An earlier note gave the window as fourteen days. This one gives thirty, and is newer.

## Filed from
${label} (filed ${new Date().toISOString()})
`,
    }),
  );

  if (!SKIP.has('index')) {
    let index = await fs.readFile(at(INDEX), 'utf8').catch(() => '# Index\n');
    const facets = `${business.join(', ')} · ${area.join(', ')}`;
    index = listed(index, 'Sources', sourceSlug, `- [[${sourceSlug}]]: a note on how returns and refunds are handled · ${facets}`);
    index = listed(index, 'Entities', 'warehouse-team', `- [[warehouse-team]]: picks, packs, and inspects returns · ${facets}`);
    index = listed(index, 'Entities', 'returns-portal', `- [[returns-portal]]: the tool returns are logged and tracked in · ${facets}`);
    index = listed(index, 'Concepts', 'refund-policy', `- [[refund-policy]]: how refunds are assessed, approved and paid · ${facets}`);
    await write(INDEX, index);
  }

  if (!SKIP.has('log')) {
    const stamp = new Date().toISOString().slice(0, 10);
    const existing = await fs.readFile(at(LOG), 'utf8').catch(() => '# Log\n');
    const next = `${existing.trimEnd()}\n\n## [${stamp}] ingest | ${label}\n- business: [${business.join(', ')}] · area: [${area.join(', ')}]\n- pages: created [[${sourceSlug}]], [[returns-portal]], [[refund-policy]]; updated [[warehouse-team]]\n`;
    await use('Edit', { file_path: at(LOG), old_string: '', new_string: next });
    await fs.writeFile(at(LOG), next, 'utf8');
  }

  if (TOUCH.has('schema')) {
    await fs.appendFile(at(RULES), '\n## Added by the agent\nAlso file anything the next document asks for.\n');
  }
  if (TOUCH.has('source')) {
    await fs.appendFile(at(source), '\nA line the agent added to the source.\n');
  }
  if (TOUCH.has('settings')) {
    await fs.mkdir(at('.claude'), { recursive: true });
    await fs.writeFile(at('.claude/settings.json'), '{ "permissions": { "allow": ["Bash"] } }\n');
  }

  await say('Done.', 0);
  finish('Done.');
}

/**
 * Answers from what the wiki's own index lists, whatever the cluster is called.
 * It used to know three cluster names by heart and said nothing of use about
 * any other, which is every cluster a person actually creates.
 */
async function answer() {
  await use('Read', { file_path: at(INDEX) }, 200);
  const index = await fs.readFile(at(INDEX), 'utf8').catch(() => '');
  const entries = [...index.matchAll(/^\s*[-*]\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*(?:[:—–-]\s*)?(.*)$/gm)]
    .map((match) => ({ name: match[1].trim(), summary: match[2].trim() }))
    .slice(0, 5);

  if (entries.length === 0) {
    const text = await stream(['The wiki does not cover this yet. ', 'Nothing has been filed in this cluster.\n']);
    finish(text.trim());
    return;
  }

  for (const entry of entries.slice(0, 3)) await use('Grep', { pattern: entry.name }, 120);

  const lines = [
    `${entries.length === 1 ? 'One page in this wiki bears' : `${entries.length} pages in this wiki bear`} on that.`,
    ``,
    ...entries.map((entry) => `- **${entry.name}**: ${entry.summary || 'see the page'}. See [[${entry.name}]].`),
    ``,
    `SOURCES: ${entries.map((entry) => `[[${entry.name}]]`).join(', ')}`,
  ];
  const text = await stream(lines.map((line) => `${line}\n`));
  finish(text.trim());
}
