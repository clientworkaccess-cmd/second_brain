import { Share2 } from 'lucide-react';
import { buildGraph } from '@/lib/graph';
import { GraphView } from '@/components/GraphView';
import { Reveal } from '@/components/Reveal';
import { EmptyState, ButtonLink } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function GraphPage({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const graph = await buildGraph(cluster);

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="Nothing to draw yet"
        body="The graph fills in as documents are filed. Each page becomes a point, and each link the agent writes between them becomes a line."
        action={<ButtonLink href={`/c/${cluster}`}>Add a document</ButtonLink>}
      />
    );
  }

  return (
    <Reveal>
      <p className="mb-6 max-w-prose text-body">
        Every page in this cluster, and every connection between them. Drag to rearrange, hover
        to isolate a page and its neighbours, click to open one.
      </p>
      <GraphView graph={graph} cluster={cluster} />
    </Reveal>
  );
}
