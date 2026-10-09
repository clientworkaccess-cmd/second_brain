import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { HttpError, assertClusterName } from '@/lib/config';
import { isConversationId, readConversation, saveConversation } from '@/lib/conversations';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { revertCommit } from '@/lib/git';
import { acquireBusy, releaseBusy } from '@/lib/jobs';
import { layoutOf } from '@/lib/layout';
import { forgetWiki, snapshot } from '@/lib/wiki';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Undo what one turn of a conversation wrote: its restore point, reverted, as
 * a filing is undone. Refused, with nothing changed, when a later change
 * touched the same pages.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const cluster = assertClusterName(String(body.cluster ?? ''));
    if (!isConversationId(body.id)) throw new HttpError(400, 'Which conversation?');
    const index = Number(body.turn);
    const record = await readConversation(cluster, body.id);
    if (!record) throw new HttpError(404, 'No such conversation');
    const turn = Number.isInteger(index) ? record.turns[index] : undefined;
    if (!turn) throw new HttpError(404, 'No such turn');
    if (!turn.commit) throw new HttpError(409, 'That turn changed nothing, so there is nothing to undo.');
    if (turn.undoCommit) throw new HttpError(409, 'That turn has been undone already.');

    const owner = `undo:${record.id}:${index}`;
    acquireBusy(cluster, owner);
    try {
      const layout = await layoutOf(cluster);
      turn.undoCommit = await revertCommit(cluster, turn.commit, `Undo a conversation turn: ${turn.question.split('\n')[0].slice(0, 72)}`, layout);
      await saveConversation(record);
      forgetWiki(cluster);
      await snapshot(cluster);
    } finally {
      releaseBusy(cluster, owner);
    }
    await audit({
      event: 'conversation-undone',
      client: clientOf(req),
      session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value),
      detail: `${cluster}: ${turn.wrote.slice(0, 6).join(', ')} (${turn.undoCommit ?? ''})`,
    });
    return NextResponse.json({ undoCommit: turn.undoCommit });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[conversations/undo]', err);
    return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
  }
}
