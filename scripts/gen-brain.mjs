#!/usr/bin/env node
/**
 * Makes a wiki in the brain layout, out of nothing, for the checks and for
 * looking at the app with a wiki of real size in it.
 *
 *   node scripts/gen-brain.mjs <folder> [--pages 60] [--links 6] [--seed 1]
 *
 * Everything in it is made up: the group, its businesses, the people. The same
 * seed gives the same wiki. A real wiki is never used for a check; this is
 * what is used instead.
 *
 * The layout is the one src/lib/layout.ts calls a brain:
 *
 *   CLAUDE.md                       the schema
 *   .claude/                        what a person keeps there for their own Claude
 *   raw/, raw/inbox/, raw/assets/   the sources
 *   wiki/index.md, log.md, overview.md, businesses.md
 *   wiki/sources/, entities/, concepts/, synthesis/
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AREAS = ['strategy', 'marketing', 'sales', 'operations', 'finance', 'people', 'product', 'technology', 'legal', 'customer'];

export const BUSINESSES = [
  { slug: 'group', name: 'All businesses', page: 'overview', notes: 'reserved: what applies to the whole group' },
  { slug: 'northwind-holdings', name: 'Northwind Holdings', page: 'northwind-holdings', notes: 'the parent company' },
  { slug: 'harbour-bakery', name: 'Harbour Bakery', page: 'harbour-bakery', notes: 'three shops and a wholesale round' },
  { slug: 'cedar-cycles', name: 'Cedar Cycles', page: 'cedar-cycles', notes: 'bicycle repair and hire' },
  { slug: 'lumen-print', name: 'Lumen Print', page: 'lumen-print', notes: 'print shop, bought in 2025' },
];

const FIRST = ['Mark', 'Dana', 'Priya', 'Tomas', 'Aiko', 'Lena', 'Omar', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kavya', 'Milan', 'Nora', 'Pavel', 'Rosa', 'Sven', 'Talia', 'Viktor', 'Wren'];
const LAST = ['Chen', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Novak', 'Haddad', 'Silva', 'Brandt', 'Castillo', 'Dunmore', 'Eklund', 'Farrow', 'Galvez', 'Hoang'];
const FIRMS = ['Tidewater', 'Alder', 'Bluefield', 'Copperline', 'Dovetail', 'Eastgate', 'Foxglove', 'Granite', 'Hollow Oak', 'Ironbridge', 'Juniper', 'Kestrel'];
const FIRM_KINDS = ['Bank', 'Supply', 'Logistics', 'Insurance', 'Accounting', 'Software', 'Flour Mill', 'Couriers', 'Legal', 'Studio'];
const TOPICS = ['Refund', 'Pricing', 'Hiring', 'Opening Hours', 'Wholesale', 'Loyalty', 'Stock Count', 'Payroll', 'Lease', 'Maintenance', 'Onboarding', 'Supplier Review', 'Cash Handling', 'Delivery', 'Returns', 'Complaints', 'Budget', 'Signage', 'Warranty', 'Rota'];
const TOPIC_KINDS = ['Policy', 'Process', 'Playbook', 'Checklist', 'Metric', 'Plan'];
const MEETINGS = ['Board Pack', 'Weekly Review', 'Supplier Call', 'Lease Renewal Notes', 'Budget Session', 'Staff Meeting', 'Planning Day', 'Insurance Review', 'Stocktake Notes', 'Pricing Workshop'];
const CLAIMS = [
  'agreed to revisit this at the next review',
  'is the owner of the decision',
  'raised the cost and asked for two quotes',
  'depends on this being in place before the summer',
  'was named as the contact for anything urgent',
  'is covered by the same agreement',
  'needs a second signature above the limit',
  'moved from monthly to weekly reporting',
];

/** A small generator with a seed, so that the same seed gives the same wiki. */
function random(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    some: (list, n) => {
      const copy = [...list];
      const out = [];
      while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function block(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // A title with a colon in it has to be quoted, or it is not YAML.
    const text = Array.isArray(value) ? `[${value.join(', ')}]` : /[:#]/.test(String(value)) ? JSON.stringify(String(value)) : String(value);
    lines.push(`${key}: ${text}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

const SCHEMA = `# Northwind: Wiki Schema

This folder is a knowledge base about the businesses of the Northwind group, kept by an
agent. People add sources and ask questions; the agent writes and maintains every page
in \`wiki/\`. Read this file before any operation.

## Layers

| Path | Owner | Rule |
|---|---|---|
| \`raw/inbox/\` | human | Drop zone for sources. Each is moved to \`raw/\` once ingested. |
| \`raw/\` | human | **Immutable.** Never edit or delete a source after ingest. |
| \`raw/assets/\` | human | Images and attachments referenced by sources. |
| \`wiki/\` | agent | All compiled knowledge. The agent creates, updates and cross-links it. |
| \`CLAUDE.md\` | shared | This schema. Changes are agreed with a person. |

## Page types (folder = what kind of page it is)

- \`wiki/sources/\`: one summary per raw source (\`YYYY-MM-DD-short-slug.md\`).
- \`wiki/entities/\`: people, companies, clients, vendors, products, tools, places.
- \`wiki/concepts/\`: ideas, processes, playbooks, policies, metrics, recurring themes.
- \`wiki/synthesis/\`: comparisons, analyses and answers to questions worth keeping.
- \`wiki/index.md\`: catalogue of every page, grouped by type, one line each.
- \`wiki/log.md\`: append-only activity log.
- \`wiki/overview.md\`: the current big picture across all businesses.
- \`wiki/businesses.md\`: registry of valid \`business:\` values.

Folders never encode business or department.

## Facets: business and area

Every page carries two facets in its frontmatter:

- \`business:\` which company or companies the page concerns. A list, with values only
  from \`wiki/businesses.md\`. Use \`group\` when the page applies to the whole group.
- \`area:\` which kind of work it is. A list, with values only from this fixed set:

| area | covers |
|---|---|
${AREAS.map((area) => `| \`${area}\` | work of the kind "${area}" |`).join('\n')}

Tag with every area that really applies, but keep it to three at most.

## Frontmatter (required on every wiki page)

\`\`\`yaml
---
title: Human Readable Title
type: source | entity | concept | synthesis
business: [harbour-bakery]
area: [marketing, sales]
tags: []
sources: [2026-01-22-slug]
created: 2026-01-22
updated: 2026-01-22
confidence: high | medium | low
---
\`\`\`

Source pages also add \`date:\` and \`raw: raw/<filename>\`.

## Conventions

- Slugs are lowercase and hyphenated. File name = slug. Link with \`[[slug]]\`.
- Every claim traces to a source page. Cite inline, for example \`([[2026-01-22-board-pack]])\`.
- When sources conflict, keep both claims and flag them with \`> [!conflict]\`.
- Dates are absolute (YYYY-MM-DD).
- Don't store secrets, even if a source contains them.

## Log format (\`wiki/log.md\`, append-only)

\`\`\`
## [YYYY-MM-DD] ingest | Source Title
- business: [..] · area: [..]
- pages: created [[a]], [[b]]; updated [[c]]
\`\`\`
`;

/**
 * Write a brain into \`dir\`, which must not hold one yet.
 *
 * @returns what was made, for a check to compare the app's reading with
 */
export async function generateBrain(dir, { pages = 60, links = 6, seed = 1 } = {}) {
  const rng = random(seed);
  const businesses = BUSINESSES.filter((b) => b.slug !== 'group');
  const day = (n) => new Date(Date.UTC(2026, 0, 5) + n * 86_400_000).toISOString().slice(0, 10);

  // ------------------------------------------------------------ the pages
  const made = [];
  const taken = new Set(['index', 'log', 'overview', 'businesses']);
  const add = (dirName, type, title, extra = {}) => {
    let slug = slugOf(extra.slug ?? title);
    for (let n = 2; taken.has(slug); n++) slug = `${slugOf(extra.slug ?? title)}-${n}`;
    taken.add(slug);
    const page = {
      dir: dirName,
      type,
      title,
      slug,
      business: extra.business ?? rng.some(businesses, 1 + rng.int(2)).map((b) => b.slug),
      area: extra.area ?? rng.some(AREAS, 1 + rng.int(3)),
      created: extra.created ?? day(rng.int(200)),
      links: [],
      cites: [],
      ...extra.more,
    };
    made.push(page);
    return page;
  };

  // The businesses themselves are entities: the registry points at their pages.
  for (const business of businesses) {
    add('entities', 'entity', business.name, { slug: business.page, business: [business.slug], area: ['strategy'] });
  }

  const want = Math.max(pages, businesses.length + 4);
  const counts = {
    sources: Math.max(2, Math.round(want * 0.35)),
    concepts: Math.max(1, Math.round(want * 0.25)),
    synthesis: Math.max(1, Math.round(want * 0.03)),
  };
  counts.entities = Math.max(0, want - counts.sources - counts.concepts - counts.synthesis - businesses.length);

  for (let i = 0; i < counts.sources; i++) {
    const date = day(i * 2 + rng.int(2));
    const title = `${rng.pick(businesses).name} ${rng.pick(MEETINGS)}`;
    add('sources', 'source', title, { slug: `${date}-${slugOf(title)}`, created: date, more: { date, raw: `raw/${date}-${slugOf(title)}.md` } });
  }
  for (let i = 0; i < counts.entities; i++) {
    add('entities', 'entity', i % 3 === 0 ? `${rng.pick(FIRMS)} ${rng.pick(FIRM_KINDS)}` : `${rng.pick(FIRST)} ${rng.pick(LAST)}`);
  }
  for (let i = 0; i < counts.concepts; i++) add('concepts', 'concept', `${rng.pick(TOPICS)} ${rng.pick(TOPIC_KINDS)}`);
  for (let i = 0; i < counts.synthesis; i++) {
    const [a, b] = rng.some(businesses, 2);
    add('synthesis', 'synthesis', `${a.name} and ${b.name}: ${rng.pick(TOPICS)} Compared`, { business: [a.slug, b.slug] });
  }

  // ------------------------------------------------------------ the links
  const sources = made.filter((p) => p.type === 'source');
  const others = made.filter((p) => p.type !== 'source');
  for (const page of made) {
    const pool = (page.type === 'source' ? others : made).filter((p) => p !== page);
    page.links = rng.some(pool, Math.max(2, Math.min(pool.length, Math.round(links * (0.5 + rng.next())))));
    if (page.type !== 'source') page.cites = rng.some(sources, 1 + rng.int(3));
  }

  // ------------------------------------------------------------- the files
  const wiki = path.join(dir, 'wiki');
  for (const folder of ['sources', 'entities', 'concepts', 'synthesis']) await fs.mkdir(path.join(wiki, folder), { recursive: true });
  await fs.mkdir(path.join(dir, 'raw', 'inbox'), { recursive: true });
  await fs.mkdir(path.join(dir, 'raw', 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

  await fs.writeFile(path.join(dir, 'CLAUDE.md'), SCHEMA);
  await fs.writeFile(path.join(dir, '.claude', 'daily-check.md'), '# Daily check\n\nWhat a person\'s own Claude does on the first message of a day. Not run by the app.\n');
  await fs.writeFile(path.join(dir, '.claude', 'last_daily_check.txt'), `${day(0)}\n`);

  for (const page of made) {
    const body = [`# ${page.title}`, ''];
    if (page.type === 'source') {
      body.push(`A summary of the source dated ${page.date}.`, '', '## Key facts');
      for (const target of page.links) body.push(`- [[${target.slug}]] ${rng.pick(CLAIMS)}.`);
      body.push('', '## Open questions', '- None recorded.');
      await fs.writeFile(path.join(dir, page.raw), `---\nsource_url: made up\ningested: ${page.date}\nsha256: 0\n---\n# ${page.title}\n\nNotes, as they were given.\n`);
    } else {
      body.push(`What the wiki knows about ${page.title}.`, '', '## Notes');
      for (const [i, target] of page.links.entries()) {
        const cite = page.cites[i % page.cites.length];
        body.push(`- [[${target.slug}${i % 4 === 0 ? `|${target.title}` : ''}]] ${rng.pick(CLAIMS)} ([[${cite.slug}]]).`);
      }
      if (page.type === 'concept' && rng.int(5) === 0) {
        body.push('', '> [!conflict]', `> Two sources give different dates for this. [[${page.cites[0].slug}]] is the newer one.`);
      }
    }
    const fields = {
      title: page.title,
      type: page.type,
      business: page.business,
      area: page.area,
      tags: [],
      sources: page.type === 'source' ? undefined : page.cites.map((c) => c.slug),
      date: page.date,
      raw: page.raw,
      created: page.created,
      updated: page.created,
      confidence: rng.pick(['high', 'medium', 'medium', 'low']),
    };
    await fs.writeFile(path.join(wiki, page.dir, `${page.slug}.md`), `${block(fields)}${body.join('\n')}\n`);
  }

  const registry = [
    '# Business Registry',
    '',
    'Valid values for the `business:` facet. The agent must not invent new ones.',
    '',
    '| slug | name | main page | notes |',
    '|---|---|---|---|',
    ...BUSINESSES.map((b) => `| \`${b.slug}\` | ${b.name} | [[${b.page}]] | ${b.notes} |`),
    '',
  ];
  await fs.writeFile(
    path.join(wiki, 'businesses.md'),
    `${block({ title: 'Business Registry', type: 'concept', business: ['group'], area: ['strategy'], created: day(0), updated: day(0), confidence: 'high' })}${registry.join('\n')}`,
  );

  await fs.writeFile(
    path.join(wiki, 'overview.md'),
    `${block({ title: 'Overview', type: 'synthesis', business: ['group'], area: ['strategy'], created: day(0), updated: day(0), confidence: 'medium' })}# Overview\n\nThe group in one page.\n\n${businesses.map((b) => `- [[${b.page}]]: ${b.notes}`).join('\n')}\n\nThe values for \`business:\` are in [[businesses]].\n`,
  );

  const line = (page) => `- [[${page.slug}]]: ${page.title} · ${page.business.join(', ')} · ${page.area.join(', ')}`;
  const section = (title, type) => [`## ${title}`, ...made.filter((p) => p.type === type).sort((a, b) => a.slug.localeCompare(b.slug)).map(line), ''];
  await fs.writeFile(
    path.join(wiki, 'index.md'),
    [
      '# Index',
      '',
      'Catalogue of every wiki page: `link: summary · business · area`.',
      '',
      '## Overview',
      '- [[overview]]: big picture, priorities, open questions · group · strategy',
      '- [[businesses]]: registry of valid business slugs · group · strategy',
      '',
      ...section('Sources', 'source'),
      ...section('Entities', 'entity'),
      ...section('Concepts', 'concept'),
      ...section('Synthesis', 'synthesis'),
    ].join('\n'),
  );

  await fs.writeFile(
    path.join(wiki, 'log.md'),
    [
      '# Log',
      '',
      `## [${day(0)}] schema | Wiki initialised`,
      '- Structure set up per CLAUDE.md',
      '',
      ...sources.slice(0, 12).flatMap((page) => [
        `## [${page.date}] ingest | ${page.title}`,
        `- business: [${page.business.join(', ')}] · area: [${page.area.join(', ')}]`,
        `- pages: created [[${page.slug}]]; updated ${page.links.slice(0, 3).map((p) => `[[${p.slug}]]`).join(', ')}`,
        '',
      ]),
    ].join('\n'),
  );

  return {
    pages: made.length + 2, // and the overview and the registry
    byFolder: Object.fromEntries(['sources', 'entities', 'concepts', 'synthesis'].map((f) => [f, made.filter((p) => p.dir === f).length])),
    links: made.reduce((n, page) => n + new Set([...page.links, ...page.cites].map((p) => p.slug)).size, 0),
    slugs: made.map((page) => `${page.dir}/${page.slug}`),
    sample: made.find((p) => p.type === 'entity' && p.links.length > 0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  const number = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) || fallback : fallback);
  if (!dir) {
    console.error('Usage: node scripts/gen-brain.mjs <folder> [--pages 60] [--links 6] [--seed 1]');
    process.exit(2);
  }
  if (await fs.stat(path.join(dir, 'wiki')).then(() => true, () => false)) {
    console.error(`${dir} holds a wiki already. Nothing was written.`);
    process.exit(1);
  }
  const made = await generateBrain(dir, { pages: number('--pages', 60), links: number('--links', 6), seed: number('--seed', 1) });
  console.log(`${made.pages} pages and about ${made.links} links in ${path.resolve(dir)}`);
}
