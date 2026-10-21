import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DASHBOARD_DIR } from './config';
import { publicOrigin } from './gate';
import { currentEpoch } from './sessions';

/**
 * OAuth 2.1 for the brain's MCP server (lib/mcp.ts, /mcp), so that Claude can
 * be connected to the brain the way any connector is: Claude registers itself
 * (dynamic client registration), sends the owner to /oauth/authorize, where the
 * app's own sign-in (password and code) stands in front of a consent page, and
 * gets a code it trades for tokens with PKCE.
 *
 * - Only Claude's own callback addresses (and the owner's own machine, for
 *   Claude Code and the desktop app) can receive a code. `MCP_REDIRECT_HOSTS`
 *   adds more.
 * - Tokens are random and kept only as hashes. An access token lasts an hour;
 *   the refresh token is replaced every time it is used, and one used twice
 *   ends the connection (it was copied).
 * - A connection belongs to the sign-in epoch it was made in: "sign out
 *   everywhere" and a password change end every connection too.
 * - Connections are listed on the Security page and can be ended there.
 *
 * The store is one JSON file under .dashboard, written whole.
 */

export const SCOPE = 'brain:read';
export const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 100;
/** A registration that never led to a connection is forgotten after a day. */
const IDLE_CLIENT_MS = 24 * 60 * 60 * 1000;
/** How often "last used" is written down; a call between two writes is not worth a disk write. */
const USE_WRITE_MS = 60 * 1000;

const FILE = path.join(DASHBOARD_DIR, 'oauth.json');

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  /** Set for a client that registered as confidential. */
  secretHash?: string;
  createdAt: string;
}

interface Code {
  hash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  epoch: number;
  expiresAt: number;
}

export interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  epoch: number;
  createdAt: string;
  lastUsedAt: string;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  /** The refresh token this one replaced: shown again, the connection was copied. */
  previousRefreshHash?: string;
}

interface Store {
  clients: Client[];
  codes: Code[];
  grants: Grant[];
}

// ------------------------------------------------------------------ pure

/** The redirect hosts Claude uses, always allowed (https only). */
const CLAUDE_HOSTS = ['claude.ai', 'claude.com'];

/**
 * Whether a code may be sent to this address: https on Claude's own hosts or
 * on one named in `extraHosts`, or http on the owner's own machine (loopback,
 * any port), as Claude Code and the desktop app use. No fragments, no
 * credentials in the address.
 */
export function redirectAllowed(uri: string, extraHosts: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:') return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (url.protocol !== 'https:') return false;
  return [...CLAUDE_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)].includes(host);
}

/** PKCE, S256 only: the verifier hashes to the challenge. */
export function pkceOk(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const made = createHash('sha256').update(verifier).digest('base64url');
  return sameText(made, challenge);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function extraRedirectHosts(): string[] {
  return (process.env.MCP_REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
}

/** The site's address as the caller used it: the issuer, and where /mcp is. */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  return publicOrigin(
    { forwardedHost: request.headers.get('x-forwarded-host'), host: request.headers.get('host'), forwardedProto: request.headers.get('x-forwarded-proto') },
    url.origin,
  );
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Second Brain',
  };
}

// ------------------------------------------------------------------ store

const globalForOAuth = globalThis as typeof globalThis & { __brainOAuth?: { store: Store | null; queue: Promise<unknown>; lastUseWrite: number } };
const kept = (globalForOAuth.__brainOAuth ??= { store: null, queue: Promise.resolve(), lastUseWrite: 0 });

let loading: Promise<Store> | null = null;

async function load(): Promise<Store> {
  if (kept.store) return kept.store;
  loading ??= (async () => {
    let store: Store = { clients: [], codes: [], grants: [] };
    try {
      const parsed = JSON.parse(await fs.readFile(FILE, 'utf8')) as Partial<Store>;
      store = {
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        codes: Array.isArray(parsed.codes) ? parsed.codes : [],
        grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      };
    } catch {
      /* none yet */
    }
    kept.store = store;
    return store;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

async function save(store: Store): Promise<void> {
  await fs.mkdir(DASHBOARD_DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temp, FILE);
}

/** One change at a time, so two requests cannot write over each other. */
function change<T>(fn: (store: Store, now: number) => T | Promise<T>): Promise<T> {
  const run = kept.queue.then(async () => {
    const store = await load();
    const now = Date.now();
    prune(store, now);
    try {
      return await fn(store, now);
    } finally {
      // Also when it refused: a code is spent and a copied connection ended either way.
      await save(store);
    }
  });
  kept.queue = run.catch(() => undefined);
  return run;
}

function prune(store: Store, now: number): void {
  store.codes = store.codes.filter((c) => c.expiresAt > now);
  store.grants = store.grants.filter((g) => g.refreshExpiresAt > now);
  const used = new Set(store.grants.map((g) => g.clientId));
  store.clients = store.clients.filter((c) => used.has(c.id) || now - Date.parse(c.createdAt) < IDLE_CLIENT_MS);
  if (store.clients.length > MAX_CLIENTS) {
    const idle = store.clients.filter((c) => !used.has(c.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const drop = new Set(idle.slice(0, store.clients.length - MAX_CLIENTS).map((c) => c.id));
    store.clients = store.clients.filter((c) => !drop.has(c.id));
  }
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Dynamic client registration (RFC 7591). Public clients get no secret. */
export async function registerClient(input: unknown): Promise<{ client: Client; secret: string | null }> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'Give one to ten redirect_uris');
  const extra = extraRedirectHosts();
  const refused = uris.find((u) => !redirectAllowed(u, extra));
  if (refused) throw new OAuthError('invalid_redirect_uri', `This server only sends codes to Claude: ${refused} is not allowed`);
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  const confidential = method === 'client_secret_post' || method === 'client_secret_basic';
  const name = (typeof body.client_name === 'string' ? body.client_name : 'An MCP client').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'An MCP client';
  const secret = confidential ? newToken() : null;
  const client: Client = { id: randomUUID(), name, redirectUris: uris, createdAt: new Date().toISOString(), ...(secret ? { secretHash: hashToken(secret) } : {}) };
  await change((store) => {
    store.clients.push(client);
  });
  return { client, secret };
}

export async function findClient(id: unknown): Promise<Client | null> {
  if (typeof id !== 'string') return null;
  return (await load()).clients.find((c) => c.id === id) ?? null;
}

export interface AuthorizeRequest {
  client: Client;
  redirectUri: string;
  challenge: string;
  state: string | null;
}

/**
 * The checks on an authorization request, in the order the spec wants them:
 * a client or redirect address that is wrong is shown on the page (never
 * redirected to); anything else goes back to the client as an error.
 */
export async function checkAuthorize(params: URLSearchParams | Map<string, string>): Promise<{ ok: AuthorizeRequest } | { fatal: string } | { redirect: string }> {
  const get = (k: string): string | null => (params instanceof Map ? (params.get(k) ?? null) : params.get(k));
  const client = await findClient(get('client_id'));
  if (!client) return { fatal: 'This app is not registered with your brain. Start the connection again from Claude.' };
  const redirectUri = get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!client.redirectUris.includes(redirectUri) || !redirectAllowed(redirectUri, extraRedirectHosts())) return { fatal: 'The address this app wants the answer sent to is not one it registered.' };
  const state = get('state');
  const back = (error: string, description: string): { redirect: string } => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    return { redirect: url.toString() };
  };
  if (get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code');
  const challenge = get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || (get('code_challenge_method') ?? 'S256') !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
  return { ok: { client, redirectUri, challenge, state } };
}

/** The owner said yes: a code for the client, valid ten minutes, once. */
export async function issueCode(request: AuthorizeRequest, issuer: string): Promise<string> {
  const code = newToken();
  const epoch = await currentEpoch();
  await change((store, now) => {
    store.codes.push({ hash: hashToken(code), clientId: request.client.id, redirectUri: request.redirectUri, challenge: request.challenge, epoch, expiresAt: now + CODE_TTL_MS });
  });
  const url = new URL(request.redirectUri);
  url.searchParams.set('code', code);
  if (request.state) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

export function deniedRedirect(request: AuthorizeRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('error_description', 'The owner did not allow it');
  if (request.state) url.searchParams.set('state', request.state);
  return url.toString();
}

export interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function mint(grant: Grant, now: number): Tokens {
  const access = newToken();
  const refresh = newToken();
  grant.accessHash = hashToken(access);
  grant.accessExpiresAt = now + ACCESS_TTL_S * 1000;
  grant.refreshHash = hashToken(refresh);
  grant.refreshExpiresAt = now + REFRESH_TTL_MS;
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

function authenticateClient(client: Client, secret: string | null): void {
  if (!client.secretHash) return;
  if (!secret || !sameText(hashToken(secret), client.secretHash)) throw new OAuthError('invalid_client', 'Wrong client secret', 401);
}

/** The token endpoint. Returns the tokens and, for a new connection, its grant. */
export async function exchange(form: Map<string, string>, clientSecret: string | null): Promise<{ tokens: Tokens; created: Grant | null }> {
  const grantType = form.get('grant_type');
  const client = await findClient(form.get('client_id'));
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
  authenticateClient(client, clientSecret);
  const epoch = await currentEpoch();

  if (grantType === 'authorization_code') {
    const presented = hashToken(form.get('code') ?? '');
    return change((store, now) => {
      const at = store.codes.findIndex((c) => sameText(c.hash, presented));
      if (at < 0) throw new OAuthError('invalid_grant', 'That code is not valid, or was used already');
      const code = store.codes[at];
      store.codes.splice(at, 1); // once, whatever happens next
      if (code.clientId !== client.id) throw new OAuthError('invalid_grant', 'That code was given to another client');
      if (code.redirectUri !== (form.get('redirect_uri') ?? code.redirectUri)) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
      if (!pkceOk(form.get('code_verifier'), code.challenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match');
      if (code.epoch !== epoch) throw new OAuthError('invalid_grant', 'Everyone was signed out since; connect again');
      const grant: Grant = { id: randomUUID(), clientId: client.id, clientName: client.name, epoch, createdAt: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString(), accessHash: '', accessExpiresAt: 0, refreshHash: '', refreshExpiresAt: 0 };
      const tokens = mint(grant, now);
      store.grants.push(grant);
      return { tokens, created: grant };
    });
  }

  if (grantType === 'refresh_token') {
    const presented = hashToken(form.get('refresh_token') ?? '');
    return change((store, now) => {
      const reused = store.grants.find((g) => g.previousRefreshHash && sameText(g.previousRefreshHash, presented));
      if (reused) {
        store.grants = store.grants.filter((g) => g !== reused);
        throw new OAuthError('invalid_grant', 'That refresh token was already used; the connection has been ended');
      }
      const grant = store.grants.find((g) => sameText(g.refreshHash, presented));
      if (!grant || grant.clientId !== client.id) throw new OAuthError('invalid_grant', 'That refresh token is not valid');
      if (grant.epoch !== epoch) {
        store.grants = store.grants.filter((g) => g !== grant);
        throw new OAuthError('invalid_grant', 'Everyone was signed out since; connect again');
      }
      grant.previousRefreshHash = grant.refreshHash;
      grant.lastUsedAt = new Date(now).toISOString();
      return { tokens: mint(grant, now), created: null };
    });
  }

  throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token');
}

/** The connection a bearer token belongs to, or null. */
export async function verifyAccess(token: string | null): Promise<Grant | null> {
  if (!token) return null;
  const store = await load();
  const presented = hashToken(token);
  const now = Date.now();
  const grant = store.grants.find((g) => sameText(g.accessHash, presented));
  if (!grant || grant.accessExpiresAt <= now) return null;
  if (grant.epoch !== (await currentEpoch())) return null;
  grant.lastUsedAt = new Date(now).toISOString();
  if (now - kept.lastUseWrite > USE_WRITE_MS) {
    kept.lastUseWrite = now;
    void change(() => undefined).catch(() => undefined);
  }
  return grant;
}

/** RFC 7009: any token of a connection ends the connection. Unknown tokens are not an error. */
export async function revokeToken(token: string): Promise<Grant | null> {
  const presented = hashToken(token);
  return change((store) => {
    const grant = store.grants.find((g) => sameText(g.accessHash, presented) || sameText(g.refreshHash, presented));
    if (grant) store.grants = store.grants.filter((g) => g !== grant);
    return grant ?? null;
  });
}

export interface Connection {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

/** The connections that are open now, for the Security page. */
export async function listConnections(): Promise<Connection[]> {
  const store = await load();
  const epoch = await currentEpoch();
  const now = Date.now();
  return store.grants
    .filter((g) => g.epoch === epoch && g.refreshExpiresAt > now)
    .map((g) => ({ id: g.id, name: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export async function endConnection(id: string): Promise<Grant | null> {
  return change((store) => {
    const grant = store.grants.find((g) => g.id === id) ?? null;
    if (grant) store.grants = store.grants.filter((g) => g !== grant);
    return grant;
  });
}

/** For the checks: forget what is held in memory, so the file is read again. */
export function forgetOAuth(): void {
  kept.store = null;
}
