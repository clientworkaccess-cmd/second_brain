import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { CHAT_TIMEOUT_MS, HttpError, INGEST_TIMEOUT_MS, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { chatPrompt, recapPrompt, sourcesOf, workPrompt } from '@/lib/chat';
import { agentFailure, runClaude, type AgentRun } from '@/lib/claude';
import {
  appendTurn,
  beginTurn,
  createConversation,
  endTurn,
  isConversationId,
  readConversation,
  saveConversation,
  type ConversationMode,
  type ConversationRecord,
  type ConversationTurn,
} from '@/lib/conversations';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { commitCluster, ensureRepo } from '@/lib/git';
import { acquireBusy, releaseBusy } from '@/lib/jobs';
import { layoutOf, type Layout } from '@/lib/layout';
import { beforeIngest, lintAfterIngest } from '@/lib/lint';
import { modelChoice } from '@/lib/models';
import { sseResponse } from '@/lib/sse';
import { forgetWiki, snapshot, type Snapshot } from '@/lib/wiki';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A question, in a conversation with one wiki.
 *
 * Every conversation is kept by the app (lib/conversations.ts): the client
 * names it by its id, or names none and one is started. The agent resumes
 * Claude Code's own session for it, which is what lets it remember; when the
 * binary has forgotten (cleaned up, or the server moved), the question is
 * given a recap of the conversation from the record, and it carries on.
 *
 * Discuss, the default: the chat profile in lib/claude.ts gives the agent
 * reading tools only, so the question cannot change the wiki however it is
 * phrased, and it runs beside anything else. Work: the agent may write where a
 * filing may. Then the turn holds the wiki as a filing does, the wiki is
 * checked afterwards as a filing is, and what it wrote is committed as one
 * restore point that the reader can undo.
 *
 * A question names the model it is asked of (lib/models.ts), or leaves it to
 * the server.
 */
export async function POST(req: NextRequest) {
  let cluster: string;
  let question: string;
  let layout: Layout;
  let record: ConversationRecord;
  let model: string | null;
  let mode: ConversationMode;
  let created = false;

  try {
    const body = await req.json();
    cluster = assertClusterName(String(body.cluster ?? ''));
    question = String(body.question ?? '').trim();
    if (!question) throw new HttpError(400, 'Ask something');
    if (question.length > 8000) throw new HttpError(400, 'That question is too long');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
    layout = await layoutOf(cluster);
    // The model is the reader's choice for this question; anything but a known alias means the server's.
    model = modelChoice(body.model);
    mode = body.mode === 'work' ? 'work' : 'discuss';
    if (body.conversation !== undefined && body.conversation !== null && body.conversation !== '') {
      if (!isConversationId(body.conversation)) throw new HttpError(400, 'Which conversation?');
      const found = await readConversation(cluster, body.conversation);
      if (!found) throw new HttpError(404, 'That conversation is not there any more. Start a new one.');
      record = found;
    } else {
      record = await createConversation(cluster);
      created = true;
    }
    beginTurn(record.id);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const client = clientOf(req);
  const who = sessionLabel(req.cookies.get(SESSION_COOKIE)?.value);
  if (created) await audit({ event: 'conversation-started', client, session: who, detail: `${cluster}: ${record.id.slice(0, 8)}` });

  // A turn that may write holds the wiki for as long as it runs, as a filing does.
  const owner = `conversation:${record.id}`;
  if (mode === 'work') {
    try {
      acquireBusy(cluster, owner);
    } catch (err) {
      endTurn(record.id);
      const status = err instanceof HttpError ? err.status : 500;
      return NextResponse.json({ error: err instanceof Error ? err.message : 'The wiki is busy' }, { status });
    }
  }

  const promptFor = (recap: string): string => `${recap}${mode === 'work' ? workPrompt(question, layout) : chatPrompt(question, layout)}`;
  const start = (sessionId: string, resume: boolean, recap: string): AgentRun =>
    runClaude({
      mode: mode === 'work' ? 'work' : 'chat',
      prompt: promptFor(recap),
      cwd: clusterPath(cluster),
      layout,
      conversation: { id: sessionId, resume },
      model,
      timeoutMs: mode === 'work' ? INGEST_TIMEOUT_MS : CHAT_TIMEOUT_MS,
    });

  let run: AgentRun | null = null;

  return sseResponse(({ send, close }) => {
    (async () => {
      const turn: ConversationTurn = {
        at: new Date().toISOString(),
        question,
        answer: '',
        sources: [],
        mode,
        model,
        answeredBy: null,
        wrote: [],
        commit: null,
        undoCommit: null,
        findings: [],
        error: null,
      };
      let before: Snapshot | null = null;
      let baseline: Awaited<ReturnType<typeof beforeIngest>> | null = null;
      try {
        send('conversation', { id: record.id, title: record.title });

        if (mode === 'work') {
          // The restore point first, for a wiki that came here without history.
          await ensureRepo(cluster, layout);
          before = await snapshot(cluster);
          baseline = await beforeIngest(cluster, before, layout);
        }

        // Resume the binary's session when it has one; otherwise start it, with a
        // recap when the conversation already has turns it would not know of.
        let sessionId = record.session.id;
        let resume = record.session.started;
        let recap = resume ? '' : recapPrompt(record.turns);

        for (;;) {
          const current = start(sessionId, resume, recap);
          run = current;

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
            turn.answer = result.text;
            turn.answeredBy = result.model;
            record.session = { id: sessionId, started: true };
            // What was streamed includes anything the agent said before it had
            // read what it needed. This is the answer it settled on.
            if (result.text.trim()) send('final', { text: result.text });
            break;
          }

          // The binary no longer has this conversation's session: pick it back
          // up from the record, once.
          const lost = resume && streamed === 0 && result.error !== 'logged_out' && result.error !== 'limit';
          if (lost) {
            send('activity', { text: 'Picking the conversation back up' });
            sessionId = randomUUID();
            resume = false;
            recap = recapPrompt(record.turns);
            record.session = { id: sessionId, started: false };
            continue;
          }
          turn.error = agentFailure(result, current.stderrTail());
          break;
        }

        turn.sources = sourcesOf(turn.answer);

        if (mode === 'work' && before && baseline) {
          // What changed is read from the disk, not taken from what the agent says.
          forgetWiki(cluster);
          const after = await snapshot(cluster);
          const touched = new Set<string>();
          for (const [slug, print] of after.pages) if (before.pages.get(slug) !== print) touched.add(slug);
          for (const slug of before.pages.keys()) if (!after.pages.has(slug)) touched.add(slug);
          turn.wrote = [...touched].sort();
          const lint = await lintAfterIngest(cluster, baseline, 'turn');
          turn.findings = lint.findings.map((f) => ({ severity: f.severity, detail: f.detail }));
          turn.commit = await commitCluster(
            cluster,
            `Conversation "${record.title}": ${question.split('\n')[0].slice(0, 72)}\n\n${lint.ok ? 'Checks passed.' : 'Checks found problems; see the conversation.'}`,
            layout,
          );
          if (turn.wrote.length > 0) {
            await audit({
              event: 'conversation-wrote',
              client,
              session: who,
              detail: `${cluster}: ${turn.wrote.slice(0, 6).join(', ')}${turn.wrote.length > 6 ? ' …' : ''} (${turn.commit ?? 'not committed'})`,
            });
          }
        }
      } catch (err) {
        turn.error = err instanceof Error ? err.message : 'The agent failed';
      } finally {
        if (mode === 'work') releaseBusy(cluster, owner);
        try {
          await appendTurn(record, turn);
        } catch (err) {
          console.error('[chat] could not keep the turn', err);
          await saveConversation(record).catch(() => {});
        }
        endTurn(record.id);
        if (turn.error) send('error', { message: turn.error, title: record.title, turn: record.turns.length - 1 });
        else
          send('end', {
            model: turn.answeredBy,
            title: record.title,
            wrote: turn.wrote,
            commit: turn.commit,
            findings: turn.findings,
            turn: record.turns.length - 1,
          });
        close();
      }
    })();

    // If the reader goes away, a question that only reads is stopped. One that
    // may write is let finish: it is checked and committed, and the reader
    // finds it in the conversation when they come back.
    return () => {
      if (mode !== 'work') run?.kill();
    };
  });
}
