import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  Alert, useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { importGtfsFeed } from '../../src/gtfs/import';
import { buildGraph, nextDateForDayOfWeek } from '../../src/graph/build';
import { setCurrentGraph } from '../../src/graph/store';
import { solve } from '../../src/solver/solve';
import { schedule } from '../../src/solver/schedule';
import { ProgressIndicator } from '../../src/components/ProgressIndicator';
import { FeedChip } from '../../src/components/FeedChip';
import { TimePicker } from '../../src/components/TimePicker';
import type { ImportProgress, ImportSummary } from '../../src/gtfs/types';
import type { GraphBuildProgress, CompressedGraph, DayOfWeek } from '../../src/graph/types';
import type { PlannedRoute, RouteLeg, ScheduledLeg, ScheduledRoute } from '../../src/solver/types';
import { RouteMap } from '../../src/components/RouteMap';

type FeedEntry = ImportSummary & { type: 'primary' | 'auxiliary' };
type Phase =
  | 'idle' | 'importing' | 'imported'
  | 'building' | 'built'
  | 'solving' | 'solved'
  | 'scheduling' | 'scheduled';

const DAYS: { key: DayOfWeek; label: string }[] = [
  { key: 'monday',    label: 'Mon' },
  { key: 'tuesday',  label: 'Tue' },
  { key: 'wednesday',label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday',   label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday',   label: 'Sun' },
];

// Colours cycling through tram-style hues; same index → same colour across views.
const TRANSIT_COLORS = [
  '#C5202A', '#1450B0', '#1E7835', '#D05C08',
  '#6A2C9E', '#0A7265', '#B8860B', '#4A5C68',
];
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];

function timeToSecs(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}


interface ItineraryPlan {
  mergedLegs: ScheduledLeg[];
  legColors: (string | null)[]; // index-aligned with mergedLegs; null = reposition
}

function computeItinerary(legs: ScheduledLeg[]): ItineraryPlan {
  const colorMap = new Map<string, string>();
  let ci = 0;
  const mergedLegs = mergeLegsForDisplay(legs);
  const legColors: (string | null)[] = [];

  for (const leg of mergedLegs) {
    if (leg.type !== 'transit') {
      legColors.push(null);
    } else {
      const key = leg.routeShortName ?? `__${ci}`;
      if (!colorMap.has(key)) colorMap.set(key, TRANSIT_COLORS[ci++ % TRANSIT_COLORS.length]);
      legColors.push(colorMap.get(key)!);
    }
  }

  return { mergedLegs, legColors };
}

function fmtDuration(secs: number): string {
  const m = Math.round(secs / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Merge consecutive transit legs where the rider stays on the same vehicle.
// Each merged-away leg contributes its intermediates + 1 (for the junction stop itself).
function mergeLegsForDisplay(legs: ScheduledLeg[]): ScheduledLeg[] {
  const result: ScheduledLeg[] = [];
  for (const leg of legs) {
    if (leg.type === 'transit' && leg.stayOnBoard && result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.type === 'transit') {
        result[result.length - 1] = {
          ...prev,
          toStationId: leg.toStationId,
          toStationName: leg.toStationName,
          arrivalTime: leg.arrivalTime,
          intermediateCount: prev.intermediateCount + 1 + leg.intermediateCount,
          isImpossible: prev.isImpossible || leg.isImpossible,
        };
        continue;
      }
    }
    result.push({ ...leg });
  }
  return result;
}

export default function PlanScreen() {
  const db = useSQLiteContext();
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();
  const s = dark ? darkStyles : lightStyles;

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ImportProgress | GraphBuildProgress | null>(null);
  const [asyncMsg, setAsyncMsg] = useState('');
  const [feeds, setFeeds] = useState<FeedEntry[]>([]);

  const [dayOfWeek, setDayOfWeek] = useState<DayOfWeek>('monday');
  const [windowStart, setWindowStart] = useState('09:00');
  const [windowEnd, setWindowEnd] = useState('18:00');

  const [graphResult, setGraphResult] = useState<CompressedGraph | null>(null);
  const [solutions, setSolutions] = useState<PlannedRoute[]>([]);
  const [scheduledRoute, setScheduledRoute] = useState<ScheduledRoute | null>(null);
  const [showMap, setShowMap] = useState(false);
  const itinPlan = useMemo<ItineraryPlan | null>(
    () => scheduledRoute ? computeItinerary(scheduledRoute.legs) : null,
    [scheduledRoute],
  );

  const hasPrimary = feeds.some((f) => f.type === 'primary');
  const primaryFeed = feeds.find((f) => f.type === 'primary');

  // ── Import ──────────────────────────────────────────────────────────────────

  const pickAndImport = useCallback(async (type: 'primary' | 'auxiliary') => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/zip',
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    const feedName = asset.name.replace(/\.zip$/i, '');

    setPhase('importing');
    setProgress({ step: 1, totalSteps: 7, label: 'Starting import…' });

    try {
      const summary = await importGtfsFeed(db, asset.uri, feedName, type, setProgress);
      setFeeds((prev) => [...prev, { ...summary, type }]);
      setPhase('imported');
      setGraphResult(null);
      setSolutions([]);
      setScheduledRoute(null);
    } catch (err: any) {
      setPhase(feeds.length > 0 ? 'imported' : 'idle');
      Alert.alert('Import failed', err?.message ?? 'Unknown error');
    }
  }, [db, feeds.length]);

  const removeFeed = useCallback((feedId: number) => {
    setFeeds((prev) => {
      const next = prev.filter((f) => f.feedId !== feedId);
      if (!next.some((f) => f.type === 'primary')) {
        setPhase('idle');
        setGraphResult(null);
        setSolutions([]);
        setScheduledRoute(null);
      }
      return next;
    });
  }, []);

  // ── Graph build ──────────────────────────────────────────────────────────────

  const startBuildGraph = useCallback(async () => {
    if (!primaryFeed) return;
    if (windowStart >= windowEnd) {
      Alert.alert('Invalid window', 'End time must be after start time.');
      return;
    }

    const date = nextDateForDayOfWeek(dayOfWeek);
    setPhase('building');
    setProgress({ step: 1, totalSteps: 5, label: 'Starting…' });
    setSolutions([]);
    setScheduledRoute(null);

    try {
      const auxiliaryFeedIds = feeds
        .filter((f) => f.type === 'auxiliary')
        .map((f) => f.feedId);

      const graph = await buildGraph(
        db,
        { feedId: primaryFeed.feedId, feedName: primaryFeed.feedName, auxiliaryFeedIds, dayOfWeek, date, windowStart, windowEnd },
        setProgress,
      );
      setCurrentGraph(graph);
      setGraphResult(graph);
      setPhase('built');
    } catch (err: any) {
      setPhase('imported');
      Alert.alert('Graph build failed', err?.message ?? 'Unknown error');
    }
  }, [db, primaryFeed, dayOfWeek, windowStart, windowEnd]);

  // ── Solver ───────────────────────────────────────────────────────────────────

  const startSolve = useCallback(async () => {
    if (!graphResult) return;
    setPhase('solving');
    setAsyncMsg('Initialising…');
    setSolutions([]);
    setScheduledRoute(null);

    try {
      const routes = await solve(graphResult, { maxSolutions: 3 }, setAsyncMsg);
      setSolutions(routes);
      setPhase('solved');
    } catch (err: any) {
      setPhase('built');
      Alert.alert('Solver failed', err?.message ?? 'Unknown error');
    }
  }, [graphResult]);

  // ── Scheduler ────────────────────────────────────────────────────────────────

  const startSchedule = useCallback(async (solution: PlannedRoute) => {
    if (!graphResult) return;
    setPhase('scheduling');
    setAsyncMsg('Starting…');

    try {
      const result = await schedule(db, solution, graphResult, setAsyncMsg);
      setScheduledRoute(result);
      setPhase('scheduled');
    } catch (err: any) {
      setPhase('solved');
      Alert.alert('Scheduling failed', err?.message ?? 'Unknown error');
    }
  }, [db, graphResult]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const showingAsyncProgress = phase === 'solving' || phase === 'scheduling';
  const showingImportProgress = phase === 'importing' || phase === 'building';
  const showConfig = hasPrimary && (phase === 'imported' || phase === 'built');
  const showGraphResults = phase === 'built' && graphResult !== null;
  const showImportActions = !showingImportProgress && !showingAsyncProgress
    && phase !== 'solved' && phase !== 'scheduled';

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.title}>Plan a Trip</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Feeds */}
        {feeds.length > 0 && phase !== 'solved' && phase !== 'scheduled' && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>LOADED FEEDS</Text>
            {feeds.map((f) => (
              <FeedChip key={f.feedId} feed={f} onRemove={() => removeFeed(f.feedId)} />
            ))}
          </View>
        )}

        {/* Import progress / graph build progress */}
        {(showingImportProgress) && progress && (
          <View style={s.section}>
            <ProgressIndicator progress={progress as ImportProgress} />
          </View>
        )}

        {/* Solver / scheduler spinner */}
        {showingAsyncProgress && (
          <View style={s.section}>
            <View style={s.spinnerCard}>
              <Text style={s.spinnerTitle}>
                {phase === 'solving' ? 'Computing optimal routes…' : 'Scheduling real trips…'}
              </Text>
              {asyncMsg ? <Text style={s.spinnerDetail}>{asyncMsg}</Text> : null}
            </View>
          </View>
        )}

        {/* Import actions */}
        {showImportActions && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>GTFS ARCHIVES</Text>
            {!hasPrimary && (
              <Pressable style={[s.fileZone, s.fileZonePrimary]} onPress={() => pickAndImport('primary')}>
                <Text style={s.fileZoneIcon}>📂</Text>
                <Text style={s.fileZoneTitle}>Add Primary Feed</Text>
                <Text style={s.fileZoneSub}>The mode you want to complete (e.g. trams)</Text>
              </Pressable>
            )}
            {hasPrimary && (
              <Pressable style={s.fileZone} onPress={() => pickAndImport('auxiliary')}>
                <Text style={s.fileZoneIcon}>➕</Text>
                <Text style={s.fileZoneTitle}>Add Auxiliary Feed</Text>
                <Text style={s.fileZoneSub}>Optional — buses, metro, etc. for repositioning</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Empty state */}
        {feeds.length === 0 && phase === 'idle' && (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>🚋</Text>
            <Text style={s.emptyTitle}>Import a GTFS Feed</Text>
            <Text style={s.emptyBody}>
              Download a GTFS archive from your city's transit agency and import it to get started.
              Kraków feeds are available at gtfs.ztp.krakow.pl
            </Text>
          </View>
        )}

        {/* Configure */}
        {showConfig && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>CONFIGURE</Text>
            <View style={s.configCard}>
              <Text style={s.configLabel}>Day of week</Text>
              <View style={s.dayRow}>
                {DAYS.map(({ key, label }) => (
                  <Pressable
                    key={key}
                    style={[s.dayBtn, dayOfWeek === key && s.dayBtnSelected]}
                    onPress={() => setDayOfWeek(key)}
                  >
                    <Text style={[s.dayBtnText, dayOfWeek === key && s.dayBtnTextSelected]}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[s.configLabel, { marginTop: 14 }]}>Time window</Text>
              <View style={s.timeRow}>
                <TimePicker label="From" value={windowStart} onChange={setWindowStart} />
                <Text style={s.timeSep}>→</Text>
                <TimePicker label="To" value={windowEnd} onChange={setWindowEnd} />
              </View>

              <Pressable style={s.buildBtn} onPress={startBuildGraph}>
                <Text style={s.buildBtnText}>
                  {phase === 'built' ? 'Rebuild Graph' : 'Build Graph →'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Graph results */}
        {showGraphResults && graphResult && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>GRAPH RESULTS</Text>
            <View style={s.resultCard}>
              <Text style={s.resultTitle}>
                {graphResult.config.feedName} — {capitalize(graphResult.config.dayOfWeek)}{' '}
                {graphResult.config.windowStart}–{graphResult.config.windowEnd}
              </Text>
              <Text style={s.resultDate}>Date used: {formatDate(graphResult.config.date)}</Text>

              <View style={s.statsGrid}>
                <StatBox label="Services" value={graphResult.activeServiceIds.size} s={s} />
                <StatBox label="Stations" value={graphResult.stations.size} s={s} />
                <StatBox label="Served"   value={graphResult.servedStationCount} s={s} />
                <StatBox label="Nodes"    value={graphResult.nodes.size} s={s} />
              </View>

              <Text style={s.nodeBreakdownText}>
                {graphResult.edges.length} edges · {countRole(graphResult.nodes, 'terminus')} termini · {countRole(graphResult.nodes, 'junction')} junctions
              </Text>

              {graphResult.activeServiceIds.size === 0 && (
                <Text style={s.warnText}>
                  No calendar entries found for {formatDate(graphResult.config.date)} ({capitalize(graphResult.config.dayOfWeek)}). Your GTFS archive may have expired — try importing a newer feed.
                </Text>
              )}
              {graphResult.activeServiceIds.size > 0 && graphResult.nodes.size === 0 && (
                <Text style={s.warnText}>
                  No trips run within {graphResult.config.windowStart}–{graphResult.config.windowEnd}. Try a wider time window.
                </Text>
              )}
            </View>

            {graphResult.unservedStationIds.length > 0 && (
              <View style={[s.resultCard, s.warnCard]}>
                <Text style={s.warnTitle}>
                  {graphResult.unservedStationIds.length} unserved station{graphResult.unservedStationIds.length !== 1 ? 's' : ''}
                </Text>
                <Text style={s.warnSub}>
                  {graphResult.unservedStationIds.length === graphResult.stations.size
                    ? 'All stations unserved — GTFS calendar may not cover this date.'
                    : 'These stops have no trips during your chosen hours.'}
                </Text>
                {graphResult.unservedStationIds.slice(0, 10).map((id) => (
                  <Text key={id} style={s.unservedItem}>• {graphResult.stations.get(id)?.name ?? id}</Text>
                ))}
                {graphResult.unservedStationIds.length > 10 && (
                  <Text style={s.unservedMore}>+{graphResult.unservedStationIds.length - 10} more</Text>
                )}
              </View>
            )}

            {graphResult.nodes.size > 0 && (
              <Pressable style={s.ctaPrimary} onPress={startSolve}>
                <Text style={s.ctaPrimaryText}>Find Optimal Route →</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Solution cards */}
        {phase === 'solved' && (
          <View style={s.section}>
            <View style={s.solvedHeader}>
              <Text style={s.sectionLabel}>ROUTE OPTIONS</Text>
              <Pressable onPress={() => setPhase('built')}>
                <Text style={s.backLink}>← Back</Text>
              </Pressable>
            </View>
            {solutions.length === 0 && (
              <Text style={s.warnText}>No routes found. Try a wider time window.</Text>
            )}
            {solutions.map((sol, idx) => {
              const endName = graphResult
                ? (graphResult.stations.get(sol.legs[sol.legs.length - 1]?.edge.toId ?? '')?.name ?? '')
                : '';
              const repoCount = sol.legs.filter((l) => l.repositionFromId !== null).length;
              const label = OPTION_LABELS[idx] ?? String(idx + 1);
              return (
                <Pressable
                  key={idx}
                  style={[s.forkCard, idx === 0 && s.forkCardBest]}
                  onPress={() => startSchedule(sol)}
                >
                  {/* ── Card header ── */}
                  <View style={s.forkCardTop}>
                    <View style={s.forkLabelRow}>
                      <Text style={s.forkOptionLabel}>Option {label}</Text>
                      <View style={s.forkBadgesRow}>
                        {idx === 0 && <Text style={s.forkBadgeBest}>★ Best</Text>}
                        {sol.isUserPreferred && idx > 0 && <Text style={s.forkBadge}>Your start</Text>}
                        {!sol.isComplete && <Text style={s.forkBadgeWarn}>Incomplete</Text>}
                      </View>
                    </View>
                    <Text style={s.forkDuration}>{fmtDuration(sol.totalEstimatedSecs)}</Text>
                    <Text style={s.forkRoute}>
                      {sol.startName}{endName ? ` → ${endName}` : ''}
                    </Text>
                    <View style={s.forkStats}>
                      <Text style={s.forkStat}>{sol.legs.length} leg{sol.legs.length !== 1 ? 's' : ''}</Text>
                      {repoCount > 0 && (
                        <Text style={s.forkStat}>
                          {'  ·  '}{repoCount} {repoCount === 1 ? 'reposition' : 'repositions'}
                        </Text>
                      )}
                      {graphResult && (
                        <Text style={s.forkStat}>{'  ·  '}{graphResult.servedStationCount} stops</Text>
                      )}
                    </View>
                  </View>

                  {/* ── Footer CTA ── */}
                  <View style={s.forkFooter}>
                    <Text style={s.forkFooterText}>Schedule This Route →</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Scheduled itinerary */}
        {phase === 'scheduled' && scheduledRoute && itinPlan && (
          <View style={s.section}>
            <View style={s.solvedHeader}>
              <Text style={s.sectionLabel}>ITINERARY</Text>
              <View style={s.itinHeaderRight}>
                <Pressable onPress={() => setPhase('solved')}>
                  <Text style={s.backLink}>← Routes</Text>
                </Pressable>
                <Pressable onPress={() => setShowMap(true)}>
                  <Text style={s.backLink}>Map →</Text>
                </Pressable>
              </View>
            </View>

            <View style={s.itinerarySummary}>
              <Text style={s.itinTime}>
                {scheduledRoute.actualDepartureTime} → {scheduledRoute.actualArrivalTime}
              </Text>
              <Text style={s.itinDuration}>
                {fmtDuration(scheduledRoute.totalActualSecs)}
              </Text>
              {scheduledRoute.impossibleCount > 0 && (
                <Text style={s.itinWarn}>
                  ⚠ {scheduledRoute.impossibleCount} leg{scheduledRoute.impossibleCount !== 1 ? 's' : ''} with no trip found
                </Text>
              )}
            </View>

            {itinPlan.mergedLegs.map((leg, idx) => {
              const legColor = itinPlan.legColors[idx];
              return (
                <View
                  key={idx}
                  style={[
                    s.legRow,
                    leg.isImpossible && s.legRowImpossible,
                    leg.type !== 'transit' && s.legRowRepo,
                    // Coloured left accent on coverage legs; transparent placeholder on
                    // reposition legs keeps the time column aligned across both row types.
                    legColor ? { borderLeftColor: legColor } : undefined,
                  ]}
                >
                  {leg.type !== 'transit' ? (
                    <>
                      <Text style={s.legTime}>{leg.departureTime}</Text>
                      <View style={s.legBody}>
                        <Text style={s.legStation}>{leg.fromStationName}</Text>
                        {leg.type === 'reposition-transit' ? (
                          <>
                            <Text style={s.legRoute}>
                              ↩ {leg.routeShortName ? `Line ${leg.routeShortName}` : 'Transit'}
                              {leg.tripHeadsign ? ` → ${leg.tripHeadsign}` : ''}
                              {' · reposition'}
                            </Text>
                            <Text style={s.legArrStation}>
                              <Text style={s.legArrTime}>{leg.arrivalTime} </Text>
                              {leg.toStationName}
                            </Text>
                          </>
                        ) : (
                          <Text style={s.legRoute}>↪ Walk (~{fmtDuration(
                            timeToSecs(leg.arrivalTime) - timeToSecs(leg.departureTime)
                          )})</Text>
                        )}
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={[s.legTime, leg.isImpossible && s.legTimeWarn]}>
                        {leg.departureTime}
                      </Text>
                      <View style={s.legBody}>
                        <Text style={s.legStation}>{leg.fromStationName}</Text>
                        <Text style={s.legRoute}>
                          {leg.isImpossible ? '⚠ No trip found · ' : ''}
                          {leg.routeShortName ? `Line ${leg.routeShortName}` : 'Line ?'}
                          {leg.tripHeadsign ? ` → ${leg.tripHeadsign}` : ''}
                          {leg.intermediateCount > 0 ? ` (${leg.intermediateCount} stop${leg.intermediateCount !== 1 ? 's' : ''})` : ''}
                        </Text>
                        <Text style={s.legArrStation}>
                          <Text style={s.legArrTime}>{leg.arrivalTime} </Text>
                          {leg.toStationName}
                        </Text>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
          </View>
        )}

      </ScrollView>

      {itinPlan && graphResult && (
        <RouteMap
          visible={showMap}
          onClose={() => setShowMap(false)}
          mergedLegs={itinPlan.mergedLegs}
          legColors={itinPlan.legColors}
          stations={graphResult.stations}
          db={db}
          feedId={graphResult.config.feedId}
        />
      )}
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function countRole(nodes: CompressedGraph['nodes'], role: 'terminus' | 'junction'): number {
  return [...nodes.values()].filter((n) => n.role === role).length;
}

function StatBox({ label, value, s }: { label: string; value: number; s: typeof lightStyles }) {
  return (
    <View style={s.statBox}>
      <Text style={s.statValue}>{value.toLocaleString()}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const base = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 0.5 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 40, paddingTop: 8 },
  section: { marginTop: 16, marginHorizontal: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, marginBottom: 8 },
  fileZone: {
    borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed',
    padding: 20, alignItems: 'center', gap: 6, marginBottom: 10,
  },
  fileZonePrimary: {},
  fileZoneIcon: { fontSize: 28 },
  fileZoneTitle: { fontSize: 16, fontWeight: '700' },
  fileZoneSub: { fontSize: 12, textAlign: 'center' },
  spinnerCard: { borderRadius: 14, padding: 20, alignItems: 'center', gap: 8 },
  spinnerTitle: { fontSize: 16, fontWeight: '700' },
  spinnerDetail: { fontSize: 13 },
  configCard: { borderRadius: 14, padding: 16, marginBottom: 10 },
  configLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, marginBottom: 8 },
  dayRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  dayBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  dayBtnSelected: { borderWidth: 0 },
  dayBtnText: { fontSize: 13, fontWeight: '600' },
  dayBtnTextSelected: { color: '#fff' },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  timeSep: { fontSize: 16, paddingBottom: 13 },
  buildBtn: {
    marginTop: 16, borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', backgroundColor: '#1A56C4',
  },
  buildBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  resultCard: { borderRadius: 14, padding: 16, marginBottom: 10 },
  resultTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  resultDate: { fontSize: 12, marginBottom: 12 },
  statsGrid: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statBox: { flex: 1, borderRadius: 10, padding: 10, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11, marginTop: 2 },
  nodeBreakdownText: { fontSize: 13 },
  warnCard: {},
  warnTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  warnSub: { fontSize: 12, marginBottom: 8 },
  warnText: { fontSize: 13 },
  unservedItem: { fontSize: 13, marginBottom: 2 },
  unservedMore: { fontSize: 12, marginTop: 4 },
  ctaPrimary: {
    backgroundColor: '#1A56C4', borderRadius: 14,
    padding: 16, alignItems: 'center', marginTop: 4,
  },
  ctaPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  solvedHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  itinHeaderRight: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  backLink: { fontSize: 14, fontWeight: '600' },
  solutionCard: { borderRadius: 14, padding: 16, marginBottom: 10, gap: 4 },
  solutionCardPreferred: {},
  solutionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  solutionRank: { fontSize: 13, fontWeight: '800' },
  preferredBadge: {
    fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 6, overflow: 'hidden',
  },
  incompleteBadge: {
    fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 6, overflow: 'hidden',
  },
  solutionStart: { fontSize: 13 },
  solutionTime: { fontSize: 20, fontWeight: '800' },
  solutionDetail: { fontSize: 12 },
  scheduleBtn: {
    marginTop: 10, borderRadius: 10, paddingVertical: 10,
    alignItems: 'center', backgroundColor: '#1A56C4',
  },
  scheduleBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  itinerarySummary: { borderRadius: 14, padding: 16, marginBottom: 10, gap: 4 },
  itinTime: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  itinDuration: { fontSize: 28, fontWeight: '800' },
  itinWarn: { fontSize: 13, marginTop: 4 },
  legRow: {
    borderRadius: 12, padding: 12, paddingLeft: 16,
    marginBottom: 6, flexDirection: 'row', gap: 12,
    borderLeftWidth: 4, borderLeftColor: 'transparent',
  },
  legRowImpossible: {},
  legRowRepo: {},
  legTime: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], width: 44 },
  legTimeWarn: {},
  legBody: { flex: 1, gap: 2 },
  legStation: { fontSize: 14, fontWeight: '700' },
  legRoute: { fontSize: 12 },
  legArrStation: { fontSize: 13, marginTop: 4 },
  legArrTime: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  emptyState: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  // ── Fork cards ──
  forkCard: { borderRadius: 16, overflow: 'hidden', marginBottom: 12 },
  forkCardBest: { borderWidth: 1.5 },
  forkCardTop: { padding: 16 },
  forkLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  forkBadgesRow: { flexDirection: 'row', gap: 6 },
  forkOptionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
  forkBadgeBest: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  forkBadge: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  forkBadgeWarn: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  forkDuration: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'], marginBottom: 2 },
  forkRoute: { fontSize: 13, marginBottom: 8 },
  forkStats: { flexDirection: 'row', flexWrap: 'wrap' },
  forkStat: { fontSize: 12 },
  forkFooter: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 0.5, alignItems: 'flex-end' },
  forkFooterText: { fontSize: 13, fontWeight: '700' },
});

const lightStyles = StyleSheet.create({
  ...base,
  root: { ...base.root, backgroundColor: '#EDECE9' },
  header: { ...base.header, borderBottomColor: '#D8D6E0' },
  title: { ...base.title, color: '#111018' },
  sectionLabel: { ...base.sectionLabel, color: '#938FA6' },
  fileZone: { ...base.fileZone, borderColor: '#C8C5D8', backgroundColor: '#FFFFFF' },
  fileZoneTitle: { ...base.fileZoneTitle, color: '#111018' },
  fileZoneSub: { ...base.fileZoneSub, color: '#6B6880' },
  spinnerCard: { ...base.spinnerCard, backgroundColor: '#FFFFFF' },
  spinnerTitle: { ...base.spinnerTitle, color: '#111018' },
  spinnerDetail: { ...base.spinnerDetail, color: '#6B6880' },
  configCard: { ...base.configCard, backgroundColor: '#FFFFFF' },
  configLabel: { ...base.configLabel, color: '#6B6880' },
  dayBtn: { ...base.dayBtn, borderColor: '#C8C5D8', backgroundColor: '#F4F3F7' },
  dayBtnSelected: { ...base.dayBtnSelected, backgroundColor: '#1A56C4' },
  dayBtnText: { ...base.dayBtnText, color: '#111018' },
  timeSep: { ...base.timeSep, color: '#938FA6' },
  resultCard: { ...base.resultCard, backgroundColor: '#FFFFFF' },
  resultTitle: { ...base.resultTitle, color: '#111018' },
  resultDate: { ...base.resultDate, color: '#938FA6' },
  statBox: { ...base.statBox, backgroundColor: '#F4F3F7' },
  statValue: { ...base.statValue, color: '#111018' },
  statLabel: { ...base.statLabel, color: '#938FA6' },
  nodeBreakdownText: { ...base.nodeBreakdownText, color: '#6B6880' },
  warnCard: { ...base.warnCard, backgroundColor: '#FFF8E6', borderWidth: 1, borderColor: '#F5D78A' },
  warnTitle: { ...base.warnTitle, color: '#7A5800' },
  warnSub: { ...base.warnSub, color: '#7A5800' },
  warnText: { ...base.warnText, color: '#6B6880' },
  unservedItem: { ...base.unservedItem, color: '#7A5800' },
  unservedMore: { ...base.unservedMore, color: '#938FA6' },
  backLink: { ...base.backLink, color: '#1A56C4' },
  solutionCard: { ...base.solutionCard, backgroundColor: '#FFFFFF' },
  solutionCardPreferred: { ...base.solutionCardPreferred, borderWidth: 1.5, borderColor: '#1A56C4' },
  solutionRank: { ...base.solutionRank, color: '#111018' },
  preferredBadge: { ...base.preferredBadge, backgroundColor: '#E6EEFF', color: '#1A56C4' },
  incompleteBadge: { ...base.incompleteBadge, backgroundColor: '#FFF0CC', color: '#7A5800' },
  solutionStart: { ...base.solutionStart, color: '#6B6880' },
  solutionTime: { ...base.solutionTime, color: '#111018' },
  solutionDetail: { ...base.solutionDetail, color: '#938FA6' },
  itinerarySummary: { ...base.itinerarySummary, backgroundColor: '#FFFFFF' },
  itinTime: { ...base.itinTime, color: '#6B6880' },
  itinDuration: { ...base.itinDuration, color: '#111018' },
  itinWarn: { ...base.itinWarn, color: '#7A5800' },
  legRow: { ...base.legRow, backgroundColor: '#FFFFFF' },
  legRowImpossible: { ...base.legRowImpossible, backgroundColor: '#FFF8E6' },
  legRowRepo: { ...base.legRowRepo, backgroundColor: '#F2F1F6' },
  legTime: { ...base.legTime, color: '#1A56C4' },
  legTimeWarn: { ...base.legTimeWarn, color: '#7A5800' },
  legStation: { ...base.legStation, color: '#111018' },
  legRoute: { ...base.legRoute, color: '#6B6880' },
  legArrStation: { ...base.legArrStation, color: '#6B6880' },
  legArrTime: { ...base.legArrTime, color: '#111018' },
  emptyTitle: { ...base.emptyTitle, color: '#111018' },
  emptyBody: { ...base.emptyBody, color: '#6B6880' },
  // ── Fork cards ──
  forkCard: { ...base.forkCard, backgroundColor: '#FFFFFF', borderWidth: 0.5, borderColor: '#E2E0EC' },
  forkCardBest: { ...base.forkCardBest, borderColor: '#1A56C4' },
  forkOptionLabel: { ...base.forkOptionLabel, color: '#938FA6' },
  forkBadgeBest: { ...base.forkBadgeBest, backgroundColor: '#E6EEFF', color: '#1A56C4' },
  forkBadge: { ...base.forkBadge, backgroundColor: '#F4F3F7', color: '#6B6880' },
  forkBadgeWarn: { ...base.forkBadgeWarn, backgroundColor: '#FFF0CC', color: '#7A5800' },
  forkDuration: { ...base.forkDuration, color: '#111018' },
  forkRoute: { ...base.forkRoute, color: '#6B6880' },
  forkStat: { ...base.forkStat, color: '#938FA6' },
  forkFooter: { ...base.forkFooter, borderTopColor: '#F0EEF8' },
  forkFooterText: { ...base.forkFooterText, color: '#1A56C4' },
});

const darkStyles = StyleSheet.create({
  ...base,
  root: { ...base.root, backgroundColor: '#0D0C18' },
  header: { ...base.header, borderBottomColor: '#1E1C30' },
  title: { ...base.title, color: '#F0EFF8' },
  sectionLabel: { ...base.sectionLabel, color: '#524E62' },
  fileZone: { ...base.fileZone, borderColor: '#2A2840', backgroundColor: '#191728' },
  fileZoneTitle: { ...base.fileZoneTitle, color: '#F0EFF8' },
  fileZoneSub: { ...base.fileZoneSub, color: '#8A86A0' },
  spinnerCard: { ...base.spinnerCard, backgroundColor: '#191728' },
  spinnerTitle: { ...base.spinnerTitle, color: '#F0EFF8' },
  spinnerDetail: { ...base.spinnerDetail, color: '#8A86A0' },
  configCard: { ...base.configCard, backgroundColor: '#191728' },
  configLabel: { ...base.configLabel, color: '#8A86A0' },
  dayBtn: { ...base.dayBtn, borderColor: '#2A2840', backgroundColor: '#0D0C18' },
  dayBtnSelected: { ...base.dayBtnSelected, backgroundColor: '#1A56C4' },
  dayBtnText: { ...base.dayBtnText, color: '#F0EFF8' },
  timeSep: { ...base.timeSep, color: '#524E62' },
  resultCard: { ...base.resultCard, backgroundColor: '#191728' },
  resultTitle: { ...base.resultTitle, color: '#F0EFF8' },
  resultDate: { ...base.resultDate, color: '#524E62' },
  statBox: { ...base.statBox, backgroundColor: '#0D0C18' },
  statValue: { ...base.statValue, color: '#F0EFF8' },
  statLabel: { ...base.statLabel, color: '#524E62' },
  nodeBreakdownText: { ...base.nodeBreakdownText, color: '#8A86A0' },
  warnCard: { ...base.warnCard, backgroundColor: '#1C1600', borderWidth: 1, borderColor: '#3D3200' },
  warnTitle: { ...base.warnTitle, color: '#E8C840' },
  warnSub: { ...base.warnSub, color: '#C4A820' },
  warnText: { ...base.warnText, color: '#8A86A0' },
  unservedItem: { ...base.unservedItem, color: '#C4A820' },
  unservedMore: { ...base.unservedMore, color: '#524E62' },
  backLink: { ...base.backLink, color: '#4E80F0' },
  solutionCard: { ...base.solutionCard, backgroundColor: '#191728' },
  solutionCardPreferred: { ...base.solutionCardPreferred, borderWidth: 1.5, borderColor: '#4E80F0' },
  solutionRank: { ...base.solutionRank, color: '#F0EFF8' },
  preferredBadge: { ...base.preferredBadge, backgroundColor: '#0F1E3D', color: '#4E80F0' },
  incompleteBadge: { ...base.incompleteBadge, backgroundColor: '#1C1600', color: '#E8C840' },
  solutionStart: { ...base.solutionStart, color: '#8A86A0' },
  solutionTime: { ...base.solutionTime, color: '#F0EFF8' },
  solutionDetail: { ...base.solutionDetail, color: '#524E62' },
  itinerarySummary: { ...base.itinerarySummary, backgroundColor: '#191728' },
  itinTime: { ...base.itinTime, color: '#8A86A0' },
  itinDuration: { ...base.itinDuration, color: '#F0EFF8' },
  itinWarn: { ...base.itinWarn, color: '#E8C840' },
  legRow: { ...base.legRow, backgroundColor: '#191728' },
  legRowImpossible: { ...base.legRowImpossible, backgroundColor: '#1C1600' },
  legRowRepo: { ...base.legRowRepo, backgroundColor: '#111020' },
  legTime: { ...base.legTime, color: '#4E80F0' },
  legTimeWarn: { ...base.legTimeWarn, color: '#E8C840' },
  legStation: { ...base.legStation, color: '#F0EFF8' },
  legRoute: { ...base.legRoute, color: '#8A86A0' },
  legArrStation: { ...base.legArrStation, color: '#8A86A0' },
  legArrTime: { ...base.legArrTime, color: '#F0EFF8' },
  emptyTitle: { ...base.emptyTitle, color: '#F0EFF8' },
  emptyBody: { ...base.emptyBody, color: '#8A86A0' },
  // ── Fork cards ──
  forkCard: { ...base.forkCard, backgroundColor: '#191728', borderWidth: 0.5, borderColor: '#1E1C30' },
  forkCardBest: { ...base.forkCardBest, borderColor: '#4E80F0' },
  forkOptionLabel: { ...base.forkOptionLabel, color: '#524E62' },
  forkBadgeBest: { ...base.forkBadgeBest, backgroundColor: '#0F1E3D', color: '#4E80F0' },
  forkBadge: { ...base.forkBadge, backgroundColor: '#0D0C18', color: '#8A86A0' },
  forkBadgeWarn: { ...base.forkBadgeWarn, backgroundColor: '#1C1600', color: '#E8C840' },
  forkDuration: { ...base.forkDuration, color: '#F0EFF8' },
  forkRoute: { ...base.forkRoute, color: '#8A86A0' },
  forkStat: { ...base.forkStat, color: '#524E62' },
  forkFooter: { ...base.forkFooter, borderTopColor: '#12111E' },
  forkFooterText: { ...base.forkFooterText, color: '#4E80F0' },
});
