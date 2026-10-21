import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { checkAuthorize, deniedRedirect, issueCode, originOf } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The owner's answer on /oauth/authorize. Behind the login (only a signed-in
 * browser gets here) and only from this site's own page: a form on another
 * site cannot say yes for the owner.
 */
export async function POST(request: Request) {
  const origin = originOf(request);
  if (request.headers.get('origin') !== origin) return NextResponse.json({ error: 'This can only be answered on the brain itself' }, { status: 403 });

  const form = new URLSearchParams(await request.text());
  const checked = await checkAuthorize(form);
  if ('fatal' in checked) return NextResponse.json({ error: checked.fatal }, { status: 400 });
  if ('redirect' in checked) return NextResponse.redirect(checked.redirect, 303);

  const session = sessionLabel((await cookies()).get(SESSION_COOKIE)?.value);
  if (form.get('decision') !== 'allow') {
    void audit({ event: 'mcp-refused', client: clientOf(request), session, detail: checked.ok.client.name });
    return NextResponse.redirect(deniedRedirect(checked.ok), 303);
  }
  const to = await issueCode(checked.ok, origin);
  void audit({ event: 'mcp-authorized', client: clientOf(request), session, detail: checked.ok.client.name });
  return NextResponse.redirect(to, 303);
}
