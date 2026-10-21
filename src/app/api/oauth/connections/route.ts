import { NextResponse } from 'next/server';
import { audit, clientOf } from '@/lib/audit';
import { endConnection, listConnections } from '@/lib/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The apps connected to the brain (Claude), for the Security page. Behind the login. */
export async function GET() {
  return NextResponse.json({ connections: await listConnections() });
}

/** End one connection: its tokens stop working at once. */
export async function DELETE(request: Request) {
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== 'string') return NextResponse.json({ error: 'Say which connection' }, { status: 400 });
  const ended = await endConnection(id);
  if (!ended) return NextResponse.json({ error: 'No such connection' }, { status: 404 });
  void audit({ event: 'mcp-disconnected', client: clientOf(request), detail: ended.clientName });
  return NextResponse.json({ ok: true });
}
