#!/usr/bin/env node
/**
 * The graph of a wiki, and the neighbourhood of one page cut out of it.
 *
 *   npm run check:graph
 *
 * lib/graph.ts and lib/localGraph.ts, called directly on a throwaway wiki.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-graph-'));
process.env.WIKI_ROOT = wikiRoot;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { buildGraph } = await import(lib('graph'));
const { localGraph } = await import(lib('localGraph'));
const { hideFrom, parsePatterns, NOTHING_HIDDEN } = await import(lib('graphFilter'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// A chain with a branch: index -> a -> b -> c -> d, b -> gone (not written), e alone.
const ops = path.join(wikiRoot, 'ops');
await fs.mkdir(path.join(ops, 'entities'), { recursive: true });
await fs.mkdir(path.join(ops, 'concepts'), { recursive: true });
await fs.writeFile(path.join(ops, 'SCHEMA.md'), '# Rules\n');
await fs.writeFile(path.join(ops, 'index.md'), '# Wiki Index\n\n- [[A]]\n- [[B]]\n- [[C]]\n- [[D]]\n- [[E]]\n');
const page = (title, body) => `---\ntitle: ${title}\ntype: entity\n---\n\n# ${title}\n\n${body}\n`;
await fs.writeFile(path.join(ops, 'entities', 'a.md'), page('A', 'Leads to [[B]].'));
await fs.writeFile(path.join(ops, 'entities', 'b.md'), page('B', 'Leads to [[C]] and [[Gone]].'));
await fs.writeFile(path.join(ops, 'concepts', 'c.md'), page('C', 'Leads to [[D]].'));
await fs.writeFile(path.join(ops, 'concepts', 'd.md'), page('D', 'The end.'));
await fs.writeFile(path.join(ops, 'entities', 'e.md'), page('E', 'Alone.'));
await fs.mkdir(path.join(ops, 'sources'), { recursive: true });
await fs.writeFile(path.join(ops, 'sources', 'memo.md'), page('Memo', 'About [[A]] and [[Lost]].'));
await fs.writeFile(path.join(ops, 'overview.md'), page('Overview', 'Starts at [[A]].'));

try {
  const graph = await buildGraph('ops');
  const ids = (g) => g.nodes.map((n) => n.id).sort();
  check('the whole graph has every page, the missing ones, and no catalogue', JSON.stringify(ids(graph)) === JSON.stringify(['concepts/c', 'concepts/d', 'entities/a', 'entities/b', 'entities/e', 'missing:gone', 'missing:lost', 'overview', 'sources/memo'].sort()), JSON.stringify(ids(graph)));
  const missing = graph.nodes.find((n) => n.kind === 'missing');
  check('a page that is linked but not written is a node of its own kind', missing !== undefined && missing.href === null, JSON.stringify(missing));
  check('a page nothing links to is an orphan', graph.orphans.includes('entities/e') && !graph.orphans.includes('entities/b'), JSON.stringify(graph.orphans));

  const one = localGraph(graph, 'entities/b', 1);
  check('one link away: the pages b links to or from', JSON.stringify(ids(one)) === JSON.stringify(['concepts/c', 'entities/a', 'entities/b', missing.id].sort()), JSON.stringify(ids(one)));
  check('and only the links among them', one.links.length === 3 && one.links.every((l) => ids(one).includes(l.source) && ids(one).includes(l.target)), JSON.stringify(one.links));
  const two = localGraph(graph, 'entities/b', 2);
  check('two links away reaches d, not e', ids(two).includes('concepts/d') && !ids(two).includes('entities/e'), JSON.stringify(ids(two)));
  check('the page itself, at zero', JSON.stringify(ids(localGraph(graph, 'entities/b', 0))) === JSON.stringify(['entities/b']));
  const lonely = localGraph(graph, 'entities/e', 2);
  check('a page with no links is alone, and an orphan there too', ids(lonely).length === 1 && lonely.orphans.includes('entities/e'));
  check('a page not in the graph gives nothing', localGraph(graph, 'entities/nobody', 2).nodes.length === 0);
  check('the kinds are only those present, the facets are kept', two.kinds.every((k) => two.nodes.some((n) => n.kind === k.kind)) && two.facets === graph.facets);
  check('the whole graph is not changed by cutting', graph.nodes.length === 9 && graph.links.length === 7, `${graph.nodes.length} nodes, ${graph.links.length} links`);

  // ------------------------------------------------- hiding from the drawing
  check('nothing hidden is the same graph', hideFrom(graph, NOTHING_HIDDEN) === graph);
  const noSources = hideFrom(graph, { folders: ['sources'], pages: [], patterns: [] });
  check('a hidden folder takes its pages, their links, and the missing page only they linked to', !ids(noSources).includes('sources/memo') && !ids(noSources).includes('missing:lost') && ids(noSources).includes('missing:gone') && noSources.links.length === 5, JSON.stringify(ids(noSources)));
  check('the kinds and the degrees follow', !noSources.kinds.some((k) => k.kind === 'sources') && noSources.nodes.find((n) => n.id === 'entities/a').degree === 2 && graph.nodes.find((n) => n.id === 'entities/a').degree === 3);
  const noOverview = hideFrom(graph, { folders: [], pages: ['overview'], patterns: [] });
  check('a hidden page beside the index goes, and the folder it was beside with it', !ids(noOverview).includes('overview') && !noOverview.kinds.some((k) => k.kind === 'root'), JSON.stringify(noOverview.kinds));
  check('patterns: a folder with a slash, a title, a star', JSON.stringify(ids(hideFrom(graph, { folders: [], pages: [], patterns: ['sources/'] }))) === JSON.stringify(ids(noSources)) && !ids(hideFrom(graph, { folders: [], pages: [], patterns: ['OVERVIEW'] })).includes('overview') && JSON.stringify(ids(hideFrom(graph, { folders: [], pages: [], patterns: ['concepts/*'] })).filter((id) => id.startsWith('concepts/'))) === '[]');
  check('a pattern can name a page nobody has written', !ids(hideFrom(graph, { folders: [], pages: [], patterns: ['gone'] })).includes('missing:gone'));
  check('an orphan made by hiding is counted as one', hideFrom(graph, { folders: ['entities'], pages: [], patterns: [] }).orphans.includes('overview'));
  check('the patterns as typed', JSON.stringify(parsePatterns(' sources/, overview\n\n *meeting* ,')) === JSON.stringify(['sources/', 'overview', '*meeting*']));
  check('hiding does not change the whole graph', graph.nodes.length === 9 && graph.links.length === 7);
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
