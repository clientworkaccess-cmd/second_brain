import { NextRequest, NextResponse } from 'next/server';
import { HttpError } from '@/lib/config';
import { approvePlan } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Approve. The only endpoint in the pipeline that writes into a cluster.
 *
 * Returns 202 immediately — the write is minutes long and the client follows it
 * over SSE, the same way it followed the planning pass. Everything that could
 * refuse (wrong state, missing plan, another writer holding the cluster, a plan
 * made against a wiki that has since moved) is checked inside approvePlan
 * before the job flips to executing, so a rejection arrives here as a status
 * code rather than as a half-finished ingest.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const jobId = String(body.jobId ?? '');
    const job = await approvePlan(jobId);
    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[api/pipeline/execute]', err);
    return NextResponse.json({ error: 'Could not start the ingest' }, { status: 500 });
  }
}
