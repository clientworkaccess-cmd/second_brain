import { FileQuestion } from 'lucide-react';
import { Wordmark } from '@/components/Logo';
import { EmptyState, ButtonLink } from '@/components/ui';

/**
 * Shown without the frame. This page also answers addresses that never reach
 * the login check, so it must not list clusters or anything else that is ours.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-canvas px-4">
      <Wordmark />
      <EmptyState
        icon={FileQuestion}
        title="Nothing here"
        body="That page does not exist, or it was linked from somewhere before it was written."
        action={<ButtonLink href="/">Back to the clusters</ButtonLink>}
      />
    </main>
  );
}
