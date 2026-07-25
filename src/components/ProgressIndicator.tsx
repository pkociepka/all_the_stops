import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import type { ImportProgress } from '../gtfs/types';

interface Props {
  progress: ImportProgress;
}

export function ProgressIndicator({ progress }: Props) {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const s = dark ? darkStyles : lightStyles;

  const fraction = progress.step / progress.totalSteps;

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.step}>
          Step {progress.step}/{progress.totalSteps}
        </Text>
        <Text style={s.pct}>{Math.round(fraction * 100)}%</Text>
      </View>
      <Text style={s.label}>{progress.label}</Text>
      {progress.detail ? <Text style={s.detail}>{progress.detail}</Text> : null}
      <View style={s.track}>
        <View style={[s.fill, { width: `${fraction * 100}%` }]} />
      </View>
      <View style={s.dots}>
        {Array.from({ length: progress.totalSteps }, (_, i) => (
          <View
            key={i}
            style={[s.dot, i < progress.step ? s.dotDone : i === progress.step - 1 ? s.dotActive : s.dotPending]}
          />
        ))}
      </View>
    </View>
  );
}

const base = StyleSheet.create({
  container: { padding: 20, borderRadius: 16, marginHorizontal: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  step: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  pct: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  detail: { fontSize: 13, marginBottom: 10 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 12 },
  fill: { height: '100%', borderRadius: 3, backgroundColor: '#1A56C4' },
  dots: { flexDirection: 'row', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotDone: { backgroundColor: '#1A56C4' },
  dotActive: { backgroundColor: '#1A56C4', opacity: 0.5 },
  dotPending: {},
});

const lightStyles = StyleSheet.create({
  ...base,
  container: { ...base.container, backgroundColor: '#FFFFFF' },
  step: { ...base.step, color: '#938FA6' },
  pct: { ...base.pct, color: '#1A56C4' },
  label: { ...base.label, color: '#111018' },
  detail: { ...base.detail, color: '#6B6880' },
  track: { ...base.track, backgroundColor: '#EDECF2' },
  dotPending: { ...base.dotPending, backgroundColor: '#EDECF2' },
});

const darkStyles = StyleSheet.create({
  ...base,
  container: { ...base.container, backgroundColor: '#191728' },
  step: { ...base.step, color: '#524E62' },
  pct: { ...base.pct, color: '#4E80F0' },
  label: { ...base.label, color: '#F0EFF8' },
  detail: { ...base.detail, color: '#8A86A0' },
  track: { ...base.track, backgroundColor: '#2A2840' },
  dotDone: { ...base.dotDone, backgroundColor: '#4E80F0' },
  dotActive: { ...base.dotActive, backgroundColor: '#4E80F0' },
  dotPending: { ...base.dotPending, backgroundColor: '#2A2840' },
});
