import type { SQLiteDatabase } from 'expo-sqlite';
import type { CompressedGraph } from '../graph/types';
import type { PlannedRoute, ScheduledLeg, ScheduledRoute } from './types';

const MIN_TRANSFER_SECS = 120; // 2-minute minimum transfer time at a stop
const WALK_THRESHOLD_M  = 400; // hops closer than this → walk rather than transit
const WALK_SPEED_MPS    = 1.4; // ~5 km/h

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

// ─── Time helpers ─────────────────────────────────────────────────────────────

function timeStrToSecs(t: string): number {
  const p = t.split(':');
  return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseInt(p[2] ?? '0', 10);
}

function secsToTimeStr(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function secsToHHMM(secs: number): string {
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── Find stops from one feed that are geographically near a lat/lon ─────────

async function findNearbyStopIds(
  db: SQLiteDatabase,
  feedId: number,
  lat: number,
  lon: number,
  radiusM: number,
): Promise<string[]> {
  const latDelta = radiusM / 111_000;
  const lonDelta = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  const rows = await db.getAllAsync<{ stop_id: string; stop_lat: number; stop_lon: number }>(
    `SELECT stop_id, stop_lat, stop_lon FROM stops
     WHERE feed_id = ?
       AND stop_lat BETWEEN ? AND ?
       AND stop_lon BETWEEN ? AND ?`,
    [feedId, lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta],
  );
  return rows
    .filter((r) => haversineMeters(lat, lon, r.stop_lat, r.stop_lon) <= radiusM)
    .map((r) => r.stop_id);
}

// ─── Shared result type for both trip queries ─────────────────────────────────

interface TripResult {
  dep: string;
  arr: string;
  tripId: string;
  routeName: string | null;
  headsign: string | null;
}

// ─── Find the next real departure for a compressed edge ──────────────────────
// Returns { result, wrappedAround } where wrappedAround=true means no trip was
// found after afterTimeSecs so we fell back to the first trip of the day
// (caller must advance curSecs by 24 h to represent the overnight wait).

interface FindNextTripResult {
  trip: TripResult;
  wrappedAround: boolean;
}

async function findNextTrip(
  db: SQLiteDatabase,
  feedId: number,
  fromStopIds: string[],
  toStopIds: string[],
  afterTimeSecs: number,
  serviceIds: string[],
): Promise<FindNextTripResult | null> {
  if (fromStopIds.length === 0 || toStopIds.length === 0 || serviceIds.length === 0) return null;

  const fromPh = fromStopIds.map(() => '?').join(',');
  const toPh = toStopIds.map(() => '?').join(',');
  const svcPh = serviceIds.map(() => '?').join(',');
  const afterStr = secsToTimeStr(afterTimeSecs);

  const baseQuery = `
     SELECT st_from.departure_time AS dep,
            st_to.arrival_time   AS arr,
            st_from.trip_id      AS trip_id,
            COALESCE(r.route_short_name, t.route_id) AS route_name,
            t.trip_headsign AS headsign
     FROM stop_times st_from
     JOIN stop_times st_to
       ON  st_to.feed_id       = st_from.feed_id
       AND st_to.trip_id       = st_from.trip_id
       AND st_to.stop_sequence > st_from.stop_sequence
     JOIN trips t
       ON  t.feed_id  = st_from.feed_id
       AND t.trip_id  = st_from.trip_id
     LEFT JOIN routes r
       ON  r.feed_id  = t.feed_id
       AND r.route_id = t.route_id
     WHERE st_from.feed_id  = ?
       AND st_from.stop_id  IN (${fromPh})
       AND st_to.stop_id    IN (${toPh})`;

  type Row = { dep: string; arr: string; trip_id: string; route_name: string | null; headsign: string | null };

  // Primary search: trips departing after afterTimeSecs
  const rows = await db.getAllAsync<Row>(
    baseQuery + `
       AND st_from.departure_time >= ?
       AND t.service_id IN (${svcPh})
     ORDER BY st_from.departure_time ASC
     LIMIT 1`,
    [feedId, ...fromStopIds, ...toStopIds, afterStr, ...serviceIds],
  );

  if (rows[0]) {
    const r = rows[0];
    return { trip: { dep: r.dep, arr: r.arr, tripId: r.trip_id, routeName: r.route_name, headsign: r.headsign }, wrappedAround: false };
  }

  // Fallback: look for any trip today (service has ended for the day — try first
  // available departure so caller can treat it as next-day overnight service).
  const fallback = await db.getAllAsync<Row>(
    baseQuery + `
       AND t.service_id IN (${svcPh})
     ORDER BY st_from.departure_time ASC
     LIMIT 1`,
    [feedId, ...fromStopIds, ...toStopIds, ...serviceIds],
  );

  if (fallback[0]) {
    const r = fallback[0];
    return { trip: { dep: r.dep, arr: r.arr, tripId: r.trip_id, routeName: r.route_name, headsign: r.headsign }, wrappedAround: true };
  }

  return null;
}

// ─── Check if the current trip continues through the junction ─────────────────
// Returns the departure from the junction and arrival at the next destination
// when the rider can stay on board without transferring.

async function findContinuation(
  db: SQLiteDatabase,
  feedId: number,
  tripId: string,
  junctionStopIds: string[],
  nextToStopIds: string[],
): Promise<TripResult | null> {
  if (junctionStopIds.length === 0 || nextToStopIds.length === 0) return null;

  const jPh = junctionStopIds.map(() => '?').join(',');
  const toPh = nextToStopIds.map(() => '?').join(',');

  const rows = await db.getAllAsync<{
    dep: string; arr: string; trip_id: string;
    route_name: string | null; headsign: string | null;
  }>(
    `SELECT st_mid.departure_time AS dep,
            st_to.arrival_time   AS arr,
            st_mid.trip_id       AS trip_id,
            COALESCE(r.route_short_name, t.route_id) AS route_name,
            t.trip_headsign AS headsign
     FROM stop_times st_mid
     JOIN stop_times st_to
       ON  st_to.feed_id       = st_mid.feed_id
       AND st_to.trip_id       = st_mid.trip_id
       AND st_to.stop_sequence > st_mid.stop_sequence
     JOIN trips t ON t.feed_id = st_mid.feed_id AND t.trip_id = st_mid.trip_id
     LEFT JOIN routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
     WHERE st_mid.feed_id = ?
       AND st_mid.trip_id  = ?
       AND st_mid.stop_id  IN (${jPh})
       AND st_to.stop_id   IN (${toPh})
     LIMIT 1`,
    [feedId, tripId, ...junctionStopIds, ...nextToStopIds],
  );

  const row = rows[0];
  return row
    ? { dep: row.dep, arr: row.arr, tripId: row.trip_id, routeName: row.route_name, headsign: row.headsign }
    : null;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function schedule(
  db: SQLiteDatabase,
  route: PlannedRoute,
  graph: CompressedGraph,
  onProgress?: (msg: string) => void,
): Promise<ScheduledRoute> {
  const { config, stations, activeServiceIds, auxiliaryServiceIds } = graph;
  const serviceIds = [...activeServiceIds];
  const feedId = config.feedId;

  let curSecs = timeStrToSecs(`${config.windowStart}:00`);
  const startSecs = curSecs;

  const legs: ScheduledLeg[] = [];
  let impossibleCount = 0;
  let currentTripId: string | null = null; // trip in progress from the previous transit leg

  for (let li = 0; li < route.legs.length; li++) {
    const leg = route.legs[li];
    onProgress?.(`Leg ${li + 1} / ${route.legs.length}`);

    // ── Repositioning hops ─────────────────────────────────────────────────
    // Each consecutive pair in repositionPath is one hop.
    // Short hops (≤ WALK_THRESHOLD_M) → walk with haversine-based duration.
    // Long hops → find a real transit trip; fall back to walk estimate if none.
    if (leg.repositionFromId !== null && leg.repositionPath.length >= 2) {
      currentTripId = null; // rider disembarks before repositioning

      for (let hi = 0; hi + 1 < leg.repositionPath.length; hi++) {
        const hopFromId = leg.repositionPath[hi];
        const hopToId   = leg.repositionPath[hi + 1];
        const hopFromSt = stations.get(hopFromId);
        const hopToSt   = stations.get(hopToId);
        const fromStops = hopFromSt?.stopIds ?? [];
        const toStops   = hopToSt?.stopIds ?? [];

        const distM = hopFromSt && hopToSt
          ? haversineMeters(hopFromSt.lat, hopFromSt.lon, hopToSt.lat, hopToSt.lon)
          : Infinity;

        if (distM <= WALK_THRESHOLD_M) {
          // Walk
          const walkSecs = distM / WALK_SPEED_MPS;
          const depTime = secsToHHMM(curSecs);
          curSecs += walkSecs;
          legs.push({
            type: 'reposition',
            fromStationId: hopFromId,
            fromStationName: hopFromSt?.name ?? hopFromId,
            toStationId: hopToId,
            toStationName: hopToSt?.name ?? hopToId,
            intermediateCount: 0,
            departureTime: depTime,
            arrivalTime: secsToHHMM(curSecs),
            routeShortName: null,
            tripHeadsign: null,
            isImpossible: false,
            stayOnBoard: false,
          });
          // No currentTripId update — still on foot
        } else {
          // Take transit for this hop — search the primary feed, then each
          // auxiliary feed using stops geographically near the hop endpoints.
          let found = await findNextTrip(db, feedId, fromStops, toStops, curSecs, serviceIds);

          if (hopFromSt && hopToSt) {
            for (const [auxFeedId, auxServiceSet] of auxiliaryServiceIds) {
              const auxSvcIds = [...auxServiceSet];
              if (auxSvcIds.length === 0) continue;
              const auxFrom = await findNearbyStopIds(db, auxFeedId, hopFromSt.lat, hopFromSt.lon, 200);
              const auxTo   = await findNearbyStopIds(db, auxFeedId, hopToSt.lat, hopToSt.lon, 200);
              if (auxFrom.length === 0 || auxTo.length === 0) continue;
              const auxFound = await findNextTrip(db, auxFeedId, auxFrom, auxTo, curSecs, auxSvcIds);
              if (auxFound && (!found || timeStrToSecs(auxFound.trip.dep) < timeStrToSecs(found.trip.dep))) {
                found = auxFound;
              }
            }
          }

          if (found) {
            const { trip, wrappedAround } = found;
            let depSecs = timeStrToSecs(trip.dep);
            let arrSecs = timeStrToSecs(trip.arr);
            if (wrappedAround) {
              // Service has ended for today on this hop; treat as next-day
              depSecs += 24 * 3600;
              arrSecs += 24 * 3600;
            }
            legs.push({
              type: 'transit',
              fromStationId: hopFromId,
              fromStationName: hopFromSt?.name ?? hopFromId,
              toStationId: hopToId,
              toStationName: hopToSt?.name ?? hopToId,
              intermediateCount: 0,
              departureTime: secsToHHMM(depSecs),
              arrivalTime: secsToHHMM(arrSecs),
              routeShortName: trip.routeName,
              tripHeadsign: trip.headsign,
              isImpossible: false,
              stayOnBoard: false,
            });
            curSecs = Math.max(curSecs, arrSecs) + MIN_TRANSFER_SECS;
            currentTripId = trip.tripId;
          } else {
            // No direct trip found — show as impossible walk estimate
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                `[schedule] No trip found for reposition hop ${hopFromSt?.name ?? hopFromId} → ${hopToSt?.name ?? hopToId}`,
                { fromStops, toStops, curSecs, serviceCount: serviceIds.length },
              );
            }
            const walkSecs = isFinite(distM) ? distM / WALK_SPEED_MPS : leg.repositionSecs;
            const depTime = secsToHHMM(curSecs);
            curSecs += walkSecs;
            legs.push({
              type: 'reposition',
              fromStationId: hopFromId,
              fromStationName: hopFromSt?.name ?? hopFromId,
              toStationId: hopToId,
              toStationName: hopToSt?.name ?? hopToId,
              intermediateCount: 0,
              departureTime: depTime,
              arrivalTime: secsToHHMM(curSecs),
              routeShortName: null,
              tripHeadsign: null,
              isImpossible: true,
              stayOnBoard: false,
            });
            impossibleCount++;
          }
        }
      }
    }

    // ── Transit leg ────────────────────────────────────────────────────────
    const fromSt = stations.get(leg.edge.fromId);
    const toSt = stations.get(leg.edge.toId);
    if (process.env.NODE_ENV !== 'production' && (!fromSt || !toSt)) {
      console.warn('[schedule] Station lookup failed for edge', leg.edge.fromId, '→', leg.edge.toId, { fromSt: !!fromSt, toSt: !!toSt });
    }
    const fromStops = fromSt?.stopIds ?? [];
    const toStops = toSt?.stopIds ?? [];

    // Before issuing a new trip lookup, check whether the vehicle from the
    // previous leg continues through this junction to the next destination.
    let foundTrip: FindNextTripResult | null = null;
    let stayOnBoard = false;

    if (currentTripId !== null) {
      const cont = await findContinuation(db, feedId, currentTripId, fromStops, toStops);
      if (cont) {
        foundTrip = { trip: cont, wrappedAround: false };
        stayOnBoard = true;
      }
    }

    if (!foundTrip) {
      foundTrip = await findNextTrip(db, feedId, fromStops, toStops, curSecs, serviceIds);
    }

    if (foundTrip) {
      const { trip, wrappedAround } = foundTrip;
      let depSecs = timeStrToSecs(trip.dep);
      let arrSecs = timeStrToSecs(trip.arr);
      if (wrappedAround) {
        depSecs += 24 * 3600;
        arrSecs += 24 * 3600;
      }
      legs.push({
        type: 'transit',
        fromStationId: leg.edge.fromId,
        fromStationName: fromSt?.name ?? leg.edge.fromId,
        toStationId: leg.edge.toId,
        toStationName: toSt?.name ?? leg.edge.toId,
        intermediateCount: leg.edge.intermediateStationIds.length,
        departureTime: secsToHHMM(depSecs),
        arrivalTime: secsToHHMM(arrSecs),
        routeShortName: trip.routeName,
        tripHeadsign: trip.headsign,
        isImpossible: false,
        stayOnBoard,
      });
      curSecs = Math.max(curSecs, arrSecs) + MIN_TRANSFER_SECS;
      currentTripId = trip.tripId;
    } else {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[schedule] No trip found for leg ${fromSt?.name ?? leg.edge.fromId} → ${toSt?.name ?? leg.edge.toId}`,
          { fromStops, toStops, curSecs: secsToTimeStr(curSecs), serviceCount: serviceIds.length },
        );
      }
      // No trip found — use median estimate and flag as impossible
      const estArr = curSecs + leg.edge.medianTravelSeconds;
      legs.push({
        type: 'transit',
        fromStationId: leg.edge.fromId,
        fromStationName: fromSt?.name ?? leg.edge.fromId,
        toStationId: leg.edge.toId,
        toStationName: toSt?.name ?? leg.edge.toId,
        intermediateCount: leg.edge.intermediateStationIds.length,
        departureTime: secsToHHMM(curSecs),
        arrivalTime: secsToHHMM(estArr),
        routeShortName: null,
        tripHeadsign: null,
        isImpossible: true,
        stayOnBoard: false,
      });
      curSecs = estArr + MIN_TRANSFER_SECS;
      currentTripId = null;
      impossibleCount++;
    }
  }

  // Strip trailing transfer buffer from finish time
  const endSecs = Math.max(startSecs, curSecs - MIN_TRANSFER_SECS);

  return {
    plannedRoute: route,
    legs,
    actualDepartureTime: secsToHHMM(startSecs),
    actualArrivalTime: secsToHHMM(endSecs),
    totalActualSecs: endSecs - startSecs,
    impossibleCount,
  };
}
