import { NextRequest, NextResponse } from 'next/server';
import { listImages } from '@/lib/assets';
import { exists } from '@/lib/clusters';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The images a wiki has, as paths from its root, for the editor to resolve `![[name.png]]` against. */
export async function GET(req: NextRequest) {
  try {
    const cluster = assertClusterName(req.nextUrl.searchParams.get('cluster') ?? '');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);
    return NextResponse.json({ images: await listImages(cluster) });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[api/assets]', err);
    return NextResponse.json({ error: 'Something went wrong on the server' }, { status: 500 });
  }
}
