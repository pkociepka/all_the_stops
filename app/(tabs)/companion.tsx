import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function CompanionScreen() {
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, dark ? styles.rootDark : styles.rootLight, { paddingTop: insets.top }]}>
      <View style={[styles.header, dark ? styles.headerDark : styles.headerLight]}>
        <Text style={[styles.title, dark ? styles.textLight : styles.textDark]}>Companion</Text>
      </View>
      <View style={styles.placeholder}>
        <Text style={styles.icon}>◉</Text>
        <Text style={[styles.placeholderTitle, dark ? styles.textLight : styles.textDark]}>
          No active trip
        </Text>
        <Text style={[styles.placeholderSub, dark ? styles.mutedDark : styles.mutedLight]}>
          Plan and start a route to activate companion mode.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  rootLight: { backgroundColor: '#EDECE9' },
  rootDark: { backgroundColor: '#0D0C18' },
  header: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 0.5 },
  headerLight: { borderBottomColor: '#D8D6E0' },
  headerDark: { borderBottomColor: '#1E1C30' },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  textDark: { color: '#111018' },
  textLight: { color: '#F0EFF8' },
  mutedLight: { color: '#6B6880' },
  mutedDark: { color: '#8A86A0' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  icon: { fontSize: 48 },
  placeholderTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  placeholderSub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
