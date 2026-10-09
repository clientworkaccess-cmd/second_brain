import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { CHAT_TIMEOUT_MS, HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { chatPrompt } from '@/lib/chat';
import { CONVERSATION_ID, agentFailure, runClaude, type AgentRun, type Conversation } from '@/lib/claude';
import { layoutOf, type Layout } from '@/lib/layout';
import { modelChoice } from '@/lib/models';
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
 * A question names the model it is asked of (lib/models.ts), or leaves it
 * to the server. A conversation can change model between questions.
 *
 * A question can be the next in a conversation. The client sends the id it was
 * given with the first answer; the agent resumes that session and remembers
 * what was asked and answered before. A conversation the binary no longer has
 * is started afresh, and the client is told.
 */
export async function POST(req: NextRequest) {
  let cluster: string;
  let question: string;
  let layout: Layout;
  let conversation: Conversation;
  let model: string | null;

  try {
    const body = await req.json();
    cluster = assertClusterName(String(body.cluster ?? ''));
    question = String(body.question ?? '').trim();
    if (!question) throw new HttpError(400, 'Ask something');
    if (question.length > 4000) throw new HttpError(400, 'That question is too long');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
    layout = await layoutOf(cluster);
    const given = String(body.conversation ?? '');
    conversation = CONVERSATION_ID.test(given) ? { id: given.toLowerCase(), resume: true } : { id: randomUUID(), resume: false };
    // The model is the reader's choice for this question; anything but a known alias means the server's.
    model = modelChoice(body.model);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const start = (turn: Conversation): AgentRun =>
    runClaude({
      mode: 'chat',
      prompt: chatPrompt(question, layout),
      cwd: clusterPath(cluster),
      layout,
      conversation: turn,
      model,
      timeoutMs: CHAT_TIMEOUT_MS,
    });

  let run: AgentRun | null = null;

  return sseResponse(({ send, close }) => {
    (async () => {
      try {
        let turn = conversation;
        for (;;) {
          const current = start(turn);
          run = current;
          send('session', { id: turn.id });

          // What the agent is doing and what it is saying arrive separately,
          // and both have to be read for the run to finish.
          let streamed = 0;
          const activity = (async () => {
            for await (const line of current.lines) send('activity', { text: line });
          })();
          for await (const text of current.tokens) {
            streamed += text.length;
            send('token', { text });
          }
          await activity;

          const result = await current.done;
          if (result.ok) {
            // What was streamed includes anything the agent said before it had
            // read what it needed. This is the answer it settled on.
            if (result.text.trim()) send('final', { text: result.text });
            // Which model answered, as the binary reported it: the reader sees it under the answer.
            send('end', { model: result.model });
            break;
          }

          // A conversation the binary no longer has: the session was cleaned
          // up, or the server moved. Ask again, from the start, once.
          const lost = turn.resume && streamed === 0 && result.error !== 'logged_out' && result.error !== 'limit';
          if (lost) {
            send('activity', { text: 'The earlier conversation is no longer there. Starting a new one.' });
            turn = { id: randomUUID(), resume: false };
            continue;
          }
          send('error', { message: agentFailure(result, current.stderrTail()) });
          break;
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'The agent failed' });
      } finally {
        close();
      }
    })();

    // If the reader goes away, stop the run.
    return () => run?.kill();
  });
}
