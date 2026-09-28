#!/usr/bin/env node
/**
 * A stand-in for the real Hermes binary.
 *
 * The dashboard talks to the agent across a process boundary — spawn, argv,
 * stdout — so anything that honours that contract is a valid agent. This one
 * writes plausible pages and streams plausible progress, which means the entire
 * UI can be built and iterated on a dev machine with no API key, no spend, and
 * no client documents ever leaving the VPS.
 *
 * Selected via HERMES_CMD / HERMES_ARGS. On the VPS those point at the real
 * binary instead and nothing else changes.
 *
 * It also streams line by line, which is the OPTIMISTIC assumption about
 * `hermes -z`. Whether the real binary does that is unverified (T1a). If it
 * turns out not to, this fake will look better than production — so judge the
 * chat feel against the real thing, not against this.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const WIKI_PATH = process.env.WIKI_PATH;
const prompt = process.argv[process.argv.indexOf('-z') + 1] ?? '';
const usageFile = process.argv.includes('--usage-file')
  ? process.argv[process.argv.indexOf('--usage-file') + 1]
  : null;

// Where a planning run writes its JSON. Named in the prompt, not on the command
// line: `--plan-file` was a flag the dashboard invented, and the real binary
// exited 2 on the unknown option before reading anything.
const planFile = prompt.match(/JSON to this exact path:\s*(.+)/)?.[1]?.trim() ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `--skip index,log` makes the fake misbehave on purpose, so the post-ingest
// check can be exercised locally. A well-behaved fake can never produce a
// "needs attention" screen, which would leave that path untested. It is an
// argument rather than an env var because the dashboard deliberately strips
// the agent's environment down to five variables (see lib/hermes.ts); pass it
// through HERMES_ARGS, e.g. HERMES_ARGS="scripts/fake-hermes.mjs --skip index".
const skipArg = process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1] ?? '' : '';
const SKIP = new Set(skipArg.split(',').map((s) => s.trim()).filter(Boolean));
const say = async (line, pause = 700) => {
  process.stdout.write(line + '\n');
  await sleep(pause);
};

if (!WIKI_PATH) {
  console.error('WIKI_PATH is not set — the dashboard must pass it on every invocation');
  process.exit(1);
}

/**
 * Which of the three jobs this is.
 *
 * Decided by an explicit flag, never by sniffing the prompt. Prompt-matching is
 * what silently turned every local ingest into a chat answer for six weeks when
 * the upload route reworded one sentence on 2026-08-25; with three prompts in
 * play that bug would now have three places to hide. --plan-file implies
 * planning, so the dashboard only has to be explicit about execution.
 */
const marker = prompt.match(/^TASK:\s*(PLAN|EXECUTE)\s*$/im)?.[1]?.toUpperCase();
const MODE = marker === 'PLAN' ? 'plan' : marker === 'EXECUTE' ? 'execute' : 'answer';

// A planning run with no path to write to would "succeed" having produced
// nothing, and the dashboard would blame the agent. Fail loudly instead.
if (MODE === 'plan' && !planFile) {
  console.error('fake-hermes: TASK: PLAN but the prompt names no output path');
  process.exit(2);
}

if (MODE === 'plan') {
  await makePlan();
} else if (MODE === 'execute') {
  await ingest();
} else {
  await answer();
}

/**
 * The planning pass. Reads, reports, writes nothing into the wiki — except that
 * with `--skip sandbox` it deliberately tries to, so the sandbox in lib/sandbox.ts
 * can be shown to contain a misbehaving agent rather than merely asking it nicely.
 */
async function makePlan() {
  const source = prompt.match(/document to assess is at:\s*(\S+)/i)?.[1]?.trim() ?? 'the uploaded file';
  const label = path.basename(source).replace(/^[0-9a-f-]{36}__/, '');
  const revising = /This is a revision/i.test(prompt);

  await say('Reading SCHEMA.md to understand this cluster.');
  await say(`Reading ${label}.`);
  await say(revising ? 'Reworking the plan with your correction.' : 'Checking what the wiki already covers.');

  if (SKIP.has('sandbox')) {
    // A planner that ignores "do not write". If the sandbox works, this lands
    // in a temp directory and the real cluster never sees it.
    await fs.mkdir(path.join(WIKI_PATH, 'entities'), { recursive: true });
    await fs.writeFile(path.join(WIKI_PATH, 'entities', 'planner-was-here.md'), '# Planner Was Here\n');
    await fs.writeFile(path.join(WIKI_PATH, 'index.md'), '# Clobbered by the planning pass\n');
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
    skipped: [
      { what: 'Thursday offsite scheduling chatter', why: 'not within this cluster’s scope' },
    ],
  };

  if (planFile) {
    await fs.writeFile(planFile, JSON.stringify(plan, null, 2), 'utf8');
    await say(`Wrote the plan to ${path.basename(planFile)}.`, 200);
  } else {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  }
}

async function ingest() {
  const source =
    prompt.match(/source document is at\s+(\S+?)[.\s]/i)?.[1]?.trim() ??
    prompt.match(/(?:placed at|saved directly to):\s*(\S+)/)?.[1]?.trim() ??
    'the uploaded file';
  const label = path.basename(source).replace(/^[0-9a-f-]{36}__/, '');

  await say('Reading SCHEMA.md to understand this cluster.');
  await say(`Converting ${label} with markitdown.`);
  await say('Extracted 11 sections. No OCR needed — the document has a text layer.');
  await say('Looking for pages this overlaps with.');

  await fs.mkdir(path.join(WIKI_PATH, 'raw', 'articles'), { recursive: true });
  await fs.mkdir(path.join(WIKI_PATH, 'entities'), { recursive: true });
  await fs.mkdir(path.join(WIKI_PATH, 'concepts'), { recursive: true });

  try {
    await fs.copyFile(source, path.join(WIKI_PATH, 'raw', 'articles', label));
  } catch {
    /* the fake does not care if the staged file moved */
  }

  const stamp = new Date().toISOString().slice(0, 10);

  await say('Writing entities/warehouse-team.md');
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

  await say('Writing entities/returns-portal.md');
  await write('entities/returns-portal.md', `# Returns Portal

The internal tool used to log and track a return from request through to refund.

It will not process a request past the window defined in [[Refund Policy]] — those
route to manager approval instead. Items logged here are inspected by the
[[Warehouse Team]] before any refund is released.

_Source: ${label}_
`);

  await say('Updating concepts/refund-policy.md — this overlaps an existing page.');
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
  await say('Updating index.md');
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
  await say('Appending to log.md');
  const logPath = path.join(WIKI_PATH, 'log.md');
  const existing = await fs.readFile(logPath, 'utf8').catch(() => '# Log\n');
  await fs.writeFile(
    logPath,
    `${existing.trimEnd()}\n\n- ${stamp} — Ingested \`${label}\`. 2 new pages, 1 updated, 5 new connections.\n`,
    'utf8',
  );
  }

  if (usageFile) {
    await fs.writeFile(
      usageFile,
      JSON.stringify({ estimated_cost_usd: 0, tokens: 0, model: 'fake-hermes', note: 'local stand-in, no API call made' }, null, 2),
      'utf8',
    );
  }

  await say('Done.', 0);
}

async function answer() {
  const clusterName = (path.basename(WIKI_PATH) ?? '').toLowerCase();

  let chunks = [];

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

  for (const chunk of chunks) {
    await say(chunk, 220);
  }
}

async function write(relative, body) {
  const file = path.join(WIKI_PATH, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}
