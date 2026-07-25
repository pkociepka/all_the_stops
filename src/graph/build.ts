import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  CompressedEdge, CompressedGraph, GraphBuildProgress,
  GraphConfig, GraphNode, Station, DayOfWeek,
} from './types';

type ProgressCallback = (p: GraphBuildProgress) => void;

const TOTAL_STEPS = 5;
const SVC_BATCH = 200;  // max service_ids per IN clause
const TRIP_BATCH = 200; // max trip_ids per IN clause

// ─── Utilities ───────────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function timeToSecs(t: string): number {
  const p = t.split(':');
  return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseInt(p[2] ?? '0', 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── Step 1: Merge stops into stations ───────────────────────────────────────

async function mergeStations(
  db: SQLiteDatabase,
  feedId: number,
): Promise<{ stations: Map<string, Station>; stopToStation: Map<string, string> }> {
  const rows = await db.getAllAsync<{
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    parent_station: string | null;
  }>('SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station FROM stops WHERE feed_id = ?', [feedId]);

  const stations = new Map<string, Station>();
  const stopToStation = new Map<string, string>();

  // Phase A: group by parent_station
  for (const row of rows) {
    if (!row.parent_station) continue;
    const sid = `ps:${row.parent_station}`;
    if (!stations.has(sid)) {
      stations.set(sid, { id: sid, name: row.stop_name, lat: row.stop_lat, lon: row.stop_lon, stopIds: [] });
    }
    stations.get(sid)!.stopIds.push(row.stop_id);
    stopToStation.set(row.stop_id, sid);
  }

  // Phase B: remaining stops — group by name, then merge within 150 m (union-find)
  const noParent = rows.filter((r) => !r.parent_station);
  const byName = new Map<string, typeof noParent>();
  for (const r of noParent) {
    const key = r.stop_name.toLowerCase().trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(r);
  }

  for (const group of byName.values()) {
    const n = group.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    function find(i: number): number {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (
          haversineMeters(
            group[i].stop_lat, group[i].stop_lon,
            group[j].stop_lat, group[j].stop_lon,
          ) <= 150
        ) {
          parent[find(i)] = find(j);
        }
      }
    }

    const components = new Map<number, typeof noParent>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(group[i]);
    }

    for (const stops of components.values()) {
      const sid = `st:${stops[0].stop_id}`;
      const lat = stops.reduce((s, r) => s + r.stop_lat, 0) / stops.length;
      const lon = stops.reduce((s, r) => s + r.stop_lon, 0) / stops.length;
      stations.set(sid, { id: sid, name: stops[0].stop_name, lat, lon, stopIds: stops.map((s) => s.stop_id) });
      for (const s of stops) stopToStation.set(s.stop_id, sid);
    }
  }

  return { stations, stopToStation };
}

// ─── Step 2: Resolve active service IDs for a date ───────────────────────────

async function getActiveServiceIds(
  db: SQLiteDatabase,
  feedId: number,
  date: string,
  dayOfWeek: DayOfWeek,
): Promise<Set<string>> {
  const fromCal = await db.getAllAsync<{ service_id: string }>(
    `SELECT service_id FROM calendar
     WHERE feed_id = ? AND ${dayOfWeek} = 1 AND start_date <= ? AND end_date >= ?`,
    [feedId, date, date],
  );
  const active = new Set(fromCal.map((r) => r.service_id));

  const added = await db.getAllAsync<{ service_id: string }>(
    'SELECT service_id FROM calendar_dates WHERE feed_id = ? AND date = ? AND exception_type = 1',
    [feedId, date],
  );
  for (const r of added) active.add(r.service_id);

  const removed = await db.getAllAsync<{ service_id: string }>(
    'SELECT service_id FROM calendar_dates WHERE feed_id = ? AND date = ? AND exception_type = 2',
    [feedId, date],
  );
  for (const r of removed) active.delete(r.service_id);

  return active;
}

// ─── Steps 3+4: Build raw directed graph from stop_times ─────────────────────

type EdgeKey = string; // `${fromStationId}→${toStationId}`

interface RawEdgeData {
  allTimes: number[];    // travel times (seconds) for all qualifying trips
  windowTimes: number[]; // travel times where the from-departure is within the window
}

async function buildRawGraph(
  db: SQLiteDatabase,
  feedId: number,
  activeServiceIds: Set<string>,
  windowStartSecs: number,
  windowEndSecs: number,
  stopToStation: Map<string, string>,
  onProgress: (detail: string) => void,
): Promise<{ graph: Map<EdgeKey, RawEdgeData>; servedStationIds: Set<string> }> {
  // Collect active trip IDs
  const activeTripIds = new Set<string>();
  const serviceList = [...activeServiceIds];

  for (let i = 0; i < serviceList.length; i += SVC_BATCH) {
    const batch = serviceList.slice(i, i + SVC_BATCH);
    const ph = batch.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ trip_id: string }>(
      `SELECT trip_id FROM trips WHERE feed_id = ? AND service_id IN (${ph})`,
      [feedId, ...batch],
    );
    for (const r of rows) activeTripIds.add(r.trip_id);
  }

  onProgress(`${activeTripIds.size} active trips`);

  const graph = new Map<EdgeKey, RawEdgeData>();
  const servedStationIds = new Set<string>();
  const tripList = [...activeTripIds];

  for (let i = 0; i < tripList.length; i += TRIP_BATCH) {
    const batch = tripList.slice(i, i + TRIP_BATCH);
    const ph = batch.map(() => '?').join(',');

    const rows = await db.getAllAsync<{
      trip_id: string;
      stop_id: string;
      departure_time: string;
      stop_sequence: number;
    }>(
      `SELECT trip_id, stop_id, departure_time, stop_sequence
       FROM stop_times WHERE feed_id = ? AND trip_id IN (${ph})
       ORDER BY trip_id, stop_sequence`,
      [feedId, ...batch],
    );

    let prevTripId = '';
    let prevStationId = '';
    let prevDepSecs = 0;

    for (const row of rows) {
      const stationId = stopToStation.get(row.stop_id);
      if (!stationId) continue;

      const depSecs = timeToSecs(row.departure_time);

      if (depSecs >= windowStartSecs && depSecs <= windowEndSecs) {
        servedStationIds.add(stationId);
      }

      if (row.trip_id === prevTripId && prevStationId && prevStationId !== stationId) {
        const travel = depSecs - prevDepSecs;
        if (travel > 0) {
          const key: EdgeKey = `${prevStationId}→${stationId}`;
          if (!graph.has(key)) graph.set(key, { allTimes: [], windowTimes: [] });
          const e = graph.get(key)!;
          e.allTimes.push(travel);
          if (prevDepSecs >= windowStartSecs && prevDepSecs <= windowEndSecs) {
            e.windowTimes.push(travel);
          }
        }
      }

      prevTripId = row.trip_id;
      prevStationId = stationId;
      prevDepSecs = depSecs;
    }

    await yieldToUI();
    onProgress(`${Math.min(i + TRIP_BATCH, tripList.length).toLocaleString()} / ${tripList.length.toLocaleString()} trips`);
  }

  return { graph, servedStationIds };
}

// ─── Step 5: Compress the raw graph ──────────────────────────────────────────

function compressGraph(
  rawGraph: Map<EdgeKey, RawEdgeData>,
): { nodes: Map<string, GraphNode>; edges: CompressedEdge[] } {
  // Compute undirected neighbor sets for degree classification
  const undirNeighbors = new Map<string, Set<string>>();
  for (const key of rawGraph.keys()) {
    const sep = key.indexOf('→');
    const from = key.slice(0, sep);
    const to = key.slice(sep + 1);
    if (!undirNeighbors.has(from)) undirNeighbors.set(from, new Set());
    if (!undirNeighbors.has(to)) undirNeighbors.set(to, new Set());
    undirNeighbors.get(from)!.add(to);
    undirNeighbors.get(to)!.add(from);
  }

  // Classify: keep termini (degree 1) and junctions (degree 3+)
  const keepNodes = new Set<string>();
  const nodes = new Map<string, GraphNode>();

  for (const [node, nbrs] of undirNeighbors) {
    if (nbrs.size !== 2) {
      keepNodes.add(node);
      nodes.set(node, {
        stationId: node,
        degree: nbrs.size,
        role: nbrs.size === 1 ? 'terminus' : 'junction',
      });
    }
  }

  // Edge case: pure loop — pick one arbitrary node as junction
  if (keepNodes.size === 0 && undirNeighbors.size > 0) {
    const node = [...undirNeighbors.keys()].sort()[0];
    keepNodes.add(node);
    nodes.set(node, { stationId: node, degree: 2, role: 'junction' });
  }

  // Build directed adjacency list for O(1) traversal
  const dirAdj = new Map<string, string[]>();
  for (const key of rawGraph.keys()) {
    const sep = key.indexOf('→');
    const from = key.slice(0, sep);
    const to = key.slice(sep + 1);
    if (!dirAdj.has(from)) dirAdj.set(from, []);
    dirAdj.get(from)!.push(to);
  }

  // Traverse chains: from each kept node, follow directed edges through
  // degree-2 nodes until the next kept node.
  const edges: CompressedEdge[] = [];
  const processedKeys = new Set<EdgeKey>();

  for (const startNode of keepNodes) {
    for (const firstNext of dirAdj.get(startNode) ?? []) {
      const firstKey: EdgeKey = `${startNode}→${firstNext}`;
      if (processedKeys.has(firstKey)) continue;

      const intermediates: string[] = [];
      let sumMedianSecs = 0;

      const firstEdge = rawGraph.get(firstKey)!;
      // Per-leg local median: prefer window-filtered times, fall back to all times.
      // Sum across legs approximates the chain traversal time.
      sumMedianSecs += median(firstEdge.windowTimes.length > 0 ? firstEdge.windowTimes : firstEdge.allTimes);
      processedKeys.add(firstKey);

      let prev = startNode;
      let current = firstNext;

      while (!keepNodes.has(current)) {
        intermediates.push(current);
        const outgoing = dirAdj.get(current) ?? [];
        const nextNode = outgoing.find((n) => n !== prev);
        if (!nextNode) break;

        const nextKey: EdgeKey = `${current}→${nextNode}`;
        const nextEdge = rawGraph.get(nextKey);
        if (!nextEdge) break;

        sumMedianSecs += median(nextEdge.windowTimes.length > 0 ? nextEdge.windowTimes : nextEdge.allTimes);
        processedKeys.add(nextKey);

        prev = current;
        current = nextNode;
      }

      edges.push({
        fromId: startNode,
        toId: current,
        medianTravelSeconds: sumMedianSecs,
        intermediateStationIds: intermediates,
      });
    }
  }

  return { nodes, edges };
}

// ─── Public helpers ───────────────────────────────────────────────────────────

// Return the nearest upcoming date (today or future) for the given day of week.
export function nextDateForDayOfWeek(dow: DayOfWeek): string {
  const DOW_JS: Record<DayOfWeek, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const target = DOW_JS[dow];
  const today = new Date();
  const diff = (target - today.getDay() + 7) % 7;
  const d = new Date(today);
  d.setDate(today.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function buildGraph(
  db: SQLiteDatabase,
  config: GraphConfig,
  onProgress: ProgressCallback,
): Promise<CompressedGraph> {
  const windowStartSecs = timeToSecs(`${config.windowStart}:00`);
  const windowEndSecs = timeToSecs(`${config.windowEnd}:00`);

  onProgress({ step: 1, totalSteps: TOTAL_STEPS, label: 'Merging stations…' });
  const { stations, stopToStation } = await mergeStations(db, config.feedId);
  onProgress({
    step: 1, totalSteps: TOTAL_STEPS, label: 'Merging stations…',
    detail: `${stations.size} stations from ${stopToStation.size} stops`,
  });
  await yieldToUI();

  onProgress({ step: 2, totalSteps: TOTAL_STEPS, label: 'Resolving active services…' });
  const activeServiceIds = await getActiveServiceIds(db, config.feedId, config.date, config.dayOfWeek);
  onProgress({
    step: 2, totalSteps: TOTAL_STEPS, label: 'Resolving active services…',
    detail: `${activeServiceIds.size} service${activeServiceIds.size !== 1 ? 's' : ''}`,
  });
  await yieldToUI();

  onProgress({ step: 3, totalSteps: TOTAL_STEPS, label: 'Building raw graph…' });
  const { graph: rawGraph, servedStationIds } = await buildRawGraph(
    db, config.feedId, activeServiceIds,
    windowStartSecs, windowEndSecs, stopToStation,
    (detail) => onProgress({ step: 3, totalSteps: TOTAL_STEPS, label: 'Building raw graph…', detail }),
  );
  onProgress({
    step: 3, totalSteps: TOTAL_STEPS, label: 'Building raw graph…',
    detail: `${rawGraph.size} directed edges`,
  });
  await yieldToUI();

  onProgress({ step: 4, totalSteps: TOTAL_STEPS, label: 'Compressing graph…' });
  const { nodes, edges } = compressGraph(rawGraph);
  onProgress({
    step: 4, totalSteps: TOTAL_STEPS, label: 'Compressing graph…',
    detail: `${nodes.size} nodes, ${edges.length} edges`,
  });
  await yieldToUI();

  onProgress({ step: 5, totalSteps: TOTAL_STEPS, label: 'Checking coverage…' });
  const unservedStationIds = [...stations.keys()].filter((id) => !servedStationIds.has(id));

  return {
    stations,
    stopToStation,
    nodes,
    edges,
    unservedStationIds,
    servedStationCount: servedStationIds.size,
    config,
  };
}
