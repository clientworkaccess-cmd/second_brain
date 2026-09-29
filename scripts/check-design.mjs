#!/usr/bin/env node
/**
 * The look: the things that go wrong without anything failing to build.
 *
 *   npm run check:design
 *
 * | what is checked                                  | what it looks like when it is wrong        |
 * |--------------------------------------------------|--------------------------------------------|
 * | theme.css has the values DESIGN.md says          | the two apps drift apart, one shade at a time |
 * | dark is complete, and the same in both places    | a colour stays light on a dark page        |
 * | no class of ours is also a Tailwind utility      | a stray border, or a block that turns inline |
 * | no class from Tailwind's own palette             | nothing at all: the class does not exist   |
 * | the pure helpers behind the outline and the links | a heading the outline cannot reach         |
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFile(path.join(root, ...parts), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- the tokens
const theme = await read('src', 'app', 'theme.css');

/** The declarations of the first rule whose selector is `selector`. */
function declarations(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = declarations(theme, ':root');
const darkChosen = declarations(theme, ":root[data-theme='dark']");
const darkSystem = declarations(theme, ":root:not([data-theme='light'])");
check('theme.css has a light set and both dark sets', Boolean(light && darkChosen && darkSystem));

if (light && darkChosen && darkSystem) {
  // What changes with the theme: the colour channels and the few see-through ones.
  const themed = [...light.keys()].filter((name) => name.startsWith('--c-') || /^rgba\(/.test(light.get(name)) || name === '--graph-lightness');
  const missing = themed.filter((name) => !darkChosen.has(name));
  check('every colour has a dark value', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${themed.length} tokens`);

  const differ = [...new Set([...darkChosen.keys(), ...darkSystem.keys()])].filter((name) => darkChosen.get(name) !== darkSystem.get(name));
  check('dark by choice and dark by system are the same', differ.length === 0, differ.join(', '));

  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
  const rows = [...(await read('DESIGN.md')).matchAll(/^\|\s*((?:`--[\w-]+`(?:,\s*)?)+)\s*\|\s*((?:`#[0-9a-f]{6}`(?:,\s*)?)+)\s*\|\s*((?:`#[0-9a-f]{6}`(?:,\s*)?)+)\s*\|/gim)];
  const drift = [];
  let compared = 0;
  for (const [, names, lights, darks] of rows) {
    const list = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    list(names).forEach((name, i) => {
      const token = `--c-${name.slice(2)}`;
      compared++;
      if (light.get(token) !== channels(list(lights)[i])) drift.push(`${name} light`);
      if (darkChosen.get(token) !== channels(list(darks)[i])) drift.push(`${name} dark`);
    });
  }
  check('theme.css has the values DESIGN.md gives', compared >= 10 && drift.length === 0, drift.length ? drift.join(', ') : `${compared} tokens`);
}

// ------------------------------------------------------------ class names
const css = await read('src', 'app', 'globals.css');
const ours = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

// Tailwind's utilities that are one plain word. A class of ours with one of
// these names gets Tailwind's rule as well as ours, as soon as the word appears
// anywhere in the source.
const UTILITIES = [
  'container', 'static', 'fixed', 'absolute', 'relative', 'sticky', 'visible', 'invisible', 'collapse', 'isolate',
  'block', 'inline', 'flex', 'table', 'grid', 'contents', 'hidden', 'flow-root', 'inline-block', 'inline-flex',
  'inline-table', 'inline-grid', 'list-item', 'table-caption', 'table-cell', 'table-column', 'table-row',
  'transform', 'resize', 'truncate', 'italic', 'not-italic', 'underline', 'overline', 'line-through', 'no-underline',
  'uppercase', 'lowercase', 'capitalize', 'normal-case', 'antialiased', 'subpixel-antialiased', 'ordinal',
  'border', 'rounded', 'shadow', 'outline', 'ring', 'blur', 'grayscale', 'invert', 'sepia', 'filter',
  'backdrop-filter', 'transition', 'sr-only', 'not-sr-only', 'grow', 'shrink',
];
const clashes = UTILITIES.filter((name) => ours.has(name));
check('no class in globals.css is also a Tailwind utility', clashes.length === 0, clashes.length ? clashes.join(', ') : `${ours.size} classes`);

// Tailwind's own palette is switched off (tailwind.config.ts), so these
// classes produce nothing, and say nothing about it.
const PALETTE = /\b(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const strays = [];
for (const file of await sources(path.join(root, 'src'))) {
  for (const match of (await fs.readFile(file, 'utf8')).matchAll(PALETTE)) {
    strays.push(`${path.relative(root, file).replace(/\\/g, '/')}: ${match[0]}`);
  }
}
check('no class from Tailwind’s own palette', strays.length === 0, strays.slice(0, 5).join(', '));

async function sources(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(p)));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------ the helpers
await compileLib();
const lib = (name) => pathToFileURL(path.join(OUT_DIR, `${name}.js`)).href;
const { outlineOf, wordCount } = await import(lib('outline'));
const { extractWikilinks, linkifyWikilinks } = await import(lib('wikilinks'));

const FENCE = '```';
const outline = outlineOf(
  [
    '# The **Warehouse** [[Team]]',
    '## Notes',
    `${FENCE}sh`,
    '# a comment, not a heading',
    FENCE,
    '## Notes',
    '### Übersicht & Zahlen',
    '#not a heading',
    '## [[Refund Policy|Refunds]] ##',
  ].join('\n'),
);
check('a heading is read without its markup', outline[0]?.text === 'The Warehouse Team' && outline[0]?.id === 'the-warehouse-team' && outline[0]?.depth === 1, JSON.stringify(outline[0]));
check('two headings with the same words get two ids', outline[1]?.id === 'notes' && outline[2]?.id === 'notes-2', outline.map((h) => h.id).join(', '));
check('a # inside a code block is not a heading', outline.length === 5 && !outline.some((h) => h.text.includes('comment')), `${outline.length} headings`);
check('a heading in another alphabet keeps its letters', outline[3]?.id === 'übersicht-zahlen', outline[3]?.id);
check('a link in a heading is read as its label', outline[4]?.text === 'Refunds' && outline[4]?.id === 'refunds', JSON.stringify(outline[4]));
check('words are counted', wordCount('  one two\nthree  ') === 3 && wordCount('') === 0);

const links = extractWikilinks('[[Warehouse Team]] and [[warehouse team]] and [[Refund Policy|the policy]]');
check('a page linked twice is one link', links.length === 2 && links[0] === 'Warehouse Team' && links[1] === 'Refund Policy', links.join(', '));

const known = new Map([['warehouse team', 'entities/warehouse-team']]);
const linked = linkifyWikilinks('See [[Warehouse Team|the team]] and [[Nobody Wrote This]].', 'operations', known);
check('a link to a page that exists leads to it', linked.includes('[the team](/c/operations/entities/warehouse-team)'), linked);
check('a link to a page that does not exist says so', linked.includes('[Nobody Wrote This](/c/operations?missing=Nobody%20Wrote%20This)'), linked);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
