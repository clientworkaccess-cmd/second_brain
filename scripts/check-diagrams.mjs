#!/usr/bin/env node
/**
 * Diagrams: which code blocks are drawn, what of a diagram is drawn, and the
 * theme it is drawn in.
 *
 *   npm run check:diagrams
 *
 * lib/diagrams.ts, called directly. The drawing itself is mermaid's, in the
 * browser; check:live sees the chat give it a diagram and the reading view not.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLib, OUT_DIR } from './compile-lib.mjs';

await compileLib();
const { isDiagram, safeDiagram, darkTheme, DIAGRAM_MAX_CHARS } = await import(pathToFileURL(path.join(OUT_DIR, 'diagrams.js')).href);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const is = (name, got, want) => check(name, got === want, got === want ? '' : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ---------------------------------------------------------- which blocks
is('a mermaid block is a diagram', isDiagram('language-mermaid'), true);
is('also among other classes', isDiagram('hljs language-mermaid'), true);
is('other code is not', isDiagram('language-js'), false);
is('nor a language that only starts the same', isDiagram('language-mermaidx'), false);
is('nor code without a language', isDiagram(undefined), false);

// ---------------------------------------------------------- what is drawn
const flow = 'flowchart LR\n  A[Return arrives] --> B{Damaged?}\n  B -->|Yes| C[Write off]';
is('a plain diagram is drawn as it is', safeDiagram(flow), flow);
is('a click line is taken out', safeDiagram(`${flow}\n  click A "https://example.com"`), flow);
is('so is a click that calls something', safeDiagram(`${flow}\n    click B call alert()`), flow);
is('and an href line', safeDiagram(`${flow}\n  href A "javascript:alert(1)"`), flow);
is('a directive that changes the settings is taken out', safeDiagram(`%%{init: {"securityLevel": "loose"}}%%\n${flow}`), flow);
is('even one written over several lines', safeDiagram(`%%{init: {\n  "securityLevel": "loose"\n}}%%\n${flow}`), flow);
is('comments go too', safeDiagram(`${flow}\n  %% a note`), flow);
is('Windows line ends are read', safeDiagram(flow.replace(/\n/g, '\r\n')), flow);
is('nothing left is nothing to draw', safeDiagram('  click A "x"\n'), null);
is('an empty block is nothing to draw', safeDiagram(''), null);
is('one past the size is not drawn', safeDiagram(`flowchart LR\n${'  A --> B\n'.repeat(DIAGRAM_MAX_CHARS / 10)}`), null);

// ---------------------------------------------------------- theme
is('dark when the app is set to dark', darkTheme('dark', false), true);
is('light when the app is set to light, whatever the system', darkTheme('light', true), false);
is('the system decides when the app is not set', darkTheme(null, true), true);
is('and light by default', darkTheme(null, false), false);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
