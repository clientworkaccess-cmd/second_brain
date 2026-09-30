import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { HttpError } from '@/lib/config';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { undoFiling } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Undo. The commit that captured a filing is reverted: the pages it wrote and
 * the source it filed are taken back out, in a commit of their own.
 *
 * Synchronous: a revert takes a moment, not minutes. What can refuse (a filing
 * that is not filed, one that was never committed, another writer holding the
 * wiki, a later filing that changed the same pages) arrives as a status code,
 * and then nothing was changed.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const job = await undoFiling(String(body.jobId ?? ''));
    await audit({ event: 'filing-undone', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${job.cluster}: ${job.filename} (${job.undoCommit ?? '?'})` });
    return NextResponse.json({ job });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[api/pipeline/undo]', err);
    return NextResponse.json({ error: 'Could not undo the filing' }, { status: 500 });
  }
}
