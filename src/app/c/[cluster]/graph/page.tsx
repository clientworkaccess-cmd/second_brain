import { Waypoints } from 'lucide-react';
import { buildGraph } from '@/lib/graph';
import { Center } from '@/components/frame/Frame';
import { GraphView } from '@/components/GraphView';
import { EmptyState, ButtonLink } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function GraphPage({ params }: { params: Promise<{ cluster: string }> }) {
  const { cluster } = await params;
  const graph = await buildGraph(cluster);
  const tab = { href: `/c/${cluster}/graph`, title: 'Graph' };

  if (graph.nodes.length === 0) {
    return (
      <Center scope={cluster} tab={tab} home={`/c/${cluster}`}>
        <div className="content">
          <EmptyState
            icon={Waypoints}
            title="Nothing to draw yet"
            body="The graph fills in as documents are filed. Each page becomes a point, and each link between two pages becomes a line."
            action={<ButtonLink href={`/c/${cluster}`}>Add a document</ButtonLink>}
          />
        </div>
      </Center>
    );
  }

  return (
    <Center scope={cluster} tab={tab} home={`/c/${cluster}`} scroll={false}>
      <GraphView graph={graph} cluster={cluster} />
    </Center>
  );
}
