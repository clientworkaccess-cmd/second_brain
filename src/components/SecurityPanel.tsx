'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Monitor, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { Badge, Button } from '@/components/ui';

/**
 * Who is signed in, from where, since when; the second factor; and the trail
 * of what was done. One login, so a session is the nearest thing to a person:
 * a browser that signed in. Any of them can be ended from here, or all at
 * once, which also ends this one.
 */

export interface OpenSession {
  /** What a revoke names. */
  key: string;
  /** The first characters, for reading. */
  id: string;
  createdAt: string;
  expiresAt: string;
  client: string;
  agent: string;
  current: boolean;
}

export interface TrailEntry {
  at: string;
  event: string;
  client?: string;
  session?: string;
  detail?: string;
}

const SAID: Record<string, string> = {
  'sign-in': 'Signed in',
  'sign-in-refused': 'Sign-in refused',
  'sign-out': 'Signed out',
  'session-revoked': 'Session ended',
  'signed-out-everywhere': 'Signed out everywhere',
  'cluster-created': 'Wiki created',
  'settings-changed': 'Settings changed',
  'filing-planned': 'Document read',
  'filing-approved': 'Filing approved',
  'filing-automatic': 'Filed at once',
  'filing-discarded': 'Upload discarded',
  'filing-undone': 'Filing undone',
  'page-saved': 'Page saved',
};

const WARY = new Set(['sign-in-refused', 'session-revoked', 'signed-out-everywhere', 'filing-undone']);

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Chrome on Windows", from what the browser called itself. */
function browserOf(agent: string): string {
  const os = /Windows/.test(agent) ? 'Windows' : /Mac OS X|Macintosh/.test(agent) ? 'macOS' : /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /OPR\//.test(agent) ? 'Opera' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : agent ? 'a browser' : 'a script';
  return os ? `${browser} on ${os}` : browser;
}

export function SecurityPanel({ sessions, trail, secondFactor }: { sessions: OpenSession[]; trail: TrailEntry[]; secondFactor: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function end(body: { key: string } | { all: true }) {
    setBusy('key' in body ? body.key : 'all');
    setError(null);
    try {
      const res = await fetch('/api/auth/sessions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'That did not work');
      const endedThisOne = 'all' in body || sessions.find((s) => s.key === body.key)?.current;
      if (endedThisOne) {
        router.push('/login');
        router.refresh();
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 space-y-8">
      <section aria-labelledby="security-factor">
        <h2 id="security-factor" className="text-body font-semibold text-ink">
          Second factor
        </h2>
        <div className="mt-2 flex items-start gap-3 rounded border border-line bg-panel px-3.5 py-3">
          {secondFactor ? <ShieldCheck className="mt-0.5 flex-none text-success" size={18} /> : <ShieldOff className="mt-0.5 flex-none text-warning" size={18} />}
          <div className="min-w-0 text-ui">
            {secondFactor ? (
              <>
                <p className="text-ink">On. Signing in takes the password and the six-digit code from an authenticator app.</p>
                <p className="mt-0.5 text-muted">To move it to another phone, run <code>npm run totp-secret</code> on the server, set the new secret, and restart.</p>
              </>
            ) : (
              <>
                <p className="text-ink">Off. Signing in takes the password alone.</p>
                <p className="mt-0.5 text-muted">
                  To turn it on: <code>npm run totp-secret</code> on the server prints a secret and a setup key; set <code>AUTH_TOTP_SECRET</code>, add the key to an authenticator app, restart.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="security-sessions">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="security-sessions" className="text-body font-semibold text-ink">
            Signed-in browsers
            <span className="ml-2 text-small font-normal tabular-nums text-muted">{sessions.length}</span>
          </h2>
          <Button variant="quiet" disabled={busy !== null} onClick={() => end({ all: true })} title="Every browser that is signed in, this one included, has to sign in again">
            <LogOut size={14} />
            {busy === 'all' ? 'Signing out…' : 'Sign out everywhere'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-ui text-danger">
            {error}
          </p>
        )}
        <ul className="mt-2 divide-y divide-line rounded border border-line bg-panel">
          {sessions.length === 0 && <li className="px-3.5 py-3 text-ui text-muted">Nothing is signed in that the server remembers. Sessions from before this version are not listed, and are ended by “Sign out everywhere”.</li>}
          {sessions.map((s) => (
            <li key={s.key} className="flex items-center gap-3 px-3.5 py-2.5">
              <Monitor className="flex-none text-muted" size={16} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-ui text-ink">
                  {browserOf(s.agent)}
                  {s.current && <Badge tone="accent">this browser</Badge>}
                </span>
                <span className="block text-small text-muted">
                  from {s.client} · since {when(s.createdAt)} · until {when(s.expiresAt)} · <span className="font-mono">{s.id}</span>
                </span>
              </span>
              <button
                type="button"
                className="icon-button"
                title={s.current ? 'Sign out this browser' : 'End this session'}
                disabled={busy !== null}
                onClick={() => end({ key: s.key })}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="security-trail">
        <h2 id="security-trail" className="text-body font-semibold text-ink">
          What was done
          <span className="ml-2 text-small font-normal text-muted">newest first</span>
        </h2>
        {trail.length === 0 ? (
          <p className="mt-2 text-ui text-muted">Nothing recorded yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-ui">
              <thead>
                <tr className="text-left text-small text-muted">
                  <th className="px-3 py-1.5 font-medium">When</th>
                  <th className="px-3 py-1.5 font-medium">What</th>
                  <th className="px-3 py-1.5 font-medium">Detail</th>
                  <th className="px-3 py-1.5 font-medium">From</th>
                  <th className="px-3 py-1.5 font-medium">Session</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {trail.map((entry, i) => (
                  <tr key={i} className={WARY.has(entry.event) ? 'text-warning' : 'text-ink'}>
                    <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted">{when(entry.at)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{SAID[entry.event] ?? entry.event}</td>
                    <td className="px-3 py-1.5 text-muted">{entry.detail ?? ''}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted">{entry.client ?? ''}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{entry.session ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
