#!/usr/bin/env node
/**
 * `output: 'standalone'` emits a self-contained server bundle but deliberately
 * leaves out the static assets, on the assumption a CDN will serve them. We
 * serve them from the same process, so they have to be copied in.
 *
 * Skip this and the app boots fine and answers requests — with every
 * stylesheet and client chunk returning 404. It looks like a CSS bug, not a
 * deploy bug, which is what makes it worth automating rather than documenting.
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

await copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));
console.log('[postbuild] copied .next/static into the standalone bundle');

if (await exists(path.join(root, 'public'))) {
  await copyDir(path.join(root, 'public'), path.join(standalone, 'public'));
  console.log('[postbuild] copied public/ into the standalone bundle');
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
