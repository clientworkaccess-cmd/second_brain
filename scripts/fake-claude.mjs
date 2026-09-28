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
 *   --fail auth|limit          end the way the real binary does when signed out or out of usage
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const valueOf = (name) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? '') : '');

const WIKI_PATH = process.cwd();
// Declared up here: the tasks below run before the rest of the file is reached.
const at = (relative) => path.join(WIKI_PATH, relative);
const SKIP = new Set(valueOf('--skip').split(',').map((s) => s.trim()).filter(Boolean));
const FAIL = valueOf('--fail');
const TOOLS = valueOf('--tools').split(',').map((s) => s.trim()).filter(Boolean);
const SESSION = randomUUID();
const started = Date.now();

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
  const source = prompt.match(/document to assess is at:\s*(\S+)/i)?.[1]?.trim() ?? 'the uploaded file';
  const revising = /This is a revision/i.test(prompt);

  await use('Read', { file_path: at('SCHEMA.md') });
  await use('Read', { file_path: at('index.md') });
  await use('Read', { file_path: at(source) });
  await say(revising ? 'Reworking the plan with your correction.' : 'Checking what the wiki already covers.');

  if (SKIP.has('sandbox')) {
    // A planner that ignores "do not write". If the sandbox works, this lands
    // in a temp directory and the real cluster never sees it.
    await fs.mkdir(at('entities'), { recursive: true });
    await fs.writeFile(at('entities/planner-was-here.md'), '# Planner Was Here\n');
    await fs.writeFile(at('index.md'), '# Clobbered by the planning pass\n');
  }

  const plan = {
    pages: [
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

async function ingest() {
  const source =
    prompt.match(/source document is at\s+(\S+?)\.?(?:\s|$)/i)?.[1]?.trim() ??
    prompt.match(/(?:placed at|saved directly to):\s*(\S+)/)?.[1]?.trim() ??
    'the uploaded file';
  const label = path.basename(source).replace(/^[0-9a-f-]{36}__/, '');

  await use('Read', { file_path: at('SCHEMA.md') });
  await use('Read', { file_path: at('index.md') });
  await use('Read', { file_path: at(source) });
  await say('Looking for pages this overlaps with.');
  await use('Glob', { pattern: '**/*.md' });

  await write('entities/warehouse-team.md', `# Warehouse Team

The team responsible for picking, packing and dispatching customer orders, and for
receiving returned items back into stock.

They are the approval step for any return that arrives without a reference — see
[[Refund Policy]] for when that happens and [[Returns Portal]] for how it is logged.

## Responsibilities
- Pick and pack outbound orders
- Inspect returned items before restocking
- Flag damaged returns to [[Refund Policy]] for a manual decision

_Source: ${label}_
`);

  await write('entities/returns-portal.md', `# Returns Portal

The internal tool used to log and track a return from request through to refund.

It will not process a request past the window defined in [[Refund Policy]] — those
route to manager approval instead. Items logged here are inspected by the
[[Warehouse Team]] before any refund is released.

_Source: ${label}_
`);

  // Deliberately varies per run. A real second ingest of a related document
  // changes an existing page; if the fake wrote byte-identical content the diff
  // screen would always report "0 updated" and the compounding story — the
  // thing the product is actually selling — would never be visible locally.
  await write('concepts/refund-policy.md', `# Refund Policy

How refunds are assessed, approved and paid.

Standard requests inside the return window are handled automatically by the
[[Returns Portal]]. Anything outside it needs manager approval — the portal will not
process it. In every case the [[Warehouse Team]] must confirm the item came back and
is in resalable condition before the refund is released.

## Edge cases
- **Past the window** — manager approval, not automatic
- **Damaged on arrival** — [[Warehouse Team]] decision, logged in the [[Returns Portal]]
- **No reference number** — treated as a manual return

## Sources filed into this page
${label} (filed ${new Date().toISOString()})
`);

  if (!SKIP.has('index')) {
    await write('index.md', `# Index

Every page in this cluster.

## Entities
- [[Warehouse Team]] — picks, packs, and inspects returns
- [[Returns Portal]] — the tool returns are logged and tracked in

## Concepts
- [[Refund Policy]] — how refunds are assessed, approved and paid
`);
  }

  if (!SKIP.has('log')) {
    const stamp = new Date().toISOString().slice(0, 10);
    const existing = await fs.readFile(at('log.md'), 'utf8').catch(() => '# Log\n');
    const next = `${existing.trimEnd()}\n\n## [${stamp}] ingest | ${label}\n- 2 new pages, 1 updated, 5 new connections.\n`;
    await use('Edit', { file_path: at('log.md'), old_string: '', new_string: next });
    await fs.writeFile(at('log.md'), next, 'utf8');
  }

  await say('Done.', 0);
  finish('Done.');
}

async function answer() {
  const clusterName = path.basename(WIKI_PATH).toLowerCase();

  let chunks;
  if (clusterName === 'operations') {
    chunks = [
      `The **Operations** cluster covers how customer orders are fulfilled, inspected, and returned.`,
      ``,
      `Key operational areas:`,
      `- **Warehouse Management**: Order picking, packing, dispatching, and return item inspections managed by the [[Warehouse Team]].`,
      `- **Returns & Exchanges**: Tracking and processing return requests automatically via the [[Returns Portal]].`,
      `- **Policies & Escalations**: Managing window limits, damaged items, and manager overrides per [[Refund Policy]].`,
      ``,
      `SOURCES: [[Warehouse Team]], [[Returns Portal]], [[Refund Policy]]`,
    ];
  } else if (clusterName === 'finance') {
    chunks = [
      `The **Finance** cluster covers financial planning, departmental budgeting, expense tracking, and audit compliance.`,
      ``,
      `Key financial areas:`,
      `- **Financial Governance**: Budget distributions, tax compliance, and accounting supervised by the [[Finance Team]].`,
      `- **Audit & Tracking**: Recording transaction ledgers and financial variance reports inside the [[Audit Portal]].`,
      `- **Budgeting Framework**: Guidelines for annual financial planning and expense approvals in [[Budgeting Guidelines]].`,
      ``,
      `SOURCES: [[Finance Team]], [[Audit Portal]], [[Budgeting Guidelines]]`,
    ];
  } else if (clusterName === 'marketing') {
    chunks = [
      `The **Marketing** cluster covers brand positioning, acquisition campaign strategy, media asset management, and growth analytics.`,
      ``,
      `Key marketing areas:`,
      `- **Acquisition & Growth**: Paid media campaigns, SEO, and user growth strategy driven by the [[Growth Team]].`,
      `- **Brand Collateral**: Storing digital assets, design templates, and copy guidelines within the [[Content Hub]].`,
      `- **Campaign Strategy**: Blueprint for product launches, promotional pushes, and retargeting in [[Campaign Strategy]].`,
      ``,
      `SOURCES: [[Growth Team]], [[Content Hub]], [[Campaign Strategy]]`,
    ];
  } else {
    chunks = [
      `This cluster covers information, entities, and concepts configured for ${clusterName}.`,
      ``,
      `SOURCES: [[Index]]`,
    ];
  }

  await use('Read', { file_path: at('index.md') }, 200);
  const text = await stream(chunks.map((line) => `${line}\n`));
  finish(text.trim());
}
