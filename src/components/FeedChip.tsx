import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import type { ImportSummary } from '../gtfs/types';

interface Props {
  feed: ImportSummary & { type: 'primary' | 'auxiliary' };
  onRemove?: () => void;
}

export function FeedChip({ feed, onRemove }: Props) {
  const dark = useColorScheme() === 'dark';
  const s = dark ? darkStyles : lightStyles;

  const dateRange =
    feed.calendarStart && feed.calendarEnd
      ? `${formatDate(feed.calendarStart)} – ${formatDate(feed.calendarEnd)}`
      : null;

  return (
    <View style={s.chip}>
      <View style={[s.typeBadge, feed.type === 'primary' ? s.typePrimary : s.typeAux]}>
        <Text style={s.typeText}>{feed.type === 'primary' ? 'PRIMARY' : 'AUX'}</Text>
      </View>
      <View style={s.info}>
        <Text style={s.name} numberOfLines={1}>{feed.feedName}</Text>
        <Text style={s.meta}>
          {feed.stopCount} stops · {feed.routeCount} routes
          {dateRange ? ` · ${dateRange}` : ''}
        </Text>
      </View>
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={12} style={s.remove}>
          <Text style={s.removeText}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

const base = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, padding: 12, marginBottom: 8,
  },
  typeBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  typePrimary: { backgroundColor: '#1A56C4' },
  typeAux: { backgroundColor: '#6B6880' },
  typeText: { fontSize: 9, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
  info: { flex: 1 },
  name: { fontSize: 14, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 1 },
  remove: { padding: 4 },
  removeText: { fontSize: 14 },
});

const lightStyles = StyleSheet.create({
  ...base,
  chip: { ...base.chip, backgroundColor: '#FFFFFF' },
  name: { ...base.name, color: '#111018' },
  meta: { ...base.meta, color: '#6B6880' },
  removeText: { ...base.removeText, color: '#938FA6' },
});

const darkStyles = StyleSheet.create({
  ...base,
  chip: { ...base.chip, backgroundColor: '#191728' },
  name: { ...base.name, color: '#F0EFF8' },
  meta: { ...base.meta, color: '#8A86A0' },
  removeText: { ...base.removeText, color: '#524E62' },
});
