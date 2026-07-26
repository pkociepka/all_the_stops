import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet,
  Platform, useColorScheme,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

interface Props {
  label: string;
  value: string;    // HH:MM (24-hour)
  onChange: (value: string) => void;
}

function hhmmToDate(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TimePicker({ label, value, onChange }: Props) {
  const dark = useColorScheme() === 'dark';
  const [showPicker, setShowPicker] = useState(false);
  const date = hhmmToDate(value);

  const s = dark ? darkStyles : lightStyles;

  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>

      <Pressable style={s.btn} onPress={() => setShowPicker(true)}>
        <Text style={s.time}>{value}</Text>
      </Pressable>

      {/* ── Android: DateTimePicker renders as a native dialog ── */}
      {Platform.OS === 'android' && showPicker && (
        <DateTimePicker
          value={date}
          mode="time"
          display="default"
          is24Hour={true}
          onValueChange={(_, selected) => {
            setShowPicker(false);
            onChange(dateToHHMM(selected));
          }}
          onDismiss={() => setShowPicker(false)}
        />
      )}

      {/* ── iOS: spinner inside a bottom-sheet modal ── */}
      {Platform.OS === 'ios' && (
        <Modal
          visible={showPicker}
          transparent
          animationType="slide"
          onRequestClose={() => setShowPicker(false)}
        >
          <Pressable style={styles.backdrop} onPress={() => setShowPicker(false)} />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetLabel}>{label}</Text>
            <DateTimePicker
              value={date}
              mode="time"
              display="spinner"
              is24Hour={true}
              style={styles.iosPicker}
              onValueChange={(_, selected) => onChange(dateToHHMM(selected))}
            />
            <Pressable style={s.doneBtn} onPress={() => setShowPicker(false)}>
              <Text style={s.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  iosPicker: { width: '100%' },
});

const base = StyleSheet.create({
  field: { flex: 1 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3, marginBottom: 6 },
  btn: {
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 11,
    alignItems: 'center',
  },
  time: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 10, paddingBottom: 40, paddingHorizontal: 20,
    alignItems: 'center',
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2, marginBottom: 16,
  },
  sheetLabel: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  doneBtn: {
    marginTop: 12, borderRadius: 12, paddingVertical: 12,
    paddingHorizontal: 40, alignItems: 'center',
  },
  doneBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

const lightStyles = StyleSheet.create({
  ...base,
  label: { ...base.label, color: '#6B6880' },
  btn: { ...base.btn, borderColor: '#C8C5D8', backgroundColor: '#F4F3F7' },
  time: { ...base.time, color: '#111018' },
  sheet: { ...base.sheet, backgroundColor: '#FFFFFF' },
  sheetHandle: { ...base.sheetHandle, backgroundColor: '#D8D6E0' },
  sheetLabel: { ...base.sheetLabel, color: '#111018' },
  doneBtn: { ...base.doneBtn, backgroundColor: '#1A56C4' },
  doneBtnText: { ...base.doneBtnText },
});

const darkStyles = StyleSheet.create({
  ...base,
  label: { ...base.label, color: '#8A86A0' },
  btn: { ...base.btn, borderColor: '#2A2840', backgroundColor: '#0D0C18' },
  time: { ...base.time, color: '#F0EFF8' },
  sheet: { ...base.sheet, backgroundColor: '#191728' },
  sheetHandle: { ...base.sheetHandle, backgroundColor: '#2A2840' },
  sheetLabel: { ...base.sheetLabel, color: '#F0EFF8' },
  doneBtn: { ...base.doneBtn, backgroundColor: '#1A56C4' },
  doneBtnText: { ...base.doneBtnText },
});
