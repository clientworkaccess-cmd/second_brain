import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { CHAT_TIMEOUT_MS, HttpError, INGEST_TIMEOUT_MS, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { chatPrompt, recapPrompt, sourcesOf, workPrompt } from '@/lib/chat';
import { agentFailure, runClaude, type AgentRun } from '@/lib/claude';
import {
  appendTurn,
  beginTurn,
  conversationSource,
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
import { beforeIngest, lintAfterIngest, sourceFingerprints } from '@/lib/lint';
import { learnFrom, turnContext } from '@/lib/learn';
import { asksForThinking, modelChoice } from '@/lib/models';
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
 * restore point that the reader can undo. So that it has something to write
 * from, the conversation is kept under the wiki's sources first, as an
 * uploaded document is before a filing (lib/conversations.ts
 * conversationSource), and taken away again if nothing was written.
 *
 * A question names the model it is asked of (lib/models.ts), or leaves it to
 * the server. In Discuss the reader can switch the web on for a message; then,
 * and only then, the run has WebSearch and WebFetch. Never in Work, which can
 * write, and never in a filing.
 */
export async function POST(req: NextRequest) {
  let cluster: string;
  let question: string;
  let layout: Layout;
  let record: ConversationRecord;
  let model: string | null;
  let mode: ConversationMode;
  let web = false;
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
    // The web is the reader's to switch on, message by message, and only where nothing can be written.
    web = mode === 'discuss' && body.web === true;
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
  if (web) await audit({ event: 'conversation-web', client, session: who, detail: `${cluster}: ${record.id.slice(0, 8)}` });

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

  /** Work only: the conversation's source file, which this turn adds to and writes from. From the wiki's folder. */
  let source: string | null = null;
  /** What that file held before this turn added to it; null when this turn began it. */
  let sourceBefore: string | null = null;
  const promptFor = (recap: string): string =>
    `${recap}${mode === 'work' ? workPrompt(question, layout, source ? { path: source, continued: sourceBefore !== null } : null) : chatPrompt(question, layout, web)}`;
  /** Put the source file back as it was before this turn: nothing was written from what it added. */
  const withdrawSource = async (): Promise<void> => {
    if (!source) return;
    const file = clusterPath(cluster, source);
    if (sourceBefore !== null) await fs.writeFile(file, sourceBefore, 'utf8');
    else await fs.rm(file, { force: true });
    source = null;
  };
  /** Who the reader is, how to think and write, and the owner's memory as it is now (lib/learn.ts). */
  let context = '';
  const start = (sessionId: string, resume: boolean, recap: string): AgentRun =>
    runClaude({
      mode: mode === 'work' ? 'work' : 'chat',
      prompt: promptFor(recap),
      cwd: clusterPath(cluster),
      layout,
      conversation: { id: sessionId, resume },
      // Left to the default, a message that asks for thinking is asked of Opus. The record keeps the reader's choice.
      model: model ?? (asksForThinking(question) ? 'opus' : null),
      web,
      context,
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
        source: null,
        web,
        commit: null,
        undoCommit: null,
        findings: [],
        error: null,
      };
      let before: Snapshot | null = null;
      let baseline: Awaited<ReturnType<typeof beforeIngest>> | null = null;
      try {
        send('conversation', { id: record.id, title: record.title });
        context = await turnContext();

        if (mode === 'work') {
          // The restore point first, for a wiki that came here without history.
          await ensureRepo(cluster, layout);
          before = await snapshot(cluster);
          baseline = await beforeIngest(cluster, before, layout);

          // The conversation, kept where sources are kept, as an uploaded
          // document is before a filing: the wiki's rules ask for a source, and
          // the agent may not write there. Taken into the baseline, so the check
          // afterwards notices if the agent changes it.
          // One file for the conversation: begun by its first turn that writes, added to by each later one.
          const kept = conversationSource(record, question);
          const rawDir = clusterPath(cluster, layout.rawDir);
          await fs.mkdir(rawDir, { recursive: true });
          const existing = record.source ? await fs.readFile(clusterPath(cluster, record.source), 'utf8').catch(() => null) : null;
          if (record.source && existing !== null) {
            sourceBefore = existing;
            source = record.source;
            await fs.writeFile(clusterPath(cluster, source), `${existing.trimEnd()}\n\n${kept.section}`, 'utf8');
          } else {
            // Its name, unless another conversation of the same name on the same day has it.
            const taken = await fs.stat(path.join(rawDir, kept.name)).then(() => true, () => false);
            const name = taken && !record.source ? kept.name.replace(/\.md$/, `-${record.id.slice(0, 8)}.md`) : kept.name;
            await fs.writeFile(path.join(rawDir, name), `${kept.head}\n${kept.section}`, 'utf8');
            source = `${layout.rawDir}/${name}`;
          }
          baseline.sources = await sourceFingerprints(cluster, layout);
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
          if (source && turn.wrote.length === 0) {
            // Nothing was written from what this turn added, so it is taken back out.
            await withdrawSource();
            baseline.sources = await sourceFingerprints(cluster, layout);
          }
          turn.source = source;
          if (source) record.source = source;
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
        // A turn that wrote nothing leaves no source behind, however it ended.
        if (source && turn.wrote.length === 0) {
          await withdrawSource().catch(() => {});
          turn.source = null;
        }
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
            source: turn.source,
            web: turn.web,
            commit: turn.commit,
            findings: turn.findings,
            turn: record.turns.length - 1,
          });
        close();
        // What the reader taught in this message, if anything, kept for the next ones. In the background: the
        // reply has already been sent, and a learning run that fails changes nothing.
        if (!turn.error && turn.answer.trim()) void learnFrom({ question, answer: turn.answer, layout });
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
