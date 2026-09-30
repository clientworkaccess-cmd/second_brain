import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { exists } from '@/lib/clusters';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { renamePage } from '@/lib/rename';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A page given a new title: the file name follows, and so does every link to it. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cluster = assertClusterName(String(body.cluster ?? ''));
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
    const slug = String(body.slug ?? '');
    const result = await renamePage(cluster, slug, String(body.title ?? ''));
    await audit({ event: 'page-renamed', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${cluster}: ${result.from} → ${result.to} (${result.rewritten.length} pages relinked)` });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[api/page/rename]', err);
    return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
  }
}
