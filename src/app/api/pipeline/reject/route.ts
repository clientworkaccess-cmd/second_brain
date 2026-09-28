import { NextRequest, NextResponse } from 'next/server';
import { HttpError } from '@/lib/config';
import { rejectPlan } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Reject. No agent runs, so no API spend, and the cluster was never touched.
 *
 * This is plain fs cleanup, not a git operation — the staged markdown, the
 * archived original and the plan JSON all live in .dashboard/, outside any
 * cluster and outside version control. There is nothing to revert because
 * nothing was ever committed.
 *
 * The job record itself survives, as the trail that a document was looked at
 * and turned down.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const jobId = String(body.jobId ?? '');
    const job = await rejectPlan(jobId);
    return NextResponse.json({ job });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[api/pipeline/reject]', err);
    return NextResponse.json({ error: 'Could not discard this upload' }, { status: 500 });
  }
}
