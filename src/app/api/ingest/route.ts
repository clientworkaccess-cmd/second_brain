import { NextRequest, NextResponse } from 'next/server';
import { HttpError, assertClusterName } from '@/lib/config';
import { enqueue, ensureIngestWorker, ingestRefusal, parseIngest, queueSummary } from '@/lib/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Documents sent in from the server itself (n8n): POST one to have it filed,
 * GET to see how the queue stands. Not behind the login (lib/gate.ts), and so
 * refused to anything that came through nginx; see ingestRefusal in
 * lib/ingest.ts.
 *
 *   POST { brain, title, text, sourceId, kind?: email|transcript|document, date?: YYYY-MM-DD }
 *     202 { status: "queued", id, position }   filed in turn, as an upload is
 *     200 { status: "duplicate", id }          this sourceId was sent before
 */
export async function POST(req: NextRequest) {
  const refused = ingestRefusal(req.headers);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  ensureIngestWorker();
  try {
    const body = await req.json().catch(() => {
      throw new HttpError(400, 'Send a JSON object.');
    });
    const result = await enqueue(parseIngest(body));
    return NextResponse.json(result, { status: result.status === 'queued' ? 202 : 200 });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[api/ingest]', err);
    return NextResponse.json({ error: 'Could not take the document' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const refused = ingestRefusal(req.headers);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  ensureIngestWorker();
  try {
    const brain = req.nextUrl.searchParams.get('brain');
    return NextResponse.json(await queueSummary(brain ? assertClusterName(brain) : undefined));
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: 'Could not read the queue' }, { status: 500 });
  }
}
