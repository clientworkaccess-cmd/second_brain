import { listPages, titleIndex, PAGE_DIRS } from '@/lib/wiki';
import { Center } from '@/components/frame/Frame';
import { ChatPanel } from '@/components/ChatPanel';

export const dynamic = 'force-dynamic';

export default async function Ask({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const [pages, titles] = await Promise.all([listPages(cluster), titleIndex(cluster)]);
  const hasPages = PAGE_DIRS.some((dir) => pages[dir].length > 0);

  return (
    <Center scope={cluster} tab={{ href: `/c/${cluster}/ask`, title: 'Ask' }} home={`/c/${cluster}`} scroll={false}>
      <ChatPanel cluster={cluster} hasPages={hasPages} titles={[...titles]} />
    </Center>
  );
}
