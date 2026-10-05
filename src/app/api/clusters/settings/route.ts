import { NextRequest, NextResponse } from 'next/server';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { normalise, readSettings, writeSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** What a person has decided about a wiki. GET reads it, POST changes it. */
export async function GET(req: NextRequest) {
  try {
    const cluster = await named(req.nextUrl.searchParams.get('cluster'));
    return NextResponse.json({ settings: await readSettings(cluster) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cluster = await named(body.cluster);
    const settings = await writeSettings(cluster, normalise({ ...(await readSettings(cluster)), ...body.settings }));
    return NextResponse.json({ settings });
  } catch (err) {
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
  console.error('[api/clusters/settings]', err);
  return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
}
