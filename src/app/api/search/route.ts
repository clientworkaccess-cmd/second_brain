import { NextRequest, NextResponse } from 'next/server';
import { HttpError, assertClusterName, clusterPath } from '@/lib/config';
import { exists } from '@/lib/clusters';
import { searchCluster } from '@/lib/search';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Search the pages of one cluster. Reads only. */
export async function GET(req: NextRequest) {
  try {
    const cluster = assertClusterName(req.nextUrl.searchParams.get('cluster') ?? '');
    const query = (req.nextUrl.searchParams.get('q') ?? '').trim();
    if (query.length > 200) throw new HttpError(400, 'That search is too long');
    if (!(await exists(clusterPath(cluster)))) throw new HttpError(404, `No cluster named "${cluster}"`);

    return NextResponse.json({ hits: await searchCluster(cluster, query) });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[api/search]', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
