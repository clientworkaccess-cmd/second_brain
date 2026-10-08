#!/usr/bin/env node
/**
 * The built app, started the way the server starts it, and used over HTTP.
 *
 *   npm run build && npm run check:live
 *
 * The other checks call the library directly. This one goes through everything
 * they skip: the middleware, the routes, the event streams, and the production
 * server's habit of changing its working directory before our code runs.
 *
 * It starts `.next/standalone/server.js` on a free port with a throwaway wiki,
 * the stand-in agent, and a login made up for the run. Nothing is read from any
 * env file and nothing is left behind.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const server = path.join(appDir, '.next', 'standalone', 'server.js');

if (!(await fs.stat(server).then(() => true, () => false))) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(2);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const EMAIL = 'someone@example.com';
const PASSWORD = randomBytes(18).toString('base64url');
const salt = randomBytes(16);
const HASH = ['scrypt', 16384, 8, 1, salt.toString('base64url'), scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')].join(':');

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const running = [];

/**
 * One server, one throwaway wiki. `agentArgs` is how the stand-in is told to
 * misbehave. `relative` gives the wiki's place the way the example env file
 * does, as a path from the checkout.
 */
async function start(agentArgs = 'scripts/fake-claude.mjs', { relative = false, extraEnv = {} } = {}) {
  const port = await freePort();
  const wiki = relative
    ? await fs.mkdtemp(path.join(appDir, '.wiki-live-'))
    : await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AUTH_|SESSION_|CLAUDE_|ANTHROPIC_|WIKI_|APP_DIR$)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    WIKI_ROOT: relative ? `./${path.basename(wiki)}` : wiki,
    CLAUDE_CMD: 'node',
    CLAUDE_ARGS: agentArgs,
    AUTH_EMAIL: EMAIL,
    AUTH_PASSWORD_HASH: HASH,
    SESSION_SECRET: randomBytes(48).toString('base64url'),
    AUTH_CODE_EMAIL: EMAIL,
    CODE_CAPTURE_DIR: path.join(wiki, '.codes'),
    ...extraEnv,
  });
  // Started from the checkout, as the service unit does. APP_DIR is left unset
  // on purpose: the app has to find the checkout by itself.
  const child = spawn(process.execPath, [server], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const instance = { base: `http://127.0.0.1:${port}`, wiki, child, log: () => log };
  running.push(instance);

  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${instance.base}/login`).then((r) => r.status === 200, () => false);
    if (up) return instance;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The server did not come up.\n${log.slice(-1500)}`);
}

async function stopAll() {
  for (const { child, wiki } of running) {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    await fs.rm(wiki, { recursive: true, force: true }).catch(() => {});
  }
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const withCookie = (init, cookie) => ({ ...init, headers: { ...(init.headers ?? {}), cookie } });

/** The captcha, solved the way the widget does it. */
async function solvedCaptcha(base) {
  const challenge = await (await fetch(`${base}/api/auth/captcha`)).json();
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

/** The newest code written to a server's capture folder. */
async function latestCode(instance, kind = 'mail') {
  const dir = path.join(instance.wiki, '.codes');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.startsWith(kind)).sort();
  if (files.length === 0) return null;
  const message = JSON.parse(await fs.readFile(path.join(dir, files[files.length - 1]), 'utf8'));
  return { code: message.text.match(/\b(\d{6})\b/)?.[1] ?? null, to: message.to };
}

/**
 * The whole sign-in: captcha, password, a code by email (read back from the
 * capture folder), the session. `password` wrong stops at the password and
 * returns that response; `options.captcha` false skips the puzzle.
 */
async function signIn(base, password = PASSWORD, headers = {}, options = {}) {
  const instance = running.find((r) => r.base === base);
  const body = { email: EMAIL, password };
  if (options.captcha !== false) body.captcha = options.captcha ?? (await solvedCaptcha(base));
  const first = await fetch(`${base}/api/auth/login`, { ...json(body), headers: { 'content-type': 'application/json', ...headers } });
  const firstSet = first.headers.get('set-cookie') ?? '';
  if (!first.ok || firstSet) return { res: first, set: firstSet, cookie: firstSet.split(';')[0], first };
  const opened = await first.json();
  if (!opened.ticket) return { res: first, set: '', cookie: '', first, opened };
  const method = options.method ?? 'email';
  let code = options.code;
  if (method !== 'totp') {
    const sentRes = await fetch(`${base}/api/auth/code`, { ...json({ ticket: opened.ticket, method }), headers: { 'content-type': 'application/json', ...headers } });
    if (!sentRes.ok) return { res: sentRes, set: '', cookie: '', first, opened };
    code ??= (await latestCode(instance, method === 'sms' ? 'sms' : 'mail'))?.code;
  }
  const res = await fetch(`${base}/api/auth/verify`, { ...json({ ticket: opened.ticket, method, code }), headers: { 'content-type': 'application/json', ...headers } });
  const set = res.headers.get('set-cookie') ?? '';
  return { res, set, cookie: set.split(';')[0], first, opened, code };
}

/** Read an event stream until it closes. Returns every event in order. */
async function events(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) return { status: res.status, type: res.headers.get('content-type') ?? '', list: [] };
  const list = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const name = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (name) list.push({ name, data: data ? JSON.parse(data) : null });
    }
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', list };
}

const lastJob = (stream) => stream.list.filter((e) => e.name === 'job').pop()?.data ?? null;

/** The six-digit code of the moment, worked out here so the check does not trust the app's own arithmetic. */
function totpNow(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const c of secret.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(now / 30000), 4);
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[19] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** The middleware learns of a revocation within a few seconds. Returns the status the cookie settles on. */
async function settles(base, cookie, want, ms = 8000) {
  const until = Date.now() + ms;
  let status = 0;
  while (Date.now() < until) {
    status = (await fetch(`${base}/api/clusters`, { headers: { cookie } })).status;
    if (status === want) return status;
    await new Promise((r) => setTimeout(r, 400));
  }
  return status;
}

async function upload(base, cookie, cluster, filename, text) {
  const form = new FormData();
  form.set('cluster', cluster);
  form.set('filename', filename);
  form.set('parsedText', text);
  return fetch(`${base}/api/upload`, { method: 'POST', body: form, headers: { cookie } });
}

const NOTE = 'The warehouse team checks every returned item before we release the refund.';

try {
  // ------------------------------------------------------------ the gate
  const app = await start('scripts/fake-claude.mjs', { relative: true });
  const { base } = app;
  const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
  /** With a Host header of our choosing, which fetch does not allow. */
  const asProxy = (p, headers) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(base);
      const req = http.request({ host: hostname, port, path: p, method: 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? '' }));
      });
      req.on('error', reject);
      req.end();
    });

  for (const p of ['/api/clusters', '/api/clusters.json', '/api/jobs/x.json', '/api/chat']) {
    const res = await get(p);
    check(`${p} without a session is 401`, res.status === 401, String(res.status));
  }
  for (const p of ['/', '/new', '/c/ops', '/c/a.b', '/new.html', '/.env']) {
    const res = await get(p);
    const to = res.headers.get('location') ?? '';
    // Next writes every loopback address as `localhost`, so that is what comes
    // back for a request made to 127.0.0.1. Same machine, same port.
    const expected = `${base.replace('127.0.0.1', 'localhost')}${p === '/' ? '/login' : `/login?from=${encodeURIComponent(p)}`}`;
    check(`${p} without a session goes to the login`, res.status === 307 && to === expected, `${res.status} ${to}`);
  }
  // Behind the proxy the server believes it is `localhost`. A redirect that
  // says so sends the browser there.
  const proxied = await asProxy('/c/ops', { host: 'brain.example.com', 'x-forwarded-host': 'brain.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' });
  check('behind the proxy, the redirect goes to the public address', proxied.location === 'https://brain.example.com/login?from=%2Fc%2Fops', `${proxied.status} ${proxied.location}`);
  const posted = await fetch(`${base}/api/clusters`, json({ name: 'intruder', scope: 'x' }));
  check('nothing can be created without a session', posted.status === 401 && !(await fs.readdir(app.wiki)).includes('intruder'), String(posted.status));
  const forged = await get('/api/clusters', { cookie: 'brain_session=authenticated' });
  check('a made-up cookie is refused', forged.status === 401, String(forged.status));
  const unsigned = await get('/api/clusters', { cookie: `brain_session=abc.${Math.floor(Date.now() / 1000) + 3600}.abc` });
  check('a cookie with a made-up signature is refused', unsigned.status === 401, String(unsigned.status));

  // The image optimizer fetches and decodes what it is pointed at. The app has
  // no use for it, so it is behind the login and switched off as well.
  const IMAGE = '/_next/image?url=%2Ffavicon.ico&w=64&q=75';
  const imageOutside = await get(IMAGE);
  check('the image optimizer is not open to the outside', imageOutside.status === 307 && (imageOutside.headers.get('location') ?? '').includes('/login'), `${imageOutside.status} ${imageOutside.headers.get('location') ?? ''}`);
  const assets = await get('/_next/static/nothing-by-this-name.js');
  check('build output needs no session', assets.status === 404, String(assets.status));
  const login = await get('/login');
  check('the server does not announce what it is built with', login.headers.get('x-powered-by') === null, String(login.headers.get('x-powered-by')));
  const loginHtml = await login.text();
  check('the app calls itself Second Brain', loginHtml.includes('<title>Second Brain</title>') && !/knowledge\s*graph/i.test(loginHtml));
  const mark = await get('/icon.png');
  check('the app’s mark needs no session', mark.status === 200 && (mark.headers.get('content-type') ?? '').startsWith('image/png'), `${mark.status} ${mark.headers.get('content-type') ?? ''}`);

  // ------------------------------------------------------------- sign-in
  const wrong = await signIn(base, `${PASSWORD}x`, { 'x-forwarded-for': '198.51.100.1' });
  check('a wrong password is refused', wrong.res.status === 401 && !wrong.set, String(wrong.res.status));
  const noCaptcha = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.1' }, { captcha: false });
  check('without the captcha the password is not even looked at', noCaptcha.res.status === 400 && !noCaptcha.set, String(noCaptcha.res.status));
  const reused = await solvedCaptcha(base);
  const onceA = await signIn(base, `${PASSWORD}x`, { 'x-forwarded-for': '198.51.100.1' }, { captcha: reused });
  const onceB = await signIn(base, `${PASSWORD}x`, { 'x-forwarded-for': '198.51.100.1' }, { captcha: reused });
  check('a solved captcha is good once', onceA.res.status === 401 && onceB.res.status === 400, `${onceA.res.status} then ${onceB.res.status}`);
  const stopped = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.1' }, { code: '000000' });
  check('a wrong emailed code is refused, with no cookie', stopped.res.status === 401 && !stopped.set && stopped.opened?.methods?.[0]?.kind === 'email' && stopped.opened.methods[0].to === 'so*****@example.com', `${stopped.res.status} ${JSON.stringify(stopped.opened?.methods)}`);
  const emailed = await latestCode(app, 'mail');
  check('the code went to the address, with a plain message', emailed?.to === EMAIL && /^\d{6}$/.test(emailed?.code ?? '') && !(await (async () => (await fs.readdir(path.join(app.wiki, '.codes'))).some((f) => f.startsWith('sms')))()), JSON.stringify(emailed));

  const session = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.1' });
  check('the right password signs in', session.res.status === 200 && session.cookie.startsWith('brain_session='), String(session.res.status));
  check('the cookie is closed to scripts and to other sites', /httponly/i.test(session.set) && /samesite=lax/i.test(session.set) && /path=\//i.test(session.set), session.set.replace(/brain_session=[^;]+/, 'brain_session=…'));
  check('over plain HTTP the cookie is not marked Secure', !/;\s*secure/i.test(session.set));
  const viaProxy = await signIn(base, PASSWORD, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.1' });
  check('behind the proxy the cookie is marked Secure', /;\s*secure/i.test(viaProxy.set));

  const { cookie } = session;
  const listed = await get('/api/clusters', { cookie });
  check('a session opens the API', listed.status === 200, String(listed.status));
  const home = await get('/', { cookie });
  check('a session opens the pages', home.status === 200, String(home.status));
  const loginAgain = await get('/login', { cookie });
  check('a signed-in visitor is sent away from the login page', [302, 307, 308].includes(loginAgain.status), String(loginAgain.status));
  const imageInside = await get(IMAGE, { cookie });
  check('the image optimizer is switched off, session or not', imageInside.status === 404, String(imageInside.status));

  // ------------------------------------------------------------ sessions
  check('a session says which epoch it is from', cookie.split('.').length === 4 && cookie.split('.')[2] === '1', cookie.replace(/=[^.]+/, '=…'));
  const openSessions = (await (await get('/api/auth/sessions', { cookie })).json()).sessions ?? [];
  check('the signed-in browsers are listed, this one marked', openSessions.length >= 2 && openSessions.filter((s) => s.current).length === 1 && openSessions.every((s) => typeof s.key === 'string' && s.id.length === 8 && s.client), `${openSessions.length} sessions`);
  const state = await (await get('/api/auth/state')).json();
  check('the epoch and the revoked ids need no session, and say nothing else', state.epoch === 1 && Array.isArray(state.revoked) && !('sessions' in state), JSON.stringify(state));
  const otherSession = openSessions.find((s) => !s.current);
  const ended = await fetch(`${base}/api/auth/sessions`, withCookie({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: otherSession.key }) }, cookie));
  check('another browser’s session can be ended', ended.status === 200 && !/brain_session=;/.test(ended.headers.get('set-cookie') ?? ''), String(ended.status));
  check('the ended session is refused within seconds, cookie or no cookie', (await settles(base, viaProxy.cookie, 401)) === 401);
  check('this one still works', (await get('/api/clusters', { cookie })).status === 200);
  const securityPage = await get('/security', { cookie });
  const securityHtml = await securityPage.text();
  check('the Security page shows the browsers and the trail', securityPage.status === 200 && securityHtml.includes('Signed-in browsers') && securityHtml.includes('this browser') && securityHtml.includes('Signed in') && securityHtml.includes('Session ended'), String(securityPage.status));

  // ------------------------------------------------- one document, end to end
  const created = await fetch(`${base}/api/clusters`, withCookie(json({ name: 'operations', scope: 'Returns and refunds' }), cookie));
  check('a cluster is created', created.status === 201, String(created.status));

  const sent = await upload(base, cookie, 'operations', 'note.md', NOTE);
  const { jobId } = await sent.json();
  check('an upload is accepted and returns at once', sent.status === 202 && typeof jobId === 'string', String(sent.status));

  const planning = await events(`${base}/api/jobs/${jobId}`, { headers: { cookie } });
  const planned = lastJob(planning);
  check('progress arrives as an event stream', planning.type.startsWith('text/event-stream'), planning.type);
  check('planning ends waiting for approval', planned?.status === 'awaiting_approval', planned?.error ?? planned?.status ?? 'no job');
  check('planning reports what the agent read', (planned?.lines ?? []).some((l) => l.startsWith('Reading ')), (planned?.lines ?? []).join(' | '));
  check('planning wrote nothing into the wiki', !(await fs.readdir(path.join(app.wiki, 'operations'))).some((f) => ['entities', 'concepts', 'raw'].includes(f)));

  const plan = await (await get(`/api/pipeline/plan?jobId=${jobId}`, { cookie })).json();
  check('the plan can be read', plan.plan?.pages?.length === 3, `${plan.plan?.pages?.length ?? 0} pages`);

  const approved = await fetch(`${base}/api/pipeline/execute`, withCookie(json({ jobId }), cookie));
  check('approval is accepted', approved.status === 202, String(approved.status));
  const filing = await events(`${base}/api/jobs/${jobId}`, { headers: { cookie } });
  const filed = lastJob(filing);
  check('filing finishes and passes its check', filed?.status === 'done', `${filed?.error ?? filed?.status}${filed?.lint ? `, findings: ${filed.lint.findings.map((f) => f.code).join(', ') || 'none'}` : ''}`);
  check('filing is committed', typeof filed?.commit === 'string' && filed.commit.length >= 7, filed?.commit ?? 'no commit');
  check('the pages are on disk', (await fs.readdir(path.join(app.wiki, 'operations', 'entities')).catch(() => [])).includes('warehouse-team.md'));

  const page = await get('/c/operations/entities/warehouse-team', { cookie });
  const html = await page.text();
  check('a page can be opened', page.status === 200 && html.includes('Warehouse Team'), String(page.status));
  check('the block at the top of the page is shown as properties, not as text', html.includes('Properties') && html.includes('raw/note.md') && !html.includes('title: Warehouse Team'));
  check('the page lists what links to it', html.includes('Backlinks') && html.includes('/c/operations/entities/returns-portal'));
  check('the page has an outline that leads to its headings', html.includes('href="#responsibilities"') && html.includes('id="responsibilities"'));
  check('the frame is there: page tree, tabs, status bar', ['class="sidebar left"', 'class="tabbar"', 'class="statusbar"'].every((part) => html.includes(part)));

  // ------------------------------------------------------------- search
  const found = await (await get('/api/search?cluster=operations&q=resalable', { cookie })).json();
  check('search finds a word in a page', found.hits?.length === 1 && found.hits[0].slug === 'concepts/refund-policy', JSON.stringify(found.hits?.map((h) => h.slug)));
  check('search shows where the word stands', /resalable/i.test(found.hits?.[0]?.snippet ?? ''), found.hits?.[0]?.snippet ?? '');
  const both = await (await get('/api/search?cluster=operations&q=portal%20WAREHOUSE', { cookie })).json();
  check('every word has to be there, in any case', both.hits?.length === 3, JSON.stringify(both.hits?.map((h) => h.slug)));
  check('a match in the title comes first', both.hits?.[0]?.slug === 'entities/returns-portal' || both.hits?.[0]?.slug === 'entities/warehouse-team', both.hits?.[0]?.slug ?? '');
  const none = await (await get('/api/search?cluster=operations&q=zeppelin', { cookie })).json();
  check('a word that is nowhere finds nothing', Array.isArray(none.hits) && none.hits.length === 0);
  const searchAnon = await get('/api/search?cluster=operations&q=portal');
  check('search needs a session', searchAnon.status === 401, String(searchAnon.status));
  const climbing = await get('/api/search?cluster=..%2Foperations&q=portal', { cookie });
  check('search cannot climb out of the wiki', climbing.status === 400, String(climbing.status));

  const again = await fetch(`${base}/api/pipeline/execute`, withCookie(json({ jobId }), cookie));
  check('a plan cannot be approved twice', again.status >= 400 && again.status < 500, String(again.status));

  // ------------------------------------------------------------ the editor
  const put = (body) => fetch(`${base}/api/page`, withCookie({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, cookie));
  const opened = await (await get('/api/page?cluster=operations&slug=entities/warehouse-team', { cookie })).json();
  check('a page can be read for editing', opened.exists === true && opened.text.includes('# Warehouse Team') && /^\d+:\d+$/.test(opened.version), opened.version);
  const edited = await put({ cluster: 'operations', slug: 'entities/warehouse-team', text: `${opened.text}\nA line typed in the editor.\n`, version: opened.version });
  const editedBody = await edited.json();
  check('a save with the version that was read is taken', edited.status === 200 && /^\d+:\d+$/.test(editedBody.version) && editedBody.version !== opened.version, `${edited.status} ${JSON.stringify(editedBody).slice(0, 80)}`);
  const stale = await put({ cluster: 'operations', slug: 'entities/warehouse-team', text: `${opened.text}\nWritten from an old copy.\n`, version: opened.version });
  const staleBody = await stale.json();
  check('a save from a copy that moved on is refused, with the page as it is', stale.status === 409 && staleBody.text.includes('A line typed in the editor.') && staleBody.version === editedBody.version, String(stale.status));
  const forced = await put({ cluster: 'operations', slug: 'entities/warehouse-team', text: `${opened.text}\nForced over.\n`, version: opened.version, force: true, commit: true });
  const forcedBody = await forced.json();
  check('unless it is forced, and then the restore point is made', forced.status === 200 && typeof forcedBody.commit === 'string' && forcedBody.commit.length >= 7, `${forced.status} ${JSON.stringify(forcedBody).slice(0, 80)}`);
  const found2 = await (await get('/api/search?cluster=operations&q=forced%20over', { cookie })).json();
  check('what was saved is read at once', found2.hits?.length === 1 && found2.hits[0].slug === 'entities/warehouse-team', JSON.stringify(found2.hits?.map((h) => h.slug)));
  const made = await put({ cluster: 'operations', slug: 'entities/courier-contract', text: '---\ntitle: Courier Contract\ntype: entity\n---\n\n# Courier Contract\n' });
  check('a new page is made on its first save', made.status === 201 && (await fs.readdir(path.join(app.wiki, 'operations', 'entities'))).includes('courier-contract.md'), String(made.status));
  const refused = [];
  for (const slug of ['../SCHEMA', 'raw/note', 'CLAUDE', 'entities/../../escape', 'entities/.hidden', 'source/x']) {
    const res = await put({ cluster: 'operations', slug, text: 'x' });
    if (res.status < 400) refused.push(`${slug}: ${res.status}`);
  }
  check('nothing but a page can be written this way', refused.length === 0, refused.join(', '));

  // ------------------------------------------------------------- images
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await fs.mkdir(path.join(app.wiki, 'operations', 'raw', 'assets'), { recursive: true });
  await fs.writeFile(path.join(app.wiki, 'operations', 'raw', 'assets', 'photo.png'), PNG);
  await new Promise((r) => setTimeout(r, 400)); // the list of images a page view made is trusted for a moment
  const PHOTO = '/api/asset?cluster=operations&path=raw%2Fassets%2Fphoto.png';
  const image = await get(PHOTO, { cookie });
  check('an image of the wiki is served as itself', image.status === 200 && image.headers.get('content-type') === 'image/png' && image.headers.get('x-content-type-options') === 'nosniff' && (await image.arrayBuffer()).byteLength === PNG.length, `${image.status} ${image.headers.get('content-type')}`);
  const unchanged = await get(PHOTO, { cookie, 'if-none-match': image.headers.get('etag') ?? '' });
  check('an image the browser already has is not sent again', unchanged.status === 304, String(unchanged.status));
  const served = [];
  for (const p of ['index.md', 'SCHEMA.md', '../outside.png', '.dashboard/x.png', '.git/config', 'raw/assets/nothing.png', 'raw/assets']) {
    if ((await get(`/api/asset?cluster=operations&path=${encodeURIComponent(p)}`, { cookie })).status === 200) served.push(p);
  }
  check('nothing but an image of the wiki is served', served.length === 0, served.join(', '));
  check('images need a session', (await fetch(`${base}${PHOTO}`)).status === 401);
  await put({ cluster: 'operations', slug: 'entities/with-image', text: '# With Image\n\n![[photo.png]] then ![[photo.png|120]] then ![[gone.png]] then ![remote](https://example.com/x.png)\n', force: true });
  const withImage = await (await get('/c/operations/entities/with-image', { cookie })).text();
  const shown = (withImage.match(/<img[^>]+class="internal-embed"[^>]+src="\/api\/asset\?cluster=operations&amp;path=raw%2Fassets%2Fphoto\.png"/g) ?? []).length;
  check('a page shows its images, at the width asked for, and marks one that is not there', shown === 2 && /width="120"/.test(withImage) && /is-unresolved[^>]*>gone\.png/.test(withImage), shown === 2 ? '2 shown' : `${shown} shown: ${(withImage.match(/<p>[^]{0,600}/) ?? ['(no paragraph)'])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  check('a remote image is left out', /\[image omitted\]/.test(withImage) && !/example\.com\/x\.png/.test(withImage));
  const form = new FormData();
  form.append('cluster', 'operations');
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'Pasted.png');
  const addedImage = await fetch(`${base}/api/asset`, { method: 'POST', body: form, headers: { cookie } });
  const addedData = await addedImage.json();
  check('an image can be added from the editor', addedImage.status === 201 && addedData.path === 'raw/assets/Pasted.png' && addedData.embed === '![[Pasted.png]]', `${addedImage.status} ${JSON.stringify(addedData)}`);
  check('and is then served', (await get(addedData.href ?? '/nothing', { cookie })).status === 200);
  const images = await (await get('/api/assets?cluster=operations', { cookie })).json();
  check('the editor can ask which images there are', Array.isArray(images.images) && images.images.includes('raw/assets/Pasted.png') && images.images.includes('raw/assets/photo.png'), JSON.stringify(images.images));
  const notImage = new FormData();
  notImage.append('cluster', 'operations');
  notImage.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  check('only an image can be added this way', (await fetch(`${base}/api/asset`, { method: 'POST', body: notImage, headers: { cookie } })).status === 400);

  // --------------------------------------------------- rename and delete
  await fetch(`${base}/api/page/rename`, withCookie(json({ cluster: 'operations', slug: 'entities/with-image', title: 'Picture Page' }), cookie));
  const renamed = await fetch(`${base}/api/page/rename`, withCookie(json({ cluster: 'operations', slug: 'entities/warehouse-team', title: 'Warehouse Crew' }), cookie));
  const renamedData = await renamed.json();
  check('a page can be renamed', renamed.status === 200 && renamedData.to === 'entities/warehouse-crew' && renamedData.rewritten.length >= 1 && typeof renamedData.commit === 'string', `${renamed.status} ${JSON.stringify(renamedData)}`);
  const crew = await (await get('/api/page?cluster=operations&slug=entities/warehouse-crew', { cookie })).json();
  const teamGone = await (await get('/api/page?cluster=operations&slug=entities/warehouse-team', { cookie })).json();
  check('it is read under its new name and not its old one', crew.exists === true && crew.text.includes('# Warehouse Crew') && teamGone.exists === false);
  const relinked = await (await get('/api/page?cluster=operations&slug=index', { cookie })).json();
  check('the index links to it by its new name', relinked.text.includes('[[Warehouse Crew') && !relinked.text.includes('[[Warehouse Team'), relinked.text.split('\n').filter((l) => /warehouse/i.test(l)).join(' | '));
  const renamedPage = await get('/c/operations/entities/warehouse-crew', { cookie });
  const renamedHtml = await renamedPage.text();
  check('the renamed page opens', renamedPage.status === 200 && renamedHtml.includes('Warehouse Crew'));
  check('a page carries its own graph beside it', renamedHtml.includes('class="local-graph"') && /pages? around this one/.test(renamedHtml), (renamedHtml.match(/\d+ pages? around this one/) ?? ['no header'])[0]);
  check('renaming onto another page is refused', (await fetch(`${base}/api/page/rename`, withCookie(json({ cluster: 'operations', slug: 'entities/warehouse-crew', title: 'Returns Portal' }), cookie))).status === 409);
  const deleted = await fetch(`${base}/api/page`, withCookie({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cluster: 'operations', slug: 'entities/picture-page' }) }, cookie)).then(async (r) => ({ status: r.status, data: await r.json() }));
  check('a page can be deleted', deleted.status === 200 && deleted.data.slug === 'entities/picture-page' && typeof deleted.data.commit === 'string', `${deleted.status} ${JSON.stringify(deleted.data)}`);
  check('and is gone', (await (await get('/api/page?cluster=operations&slug=entities/picture-page', { cookie })).json()).exists === false && (await get('/c/operations/entities/picture-page', { cookie })).status === 404);
  check('the index and the log are not deleted', (await fetch(`${base}/api/page`, withCookie({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cluster: 'operations', slug: 'index' }) }, cookie))).status === 400);
  check('the rules are as they were', (await fs.readFile(path.join(app.wiki, 'operations', 'SCHEMA.md'), 'utf8')).length > 100 && !(await fs.readdir(path.join(app.wiki, 'operations'))).includes('CLAUDE.md'));
  const anon = await fetch(`${base}/api/page?cluster=operations&slug=entities/warehouse-team`);
  check('the editor needs a session', anon.status === 401, String(anon.status));

  // ---------------------------------------------------------------- chat
  const chat = await events(`${base}/api/chat`, withCookie(json({ cluster: 'operations', question: 'What is this cluster about?' }), cookie));
  const answer = chat.list.filter((e) => e.name === 'token').map((e) => e.data.text).join('');
  check('an answer arrives in pieces', chat.list.filter((e) => e.name === 'token').length > 1, `${chat.list.filter((e) => e.name === 'token').length} pieces`);
  check('the answer names its sources', /^SOURCES: \[\[/m.test(answer), answer.trim().split('\n').pop() ?? '');
  check('the answer says what was read', chat.list.some((e) => e.name === 'activity' && e.data.text === 'Reading index.md'));
  check('the answer ends cleanly', chat.list.at(-1)?.name === 'end', chat.list.at(-1)?.name ?? 'nothing');
  const conversationId = chat.list.find((e) => e.name === 'session')?.data.id ?? '';
  check('the answer names the conversation it starts', /^[0-9a-f-]{36}$/.test(conversationId), conversationId);
  const next = await events(`${base}/api/chat`, withCookie(json({ cluster: 'operations', question: 'And who logs it?', conversation: conversationId }), cookie));
  const nextAnswer = next.list.filter((e) => e.name === 'token').map((e) => e.data.text).join('');
  check('the next question builds on the last', nextAnswer.includes('Earlier you asked: "What is this cluster about?"') && next.list.find((e) => e.name === 'session')?.data.id === conversationId, nextAnswer.split('\n')[0]);
  const gone = await events(`${base}/api/chat`, withCookie(json({ cluster: 'operations', question: 'Still there?', conversation: '11111111-2222-4333-8444-555555555555' }), cookie));
  const goneSessions = gone.list.filter((e) => e.name === 'session').map((e) => e.data.id);
  check('a conversation that is no longer there is started afresh', gone.list.some((e) => e.name === 'activity' && /no longer there/.test(e.data.text)) && gone.list.at(-1)?.name === 'end' && goneSessions.length === 2 && goneSessions[1] !== goneSessions[0], goneSessions.join(' > '));
  const nowhere = await fetch(`${base}/api/chat`, withCookie(json({ cluster: '../operations', question: 'x' }), cookie));
  check('a cluster name cannot climb out of the wiki', nowhere.status === 400, String(nowhere.status));

  // ------------------------------------- filed at once, discarded, undone
  const switched = await fetch(`${base}/api/clusters/settings`, withCookie(json({ cluster: 'operations', settings: { filing: 'automatic' } }), cookie));
  check('a wiki can be set to file at once', switched.status === 200 && (await switched.json()).settings?.filing === 'automatic', String(switched.status));
  const { jobId: autoId } = await (await upload(base, cookie, 'operations', 'second-note.md', `${NOTE} Refunds go out the same day.`)).json();
  const filedAtOnce = lastJob(await events(`${base}/api/jobs/${autoId}`, { headers: { cookie } }));
  check('an upload is then filed without a decision', ['done', 'attention'].includes(filedAtOnce?.status) && filedAtOnce?.automatic === true, filedAtOnce?.error ?? filedAtOnce?.status ?? 'no job');
  await fetch(`${base}/api/clusters/settings`, withCookie(json({ cluster: 'operations', settings: { filing: 'review' } }), cookie));
  const { jobId: discardId } = await (await upload(base, cookie, 'operations', 'third-note.md', `${NOTE} Exchanges are handled by the same team.`)).json();
  const waiting = lastJob(await events(`${base}/api/jobs/${discardId}`, { headers: { cookie } }));
  const discarded = await fetch(`${base}/api/pipeline/reject`, withCookie(json({ jobId: discardId }), cookie));
  check('an upload waiting for a decision can be discarded', waiting?.status === 'awaiting_approval' && discarded.status === 200 && (await discarded.json()).job?.status === 'rejected', `${waiting?.status} then ${discarded.status}`);
  const undone = await fetch(`${base}/api/pipeline/undo`, withCookie(json({ jobId: autoId }), cookie));
  const undoneJob = (await undone.json()).job;
  check('a filing can be undone', undone.status === 200 && undoneJob?.status === 'undone' && typeof undoneJob?.undoCommit === 'string', `${undone.status} ${undoneJob?.status ?? ''}`);

  // ------------------------------------------------------------ throttle
  let status = 0;
  for (let i = 0; i < 5; i++) status = (await signIn(base, 'not the password', { 'x-forwarded-for': '203.0.113.50' })).res.status;
  check('five wrong guesses are each answered', status === 401, String(status));
  const blocked = await signIn(base, PASSWORD, { 'x-forwarded-for': '203.0.113.50' });
  check('after that, that caller is blocked even with the right password', blocked.res.status === 429 && Number(blocked.res.headers.get('retry-after')) > 0, `${blocked.res.status}, retry after ${blocked.res.headers.get('retry-after')} s`);
  const other = await signIn(base, PASSWORD, { 'x-forwarded-for': '203.0.113.51' });
  check('another caller is not', other.res.status === 200, String(other.res.status));

  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  check('signing out clears the cookie', /brain_session=;/.test(out.headers.get('set-cookie') ?? '') && /max-age=0/i.test(out.headers.get('set-cookie') ?? ''), out.headers.get('set-cookie') ?? '');
  check('a session that signed out is refused where a copy of the cookie was kept', (await settles(base, cookie, 401)) === 401);

  // ------------------------------------------------- sign out everywhere
  const a = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.3' });
  const b = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.4' });
  const everywhere = await fetch(`${base}/api/auth/sessions`, withCookie({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) }, a.cookie));
  check('sign out everywhere clears this cookie too', everywhere.status === 200 && /brain_session=;/.test(everywhere.headers.get('set-cookie') ?? ''), String(everywhere.status));
  check('every other session is refused within seconds', (await settles(base, b.cookie, 401)) === 401);
  const afterwards = await signIn(base, PASSWORD, { 'x-forwarded-for': '198.51.100.3' });
  check('signing in again works and is of the new epoch', afterwards.res.status === 200 && afterwards.cookie.split('.')[2] === '2', afterwards.cookie.split('.')[2]);
  check('the old sessions are gone from the list', ((await (await get('/api/auth/sessions', { cookie: afterwards.cookie })).json()).sessions ?? []).length === 1);
  check('the epoch and the revocations survive a restart', JSON.parse(await fs.readFile(path.join(app.wiki, '.dashboard', 'auth.json'), 'utf8')).epoch === 2);

  // ---------------------------------------------------------- the trail
  const trail = (await fs.readFile(path.join(app.wiki, '.dashboard', 'audit.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const kinds = new Set(trail.map((e) => e.event));
  const wanted = ['sign-in', 'sign-in-refused', 'sign-out', 'session-revoked', 'signed-out-everywhere', 'cluster-created', 'filing-planned', 'filing-approved', 'filing-discarded', 'filing-undone', 'settings-changed', 'filing-automatic', 'page-saved', 'image-added', 'page-renamed', 'page-deleted', 'sign-in-password', 'sign-in-code-sent'];
  check('every kind of action is in the trail', wanted.every((w) => kinds.has(w)), wanted.filter((w) => !kinds.has(w)).join(', ') || `${trail.length} entries`);
  check('the trail says when, from where and which session, never a password or a cookie', trail.every((e) => e.at && e.event) && trail.filter((e) => e.event === 'sign-in').every((e) => e.client === '198.51.100.1' || e.client === '198.51.100.3' || e.client === '198.51.100.4' || e.client === '203.0.113.51') && !trail.some((e) => JSON.stringify(e).includes(PASSWORD) || JSON.stringify(e).includes(cookie.slice(14))), trail.filter((e) => e.event === 'sign-in').map((e) => e.client).join(','));

  // ---------------------------------------------------- the second factor
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const guarded = await start('scripts/fake-claude.mjs', { extraEnv: { AUTH_TOTP_SECRET: SECRET, AUTH_CODE_PHONE: '+15185550168' } });
  check('the login page carries the captcha', (await (await fetch(`${guarded.base}/login`)).text()).includes('altcha-widget'));
  const ways = await signIn(guarded.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { code: '000000' });
  check('after the password, email and text are offered, and the app under other ways', ways.opened?.methods?.map((m) => m.kind).join() === 'email,sms,totp' && ways.opened.methods[1].to === '+1 (518) *****68', JSON.stringify(ways.opened?.methods));
  const texted = await signIn(guarded.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { method: 'sms' });
  check('a code by text signs in', texted.res.status === 200 && texted.cookie.startsWith('brain_session=') && (await latestCode(guarded, 'sms'))?.to === '+15185550168', String(texted.res.status));
  const wrongPassword = await signIn(guarded.base, `${PASSWORD}x`, { 'x-forwarded-for': '198.51.100.9' });
  check('a wrong password never reaches the code', wrongPassword.res.status === 401 && !wrongPassword.set && !wrongPassword.opened, String(wrongPassword.res.status));
  const withApp = await signIn(guarded.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { method: 'totp', code: totpNow(SECRET) });
  check('the authenticator code signs in, with nothing sent', withApp.res.status === 200 && withApp.cookie.startsWith('brain_session='), String(withApp.res.status));
  const replayed = await signIn(guarded.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { method: 'totp', code: totpNow(SECRET) });
  check('the same app code is not taken twice', replayed.res.status === 401, String(replayed.res.status));
  const wrongApp = await signIn(guarded.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { method: 'totp', code: '000000' });
  check('a wrong app code is refused', wrongApp.res.status === 401 && !wrongApp.set, String(wrongApp.res.status));
  check('the session opens the app', (await fetch(`${guarded.base}/api/clusters`, { headers: { cookie: withApp.cookie } })).status === 200);
  const plainServer = await start('scripts/fake-claude.mjs', { extraEnv: { CODE_CAPTURE_DIR: '', AUTH_CAPTCHA: 'off' } });
  const plain = await signIn(plainServer.base, PASSWORD, { 'x-forwarded-for': '198.51.100.9' }, { captcha: false });
  check('with nothing after the password set up and the captcha off, the password alone signs in', plain.res.status === 200 && plain.cookie.startsWith('brain_session='), String(plain.res.status));
  check('the login page then shows no captcha', !(await (await fetch(`${plainServer.base}/login`)).text()).includes('altcha-widget'));

  // ----------------------------------------------- when Claude is signed out
  const down = await start('scripts/fake-claude.mjs --fail auth');
  const there = (await signIn(down.base)).cookie;
  await fetch(`${down.base}/api/clusters`, withCookie(json({ name: 'operations', scope: 'Returns and refunds' }), there));
  const asked = await events(`${down.base}/api/chat`, withCookie(json({ cluster: 'operations', question: 'Anything?' }), there));
  const said = asked.list.find((e) => e.name === 'error')?.data.message ?? '';
  check('chat says that Claude is signed out', /signed out/i.test(said), said || asked.list.map((e) => e.name).join(','));
  const lost = await (await upload(down.base, there, 'operations', 'note.md', NOTE)).json();
  const failedJob = lastJob(await events(`${down.base}/api/jobs/${lost.jobId}`, { headers: { cookie: there } }));
  check('an upload says that Claude is signed out', failedJob?.status === 'failed' && /signed out/i.test(failedJob?.error ?? ''), failedJob?.error ?? failedJob?.status ?? 'no job');

  // --------------------------------------------- a server that is not set up
  const bare = spawnBare();
  const closed = await bare.then((b) => fetch(`${b.base}/api/auth/login`, json({ email: EMAIL, password: PASSWORD })));
  check('without its sign-in settings the server lets nobody in', closed.status === 503, String(closed.status));
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopAll();
}

/** A server with no sign-in settings at all. */
async function spawnBare() {
  const port = await freePort();
  const wiki = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AUTH_|SESSION_|CLAUDE_|ANTHROPIC_|WIKI_|APP_DIR$)/.test(name)) delete env[name];
  }
  Object.assign(env, { PORT: String(port), HOSTNAME: '127.0.0.1', WIKI_ROOT: wiki, CLAUDE_CMD: 'node', CLAUDE_ARGS: 'scripts/fake-claude.mjs' });
  const child = spawn(process.execPath, [server], { cwd: appDir, env, stdio: 'ignore', windowsHide: true });
  const instance = { base: `http://127.0.0.1:${port}`, wiki, child, log: () => '' };
  running.push(instance);
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${instance.base}/login`).then((r) => r.status === 200, () => false)) return instance;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The server without settings did not come up.');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
