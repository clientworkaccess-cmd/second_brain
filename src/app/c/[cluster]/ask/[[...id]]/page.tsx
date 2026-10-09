import { notFound, redirect } from 'next/navigation';
import { linkIndex, listPages } from '@/lib/wiki';
import { isConversationId, latestConversation, readConversation } from '@/lib/conversations';
import { Center } from '@/components/frame/Frame';
import { ChatPanel, type ChatConversation } from '@/components/ChatPanel';

export const dynamic = 'force-dynamic';

/**
 * Ask: one conversation with the wiki. /ask opens the newest one (or a blank
 * page to start the first); /ask/<id> opens that one. The conversation is read
 * from the app's record, so it is the same on every browser and survives a
 * reload. The list of them is in the sidebar's Chats tab.
 */
export default async function Ask({ params, searchParams }: { params: Promise<{ cluster: string; id?: string[] }>; searchParams: Promise<{ new?: string }> }) {
  const { cluster, id } = await params;
  const { new: fresh } = await searchParams;
  const wanted = id?.[0];

  if (!wanted && fresh === undefined) {
    const latest = await latestConversation(cluster);
    if (latest) redirect(`/c/${cluster}/ask/${latest}`);
  }

  let conversation: ChatConversation | null = null;
  if (wanted) {
    if (!isConversationId(wanted) || (id?.length ?? 0) > 1) notFound();
    const record = await readConversation(cluster, wanted);
    if (!record) notFound();
    conversation = {
      id: record.id,
      title: record.title,
      mode: record.mode,
      model: record.model,
      turns: record.turns.map((t) => ({
        question: t.question,
        answer: t.answer,
        sources: t.sources,
        mode: t.mode,
        model: t.model ?? undefined,
        answeredBy: t.answeredBy,
        wrote: t.wrote,
        commit: t.commit,
        undone: t.undoCommit !== null,
        findings: t.findings,
        error: t.error ?? undefined,
        done: true,
      })),
    };
  }

  const [listing, titles] = await Promise.all([listPages(cluster), linkIndex(cluster)]);
  const hasPages = listing.total > 0;
  const tab = { href: `/c/${cluster}/ask${conversation ? `/${conversation.id}` : ''}`, title: conversation ? conversation.title : 'Ask' };

  return (
    <Center scope={cluster} tab={tab} home={`/c/${cluster}`} scroll={false}>
      <ChatPanel key={conversation?.id ?? 'new'} cluster={cluster} hasPages={hasPages} titles={[...titles]} conversation={conversation} />
    </Center>
  );
}
