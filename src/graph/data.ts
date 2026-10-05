// The parts of the desktop app's src/renderer/src/core/graph.ts that its WebGL
// engine draws from, as they are. Keep them in step.

export interface GraphNode {
  /** Vault path, or an `unresolved:` key for a dangling link target. */
  id: string
  label: string
  unresolved: boolean
  degree: number
  /** Top-level folder ('' for notes in the vault root, UNRESOLVED_GROUP for dangling targets); drives node colors. */
  group: string
  /** Departments the note belongs to (see core/areas); empty for most vaults and for dangling targets. */
  areas: string[]
}

export const UNRESOLVED_GROUP = '\u0000unresolved'

/** Golden-angle hues give visibly distinct colors for any number of groups; the order is stable (sorted names). */
export function groupHues(groups: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(groups)].filter((g) => g !== '' && g !== UNRESOLVED_GROUP).sort((a, b) => a.localeCompare(b))
  return new Map(sorted.map((g, i) => [g, (i * 137.508) % 360]))
}

/** Area colors: the same golden-angle spread as folders, started elsewhere on the wheel. */
export function areaHues(areas: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(areas)].sort((a, b) => a.localeCompare(b))
  return new Map(sorted.map((a, i) => [a, (28 + i * 137.508) % 360]))
}

export interface GraphLink {
  source: string
  target: string
  /** Number of links from source to target. */
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

/** How many notes each area holds, and how many notes have none (dangling targets are not counted). */
export function areaStats(nodes: readonly Pick<GraphNode, 'areas' | 'unresolved'>[]): { counts: Map<string, number>; none: number } {
  const counts = new Map<string, number>()
  let none = 0
  for (const n of nodes) {
    if (n.areas.length === 0) {
      if (!n.unresolved) none++
      continue
    }
    for (const a of n.areas) counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return { counts, none }
}

/**
 * Order in which areas are laid out around the circle: start with the biggest, then keep appending the
 * area most linked with the one placed last, so departments that share a lot of links end up neighbours.
 */
export function orderAreas(
  nodes: readonly Pick<GraphNode, 'id' | 'areas'>[],
  links: readonly { source: string; target: string }[]
): string[] {
  const size = new Map<string, number>()
  const areasOf = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.areas.length === 0) continue
    areasOf.set(n.id, n.areas)
    for (const a of n.areas) size.set(a, (size.get(a) ?? 0) + 1)
  }
  const all = [...size.keys()].sort((a, b) => a.localeCompare(b))
  if (all.length <= 2) return all
  const pair = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  const weight = new Map<string, number>()
  for (const l of links) {
    const s = areasOf.get(l.source)
    const t = areasOf.get(l.target)
    if (!s || !t) continue
    for (const a of s) for (const b of t) if (a !== b) weight.set(pair(a, b), (weight.get(pair(a, b)) ?? 0) + 1)
  }
  const left = new Set(all)
  let current = all.reduce((best, a) => ((size.get(a) ?? 0) > (size.get(best) ?? 0) ? a : best))
  const order = [current]
  left.delete(current)
  while (left.size > 0) {
    let next = ''
    let best = -1
    for (const a of left) {
      const w = weight.get(pair(current, a)) ?? 0
      if (w > best) {
        best = w
        next = a
      }
    }
    order.push(next)
    left.delete(next)
    current = next
  }
  return order
}

/** Where each area gathers in "group by area" mode: evenly spaced on a circle that grows with the graph. */
export function areaAnchors(areas: readonly string[], nodeCount: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (areas.length === 1) out.set(areas[0], { x: 0, y: 0 })
  if (areas.length < 2) return out
  const radius = Math.max(160, 26 * Math.sqrt(Math.max(1, nodeCount)))
  areas.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i / areas.length) * Math.PI * 2
    out.set(a, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })
  return out
}
