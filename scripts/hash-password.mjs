#!/usr/bin/env node
/**
 * Prints the three sign-in lines for the env file.
 *
 *   npm run hash-password -- you@example.com
 *
 * The password is read from the terminal without echo, or from stdin when
 * piped. It is never taken as an argument, because arguments end up in shell
 * history and in the process list.
 *
 * The format must stay in step with hashPassword() in src/lib/auth.ts.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import readline from 'node:readline';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run hash-password -- <email>');
  process.exit(1);
}

const password = await readPassword();
if (password.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });

console.log('');
console.log(`AUTH_EMAIL=${email}`);
// No quotes needed: colons and base64url mean the same thing to every env loader.
console.log(`AUTH_PASSWORD_HASH=${['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':')}`);
console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Keep the prompt, swallow the keystrokes.
  const write = rl._writeToOutput.bind(rl);
  let prompted = false;
  rl._writeToOutput = (text) => {
    if (!prompted) write(text);
    prompted = true;
  };
  const answer = await new Promise((resolve) => rl.question('Password: ', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
