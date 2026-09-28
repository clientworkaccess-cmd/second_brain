import { listPages, PAGE_DIRS } from '@/lib/wiki';
import { ChatPanel } from '@/components/ChatPanel';

export const dynamic = 'force-dynamic';

export default async function Ask({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const pages = await listPages(cluster);
  const hasPages = PAGE_DIRS.some((dir) => pages[dir].length > 0);

  return <ChatPanel cluster={cluster} hasPages={hasPages} />;
}
