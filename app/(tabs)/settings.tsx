import React from 'react';
import { View, Text, StyleSheet, useColorScheme, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function SettingsScreen() {
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, dark ? styles.rootDark : styles.rootLight, { paddingTop: insets.top }]}>
      <View style={[styles.header, dark ? styles.headerDark : styles.headerLight]}>
        <Text style={[styles.title, dark ? styles.textLight : styles.textDark]}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.placeholder, dark ? styles.mutedDark : styles.mutedLight]}>
          Settings coming in a later milestone.
        </Text>
      </ScrollView>
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
  content: { padding: 20 },
  placeholder: { fontSize: 14 },
});
