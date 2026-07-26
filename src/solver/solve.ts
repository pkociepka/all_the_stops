import type { CompressedEdge, CompressedGraph, GraphNode } from '../graph/types';
import type { PlannedRoute, RouteLeg, SolverConfig } from './types';

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── All-pairs shortest paths (simple O(V²) Dijkstra, fine for ≤200 nodes) ──

interface DijkstraResult {
  dist: Map<string, number>;
  pred: Map<string, string | null>; // predecessor node in shortest-path tree
}

function dijkstra(
  nodes: Map<string, GraphNode>,
  edges: CompressedEdge[],
  startId: string,
): DijkstraResult {
  const dist = new Map<string, number>([...nodes.keys()].map((id) => [id, Infinity]));
  const pred = new Map<string, string | null>([...nodes.keys()].map((id) => [id, null]));
  dist.set(startId, 0);
  const visited = new Set<string>();

  for (;;) {
    let u: string | null = null;
    let uDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < uDist) { u = id; uDist = d; }
    }
    if (!u) break;
    visited.add(u);
    for (const e of edges) {
      if (e.fromId !== u) continue;
      const nd = uDist + e.medianTravelSeconds;
      if (nd < (dist.get(e.toId) ?? Infinity)) {
        dist.set(e.toId, nd);
        pred.set(e.toId, u);
      }
    }
  }
  return { dist, pred };
}

// Reconstruct the ordered node sequence from `from` to `to` using the
// predecessor map produced by Dijkstra starting at `from`.
function reconstructPath(
  pred: Map<string, string | null>,
  from: string,
  to: string,
): string[] {
  const path: string[] = [];
  let cur: string | null = to;
  while (cur !== null && cur !== from) {
    path.unshift(cur);
    cur = pred.get(cur) ?? null;
  }
  if (cur === from) {
    path.unshift(from);
    return path;
  }
  return [from, to]; // fallback: no path (shouldn't happen in a connected graph)
}

// ─── Route cost ──────────────────────────────────────────────────────────────

function routeCost(
  order: CompressedEdge[],
  dist: Map<string, Map<string, number>>,
  startId: string,
): number {
  let cost = 0;
  let cur = startId;
  for (const e of order) {
    const repo = dist.get(cur)?.get(e.fromId) ?? Infinity;
    if (repo === Infinity) return Infinity;
    cost += repo + e.medianTravelSeconds;
    cur = e.toId;
  }
  return cost;
}

// ─── Minimal must-visit edge set ─────────────────────────────────────────────
// The full compressed graph contains edges that are redundant for the "visit
// every stop" objective:
//
//  (a) Zero-intermediate junction↔junction edges: no stops hidden inside, and
//      both endpoints are covered when other adjacent edges are traversed.
//  (b) Bidirectional pairs A↔B whose intermediate station-ID sets are identical:
//      inbound/outbound stops were merged at build time, so riding one direction
//      already covers all physical stops on that link.
//
// Dijkstra still runs on ALL edges so repositioning costs remain correct.
// Only the "must visit" list is trimmed.

function computeMustVisitEdges(
  edges: CompressedEdge[],
  nodes: Map<string, GraphNode>,
): CompressedEdge[] {
  // Step 1: edges that cover stops reachable only via that edge.
  //   — intermediates: by definition unique to their edge
  //   — terminus endpoints: the one and only edge to that terminus
  const required = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (
      e.intermediateStationIds.length > 0 ||
      nodes.get(e.fromId)?.role === 'terminus' ||
      nodes.get(e.toId)?.role === 'terminus'
    ) {
      required.add(i);
    }
  }

  // Step 2: drop one direction of every A↔B pair whose sorted intermediate
  // station-ID sets are equal — the same physical stops are covered by either
  // direction, so only one traversal is needed.
  const seen = new Set<string>();
  for (const i of [...required]) {
    const e = edges[i];
    const key =
      [e.fromId, e.toId].sort().join('↔') +
      ':' +
      [...e.intermediateStationIds].sort().join(',');
    if (seen.has(key)) {
      required.delete(i);
    } else {
      seen.add(key);
    }
  }

  // Step 3: any node not yet an endpoint of a required edge is an isolated
  // junction (all its neighbours are connected by zero-intermediate links).
  // Force the cheapest incident edge so the junction itself is visited.
  const covered = new Set<string>();
  for (const i of required) {
    covered.add(edges[i].fromId);
    covered.add(edges[i].toId);
  }
  for (const nodeId of nodes.keys()) {
    if (covered.has(nodeId)) continue;
    let bestIdx = -1;
    let bestMs = Infinity;
    for (let i = 0; i < edges.length; i++) {
      if (required.has(i)) continue;
      const e = edges[i];
      if ((e.fromId === nodeId || e.toId === nodeId) && e.medianTravelSeconds < bestMs) {
        bestIdx = i;
        bestMs = e.medianTravelSeconds;
      }
    }
    if (bestIdx >= 0) {
      required.add(bestIdx);
      covered.add(edges[bestIdx].fromId);
      covered.add(edges[bestIdx].toId);
    }
  }

  return [...required].map((i) => edges[i]);
}

// ─── Greedy nearest-neighbour ─────────────────────────────────────────────────

function greedyNN(
  startId: string,
  edges: CompressedEdge[],
  dist: Map<string, Map<string, number>>,
): CompressedEdge[] {
  const unvisited = new Set(edges.map((_, i) => i));
  const order: CompressedEdge[] = [];
  let cur = startId;

  while (unvisited.size > 0) {
    let bestIdx = -1;
    let bestCost = Infinity;

    for (const i of unvisited) {
      const e = edges[i];
      const repo = dist.get(cur)?.get(e.fromId) ?? Infinity;
      const cost = repo === Infinity ? Infinity : repo + e.medianTravelSeconds;
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }

    if (bestIdx === -1) {
      // Remaining edges unreachable from current position; take the cheapest by traversal time.
      bestIdx = [...unvisited].reduce((best, i) =>
        edges[i].medianTravelSeconds < edges[best].medianTravelSeconds ? i : best,
      );
    }

    order.push(edges[bestIdx]);
    cur = edges[bestIdx].toId;
    unvisited.delete(bestIdx);
  }

  return order;
}

// ─── Relocation improvement (directed-graph-safe local search) ───────────────
// At each step, try moving every single leg to every other position.
// Keep the move if it reduces total route cost. Repeat until no improvement.

function relocate(
  route: CompressedEdge[],
  dist: Map<string, Map<string, number>>,
  startId: string,
  maxPasses = 200,
): CompressedEdge[] {
  let best = [...route];
  let bestCost = routeCost(best, dist, startId);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    outer:
    for (let i = 0; i < best.length; i++) {
      for (let j = 0; j < best.length; j++) {
        if (i === j) continue;
        const candidate = [...best];
        const [leg] = candidate.splice(i, 1);
        candidate.splice(j > i ? j - 1 : j, 0, leg);
        const cost = routeCost(candidate, dist, startId);
        if (cost < bestCost - 0.5) {
          best = candidate;
          bestCost = cost;
          improved = true;
          break outer;
        }
      }
    }
    if (!improved) break;
  }

  return best;
}

// ─── Assemble a PlannedRoute from an ordered edge sequence ───────────────────

function buildRoute(
  order: CompressedEdge[],
  allDist: Map<string, Map<string, number>>,
  allPred: Map<string, Map<string, string | null>>,
  startId: string,
  startName: string,
  totalEdgeCount: number,
  isUserPreferred: boolean,
): PlannedRoute {
  const legs: RouteLeg[] = [];
  let totalSecs = 0;
  let cur = startId;

  for (const e of order) {
    const needsRepo = cur !== e.fromId;
    const repoSecs = needsRepo ? (allDist.get(cur)?.get(e.fromId) ?? 0) : 0;
    const repoPath = needsRepo
      ? reconstructPath(allPred.get(cur)!, cur, e.fromId)
      : [];
    legs.push({
      edge: e,
      repositionFromId: needsRepo ? cur : null,
      repositionSecs: repoSecs,
      repositionPath: repoPath,
    });
    totalSecs += repoSecs + e.medianTravelSeconds;
    cur = e.toId;
  }

  return {
    startNodeId: startId,
    startName,
    legs,
    totalEstimatedSecs: totalSecs,
    isComplete: order.length === totalEdgeCount,
    isUserPreferred,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function solve(
  graph: CompressedGraph,
  config: SolverConfig,
  onProgress?: (msg: string) => void,
): Promise<PlannedRoute[]> {
  const { nodes, edges } = graph;
  if (edges.length === 0) return [];

  // Trim to the edges that actually need visiting (see computeMustVisitEdges).
  // Dijkstra still uses the full edge set so repositioning paths are correct.
  const mustVisit = computeMustVisitEdges(edges, nodes);

  // Build all-pairs shortest-path matrix (dist + predecessors for path reconstruction)
  onProgress?.('Computing shortest paths…');
  const allDist = new Map<string, Map<string, number>>();
  const allPred = new Map<string, Map<string, string | null>>();
  for (const nodeId of nodes.keys()) {
    const result = dijkstra(nodes, edges, nodeId);
    allDist.set(nodeId, result.dist);
    allPred.set(nodeId, result.pred);
  }
  await yieldToUI();

  // Seed nodes: every terminus, plus the user-preferred start if given
  const terminiIds = [...nodes.entries()]
    .filter(([, n]) => n.role === 'terminus')
    .map(([id]) => id);

  const seeds: Array<{ id: string; preferred: boolean }> = terminiIds.map((id) => ({
    id,
    preferred: id === config.preferredStartId,
  }));

  if (
    config.preferredStartId &&
    nodes.has(config.preferredStartId) &&
    !terminiIds.includes(config.preferredStartId)
  ) {
    seeds.push({ id: config.preferredStartId, preferred: true });
  }

  if (seeds.length === 0) {
    const first = nodes.keys().next().value;
    if (first) seeds.push({ id: first, preferred: false });
  }

  // Run greedy NN + relocation from each seed
  const candidates: PlannedRoute[] = [];

  for (let si = 0; si < seeds.length; si++) {
    const { id, preferred } = seeds[si];
    const name = graph.stations.get(id)?.name ?? id;
    onProgress?.(`Optimising from ${name} (${si + 1}/${seeds.length})…`);
    await yieldToUI();

    const initial = greedyNN(id, mustVisit, allDist);
    const improved = relocate(initial, allDist, id);
    candidates.push(buildRoute(improved, allDist, allPred, id, name, mustVisit.length, preferred));
  }

  // Deduplicate by leg-sequence signature, sort by total estimated time
  candidates.sort((a, b) => a.totalEstimatedSecs - b.totalEstimatedSecs);

  const seen = new Map<string, PlannedRoute>();
  for (const r of candidates) {
    const sig = r.legs.map((l) => `${l.edge.fromId}→${l.edge.toId}`).join('|');
    if (!seen.has(sig)) seen.set(sig, r);
  }

  const results = [...seen.values()].sort((a, b) => a.totalEstimatedSecs - b.totalEstimatedSecs);

  // Always include the user-preferred route if it didn't make the cut naturally
  const preferred = results.find((r) => r.isUserPreferred);
  if (config.preferredStartId && !preferred) {
    const prefRoute = candidates.find((r) => r.isUserPreferred);
    if (prefRoute) results.push(prefRoute);
  }

  return results.slice(0, config.maxSolutions);
}
