import { NextRequest, NextResponse } from 'next/server';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { runHermes } from '@/lib/hermes';
import { sseResponse } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Chat, scoped to exactly one cluster.
 *
 * Reads do not take the busy lock — they are non-destructive and run
 * concurrently. Only ingest serializes.
 *
 * Whether the answer actually arrives incrementally depends on whether
 * `hermes -z` emits anything mid-run, which is unverified (T1a). The client
 * handles both: tokens as they land, or one block at the end. If it turns out
 * not to stream, this endpoint keeps working and only the feel changes.
 */
export async function POST(req: NextRequest) {
  let cluster: string;
  let question: string;

  try {
    const body = await req.json();
    cluster = assertClusterName(String(body.cluster ?? ''));
    question = String(body.question ?? '').trim();
    if (!question) throw new HttpError(400, 'Ask something');
    if (question.length > 4000) throw new HttpError(400, 'That question is too long');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const prompt = [
    `Answer this question using only the wiki in your working directory: "${question}"`,
    ``,
    `Start from index.md and follow [[wikilinks]] to the pages that matter. Do not guess —`,
    `if the wiki does not cover it, say so plainly.`,
    ``,
    `End your answer with a line of the form:`,
    `SOURCES: [[Page Name]], [[Other Page]]`,
  ].join('\n');

  const run = runHermes({
    prompt,
    clusterPath: clusterPath(cluster),
    timeoutMs: 5 * 60 * 1000,
  });

  return sseResponse(({ send, close }) => {
    (async () => {
      try {
        for await (const line of run.lines) send('token', { text: line + '\n' });
        await run.done;
        send('end', {});
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'The agent failed' });
      } finally {
        close();
      }
    })();

    // If the reader goes away, stop paying for the answer.
    return () => run.kill();
  });
}
