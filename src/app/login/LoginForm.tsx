'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mark } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui';
import { returnPath } from '@/lib/gate';

/**
 * The sign-in, in up to three steps: the email and password with the captcha;
 * then, where a second factor is set up, where to send the code (or, under
 * "other ways", the authenticator app); then the code itself.
 */

// The captcha widget is a web component; React is told what it takes.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'altcha-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { challenge?: string; configuration?: string };
    }
  }
}

type Method = 'email' | 'sms' | 'totp';
interface Offer {
  kind: Method;
  to: string;
}
type Step = { at: 'password' } | { at: 'choose'; ticket: string; methods: Offer[] } | { at: 'code'; ticket: string; methods: Offer[]; method: Method; to: string };

const SAID: Record<Method, string> = { email: 'Email a code to', sms: 'Text a code to', totp: 'Use your authenticator app' };

export function LoginForm({ captcha }: { captcha: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = returnPath(searchParams.get('from'));

  const [step, setStep] = useState<Step>({ at: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [solved, setSolved] = useState<string | null>(null);
  const [otherWays, setOtherWays] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const widgetRef = useRef<HTMLElement | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // The captcha widget is a web component; it is loaded in the browser only.
  useEffect(() => {
    if (!captcha) return;
    let gone = false;
    void import('altcha').then(() => {
      const widget = widgetRef.current;
      if (gone || !widget) return;
      widget.addEventListener('statechange', (event) => {
        const detail = (event as CustomEvent<{ state: string; payload?: string }>).detail;
        setSolved(detail.state === 'verified' && detail.payload ? detail.payload : null);
      });
    });
    return () => {
      gone = true;
    };
  }, [captcha]);

  useEffect(() => {
    if (step.at === 'code') codeRef.current?.focus();
  }, [step]);

  async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  }

  function done() {
    router.push(from);
    router.refresh();
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (captcha && !solved) {
      setError('Tick the box first; it takes a second.');
      return;
    }
    setLoading(true);
    try {
      const { ok, data } = await post('/api/auth/login', captcha ? { email, password, captcha: solved } : { email, password });
      if (!ok) {
        setError(String(data.error ?? 'Invalid email or password'));
        resetCaptcha();
        return;
      }
      if (Array.isArray(data.methods) && typeof data.ticket === 'string') {
        const methods = data.methods as Offer[];
        const first = methods.find((m) => m.kind !== 'totp');
        if (first) await send(data.ticket, methods, first);
        else setStep({ at: 'choose', ticket: data.ticket, methods });
        return;
      }
      done();
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  function resetCaptcha() {
    setSolved(null);
    (widgetRef.current as (HTMLElement & { reset?: () => void }) | null)?.reset?.();
  }

  /** Send a code one way and move to entering it. */
  async function send(ticket: string, methods: Offer[], offer: Offer) {
    setError(null);
    setNotice(null);
    setCode('');
    if (offer.kind === 'totp') {
      setStep({ at: 'code', ticket, methods, method: 'totp', to: '' });
      return;
    }
    setLoading(true);
    try {
      const { ok, data } = await post('/api/auth/code', { ticket, method: offer.kind });
      if (!ok) {
        setError(String(data.error ?? 'The code could not be sent'));
        if (step.at === 'password') setStep({ at: 'choose', ticket, methods });
        return;
      }
      setStep({ at: 'code', ticket, methods, method: offer.kind, to: String(data.to ?? offer.to) });
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (step.at !== 'code') return;
    setError(null);
    setLoading(true);
    try {
      const { ok, status, data } = await post('/api/auth/verify', { ticket: step.ticket, method: step.method, code });
      if (!ok) {
        setError(String(data.error ?? 'That code is not right'));
        setCode('');
        if (status === 410) setStep({ at: 'password' });
        return;
      }
      done();
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  const alert = error && (
    <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-ui text-danger">
      {error}
    </p>
  );

  return (
    <div className="w-full max-w-[340px]">
      <div className="flex flex-col items-center text-center">
        <Mark size={52} />
        <h1 className="mt-4 text-display font-bold text-ink">Second Brain</h1>
        <p className="mt-1 text-body text-muted">
          {step.at === 'password' ? 'Sign in to continue' : step.at === 'choose' ? 'One more step' : step.method === 'totp' ? 'Your authenticator app' : 'Check your messages'}
        </p>
      </div>

      {step.at === 'password' && (
        <form onSubmit={submitPassword} className="mt-6 space-y-3.5 rounded border border-line bg-panel p-5">
          {alert}
          <Field label="Email address">
            <Input type="email" required autoFocus autoComplete="username" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {captcha && (
            <div className="captcha">
              <altcha-widget ref={widgetRef} challenge="/api/auth/captcha" configuration='{"hideLogo":true,"hideFooter":true}' />
            </div>
          )}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}

      {step.at === 'choose' && (
        <div className="mt-6 space-y-3 rounded border border-line bg-panel p-5">
          {alert}
          <p className="text-ui text-muted">Where should the code go?</p>
          {step.methods
            .filter((m) => m.kind !== 'totp')
            .map((m) => (
              <Button key={m.kind} type="button" variant="quiet" className="w-full justify-start" disabled={loading} onClick={() => void send(step.ticket, step.methods, m)}>
                {SAID[m.kind]} {m.to}
              </Button>
            ))}
          <OtherWays step={step} open={otherWays} setOpen={setOtherWays} onPick={(m) => void send(step.ticket, step.methods, m)} />
          <button type="button" className="text-small text-faint hover:text-muted" onClick={() => setStep({ at: 'password' })}>
            Start again
          </button>
        </div>
      )}

      {step.at === 'code' && (
        <form onSubmit={submitCode} className="mt-6 space-y-3.5 rounded border border-line bg-panel p-5">
          {alert}
          {notice && <p className="text-ui text-muted">{notice}</p>}
          <Field
            label={step.method === 'totp' ? 'Code from your authenticator app' : 'The six-digit code'}
            hint={step.method === 'totp' ? undefined : `${step.method === 'email' ? 'Sent to' : 'Texted to'} ${step.to}. It lasts 10 minutes.`}
          >
            <Input ref={codeRef} type="text" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? 'Checking…' : 'Continue'}
          </Button>
          <div className="flex items-center justify-between text-small">
            {step.method !== 'totp' ? (
              <button
                type="button"
                className="text-faint hover:text-muted"
                disabled={loading}
                onClick={async () => {
                  const offer = step.methods.find((m) => m.kind === step.method);
                  if (offer) {
                    await send(step.ticket, step.methods, offer);
                    setNotice('Sent again.');
                  }
                }}
              >
                Send it again
              </button>
            ) : (
              <span />
            )}
            <OtherWays step={step} open={otherWays} setOpen={setOtherWays} onPick={(m) => void send(step.ticket, step.methods, m)} inline />
          </div>
        </form>
      )}
    </div>
  );
}

/** The subtle way to the other methods, the authenticator app among them. */
function OtherWays({ step, open, setOpen, onPick, inline = false }: { step: Exclude<Step, { at: 'password' }>; open: boolean; setOpen: (v: boolean) => void; onPick: (m: Offer) => void; inline?: boolean }) {
  const others = step.methods.filter((m) => !(step.at === 'code' && m.kind === step.method));
  if (others.length === 0) return inline ? <span /> : null;
  return (
    <div className={inline ? 'relative text-right' : 'pt-1'}>
      <button type="button" className="text-small text-faint hover:text-muted" aria-expanded={open} onClick={() => setOpen(!open)}>
        Other ways
      </button>
      {open && (
        <div className={`mt-2 space-y-1.5 ${inline ? 'text-left' : ''}`}>
          {others.map((m) => (
            <button key={m.kind} type="button" className="block w-full rounded px-2 py-1 text-left text-ui text-ink hover:bg-hover" onClick={() => onPick(m)}>
              {SAID[m.kind]} {m.to}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
