import { NextRequest, NextResponse } from 'next/server';
import { audit, clientOf, sessionLabel } from '@/lib/audit';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { SESSION_COOKIE } from '@/lib/env-auth';
import { PageMovedOn, readPageSource, writePageSource } from '@/lib/pages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A page as text, for the editor. GET reads it; PUT writes it.
 *
 * A PUT carries the version it read. A page that changed on disk since then
 * is refused with 409 and what it holds now, so the writer can decide. `force`
 * overrides that; `commit` makes a restore point afterwards.
 */
export async function GET(req: NextRequest) {
  try {
    const cluster = await named(req.nextUrl.searchParams.get('cluster'));
    const slug = String(req.nextUrl.searchParams.get('slug') ?? '');
    return NextResponse.json(await readPageSource(cluster, slug));
  } catch (err) {
    return fail(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const cluster = await named(body.cluster);
    const slug = String(body.slug ?? '');
    const text = typeof body.text === 'string' ? body.text : null;
    if (text === null) throw new HttpError(400, 'No text');
    const result = await writePageSource(cluster, slug, text, {
      version: typeof body.version === 'string' ? body.version : undefined,
      force: body.force === true,
      commit: body.commit === true,
    });
    await audit({ event: 'page-saved', client: clientOf(req), session: sessionLabel(req.cookies.get(SESSION_COOKIE)?.value), detail: `${cluster}: ${slug}${result.created ? ' (new)' : ''}${body.commit === true ? ' (restore point)' : ''}` });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof PageMovedOn) {
      return NextResponse.json({ error: err.message, version: err.version, text: err.text }, { status: 409 });
    }
    return fail(err);
  }
}

async function named(value: unknown): Promise<string> {
  const cluster = assertClusterName(String(value ?? ''));
  if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
  return cluster;
}

function fail(err: unknown) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error('[api/page]', err);
  return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
}
