import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, View, Pressable, Text, StyleSheet } from 'react-native';
import { Map as MapView, Camera, GeoJSONSource, Layer, Marker, type CameraRef } from '@maplibre/maplibre-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import type { Station } from '../graph/types';
import type { ScheduledLeg } from '../solver/types';

const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// OpenFreeMap serves Noto Sans {Bold,Italic,Regular} as individual PBF files.
// These are the only fonts used by the Liberty style and by our custom layers.
// Do NOT use multi-item font arrays — OpenFreeMap does not serve combined stacks.

type Pos = [number, number]; // [lon, lat] — GeoJSON order

interface MapData {
  startCoord: Pos;
  endCoord:   Pos;
  transit:   FeatureCollection<LineString, { color: string; offset: number }>;
  repo:      FeatureCollection<LineString, { mode: 'walk' | 'transit'; offset: number }>;
  stops:     FeatureCollection<Point,      { name: string }>;
  waypoints: FeatureCollection<Point,      { seq: string; color: string; opacity: number }>;
  bounds:    LngLatBounds;
  badgeLegs: ScheduledLeg[]; // index = parseInt(seq) - 1
}

// ─── GTFS path lookup ─────────────────────────────────────────────────────────

async function fetchLegPath(
  db: SQLiteDatabase,
  feedId: number,
  tripId: string,
  fromStopIds: string[],
  toStopIds: string[],
): Promise<Pos[] | null> {
  if (fromStopIds.length === 0 || toStopIds.length === 0) return null;

  const fromPh = fromStopIds.map(() => '?').join(',');
  const toPh   = toStopIds.map(() => '?').join(',');

  const rows = await db.getAllAsync<{ stop_lat: number; stop_lon: number }>(
    `SELECT s.stop_lat, s.stop_lon
     FROM stop_times st
     JOIN stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
     WHERE st.feed_id = ?
       AND st.trip_id = ?
       AND st.stop_sequence BETWEEN
           (SELECT MIN(st2.stop_sequence) FROM stop_times st2
            WHERE st2.feed_id = ? AND st2.trip_id = ? AND st2.stop_id IN (${fromPh}))
         AND
           (SELECT MAX(st2.stop_sequence) FROM stop_times st2
            WHERE st2.feed_id = ? AND st2.trip_id = ? AND st2.stop_id IN (${toPh}))
     ORDER BY st.stop_sequence ASC`,
    [feedId, tripId, feedId, tripId, ...fromStopIds, feedId, tripId, ...toStopIds],
  );

  const coords: Pos[] = [];
  for (const r of rows) {
    const c: Pos = [r.stop_lon, r.stop_lat];
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) coords.push(c);
  }
  return coords.length >= 2 ? coords : null;
}

// ─── Overlap detection & offset assignment ────────────────────────────────────
//
// Two on-rail legs conflict when they share the same canonical station pair
// (direction-agnostic).  We build a conflict graph and colour it greedily so
// that no two conflicting legs get the same offset.
// Positive offset = right side of the direction of travel (MapLibre convention).

const OFFSET_STEP = 8; // pixels per step

// Conflict detection is by canonical station-pair key, not by coordinate
// proximity.  Two legs between the same compressed-graph node pair always share
// the same physical track segment regardless of which GTFS trip or direction
// they use, so they must be offset from one another.
function assignOffsets(
  stationPairs: (readonly [string, string] | null)[],
): number[] {
  const n = stationPairs.length;
  const edgeToIndices = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const pair = stationPairs[i];
    if (!pair) continue;
    const [a, b] = pair[0] < pair[1] ? pair : [pair[1], pair[0]];
    const key = `${a}\x1F${b}`;
    const list = edgeToIndices.get(key);
    if (list) list.push(i);
    else edgeToIndices.set(key, [i]);
  }

  const conflicts: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (const indices of edgeToIndices.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        conflicts[indices[a]].add(indices[b]);
        conflicts[indices[b]].add(indices[a]);
      }
    }
  }

  // Greedy colouring — assign the lowest-|offset| option that doesn't conflict
  const offsets = new Array<number>(n).fill(0);
  const assigned = new Array<boolean>(n).fill(false);
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => conflicts[b].size - conflicts[a].size);

  const options = [
    0,
    OFFSET_STEP, -OFFSET_STEP,
    2 * OFFSET_STEP, -2 * OFFSET_STEP,
    3 * OFFSET_STEP, -3 * OFFSET_STEP,
  ];

  for (const i of order) {
    const used = new Set<number>(
      [...conflicts[i]].filter((j) => assigned[j]).map((j) => offsets[j]),
    );
    for (const opt of options) {
      if (!used.has(opt)) { offsets[i] = opt; break; }
    }
    assigned[i] = true;
  }

  return offsets;
}

// Returns the geographic point at 50 % of the polyline's arc length.
function pathMidpoint(coords: Pos[]): Pos {
  if (coords.length < 2) return coords[0] ?? [0, 0];
  let total = 0;
  const lens: number[] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const dx = coords[i + 1][0] - coords[i][0];
    const dy = coords[i + 1][1] - coords[i][1];
    const l = Math.sqrt(dx * dx + dy * dy);
    lens.push(l);
    total += l;
  }
  if (total === 0) return coords[0];
  let rem = total / 2;
  for (let i = 0; i < lens.length; i++) {
    if (rem <= lens[i]) {
      const t = lens[i] > 0 ? rem / lens[i] : 0;
      return [
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ];
    }
    rem -= lens[i];
  }
  return coords[coords.length - 1];
}

// Iteratively push badge centres apart until none overlap.
// 0.003° ≈ 300 m at Kraków's latitude ≈ one badge-diameter at zoom 13.
const MIN_BADGE_SEP = 0.003;

function deoverlapPoints(pts: Pos[]): Pos[] {
  if (pts.length < 2) return pts;
  const out = pts.map(([lon, lat]) => [lon, lat] as Pos);
  for (let iter = 0; iter < 100; iter++) {
    let anyMoved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = out[j][0] - out[i][0];
        const dy = out[j][1] - out[i][1];
        const d2 = dx * dx + dy * dy;
        if (d2 >= MIN_BADGE_SEP * MIN_BADGE_SEP) continue;

        let nx: number, ny: number;
        if (d2 < 1e-20) {
          // Exactly coincident — spread along a deterministic direction so
          // multiple coincident points fan out rather than all going the same way.
          const angle = (i * 2.3999632 + j) % (2 * Math.PI); // golden-angle spiral
          nx = Math.cos(angle);
          ny = Math.sin(angle);
        } else {
          const d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
        }
        const push = MIN_BADGE_SEP * 0.5;
        out[i][0] -= nx * push;
        out[i][1] -= ny * push;
        out[j][0] += nx * push;
        out[j][1] += ny * push;
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }
  return out;
}

// ─── Map data builder ─────────────────────────────────────────────────────────

async function buildMapData(
  mergedLegs: ScheduledLeg[],
  legColors: (string | null)[],
  stations: Map<string, Station>,
  db: SQLiteDatabase,
  feedId: number,
): Promise<MapData | null> {

  // ── Step 1: resolve stations, skip legs with missing data ──────────────────
  type Entry = { leg: ScheduledLeg; legIdx: number; from: Station; to: Station };
  const entries: Entry[] = [];
  for (let i = 0; i < mergedLegs.length; i++) {
    const from = stations.get(mergedLegs[i].fromStationId);
    const to   = stations.get(mergedLegs[i].toStationId);
    if (from && to) entries.push({ leg: mergedLegs[i], legIdx: i, from, to });
  }
  if (entries.length === 0) return null;

  // ── Step 2: fetch all transit paths in parallel ────────────────────────────
  const paths = await Promise.all(
    entries.map(({ leg, from, to }) =>
      (leg.type === 'transit' || leg.type === 'reposition-transit') && leg.tripId
        ? fetchLegPath(db, feedId, leg.tripId, from.stopIds, to.stopIds)
        : Promise.resolve(null),
    ),
  );

  // ── Step 3: compute lateral offsets for all on-rail legs ─────────────────
  // Walk repositions travel off-rail so they stay at offset 0.
  const offsets = assignOffsets(
    entries.map((e) =>
      (e.leg.type === 'transit' || e.leg.type === 'reposition-transit')
        ? [e.leg.fromStationId, e.leg.toStationId] as const
        : null,
    ),
  );

  // ── Step 4: build GeoJSON ─────────────────────────────────────────────────
  const transitFeats: Feature<LineString, { color: string; offset: number }>[]             = [];
  const repoFeats:    Feature<LineString, { mode: 'walk' | 'transit'; offset: number }>[] = [];
  const stopFeats:    Feature<Point,      { name: string }>[]                              = [];

  // Badge data accumulated during the loop; positions deoverlapped afterwards.
  const badgeData: { seq: string; color: string; opacity: number; pos: Pos; leg: ScheduledLeg }[] = [];

  const seenStops = new Set<string>();
  let legSeq = 0;

  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  const expand = (lon: number, lat: number) => {
    if (lon < w) w = lon; if (lon > e) e = lon;
    if (lat < s) s = lat; if (lat > n) n = lat;
  };

  for (let k = 0; k < entries.length; k++) {
    const { leg, legIdx, from, to } = entries[k];
    const path   = paths[k];
    const offset = offsets[k];

    const lineCoords: Pos[] | null =
      (path && path.length >= 2)
        ? path
        : (from.lon !== to.lon || from.lat !== to.lat)
          ? [[from.lon, from.lat], [to.lon, to.lat]]
          : null;

    for (const [lon, lat] of (lineCoords ?? [[from.lon, from.lat]])) expand(lon, lat);

    // Collect badge — positions are deoverlapped after the loop.
    legSeq += 1;
    const isRepo = leg.type !== 'transit';
    badgeData.push({
      seq:     String(legSeq),
      color:   isRepo ? '#9090A8' : (legColors[legIdx] ?? '#4A5C68'),
      opacity: isRepo ? 0.7 : 1.0,
      pos:     pathMidpoint(lineCoords ?? [[from.lon, from.lat], [to.lon, to.lat]]),
      leg,
    });

    if (lineCoords) {
      if (leg.type === 'transit') {
        transitFeats.push({
          type: 'Feature',
          properties: { color: legColors[legIdx] ?? '#4A5C68', offset },
          geometry: { type: 'LineString', coordinates: lineCoords },
        });
      } else {
        repoFeats.push({
          type: 'Feature',
          properties: { mode: leg.type === 'reposition-transit' ? 'transit' : 'walk', offset },
          geometry: { type: 'LineString', coordinates: lineCoords },
        });
      }
    }

    for (const [id, st] of [[leg.fromStationId, from], [leg.toStationId, to]] as [string, Station][]) {
      if (!seenStops.has(id)) {
        seenStops.add(id);
        stopFeats.push({
          type: 'Feature',
          properties: { name: st.name },
          geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
        });
      }
    }
  }

  if (w === Infinity) return null;

  // Deoverlap badge positions and build waypoint features.
  const deoverlapped = deoverlapPoints(badgeData.map((b) => b.pos));
  const waypointFeats: Feature<Point, { seq: string; color: string; opacity: number }>[] =
    badgeData.map(({ seq, color, opacity }, i) => ({
      type: 'Feature',
      properties: { seq, color, opacity },
      geometry: { type: 'Point', coordinates: deoverlapped[i] },
    }));

  const firstEntry = entries[0];
  const last       = entries[entries.length - 1];

  return {
    startCoord: [firstEntry.from.lon, firstEntry.from.lat],
    endCoord:   [last.to.lon, last.to.lat],
    transit:   { type: 'FeatureCollection', features: transitFeats },
    repo:      { type: 'FeatureCollection', features: repoFeats },
    stops:     { type: 'FeatureCollection', features: stopFeats },
    waypoints: { type: 'FeatureCollection', features: waypointFeats },
    bounds:    [w, s, e, n],
    badgeLegs: badgeData.map((b) => b.leg),
  };
}

// ─── Terminal markers (Start / Finish) ───────────────────────────────────────

function TerminalMarker({ label, color }: { label: 'Start' | 'Finish'; color: string }) {
  return (
    <View pointerEvents="none" style={markerStyles.wrap}>
      <View style={[markerStyles.bubble, { backgroundColor: color }]}>
        <Text style={markerStyles.text}>{label}</Text>
      </View>
      <View style={[markerStyles.notch, { borderTopColor: color }]} />
    </View>
  );
}

const markerStyles = StyleSheet.create({
  wrap:   { alignItems: 'center' },
  bubble: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 4,
    elevation: 5,
  },
  text:  { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  notch: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 9,
    borderStyle: 'solid',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});

// ─── Component ────────────────────────────────────────────────────────────────

export interface RouteMapProps {
  visible: boolean;
  onClose: () => void;
  mergedLegs: ScheduledLeg[];
  legColors: (string | null)[];
  stations: Map<string, Station>;
  db: SQLiteDatabase;
  feedId: number;
}

type SelectedBadge = { seq: number; leg: ScheduledLeg; color: string };

function fmtDur(dep: string, arr: string): string {
  const [dh, dm] = dep.split(':').map(Number);
  const [ah, am] = arr.split(':').map(Number);
  let mins = (ah * 60 + am) - (dh * 60 + dm);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export function RouteMap({ visible, onClose, mergedLegs, legColors, stations, db, feedId }: RouteMapProps) {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [selectedBadge, setSelectedBadge] = useState<SelectedBadge | null>(null);

  useEffect(() => { if (!visible) setSelectedBadge(null); }, [visible]);

  const zoomIn  = useCallback(() => {
    const z = (zoom ?? 12) + 1;
    cameraRef.current?.zoomTo(z, { duration: 200 });
  }, [zoom]);

  const zoomOut = useCallback(() => {
    const z = Math.max(1, (zoom ?? 12) - 1);
    cameraRef.current?.zoomTo(z, { duration: 200 });
  }, [zoom]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    buildMapData(mergedLegs, legColors, stations, db, feedId).then((data) => {
      if (!cancelled) setMapData(data);
    });
    return () => { cancelled = true; };
  }, [visible, mergedLegs, legColors, stations, db, feedId]);

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root}>
        {mapData ? (
          <MapView
            style={styles.map}
            mapStyle={LIBERTY_STYLE_URL}
            logo={false}
            attribution={false}
            onRegionDidChange={(e) => setZoom(e.nativeEvent.zoom)}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{
                bounds: mapData.bounds,
                padding: {
                  top:    insets.top + 100,
                  bottom: insets.bottom + 80,
                  left:   100,
                  right:  100,
                },
              }}
            />

            {/* Reposition legs — walk: dashed thin; transit: solid, slightly thicker */}
            {mapData.repo.features.length > 0 && (
              <GeoJSONSource id="repo" data={mapData.repo}>
                <Layer
                  id="repo-walk-line"
                  type="line"
                  filter={['==', ['get', 'mode'], 'walk']}
                  paint={{
                    'line-color': '#9090A8',
                    'line-width': 1.5,
                    'line-dasharray': [2, 5],
                    'line-opacity': 0.55,
                  }}
                />
                <Layer
                  id="repo-transit-line"
                  type="line"
                  filter={['==', ['get', 'mode'], 'transit']}
                  paint={{
                    'line-color': '#9090A8',
                    'line-width': 3,
                    'line-opacity': 0.55,
                    'line-offset': ['get', 'offset'],
                  }}
                  layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                />
                <Layer
                  id="repo-arrows"
                  type="symbol"
                  layout={{
                    'symbol-placement': 'line',
                    'symbol-spacing': 40,
                    'text-field': '>',
                    'text-size': 18,
                    'text-font': ['Noto Sans Regular'],
                    'text-keep-upright': false,
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                  }}
                  paint={{
                    'text-color': '#9090A8',
                    'text-opacity': 0.45,
                  }}
                />
              </GeoJSONSource>
            )}

            {/* Transit legs — solid colour, laterally offset to avoid overlap */}
            <GeoJSONSource id="transit" data={mapData.transit}>
              <Layer
                id="transit-line"
                type="line"
                paint={{
                  'line-color': ['get', 'color'],
                  'line-width': 5,
                  'line-offset': ['get', 'offset'],
                }}
                layout={{
                  'line-cap': 'round',
                  'line-join': 'round',
                }}
              />
              <Layer
                id="transit-arrows"
                type="symbol"
                layout={{
                  'symbol-placement': 'line',
                  'symbol-spacing': 100,
                  'text-field': '>',
                  'text-size': 18,
                  'text-font': ['Noto Sans Regular'],
                  'text-keep-upright': false,
                  'text-rotation-alignment': 'map',
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                }}
                paint={{
                  'text-color': '#FFFFFF',
                  'text-opacity': 0.8,
                }}
              />
            </GeoJSONSource>

            {/* Small stop dots */}
            <GeoJSONSource id="stops" data={mapData.stops}>
              <Layer
                id="stop-circles"
                type="circle"
                paint={{
                  'circle-radius': 3,
                  'circle-color': '#FFFFFF',
                  'circle-stroke-width': 1.5,
                  'circle-stroke-color': '#4A4868',
                }}
              />
            </GeoJSONSource>

            {/* Numbered leg badges — deoverlapped midpoints */}
            <GeoJSONSource
              id="waypoints"
              data={mapData.waypoints}
              onPress={(e) => {
                const feat = e.nativeEvent.features[0];
                if (!feat?.properties) return;
                const { seq, color } = feat.properties as { seq: string; color: string };
                const idx = parseInt(seq, 10) - 1;
                if (idx < 0 || idx >= mapData.badgeLegs.length) return;
                setSelectedBadge({ seq: parseInt(seq, 10), leg: mapData.badgeLegs[idx], color });
              }}
            >
              <Layer
                id="waypoint-disc"
                type="circle"
                paint={{
                  'circle-radius': 11,
                  'circle-color': ['get', 'color'],
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#FFFFFF',
                  'circle-opacity': ['get', 'opacity'],
                  'circle-stroke-opacity': ['get', 'opacity'],
                }}
              />
              <Layer
                id="waypoint-label"
                type="symbol"
                layout={{
                  'text-field': ['get', 'seq'],
                  'text-size': 11,
                  'text-font': ['Noto Sans Bold'],
                  'text-anchor': 'center',
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                }}
                paint={{
                  'text-color': '#FFFFFF',
                  'text-opacity': ['get', 'opacity'],
                }}
              />
            </GeoJSONSource>

            {/* Start / Finish callout markers — rendered above all layers */}
            <Marker id="marker-start" lngLat={mapData.startCoord} anchor="bottom">
              <TerminalMarker label="Start" color="#1A56C4" />
            </Marker>
            <Marker id="marker-finish" lngLat={mapData.endCoord} anchor="bottom">
              <TerminalMarker label="Finish" color="#1E7835" />
            </Marker>
          </MapView>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Loading map…</Text>
          </View>
        )}

        {/* Leg info popup */}
        {selectedBadge && (() => {
          const { seq, leg, color } = selectedBadge;
          const isTransit = leg.type === 'transit';
          const isRepoTransit = leg.type === 'reposition-transit';
          return (
            <View style={[styles.popup, { bottom: insets.bottom + 16 }]}>
              <View style={[styles.popupAccent, { backgroundColor: color }]} />
              <View style={styles.popupBody}>
                <View style={styles.popupRow}>
                  <View style={[styles.popupSeq, { backgroundColor: color }]}>
                    <Text style={styles.popupSeqText}>#{seq}</Text>
                  </View>
                  <Text style={styles.popupType}>
                    {isTransit ? '🚊 Transit' : isRepoTransit ? '↩ Reposition (transit)' : '🚶 Walk'}
                  </Text>
                  <Pressable onPress={() => setSelectedBadge(null)} hitSlop={10} style={styles.popupCloseBtn}>
                    <Text style={styles.popupCloseText}>✕</Text>
                  </Pressable>
                </View>

                <Text style={styles.popupStations} numberOfLines={2}>
                  {leg.fromStationName}
                  <Text style={styles.popupArrow}> → </Text>
                  {leg.toStationName}
                </Text>

                <View style={styles.popupRow}>
                  <Text style={styles.popupTime}>{leg.departureTime} → {leg.arrivalTime}</Text>
                  <Text style={styles.popupDur}>{fmtDur(leg.departureTime, leg.arrivalTime)}</Text>
                </View>

                {(isTransit || isRepoTransit) && (leg.routeShortName || leg.tripHeadsign) && (
                  <Text style={styles.popupLine} numberOfLines={1}>
                    {leg.routeShortName ? `Line ${leg.routeShortName}` : ''}
                    {leg.tripHeadsign ? ` → ${leg.tripHeadsign}` : ''}
                  </Text>
                )}

                {leg.intermediateCount > 0 && (
                  <Text style={styles.popupIntermediate}>
                    {leg.intermediateCount} intermediate stop{leg.intermediateCount !== 1 ? 's' : ''}
                  </Text>
                )}

                {leg.isImpossible && (
                  <Text style={styles.popupWarn}>⚠ No matching trip found</Text>
                )}
              </View>
            </View>
          );
        })()}

        {/* Zoom controls */}
        <View style={[styles.zoomControls, { bottom: insets.bottom + 24 }]}>
          <Pressable style={styles.zoomBtn} onPress={zoomIn} hitSlop={6}>
            <Text style={styles.zoomBtnText}>+</Text>
          </Pressable>
          <View style={styles.zoomDivider} />
          <Pressable style={styles.zoomBtn} onPress={zoomOut} hitSlop={6}>
            <Text style={styles.zoomBtnText}>−</Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.closeBtn, { top: insets.top + 12 }]}
          onPress={onClose}
          hitSlop={8}
        >
          <Text style={styles.closeBtnText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#0D0C18' },
  map:       { flex: 1 },
  empty:     { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#8A86A0', fontSize: 14 },
  closeBtn: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700', lineHeight: 20 },
  zoomControls: {
    position: 'absolute',
    right: 16,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  zoomBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: { color: '#FFF', fontSize: 22, fontWeight: '300', lineHeight: 26 },
  zoomDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.2)' },

  popup: {
    position: 'absolute',
    left: 12,
    right: 64,   // leave room for zoom controls on the right
    borderRadius: 14,
    backgroundColor: '#191728',
    flexDirection: 'row',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  popupAccent: { width: 4 },
  popupBody:   { flex: 1, padding: 12, gap: 6 },
  popupRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  popupSeq: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  popupSeqText:       { color: '#FFF', fontSize: 12, fontWeight: '800' },
  popupType:          { flex: 1, color: '#8A86A0', fontSize: 12 },
  popupCloseBtn:      { padding: 2 },
  popupCloseText:     { color: '#8A86A0', fontSize: 14, fontWeight: '600' },
  popupStations:      { color: '#F0EFF8', fontSize: 15, fontWeight: '700', lineHeight: 20 },
  popupArrow:         { color: '#524E62', fontWeight: '400' },
  popupTime:          { flex: 1, color: '#8A86A0', fontSize: 13, fontVariant: ['tabular-nums'] },
  popupDur:           { color: '#524E62', fontSize: 12 },
  popupLine:          { color: '#B0ADCC', fontSize: 13 },
  popupIntermediate:  { color: '#524E62', fontSize: 12 },
  popupWarn:          { color: '#E8C840', fontSize: 12 },
});
