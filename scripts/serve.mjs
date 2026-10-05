#!/usr/bin/env node
/**
 * Runs the built app on this machine the way the server runs it.
 *
 *   npm run build && npm run serve            port 3100
 *   npm run serve -- 3200                     another port
 *
 * `next dev` compiles pages as they are asked for and reloads them as they
 * change, which makes it the wrong place to judge how the app behaves: how fast
 * a page arrives, what a redirect does, whether moving between pages works.
 * This starts `.next/standalone/server.js` with the settings from `.env.local`,
 * bound to this machine only.
 *
 * The file is read as plain `NAME=value` lines. Nothing in a value is expanded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, '.next', 'standalone', 'server.js');
const port = process.argv[2] ?? '3100';

if (!fs.existsSync(server)) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(2);
}
if (!/^\d{2,5}$/.test(port)) {
  console.error('Usage: npm run serve -- <port>');
  process.exit(2);
}

const env = { ...process.env };
const file = path.join(root, '.env.local');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith('#')) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} else {
  console.error('No .env.local found. Sign-in stays closed until AUTH_EMAIL, AUTH_PASSWORD_HASH and SESSION_SECRET are set.');
}

Object.assign(env, { PORT: port, HOSTNAME: '127.0.0.1', NODE_ENV: 'production' });

console.log(`Second Brain on http://localhost:${port}  (Ctrl+C stops it)`);
const child = spawn(process.execPath, [server], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
