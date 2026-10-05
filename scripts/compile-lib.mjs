#!/usr/bin/env node
/**
 * Compile src/lib to plain ESM in .libcheck/, so the check scripts can drive
 * the real pipeline from Node.
 *
 * Needed because the app's TS imports are extensionless — Next resolves those,
 * Node does not — so this emits JS and then rewrites `from './x'` to
 * `from './x.js'`. A `{"type":"module"}` package.json goes in alongside, since
 * the repo root is CommonJS.
 *
 * This used to be a paragraph of shell in a pull request description, which the
 * script that needed it referred to as "see the PR description". That reference
 * died the moment the PR merged. Hence a file.
 *
 *   node scripts/compile-lib.mjs      (or: npm run check:pipeline)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(root, '.libcheck');

const MODULES = [
  'env-auth', 'session', 'gate', 'auth', 'config', 'files', 'layout', 'facets', 'callouts', 'clusters', 'frontmatter', 'wiki', 'graph', 'lint', 'plans', 'sandbox', 'git', 'claude-stream', 'claude', 'chat', 'settings', 'jobs', 'wikilinks', 'outline', 'search', 'totp', 'audit', 'sessions', 'assetPaths', 'assets', 'rename', 'localGraph',
];

export async function compileLib() {
  // Emptied, not removed. On the server the folder is made once for the service
  // user, who cannot create one beside a checkout that belongs to root.
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const entry of await fs.readdir(OUT_DIR)) {
    await fs.rm(path.join(OUT_DIR, entry), { recursive: true, force: true });
  }

  // The typescript package's own entry point, run through node. `npx tsc`
  // would need a shell on Windows, where npx is a .cmd — execFileSync refuses
  // those with EINVAL.
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

  execFileSync(
    process.execPath,
    [
      tsc,
      '--outDir', OUT_DIR,
      '--module', 'es2022',
      '--moduleResolution', 'bundler',
      '--target', 'es2022',
      '--skipLibCheck',
      '--noEmit', 'false',
      ...MODULES.map((m) => path.join(root, 'src', 'lib', `${m}.ts`)),
    ],
    { cwd: root, stdio: 'inherit' },
  );

  for (const file of await fs.readdir(OUT_DIR)) {
    if (!file.endsWith('.js')) continue;
    const p = path.join(OUT_DIR, file);
    const src = await fs.readFile(p, 'utf8');
    await fs.writeFile(p, src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"), 'utf8');
  }

  await fs.writeFile(path.join(OUT_DIR, 'package.json'), '{"type":"module"}\n', 'utf8');
  return OUT_DIR;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  await compileLib();
  console.log(`Compiled to ${OUT_DIR}`);
}
