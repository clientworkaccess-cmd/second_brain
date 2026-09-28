#!/usr/bin/env node
/**
 * Two things the build does not do for itself.
 *
 * 1. `output: 'standalone'` emits a self-contained server bundle but
 *    deliberately leaves out the static assets, on the assumption a CDN will
 *    serve them. We serve them from the same process, so they have to be copied
 *    in. Skip this and the app boots fine and answers requests — with every
 *    stylesheet and client chunk returning 404. It looks like a CSS bug, not a
 *    deploy bug, which is what makes it worth automating rather than
 *    documenting.
 *
 * 2. The build decides which files to ship by reading the code for paths. Code
 *    that builds a path from the home directory is read as "this app needs the
 *    files there", and the builder's own files are copied in beside the app. It
 *    happened here with ~/.claude, which is where a login is kept. So the list
 *    of what is shipped is checked, and a build that reaches outside the
 *    checkout fails.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(root, '.next', 'standalone');

if (!(await exists(standalone))) {
  console.error('[postbuild] No .next/standalone — is output:"standalone" still set in next.config.mjs?');
  process.exit(1);
}

const strays = await tracedOutside(path.join(root, '.next', 'server'));
if (strays.size > 0) {
  console.error('[postbuild] The build wants to ship files from outside the checkout:');
  for (const [file, by] of [...strays].slice(0, 20)) console.error(`  ${file}\n      traced from ${by}`);
  if (strays.size > 20) console.error(`  … and ${strays.size - 20} more`);
  console.error('[postbuild] Look for a path built from os.homedir(), os.tmpdir() or an absolute path in src/.');
  console.error('[postbuild] Do not deploy this build. Remove .next and anything the build copied beside the app.');
  process.exit(1);
}
console.log('[postbuild] nothing outside the checkout is shipped');

await copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));
console.log('[postbuild] copied .next/static into the standalone bundle');

if (await exists(path.join(root, 'public'))) {
  await copyDir(path.join(root, 'public'), path.join(standalone, 'public'));
  console.log('[postbuild] copied public/ into the standalone bundle');
}

/** Every traced file that is not under the checkout, with the trace that named it. */
async function tracedOutside(dir) {
  const found = new Map();
  const inside = (file) => {
    const rel = path.relative(root, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const walk = async (at) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.nft.json')) {
        const trace = JSON.parse(await fs.readFile(full, 'utf8'));
        for (const file of trace.files ?? []) {
          const resolved = path.resolve(at, file);
          if (!inside(resolved) && !found.has(resolved)) found.set(resolved, path.relative(root, full));
        }
      }
    }
  };
  await walk(dir);
  return found;
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else await fs.copyFile(src, dest);
  }
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
