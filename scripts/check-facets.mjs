#!/usr/bin/env node
/**
 * Facets: what a page is about, across the folders. In a brain every page
 * says which business it concerns and what kind of work it is about, with
 * values the wiki lists.
 *
 *   npm run check:facets
 *
 * | what is checked                                | what it looks like when it is wrong                |
 * |------------------------------------------------|----------------------------------------------------|
 * | the values are read from the wiki's own files   | a business added to the registry is "not in it"    |
 * | what a page's block gets wrong is said, in words | a page with a made-up business looks fine          |
 * | the check after filing reports it               | the agent invents a business and nobody notices    |
 * | a plan carries the facets                       | the reader approves pages without knowing what they concern |
 * | callouts                                        | a `> [!conflict]` block reads as a quote           |
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';
import { generateBrain, BUSINESSES, AREAS } from './gen-brain.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-facets-'));
process.env.WIKI_ROOT = root;
process.env.CLAUDE_CMD = 'node';
process.env.CLAUDE_ARGS = 'scripts/fake-claude.mjs';

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { CLUSTER, BRAIN } = await import(lib('layout'));
const { facetsOf, areasIn, tableValues, pageProblems, AREAS_BY_DEFAULT } = await import(lib('facets'));
const { remarkCallouts } = await import(lib('callouts'));
const { createCluster, createBrain, parseBusinesses } = await import(lib('clusters'));
const { listPages, readPage, loadWiki } = await import(lib('wiki'));
const { buildGraph } = await import(lib('graph'));
const { validatePlan, readPlan } = await import(lib('plans'));
const jobs = await import(lib('jobs'));
const { STAGING_DIR } = await import(lib('config'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const settle = (job) =>
  new Promise((resolve) => {
    const stop = jobs.subscribe(job.id, (j) => jobs.isActive(j.status) || (stop(), resolve(j)));
  });
const describe = (job) =>
  `${job.status}${job.error ? ` (${job.error})` : ''}${job.lint ? `, findings: ${job.lint.findings.map((f) => `${f.severity}:${f.code}`).join(', ') || 'none'}` : ''}`;

async function file(cluster, name, switches = '') {
  process.env.CLAUDE_ARGS = `scripts/fake-claude.mjs ${switches}`.trim();
  await fs.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `${crypto.randomUUID()}__${name}`);
  await fs.writeFile(staged, `---\nsource_url: made up\ningested: 2026-09-16\nsha256: 0\n---\nA note about the warehouse team and the returns portal.\n`);
  let job = await jobs.startPlanning({ cluster, filename: name, stagedPath: staged, originalPath: null });
  job = await settle(job);
  const plan = await readPlan(job.id);
  if (job.status !== 'awaiting_approval') return { job, plan };
  job = await jobs.approvePlan(job.id);
  job = await settle(job);
  process.env.CLAUDE_ARGS = 'scripts/fake-claude.mjs';
  return { job: await jobs.getJob(job.id), plan };
}

try {
  await createCluster({ name: 'ops', scope: 'Returns and refunds', entities: '', questions: '' });
  const made = await generateBrain(path.join(root, 'northwind'), { pages: 40, links: 5, seed: 5 });

  // ------------------------------------------------------------ the values
  const wiki = await loadWiki('northwind');
  const business = wiki.facets.find((f) => f.key === 'business');
  const area = wiki.facets.find((f) => f.key === 'area');
  check('a brain has the two facets, in this order', wiki.facets.map((f) => f.key).join() === 'business,area');
  check('the businesses are read from the registry page', business?.values.map((v) => v.value).join() === BUSINESSES.map((b) => b.slug).join(), business?.values.map((v) => v.value).join());
  check('each with its name and its page', business?.values[1].label === 'Northwind Holdings' && business?.values[1].page === 'northwind-holdings', JSON.stringify(business?.values[1]));
  check('the areas are read from the table in the rules', area?.values.map((v) => v.value).join() === AREAS.join() && area?.max === 3, area?.values.map((v) => v.value).join());
  check('an area is shown with a capital', area?.values[0].label === 'Strategy');
  check('a cluster has no facets', (await loadWiki('ops')).facets.length === 0);
  check('rules without a table of areas get the schema’s own', areasIn('# Rules\n\nNo table here.\n') === null && facetsOf(BRAIN, null, null)[1].values.map((v) => v.value).join() === AREAS_BY_DEFAULT.join());
  check('a registry with bold names and no page still reads', tableValues('| `a-co` | **A Co** | | new |\n| `b-co` | B Co | [[b-co]] | |')[0].label === 'A Co' && tableValues('| `b-co` | B Co | [[b-co|B]] |')[0].page === 'b-co');
  check('a registry lists a value once', tableValues('| `a` | A | | |\n| `a` | A again | | |').length === 1);

  // -------------------------------------------------------- the problems
  const good = { slug: 'entities/x', dir: 'entities', type: 'entity', data: { title: 'X', type: 'entity', business: ['group'], area: ['finance'], created: '2026-01-02', updated: new Date('2026-01-03'), confidence: 'high' }, facets: { business: ['group'], area: ['finance'] } };
  const problems = (page) => pageProblems({ ...good, ...page, data: { ...good.data, ...page.data } }, BRAIN, wiki.facets);
  check('a page that follows the rules has nothing wrong with it', problems({}).length === 0, problems({}).join('; '));
  check('a business the registry does not have is named', problems({ data: { business: ['made-up'] }, facets: { business: ['made-up'], area: ['finance'] } }).join() === 'has the business "made-up", which is not in wiki/businesses.md');
  check('too many areas are counted', problems({ data: { area: ['a', 'b', 'c', 'd'] }, facets: { business: ['group'], area: ['finance', 'sales', 'people', 'legal'] } }).join() === 'has 4 areas; at most 3 are allowed');
  check('a type that is not the folder’s is said', problems({ type: 'concept', data: { type: 'concept' } }).join() === 'has the type "concept" but is in the folder for entities');
  check('a type the wiki does not have is said', problems({ type: 'memo', data: { type: 'memo' } }).join() === 'has the type "memo", which this wiki does not have');
  const { area: _area, ...withoutArea } = good.data;
  check('a missing facet is said', pageProblems({ ...good, data: withoutArea, facets: { business: ['group'] } }, BRAIN, wiki.facets).join() === 'has no area');
  check('a date that is not a date is said', problems({ data: { created: 'last week' } }).join() === 'has a created that is not a date (YYYY-MM-DD)');
  check('a confidence that is none of the three is said', problems({ data: { confidence: 'sure' } }).join() === 'has the confidence "sure"; it is high, medium or low');
  check('a source page needs the date of its source', problems({ dir: 'sources', type: 'source', data: { type: 'source' } }).join() === 'is a source page without the date of its source');
  check('a page without a block is said, and nothing else', pageProblems({ slug: 'a', dir: 'entities', type: null, data: {}, facets: {} }, BRAIN, wiki.facets).join() === 'has no block at its top');
  check('in a cluster the same page is fine', pageProblems({ ...good, data: { ...good.data, business: undefined, area: undefined } }, CLUSTER, []).length === 0);

  // ----------------------------------------------------------- the pages
  const listing = await listPages('northwind');
  const some = listing.folders.find((f) => f.dir === 'entities').pages[0];
  check('the listing carries the facets of every page', some.facets.business?.length >= 1 && some.facets.area?.length >= 1 && listing.facets.length === 2, JSON.stringify(some.facets));
  const page = await readPage('northwind', `entities/${made.sample.slug}`);
  check('a generated page has nothing wrong with its block', page.problems.length === 0 && page.facets.business.join() === made.sample.business.join(), page.problems.join('; '));
  check('the graph carries the facets', (await buildGraph('northwind')).facets.length === 2 && (await buildGraph('northwind')).nodes.some((n) => (n.facets.business ?? []).length > 0));

  // ------------------------------------------------- the check after filing
  const bad = await file('northwind', 'facets.md', '--touch facets');
  const found = bad.job.lint?.findings.filter((f) => f.code === 'page-block').map((f) => f.detail) ?? [];
  check('a filing that breaks the rules of the block still ends as done', bad.job.status === 'done', describe(bad.job));
  check('and every problem is reported, with the page named', found.length === 3 && found.every((d) => d.startsWith('"Made Up Co" ')), found.join(' | '));
  check('a business the registry does not have', found.some((d) => d.includes('"made-up-co", which is not in wiki/businesses.md')));
  check('one area too many', found.some((d) => d.includes('4 areas')));
  check('a type that is not the folder’s', found.some((d) => d.includes('type "concept" but is in the folder for entities')));

  const fine = await file('northwind', 'fine.md');
  check('a filing that follows the rules has nothing to report', fine.job.status === 'done' && fine.job.lint?.findings.length === 0, describe(fine.job));

  // --------------------------------------------------------------- plans
  check('the plan of a brain says what each page is about', fine.plan.pages.every((p) => p.facets.business?.length === 1 && p.facets.area?.length === 2), JSON.stringify(fine.plan.pages[0]?.facets));
  const validated = validatePlan({ pages: [{ kind: 'entity', name: 'X', business: 'Harbour-Bakery, group', area: ['Finance'] }] }, BRAIN, wiki.facets);
  check('facets in a plan are read as lists, in lower case', validated.pages[0].facets.business.join() === 'harbour-bakery,group' && validated.pages[0].facets.area.join() === 'finance');
  check('a plan for a cluster carries none', Object.keys(validatePlan({ pages: [{ kind: 'entity', name: 'X', business: 'x' }] }, CLUSTER, []).pages[0].facets).length === 0);

  // ------------------------------------------- a brain made from the interview
  const made2 = await createBrain({
    name: 'acme',
    scope: 'The Acme group: a bakery and a print shop.',
    businesses: ['Harbour Bakery', 'lumen-print: Lumen Print', '- **Cedar** Cycles', ''].join('\n'),
    questions: 'Who owns what?',
  });
  const acme = await loadWiki('acme');
  check('the interview makes a brain', made2.layout === 'brain' && acme.layout.id === 'brain' && made2.pageCount === 5, `${made2.layout}, ${made2.pageCount} pages`);
  check('with the businesses it was given, as values', acme.facets[0].values.map((v) => v.value).join() === 'group,harbour-bakery,lumen-print,cedar-cycles', acme.facets[0].values.map((v) => v.value).join());
  check('and a page for each of them', ['entities/harbour-bakery', 'entities/lumen-print', 'entities/cedar-cycles', 'overview', 'businesses'].every((slug) => acme.entries.has(slug)));
  const parsed = parseBusinesses(['A Co', 'b-co: B Co', '', 'A Co'].join('\n'));
  check('a business is written as "slug: Name" or just a name', JSON.stringify(parsed) === JSON.stringify([{ slug: 'a-co', name: 'A Co' }, { slug: 'b-co', name: 'B Co' }]), JSON.stringify(parsed));
  const into = await file('acme', 'first.md');
  check('the first filing into it has nothing to report', into.job.status === 'done' && into.job.lint?.findings.length === 0, describe(into.job));
  let refused = null;
  await createBrain({ name: 'empty', scope: 'x', businesses: '', questions: '' }).catch((err) => (refused = err));
  check('a brain needs at least one business', refused?.status === 400, refused?.message ?? 'it was made');

  // ------------------------------------------------------------- callouts
  const tree = (text) => ({ type: 'root', children: [{ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] }] });
  const run = (text) => {
    const t = tree(text);
    remarkCallouts()(t);
    return t.children[0];
  };
  const conflict = run('[!conflict]\nTwo sources disagree.');
  check('a quote that starts with [!type] becomes a callout of that type', conflict.data?.hName === 'div' && conflict.data.hProperties.className.join(' ') === 'callout callout-conflict');
  check('with a title of its own, and the text under it', conflict.children[0].data?.hProperties.className[0] === 'callout-title' && conflict.children[0].children[0].value === 'Conflict' && conflict.children[1].children[0].value === 'Two sources disagree.');
  const titled = run('[!warning] Mind the gap\nBody');
  check('a title after the marker is used', titled.children[0].children[0].value === 'Mind the gap' && titled.children[1].children[0].value === 'Body');
  const only = run('[!note]');
  check('a marker alone is a callout with a title and nothing else', only.children.length === 1 && only.children[0].children[0].value === 'Note');
  check('a plain quote is left alone', run('Just a quote.').data === undefined);
} catch (err) {
  check('the run completed', false, err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}` : String(err));
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
