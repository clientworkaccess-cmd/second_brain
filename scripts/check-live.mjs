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
import { randomBytes, scryptSync } from 'node:crypto';
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
async function start(agentArgs = 'scripts/fake-claude.mjs', { relative = false } = {}) {
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

async function signIn(base, password = PASSWORD, headers = {}) {
  const init = json({ email: EMAIL, password });
  const res = await fetch(`${base}/api/auth/login`, { ...init, headers: { ...init.headers, ...headers } });
  const set = res.headers.get('set-cookie') ?? '';
  return { res, set, cookie: set.split(';')[0] };
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
  const powered = (await get('/login')).headers.get('x-powered-by');
  check('the server does not announce what it is built with', powered === null, String(powered));

  // ------------------------------------------------------------- sign-in
  const wrong = await signIn(base, `${PASSWORD}x`, { 'x-forwarded-for': '198.51.100.1' });
  check('a wrong password is refused', wrong.res.status === 401 && !wrong.set, String(wrong.res.status));

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
  check('a page can be opened', page.status === 200 && (await page.text()).includes('Warehouse Team'), String(page.status));

  const again = await fetch(`${base}/api/pipeline/execute`, withCookie(json({ jobId }), cookie));
  check('a plan cannot be approved twice', again.status >= 400 && again.status < 500, String(again.status));

  // ---------------------------------------------------------------- chat
  const chat = await events(`${base}/api/chat`, withCookie(json({ cluster: 'operations', question: 'What is this cluster about?' }), cookie));
  const answer = chat.list.filter((e) => e.name === 'token').map((e) => e.data.text).join('');
  check('an answer arrives in pieces', chat.list.filter((e) => e.name === 'token').length > 1, `${chat.list.filter((e) => e.name === 'token').length} pieces`);
  check('the answer names its sources', /^SOURCES: \[\[/m.test(answer), answer.trim().split('\n').pop() ?? '');
  check('the answer says what was read', chat.list.some((e) => e.name === 'activity' && e.data.text === 'Reading index.md'));
  check('the answer ends cleanly', chat.list.at(-1)?.name === 'end', chat.list.at(-1)?.name ?? 'nothing');
  const nowhere = await fetch(`${base}/api/chat`, withCookie(json({ cluster: '../operations', question: 'x' }), cookie));
  check('a cluster name cannot climb out of the wiki', nowhere.status === 400, String(nowhere.status));

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
