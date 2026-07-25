import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  Alert, useColorScheme, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { importGtfsFeed } from '../../src/gtfs/import';
import { buildGraph, nextDateForDayOfWeek } from '../../src/graph/build';
import { setCurrentGraph } from '../../src/graph/store';
import { ProgressIndicator } from '../../src/components/ProgressIndicator';
import { FeedChip } from '../../src/components/FeedChip';
import type { ImportProgress, ImportSummary } from '../../src/gtfs/types';
import type { GraphBuildProgress, CompressedGraph, DayOfWeek } from '../../src/graph/types';

type FeedEntry = ImportSummary & { type: 'primary' | 'auxiliary' };
type Phase = 'idle' | 'importing' | 'imported' | 'building' | 'built';

const DAYS: { key: DayOfWeek; label: string }[] = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
];

function isValidTime(t: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(t);
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}


export default function PlanScreen() {
  const db = useSQLiteContext();
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();
  const s = dark ? darkStyles : lightStyles;

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ImportProgress | GraphBuildProgress | null>(null);
  const [feeds, setFeeds] = useState<FeedEntry[]>([]);

  const [dayOfWeek, setDayOfWeek] = useState<DayOfWeek>('monday');
  const [windowStart, setWindowStart] = useState('09:00');
  const [windowEnd, setWindowEnd] = useState('18:00');

  const [graphResult, setGraphResult] = useState<CompressedGraph | null>(null);

  const hasPrimary = feeds.some((f) => f.type === 'primary');
  const primaryFeed = feeds.find((f) => f.type === 'primary');

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
      const summary = await importGtfsFeed(
        db, asset.uri, feedName, type,
        (p) => setProgress(p),
      );
      setFeeds((prev) => [...prev, { ...summary, type }]);
      setPhase('imported');
      setGraphResult(null);
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
      }
      return next;
    });
  }, []);

  const startBuildGraph = useCallback(async () => {
    if (!primaryFeed) return;

    if (!isValidTime(windowStart) || !isValidTime(windowEnd)) {
      Alert.alert('Invalid time', 'Enter times in HH:MM format (e.g. 09:00).');
      return;
    }
    if (windowStart >= windowEnd) {
      Alert.alert('Invalid window', 'End time must be after start time.');
      return;
    }

    const date = nextDateForDayOfWeek(dayOfWeek);

    setPhase('building');
    setProgress({ step: 1, totalSteps: 5, label: 'Starting…' });

    try {
      const graph = await buildGraph(
        db,
        { feedId: primaryFeed.feedId, feedName: primaryFeed.feedName, dayOfWeek, date, windowStart, windowEnd },
        (p) => setProgress(p),
      );
      setCurrentGraph(graph);
      setGraphResult(graph);
      setPhase('built');
    } catch (err: any) {
      setPhase('imported');
      Alert.alert('Graph build failed', err?.message ?? 'Unknown error');
    }
  }, [db, primaryFeed, dayOfWeek, windowStart, windowEnd]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.title}>Plan a Trip</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Imported feeds */}
        {feeds.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>LOADED FEEDS</Text>
            {feeds.map((f) => (
              <FeedChip key={f.feedId} feed={f} onRemove={() => removeFeed(f.feedId)} />
            ))}
          </View>
        )}

        {/* Import/build progress */}
        {(phase === 'importing' || phase === 'building') && progress && (
          <View style={s.section}>
            <ProgressIndicator progress={progress as ImportProgress} />
          </View>
        )}

        {/* Import actions */}
        {phase !== 'importing' && phase !== 'building' && (
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

        {/* Configure section */}
        {hasPrimary && (phase === 'imported' || phase === 'built') && (
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
                <View style={s.timeField}>
                  <Text style={s.timeLabel}>From</Text>
                  <TextInput
                    style={s.timeInput}
                    value={windowStart}
                    onChangeText={setWindowStart}
                    placeholder="09:00"
                    placeholderTextColor={dark ? '#524E62' : '#B0ADC0'}
                    maxLength={5}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                  />
                </View>
                <Text style={s.timeSep}>→</Text>
                <View style={s.timeField}>
                  <Text style={s.timeLabel}>To</Text>
                  <TextInput
                    style={s.timeInput}
                    value={windowEnd}
                    onChangeText={setWindowEnd}
                    placeholder="18:00"
                    placeholderTextColor={dark ? '#524E62' : '#B0ADC0'}
                    maxLength={5}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                  />
                </View>
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
        {phase === 'built' && graphResult && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>GRAPH RESULTS</Text>
            <View style={s.resultCard}>
              <Text style={s.resultTitle}>
                {graphResult.config.feedName} — {graphResult.config.dayOfWeek.charAt(0).toUpperCase() + graphResult.config.dayOfWeek.slice(1)}{' '}
                {graphResult.config.windowStart}–{graphResult.config.windowEnd}
              </Text>
              <Text style={s.resultDate}>Date used: {formatDate(graphResult.config.date)}</Text>

              <View style={s.statsGrid}>
                <StatBox label="Stations" value={graphResult.stations.size} s={s} />
                <StatBox label="Served" value={graphResult.servedStationCount} s={s} />
                <StatBox label="Nodes" value={graphResult.nodes.size} s={s} />
                <StatBox label="Edges" value={graphResult.edges.length} s={s} />
              </View>

              {graphResult.nodes.size > 0 && (
                <View style={s.nodeBreakdown}>
                  <Text style={s.nodeBreakdownText}>
                    {[...graphResult.nodes.values()].filter((n) => n.role === 'terminus').length} termini,{' '}
                    {[...graphResult.nodes.values()].filter((n) => n.role === 'junction').length} junctions
                  </Text>
                </View>
              )}

              {graphResult.nodes.size === 0 && (
                <Text style={s.warnText}>
                  No active services found for this day and time window. Try a different day or wider window.
                </Text>
              )}
            </View>

            {graphResult.unservedStationIds.length > 0 && (
              <View style={[s.resultCard, s.warnCard]}>
                <Text style={s.warnTitle}>
                  {graphResult.unservedStationIds.length} unserved station{graphResult.unservedStationIds.length !== 1 ? 's' : ''} in this window
                </Text>
                <Text style={s.warnSub}>These stops have no trips during your chosen hours.</Text>
                {graphResult.unservedStationIds.slice(0, 12).map((id) => {
                  const st = graphResult.stations.get(id);
                  return (
                    <Text key={id} style={s.unservedItem}>
                      • {st?.name ?? id}
                    </Text>
                  );
                })}
                {graphResult.unservedStationIds.length > 12 && (
                  <Text style={s.unservedMore}>
                    +{graphResult.unservedStationIds.length - 12} more
                  </Text>
                )}
              </View>
            )}

            {graphResult.nodes.size > 0 && (
              <Pressable
                style={s.ctaPrimary}
                onPress={() => Alert.alert('Coming soon', 'Route solver is Milestone 3.')}
              >
                <Text style={s.ctaPrimaryText}>Find Optimal Route →</Text>
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

      </ScrollView>
    </View>
  );
}

function StatBox({ label, value, s }: { label: string; value: number; s: typeof lightStyles }) {
  return (
    <View style={s.statBox}>
      <Text style={s.statValue}>{value.toLocaleString()}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

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
  configCard: { borderRadius: 14, padding: 16, marginBottom: 10 },
  configLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, marginBottom: 8 },
  dayRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  dayBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  dayBtnSelected: { borderWidth: 0 },
  dayBtnText: { fontSize: 13, fontWeight: '600' },
  dayBtnTextSelected: { color: '#fff' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeField: { flex: 1, gap: 4 },
  timeLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  timeInput: {
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'],
  },
  timeSep: { fontSize: 16, marginTop: 16 },
  buildBtn: {
    marginTop: 16, borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', backgroundColor: '#1A56C4',
  },
  buildBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  resultCard: { borderRadius: 14, padding: 16, marginBottom: 10 },
  resultTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  resultDate: { fontSize: 12, marginBottom: 12 },
  statsGrid: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statBox: { flex: 1, borderRadius: 10, padding: 10, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11, marginTop: 2 },
  nodeBreakdown: { gap: 2 },
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
  emptyState: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
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
  configCard: { ...base.configCard, backgroundColor: '#FFFFFF' },
  configLabel: { ...base.configLabel, color: '#6B6880' },
  dayBtn: { ...base.dayBtn, borderColor: '#C8C5D8', backgroundColor: '#F4F3F7' },
  dayBtnSelected: { ...base.dayBtnSelected, backgroundColor: '#1A56C4' },
  dayBtnText: { ...base.dayBtnText, color: '#111018' },
  timeLabel: { ...base.timeLabel, color: '#6B6880' },
  timeInput: { ...base.timeInput, borderColor: '#C8C5D8', backgroundColor: '#F4F3F7', color: '#111018' },
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
  emptyTitle: { ...base.emptyTitle, color: '#111018' },
  emptyBody: { ...base.emptyBody, color: '#6B6880' },
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
  configCard: { ...base.configCard, backgroundColor: '#191728' },
  configLabel: { ...base.configLabel, color: '#8A86A0' },
  dayBtn: { ...base.dayBtn, borderColor: '#2A2840', backgroundColor: '#0D0C18' },
  dayBtnSelected: { ...base.dayBtnSelected, backgroundColor: '#1A56C4' },
  dayBtnText: { ...base.dayBtnText, color: '#F0EFF8' },
  timeLabel: { ...base.timeLabel, color: '#8A86A0' },
  timeInput: { ...base.timeInput, borderColor: '#2A2840', backgroundColor: '#0D0C18', color: '#F0EFF8' },
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
  emptyTitle: { ...base.emptyTitle, color: '#F0EFF8' },
  emptyBody: { ...base.emptyBody, color: '#8A86A0' },
});
