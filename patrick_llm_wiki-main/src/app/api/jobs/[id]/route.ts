import { NextRequest, NextResponse } from 'next/server';
import { getJob, isActive, subscribe } from '@/lib/jobs';
import { sseResponse } from '@/lib/sse';
import { HttpError } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live progress for one ingest.
 *
 * Replays everything that has already happened before streaming new events, so
 * a client that refreshes mid-ingest — or opens the page late — sees the whole
 * run, not just the tail.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let job;
  try {
    job = await getJob(id);
  } catch (err) {
    // A malformed id is a bad request, not a server fault. Without this it
    // surfaces as a 500 and looks like the job system broke.
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (!job) return NextResponse.json({ error: 'No such job' }, { status: 404 });

  return sseResponse(({ send, close }) => {
    send('job', job);

    // An ingest is now two agent runs with a human decision between them, so
    // the stream ends whenever no process is running — including at
    // awaiting_approval, which is a resting state, not a finished one. The
    // client re-attaches when the human approves or asks for a revision.
    if (!isActive(job.status)) {
      close();
      return;
    }

    const unsubscribe = subscribe(id, (updated) => {
      send('job', updated);
      if (!isActive(updated.status)) {
        send('end', { status: updated.status });
        close();
      }
    });

    // Keep the connection warm through idle stretches — an ingest can be quiet
    // for a long time while the agent is thinking.
    const ping = setInterval(() => send('ping', Date.now()), 20_000);

    return () => {
      clearInterval(ping);
      unsubscribe();
    };
  });
}
