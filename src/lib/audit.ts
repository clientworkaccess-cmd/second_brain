import fs from 'node:fs/promises';
import path from 'node:path';
import { DASHBOARD_DIR } from './config';

/**
 * The audit trail: who did what, when, from where. One line of JSON per
 * event, appended to .dashboard/audit.log, never rewritten. The Security
 * page shows the tail of it.
 *
 * What is recorded is the event and what it was about: a sign-in and where
 * from, a filing and its file, a page and who saved it (there is one login,
 * so "who" is the session). Never a password, a code, a token or a page's
 * text.
 */

export type AuditEvent =
  | 'sign-in'
  | 'sign-in-password'
  | 'sign-in-code-sent'
  | 'sign-in-refused'
  | 'password-reset-requested'
  | 'password-reset'
  | 'password-changed'
  | 'password-refused'
  | 'sign-out'
  | 'session-revoked'
  | 'signed-out-everywhere'
  | 'cluster-created'
  | 'settings-changed'
  | 'filing-planned'
  | 'filing-approved'
  | 'filing-automatic'
  | 'filing-discarded'
  | 'filing-undone'
  | 'page-saved'
  | 'page-renamed'
  | 'page-deleted'
  | 'image-added';

export interface AuditEntry {
  at: string;
  event: AuditEvent;
  /** The caller's address, as the proxy reported it. */
  client?: string;
  /** The first characters of the session id: enough to tell sessions apart, useless to anyone else. */
  session?: string;
  /** What it was about: a cluster, a file, a page, a reason. */
  detail?: string;
}

export const AUDIT_FILE = path.join(DASHBOARD_DIR, 'audit.log');
/** Past this size the file is set aside as audit-1.log and a new one begun, so the log never fills the disk. */
const ROTATE_AT_BYTES = 8 * 1024 * 1024;

export async function audit(entry: Omit<AuditEntry, 'at'>): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    await fs.mkdir(DASHBOARD_DIR, { recursive: true });
    const size = await fs.stat(AUDIT_FILE).then((s) => s.size, () => 0);
    if (size > ROTATE_AT_BYTES) await fs.rename(AUDIT_FILE, path.join(DASHBOARD_DIR, 'audit-1.log')).catch(() => {});
    await fs.appendFile(AUDIT_FILE, line, { mode: 0o600 });
  } catch (err) {
    // The trail must never be what stops the app. It is said in the server log instead.
    console.error('[audit] could not write', err, line.trim());
  }
}

/** The newest entries, newest first. */
export async function readAudit(limit = 100): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const out: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as AuditEntry);
    } catch {
      /* a torn line at the end of a file that is still being written */
    }
  }
  return out;
}

/** The first characters of a session token, for the trail. */
export function sessionLabel(token: string | null | undefined): string | undefined {
  return token ? token.split('.')[0].slice(0, 8) : undefined;
}

/** The proxy puts the caller first in X-Forwarded-For. Without a proxy every caller shares one bucket. */
export function clientOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'direct';
}
