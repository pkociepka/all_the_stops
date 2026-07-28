import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';

export interface TLSegment {
  secs: number;
  color: string | null; // null = walk / reposition
}

interface Props {
  segments: TLSegment[];
  startTime?: string;
  endTime?: string;
  startLabel?: string;
  endLabel?: string;
}

export function TimelineBar({ segments, startTime, endTime, startLabel, endLabel }: Props) {
  const dark = useColorScheme() === 'dark';

  // Ensure every segment contributes at least a sliver so nothing vanishes.
  const MIN_FLEX = 30;
  const totalFlex = segments.reduce((s, seg) => s + Math.max(seg.secs, MIN_FLEX), 0);
  if (totalFlex === 0) return null;

  const dotBg     = dark ? '#191728' : '#FFFFFF';
  const dotBorder = dark ? '#2A2840' : '#CEC9DC';
  const repoColor = dark ? '#38364A' : '#C4C0D4';

  const items: React.ReactNode[] = [];
  segments.forEach((seg, i) => {
    const flex = Math.max(seg.secs, MIN_FLEX);
    const next = segments[i + 1];

    if (seg.color !== null) {
      items.push(
        <View key={`s${i}`} style={[styles.seg, { flex, backgroundColor: seg.color }]} />,
      );
      // Transfer dot only between two consecutive transit segments.
      if (next?.color !== null && next !== undefined) {
        items.push(
          <View
            key={`d${i}`}
            style={[styles.dot, { backgroundColor: dotBg, borderColor: dotBorder }]}
          />,
        );
      }
    } else {
      // Reposition / walk: shorter bar, neutral colour.
      items.push(
        <View key={`r${i}`} style={[styles.repoSeg, { flex, backgroundColor: repoColor }]} />,
      );
    }
  });

  const showMeta = startTime || endTime || startLabel || endLabel;

  return (
    <View>
      <View style={styles.bar}>{items}</View>
      {showMeta && (
        <View style={styles.meta}>
          <View style={styles.metaSide}>
            {startTime  ? <Text style={[styles.timeText,    dark && styles.timeTextDark]}>{startTime}</Text>  : null}
            {startLabel ? <Text style={[styles.stationText, dark && styles.stationTextDark]} numberOfLines={1}>{startLabel}</Text> : null}
          </View>
          <View style={[styles.metaSide, styles.metaSideRight]}>
            {endTime  ? <Text style={[styles.timeText,    dark && styles.timeTextDark]}>{endTime}</Text>  : null}
            {endLabel ? <Text style={[styles.stationText, dark && styles.stationTextDark]} numberOfLines={1}>{endLabel}</Text> : null}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar:          { flexDirection: 'row', height: 10, alignItems: 'center' },
  seg:          { height: 10, borderRadius: 4 },
  repoSeg:      { height: 5,  borderRadius: 3 },
  dot:          { width: 8, height: 8, borderRadius: 4, borderWidth: 2, marginHorizontal: 1, flexShrink: 0 },
  meta:         { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  metaSide:     { flex: 1 },
  metaSideRight:{ alignItems: 'flex-end' },
  timeText:     { fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'], color: '#938FA6' },
  timeTextDark: { color: '#524E62' },
  stationText:      { fontSize: 10, fontWeight: '700', color: '#6B6880', marginTop: 2 },
  stationTextDark:  { color: '#8A86A0' },
});
