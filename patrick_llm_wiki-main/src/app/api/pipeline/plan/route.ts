import { NextRequest, NextResponse } from 'next/server';
import { HttpError } from '@/lib/config';
import { getJob, revisePlan } from '@/lib/jobs';
import { readPlan } from '@/lib/plans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The plan for one job.
 *
 * GET returns it, so the review card can be rendered after a refresh or from
 * the pending-plans list without replaying the SSE stream.
 *
 * POST is "Revise": send the plan back with a correction and re-run the
 * planning pass. No lock is taken and nothing is written — the cluster has not
 * been touched at this point in the flow.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId') ?? '';
  try {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: 'No such job' }, { status: 404 });

    const plan = await readPlan(jobId);
    if (!plan) {
      return NextResponse.json({ error: 'No plan for this job' }, { status: 404 });
    }
    return NextResponse.json({ job, plan });
  } catch (err) {
    return fail(err, 'Could not read the plan');
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const jobId = String(body.jobId ?? '');
    const feedback = String(body.feedback ?? '').trim();

    if (!feedback) throw new HttpError(400, 'Say what you want changed');
    if (feedback.length > 4000) throw new HttpError(400, 'That feedback is too long');

    const job = await revisePlan(jobId, feedback);
    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    return fail(err, 'Could not revise the plan');
  }
}

function fail(err: unknown, fallback: string): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error('[api/pipeline/plan]', err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
