import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  Alert, useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { useSQLiteContext } from 'expo-sqlite';
import { importGtfsFeed } from '../../src/gtfs/import';
import { ProgressIndicator } from '../../src/components/ProgressIndicator';
import { FeedChip } from '../../src/components/FeedChip';
import type { ImportProgress, ImportSummary } from '../../src/gtfs/types';

type FeedEntry = ImportSummary & { type: 'primary' | 'auxiliary' };

type Phase = 'idle' | 'importing' | 'done';

export default function PlanScreen() {
  const db = useSQLiteContext();
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();
  const s = dark ? darkStyles : lightStyles;

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [feeds, setFeeds] = useState<FeedEntry[]>([]);

  const hasPrimary = feeds.some((f) => f.type === 'primary');

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
        db,
        asset.uri,
        feedName,
        type,
        (p) => setProgress(p),
      );
      setFeeds((prev) => [...prev, { ...summary, type }]);
      setPhase('done');
    } catch (err: any) {
      setPhase('idle');
      Alert.alert('Import failed', err?.message ?? 'Unknown error');
    }
  }, []);

  const removeFeed = useCallback((feedId: number) => {
    setFeeds((prev) => prev.filter((f) => f.feedId !== feedId));
    if (feeds.length <= 1) setPhase('idle');
  }, [feeds.length]);

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

        {/* Progress */}
        {phase === 'importing' && progress && (
          <View style={s.section}>
            <ProgressIndicator progress={progress} />
          </View>
        )}

        {/* Import actions */}
        {phase !== 'importing' && (
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

        {/* Next step */}
        {hasPrimary && phase !== 'importing' && (
          <View style={s.section}>
            <Pressable style={s.ctaPrimary} onPress={() => Alert.alert('Coming soon', 'Configure screen is next milestone.')}>
              <Text style={s.ctaPrimaryText}>Configure Route →</Text>
            </Pressable>
            <Text style={s.ctaHint}>Set time window, walking options, and preferred start.</Text>
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
  ctaPrimary: {
    backgroundColor: '#1A56C4', borderRadius: 14,
    padding: 16, alignItems: 'center', marginBottom: 8,
  },
  ctaPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ctaHint: { fontSize: 12, textAlign: 'center' },
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
  ctaHint: { ...base.ctaHint, color: '#6B6880' },
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
  ctaHint: { ...base.ctaHint, color: '#8A86A0' },
  emptyTitle: { ...base.emptyTitle, color: '#F0EFF8' },
  emptyBody: { ...base.emptyBody, color: '#8A86A0' },
});
