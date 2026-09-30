#!/usr/bin/env node
/**
 * A page renamed or deleted by a person: the file, the title, every link to
 * it, the index, and the restore point.
 *
 *   npm run check:rename
 *
 * lib/rename.ts, called directly on a throwaway wiki of each layout.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-rename-'));
process.env.WIKI_ROOT = wikiRoot;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { renamePage, deletePage, rewriteLinks, retitle } = await import(lib('rename'));
const { readPage, linkIndex, backlinksOf } = await import(lib('wiki'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const read = (...parts) => fs.readFile(path.join(wikiRoot, ...parts), 'utf8');
const there = (...parts) => fs.stat(path.join(wikiRoot, ...parts)).then(() => true, () => false);
const refused = (promise) => promise.then(() => null, (err) => err.status ?? 'thrown');

// ------------------------------------------------------------ the pieces
const forms = new Set(['entities/warehouse-team', 'warehouse-team', 'warehouse team']);
const means = (t) => /^(entities\/)?warehouse[- ]team(\.md)?(#|$)/i.test(t.trim());
const text = 'See [[Warehouse Team]], [[warehouse-team|the team]], [[Warehouse Team#Duties]], ![[warehouse team]], [[entities/warehouse-team.md]], [[WT]] and `[[Warehouse Team]]`.\n```\n[[Warehouse Team]]\n```\n';
const out = rewriteLinks(text, forms, 'Warehouse Crew', means);
check('every written form of the link is rewritten, and the alias, the heading and the embed stay', out === 'See [[Warehouse Crew]], [[Warehouse Crew|the team]], [[Warehouse Crew#Duties]], ![[Warehouse Crew]], [[Warehouse Crew]], [[WT]] and `[[Warehouse Team]]`.\n```\n[[Warehouse Team]]\n```\n', out);
check('nothing to rewrite is null', rewriteLinks('See [[Returns Portal]].', forms, 'x', means) === null);
check('a page not meant is left alone even when the name looks alike', rewriteLinks('[[Warehouse Team]]', forms, 'x', () => false) === null);
const retitled = retitle('---\ntitle: Warehouse Team\ntype: entity\n---\n\n# Warehouse Team\n\nText.\n', 'Warehouse Team', 'Warehouse Crew: 2026');
check('the title in the block and the heading follow', retitled === '---\ntitle: "Warehouse Crew: 2026"\ntype: entity\n---\n\n# Warehouse Crew: 2026\n\nText.\n', JSON.stringify(retitled));
check('a block without a title gets one; a page without a block keeps its heading', retitle('---\ntype: entity\n---\n# Old\n', 'Old', 'New') === '---\ntitle: New\ntype: entity\n---\n# New\n' && retitle('# Old\n\nText.\n', 'Old', 'New') === '# New\n\nText.\n');

// ------------------------------------------------------------ a cluster
const ops = path.join(wikiRoot, 'ops');
await fs.mkdir(path.join(ops, 'entities'), { recursive: true });
await fs.mkdir(path.join(ops, 'concepts'), { recursive: true });
await fs.writeFile(path.join(ops, 'SCHEMA.md'), '# Rules\n');
await fs.writeFile(path.join(ops, 'index.md'), '# Wiki Index\n\n## Entities\n- [[Warehouse Team]] — checks returns\n- [[Returns Portal]] — the portal\n\n## Concepts\n- [[Refund Policy]] — when refunds go out\n');
await fs.writeFile(path.join(ops, 'entities', 'warehouse-team.md'), '---\ntitle: Warehouse Team\ntype: entity\naliases: [WT]\n---\n\n# Warehouse Team\n\nWorks with the [[Returns Portal]]. See [[Warehouse Team#Duties]].\n\n## Duties\n');
await fs.writeFile(path.join(ops, 'entities', 'returns-portal.md'), '---\ntitle: Returns Portal\ntype: entity\n---\n\n# Returns Portal\n\nRun by the [[Warehouse Team]] ([[warehouse-team|the team]]); see [[Warehouse Team#Duties]] and [[WT]]. Code: `[[Warehouse Team]]`.\n');
await fs.writeFile(path.join(ops, 'concepts', 'refund-policy.md'), '---\ntitle: Refund Policy\ntype: concept\n---\n\n# Refund Policy\n\nApplied by ![[Warehouse Team]].\n');

try {
  const renamed = await renamePage('ops', 'entities/warehouse-team', 'Warehouse Crew');
  check('the page is renamed: new slug, new title', renamed.to === 'entities/warehouse-crew' && renamed.title === 'Warehouse Crew', JSON.stringify(renamed));
  check('the file moved', (await there('ops', 'entities', 'warehouse-crew.md')) && !(await there('ops', 'entities', 'warehouse-team.md')));
  const own = await read('ops', 'entities', 'warehouse-crew.md');
  check('its block, its heading and its own link to itself say the new title', own.includes('title: Warehouse Crew\n') && own.includes('# Warehouse Crew\n') && own.includes('[[Warehouse Crew#Duties]]') && own.includes('aliases: [WT]'), own.slice(0, 200));
  const portal = await read('ops', 'entities', 'returns-portal.md');
  check('links in other pages are rewritten by name, keeping alias and heading; the alias link and the code stay', portal.includes('[[Warehouse Crew]] ([[Warehouse Crew|the team]]); see [[Warehouse Crew#Duties]] and [[WT]]. Code: `[[Warehouse Team]]`.'), portal);
  check('an embed is rewritten too', (await read('ops', 'concepts', 'refund-policy.md')).includes('![[Warehouse Crew]]'));
  check('the index lists the new name', (await read('ops', 'index.md')).includes('- [[Warehouse Crew]] — checks returns'));
  check('the pages that changed are named', JSON.stringify([...renamed.rewritten].sort()) === JSON.stringify(['concepts/refund-policy', 'entities/returns-portal', 'index']), JSON.stringify(renamed.rewritten));
  check('a restore point was made', typeof renamed.commit === 'string' && renamed.commit.length >= 7, String(renamed.commit));
  const opened = await readPage('ops', 'entities/warehouse-crew');
  const names = await linkIndex('ops');
  const back = await backlinksOf('ops', 'entities/warehouse-crew');
  check('the wiki knows the page by its new name at once', opened.title === 'Warehouse Crew' && names.get('warehouse crew') === 'entities/warehouse-crew' && back.length === 2, JSON.stringify({ title: opened.title, byName: names.get('warehouse crew'), byOld: names.get('warehouse team'), back: back.map((b) => b.slug) }));

  check('renaming onto another page is refused', (await refused(renamePage('ops', 'entities/warehouse-crew', 'Returns Portal'))) === 409);
  check('the index and the log keep their names', (await refused(renamePage('ops', 'index', 'Catalogue'))) === 400);
  check('an empty title, or one that is only punctuation, is refused', (await refused(renamePage('ops', 'entities/warehouse-crew', '  '))) === 400 && (await refused(renamePage('ops', 'entities/warehouse-crew', '!!!'))) === 400);
  check('a page that is not there is 404', (await refused(renamePage('ops', 'entities/nobody', 'Someone'))) === 404);
  const same = await renamePage('ops', 'entities/warehouse-crew', 'Warehouse Crew');
  check('the same title again changes nothing', same.to === 'entities/warehouse-crew' && same.rewritten.length === 0 && same.commit === null);
  const retitledOnly = await renamePage('ops', 'entities/warehouse-crew', 'Warehouse crew');
  check('a change of case only keeps the file and changes the title', retitledOnly.to === 'entities/warehouse-crew' && (await read('ops', 'entities', 'warehouse-crew.md')).includes('title: Warehouse crew\n'), JSON.stringify(retitledOnly));

  const deleted = await deletePage('ops', 'entities/returns-portal');
  check('a page is deleted, and says how many linked to it', deleted.title === 'Returns Portal' && deleted.backlinks === 1 && !(await there('ops', 'entities', 'returns-portal.md')), JSON.stringify(deleted));
  check('its line is taken out of the index, the others stay', deleted.indexUpdated && !(await read('ops', 'index.md')).includes('Returns Portal') && (await read('ops', 'index.md')).includes('[[Refund Policy]]'));
  check('the link to it in another page is left, and now leads nowhere', (await read('ops', 'entities', 'warehouse-crew.md')).includes('[[Returns Portal]]') && (await linkIndex('ops')).get('returns portal') === undefined);
  check('a restore point was made for the delete too', typeof deleted.commit === 'string');
  check('the index and the log are not deleted', (await refused(deletePage('ops', 'index'))) === 400 && (await refused(deletePage('ops', 'log'))) === 400);
  check('deleting what is not there is 404', (await refused(deletePage('ops', 'entities/returns-portal'))) === 404);

  // ------------------------------------------------------------ a brain
  const brain = path.join(wikiRoot, 'brain');
  await fs.mkdir(path.join(brain, 'wiki', 'entities'), { recursive: true });
  await fs.mkdir(path.join(brain, 'wiki', 'concepts'), { recursive: true });
  await fs.writeFile(path.join(brain, 'CLAUDE.md'), '# Rules\n');
  await fs.writeFile(path.join(brain, 'wiki', 'index.md'), '# Index\n\n| Page | About |\n|---|---|\n| [[mark-chen]] | a person |\n| [[pricing]] | a concept |\n');
  await fs.writeFile(path.join(brain, 'wiki', 'entities', 'mark-chen.md'), '---\ntitle: Mark Chen\ntype: entity\nbusiness: [x]\narea: [finance]\n---\n\n# Mark Chen\n\nOwns [[pricing]].\n');
  await fs.writeFile(path.join(brain, 'wiki', 'concepts', 'pricing.md'), '---\ntitle: Pricing\ntype: concept\nbusiness: [x]\narea: [finance]\n---\n\n# Pricing\n\nSet by [[mark-chen]] ([[mark-chen|Mark]], [[Mark Chen]]).\n');
  const renamedInBrain = await renamePage('brain', 'entities/mark-chen', 'Mark Chen-Osei');
  check('in a brain the link is rewritten by file name', renamedInBrain.to === 'entities/mark-chen-osei' && (await read('brain', 'wiki', 'concepts', 'pricing.md')).includes('Set by [[mark-chen-osei]] ([[mark-chen-osei|Mark]], [[mark-chen-osei]]).'), await read('brain', 'wiki', 'concepts', 'pricing.md'));
  check('the index table row follows', (await read('brain', 'wiki', 'index.md')).includes('| [[mark-chen-osei]] | a person |'));
  const deletedInBrain = await deletePage('brain', 'concepts/pricing');
  check('a table row is taken out of a brain’s index on delete', deletedInBrain.indexUpdated && !(await read('brain', 'wiki', 'index.md')).includes('pricing') && (await read('brain', 'wiki', 'index.md')).includes('mark-chen-osei'));
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
