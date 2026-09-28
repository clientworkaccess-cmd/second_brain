import { FileQuestion } from 'lucide-react';
import { TopBar } from '@/components/TopBar';
import { EmptyState, ButtonLink } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="min-h-[100dvh]">
      <TopBar />
      <main className="mx-auto max-w-2xl px-6 py-24">
        <EmptyState
          icon={FileQuestion}
          title="Nothing here"
          body="That page does not exist — or it was linked from somewhere before it was written."
          action={<ButtonLink href="/">Back to clusters</ButtonLink>}
        />
      </main>
    </div>
  );
}
