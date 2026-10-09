import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { createConversation, deleteConversation, isConversationId, listConversations, renameConversation } from '@/lib/conversations';
import { SESSION_COOKIE } from '@/lib/env-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The conversations with one wiki. GET lists them, newest first; POST starts
 * one; PATCH renames one; DELETE removes one. What was said is in
 * lib/conversations.ts; questions are asked through /api/chat.
 */

async function named(value: unknown): Promise<string> {
  const cluster = assertClusterName(String(value ?? ''));
  if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
  return cluster;
}

function fail(err: unknown): NextResponse {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error('[conversations]', err);
  return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const cluster = await named(req.nextUrl.searchParams.get('cluster'));
    return NextResponse.json({ conversations: await listConversations(cluster) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const cluster = await named(body.cluster);
    const record = await createConversation(cluster);
    await audit({ event: 'conversation-started', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${cluster}: ${record.id.slice(0, 8)}` });
    return NextResponse.json({ id: record.id, title: record.title }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const cluster = await named(body.cluster);
    if (!isConversationId(body.id)) throw new HttpError(400, 'Which conversation?');
    const record = await renameConversation(cluster, body.id, String(body.title ?? ''));
    return NextResponse.json({ id: record.id, title: record.title });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const cluster = await named(body.cluster);
    if (!isConversationId(body.id)) throw new HttpError(400, 'Which conversation?');
    if (!(await deleteConversation(cluster, body.id))) throw new HttpError(404, 'No such conversation');
    await audit({ event: 'conversation-deleted', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${cluster}: ${body.id.slice(0, 8)}` });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return fail(err);
  }
}
