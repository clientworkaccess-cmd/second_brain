import { cookies } from 'next/headers';
import { ShieldCheck } from 'lucide-react';
import { readAudit } from '@/lib/audit';
import { SESSION_COOKIE, secondFactorOn } from '@/lib/env-auth';
import { sessionIdOf } from '@/lib/session';
import { listSessions } from '@/lib/sessions';
import { Center } from '@/components/frame/Frame';
import { StatusItems } from '@/components/frame/controls';
import { SecurityPanel } from '@/components/SecurityPanel';

export const dynamic = 'force-dynamic';

/** Who is signed in, the second factor, and the trail of what was done. */
export default async function SecurityPage() {
  const mine = sessionIdOf((await cookies()).get(SESSION_COOKIE)?.value);
  const [open, trail] = await Promise.all([listSessions(), readAudit(80)]);
  const sessions = open.map((s) => ({ key: s.id, id: s.id.slice(0, 8), createdAt: s.createdAt, expiresAt: s.expiresAt, client: s.client, agent: s.agent, current: s.id === mine }));
  const secondFactor = secondFactorOn();

  return (
    <>
      <Center tab={{ href: '/security', title: 'Security' }}>
        <div className="content">
          <header className="flex items-start gap-3">
            <ShieldCheck className="mt-1 flex-none text-accent" size={22} />
            <div className="min-w-0 flex-1">
              <h1 className="text-title font-semibold text-ink">Security</h1>
              <p className="mt-1 max-w-prose text-body text-muted">
                One login, shared. This is where to see who is using it, end a session that should not be open, and read what was done and from where.
              </p>
            </div>
          </header>
          <SecurityPanel sessions={sessions} trail={trail} secondFactor={secondFactor} />
        </div>
      </Center>
      <StatusItems>
        <span className="statusbar-item muted">
          {sessions.length} signed in · second factor {secondFactor ? 'on' : 'off'}
        </span>
      </StatusItems>
    </>
  );
}
