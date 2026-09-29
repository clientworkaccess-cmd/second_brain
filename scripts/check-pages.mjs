#!/usr/bin/env node
/**
 * A page is data. Whatever is written at the top of one, reading it does
 * nothing but read it.
 *
 *   npm run check:pages
 *
 * Pages are written by an agent that reads documents nobody here wrote, so the
 * pages below are written the way a page would be if that went wrong, and then
 * listed and opened through the same functions the app uses.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-pages-'));
process.env.WIKI_ROOT = wikiRoot;

await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { splitPage } = await import(lib('frontmatter'));
const { listPages, readPage, titleIndex } = await import(lib('wiki'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// What a block would do if it were run: leave a file, and a mark in memory.
const MARK = path.join(wikiRoot, 'a-page-was-run');
const mark = JSON.stringify(MARK);
const RUNS = `{ title: (globalThis.__aPageWasRun = true, require('node:fs').writeFileSync(${mark}, 'x'), 'Ran') }`;
const ran = async () => globalThis.__aPageWasRun === true || (await fs.stat(MARK).then(() => true, () => false));

const cluster = 'pages';
const dir = path.join(wikiRoot, cluster);
await fs.mkdir(path.join(dir, 'entities'), { recursive: true });
await fs.writeFile(path.join(dir, 'index.md'), '# Wiki Index\n');

const NAMED = ['js', 'javascript', 'JS', 'JavaScript', ' js', 'coffee', 'coffeescript', 'cson'];
for (const [i, name] of NAMED.entries()) {
  await fs.writeFile(path.join(dir, 'entities', `named-${i}.md`), `---${name}\n${RUNS}\n---\n\n# Named ${i}\n\nText.\n`);
}
await fs.writeFile(path.join(dir, 'entities', 'json.md'), '---json\n{ "title": "From JSON" }\n---\n\n# Json\n');
await fs.writeFile(
  path.join(dir, 'entities', 'plain.md'),
  '---\ntitle: Plain\ncreated: 2026-01-02\ntags: [a, b]\n---\n\n# Plain Page\n\nText with [[Named 0]].\n',
);
await fs.writeFile(path.join(dir, 'entities', 'windows.md'), '---\r\ntitle: Windows\r\n---\r\n\r\n# Windows Page\r\n');
await fs.writeFile(path.join(dir, 'entities', 'broken.md'), '---\ntitle: [unclosed\n  - : :\n---\n\n# Broken Block\n');
await fs.writeFile(path.join(dir, 'entities', 'unclosed.md'), '---\ntitle: Never closed\n\n# Unclosed\n');
await fs.writeFile(path.join(dir, 'entities', 'huge.md'), `---\nnote: ${'x'.repeat(40 * 1024)}\n---\n\n# Huge Block\n`);
await fs.writeFile(path.join(dir, 'entities', 'none.md'), '# No Block\n\nText.\n');

try {
  // ------------------------------------------------ through the app's own functions
  const listed = await listPages(cluster);
  const expected = NAMED.length + 7;
  check('every page is listed, whatever is at its top', listed.entities.length === expected, `${listed.entities.length} of ${expected}`);
  await titleIndex(cluster);

  const opened = [];
  for (const ref of listed.entities) opened.push(await readPage(cluster, ref.slug));
  check('every page opens', opened.length === expected);
  check('nothing at the top of a page was run', !(await ran()));

  const named = opened.filter((page) => page.slug.startsWith('entities/named-'));
  check(
    'a block that names a format is shown, not read',
    named.length === NAMED.length && named.every((page) => page.body.includes('globalThis.__aPageWasRun')),
    named.filter((page) => !page.body.includes('globalThis.__aPageWasRun')).map((page) => page.slug).join(', '),
  );

  const plain = opened.find((page) => page.slug === 'entities/plain');
  check('a YAML block is read and left out of the text', plain?.title === 'Plain Page' && !plain.body.includes('created:'), plain?.body.slice(0, 40));

  // ------------------------------------------------------------ the block itself
  check('YAML is read', splitPage('---\ntitle: A\ntags: [x, y]\n---\nText').data.title === 'A');
  check('YAML is read with Windows line endings', splitPage('---\r\ntitle: W\r\n---\r\nText').data.title === 'W');
  check('an empty block is a block', splitPage('---\n---\nText').content.trim() === 'Text');
  check('a page without a block is left as it is', splitPage('# Title\n\n---\n\nText').content === '# Title\n\n---\n\nText');
  for (const name of [...NAMED, 'json', 'yaml', 'toml', 'anything']) {
    const raw = `---${name}\n${name.trim().toLowerCase() === 'json' ? '{"a":1}' : 'a: 1'}\n---\nText`;
    const split = splitPage(raw);
    check(`"---${name}" opens no block`, split.content === raw && Object.keys(split.data).length === 0);
  }
  check('a block that does not parse leaves the page whole', splitPage('---\ntitle: [unclosed\n---\nText').content.startsWith('---'));
  check('a block that never closes leaves the page whole', splitPage('---\ntitle: x\n\nText').content.startsWith('---'));
  check('a block past the size limit is not read', Object.keys(splitPage(`---\nnote: ${'x'.repeat(40 * 1024)}\n---\nText`).data).length === 0);
  check('a block that is a list, not keys, holds nothing', Object.keys(splitPage('---\n- a\n- b\n---\nText').data).length === 0);
  check('nothing was run by reading blocks directly either', !(await ran()));

  // --------------------------------------------------- one place calls the parser
  const callers = [];
  for (const file of await sources(path.join(root, 'src'))) {
    if (/from 'gray-matter'|require\('gray-matter'\)/.test(await fs.readFile(file, 'utf8'))) {
      callers.push(path.relative(root, file).replace(/\\/g, '/'));
    }
  }
  check('the parser is called from one file', callers.length === 1 && callers[0] === 'src/lib/frontmatter.ts', callers.join(', '));
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err));
} finally {
  await fs.rm(wikiRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function sources(folder) {
  const out = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const p = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(p)));
    else if (/\.(tsx?|mjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
