#!/usr/bin/env node
/**
 * A second factor for the sign-in: prints the env line and what to give an
 * authenticator app.
 *
 *   npm run totp-secret [-- you@example.com]
 *
 * Put the AUTH_TOTP_SECRET line in the env file, restart the app, and from
 * then on the sign-in asks for the six-digit code the app shows. In the
 * authenticator, add an account by entering the setup key by hand, or from
 * the otpauth address as a QR code made with any QR tool.
 *
 * The secret is the second thing that lets someone in. Give it to the team
 * the way the password is given: through a password manager, never in chat.
 */
import { createHmac, randomBytes } from 'node:crypto';

// The account name the authenticator shows; the email is only a label here.
const account = (process.argv[2] ?? '').trim() || 'shared login';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bytes = randomBytes(20);
let bits = 0;
let value = 0;
let secret = '';
for (const byte of bytes) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    secret += ALPHABET[(value >>> (bits - 5)) & 31];
    bits -= 5;
  }
}
if (bits > 0) secret += ALPHABET[(value << (5 - bits)) & 31];

// The code right now, so that the authenticator can be compared with it once set up.
const counter = Math.floor(Date.now() / 30000);
const message = Buffer.alloc(8);
message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
message.writeUInt32BE(counter >>> 0, 4);
const digest = createHmac('sha1', bytes).update(message).digest();
const offset = digest[digest.length - 1] & 0x0f;
const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
const code = String(binary % 1_000_000).padStart(6, '0');

const label = encodeURIComponent(`Second Brain:${account}`);
console.log(`AUTH_TOTP_SECRET=${secret}`);
console.log('');
console.log(`Setup key for the authenticator app: ${secret.match(/.{1,4}/g).join(' ')}`);
console.log(`otpauth://totp/${label}?secret=${secret}&issuer=Second%20Brain&algorithm=SHA1&digits=6&period=30`);
console.log('');
console.log(`The code the app should show right now: ${code}`);
