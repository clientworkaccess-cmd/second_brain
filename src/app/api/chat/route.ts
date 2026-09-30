import { NextRequest, NextResponse } from 'next/server';
import { CHAT_TIMEOUT_MS, HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { chatPrompt } from '@/lib/chat';
import { agentFailure, runClaude } from '@/lib/claude';
import { layoutOf, type Layout } from '@/lib/layout';
import { sseResponse } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Chat, scoped to exactly one cluster.
 *
 * Reads do not take the busy lock — they are non-destructive and run
 * concurrently. Only ingest serializes. The chat profile in lib/claude.ts gives
 * the agent reading tools and nothing else, so a question cannot change the
 * wiki however it is phrased.
 *
 * Each question stands alone: nothing of the previous answer is sent along.
 */
export async function POST(req: NextRequest) {
  let cluster: string;
  let question: string;
  let layout: Layout;

  try {
    const body = await req.json();
    cluster = assertClusterName(String(body.cluster ?? ''));
    question = String(body.question ?? '').trim();
    if (!question) throw new HttpError(400, 'Ask something');
    if (question.length > 4000) throw new HttpError(400, 'That question is too long');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
    layout = await layoutOf(cluster);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const run = runClaude({
    mode: 'chat',
    prompt: chatPrompt(question, layout),
    cwd: clusterPath(cluster),
    layout,
    timeoutMs: CHAT_TIMEOUT_MS,
  });

  return sseResponse(({ send, close }) => {
    (async () => {
      try {
        // What the agent is doing and what it is saying arrive separately, and
        // both have to be read for the run to finish.
        const activity = (async () => {
          for await (const line of run.lines) send('activity', { text: line });
        })();
        for await (const text of run.tokens) send('token', { text });
        await activity;

        const result = await run.done;
        if (result.ok) {
          // What was streamed includes anything the agent said before it had
          // read what it needed. This is the answer it settled on.
          if (result.text.trim()) send('final', { text: result.text });
          send('end', {});
        } else {
          send('error', { message: agentFailure(result, run.stderrTail()) });
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'The agent failed' });
      } finally {
        close();
      }
    })();

    // If the reader goes away, stop the run.
    return () => run.kill();
  });
}
