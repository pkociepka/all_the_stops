import { useRouter } from 'expo-router';
import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const dark = useColorScheme() === 'dark';

  return (
    <View style={[styles.container, dark ? styles.containerDark : styles.containerLight, { paddingTop: insets.top + 16 }]}>
      <View style={styles.hero}>
        <Text style={[styles.title, dark ? styles.textLight : styles.textDark]}>All The Stops</Text>
        <Text style={[styles.subtitle, dark ? styles.mutedDark : styles.mutedLight]}>
          Visit every stop on a transit line in the shortest time possible.
        </Text>
      </View>

      <Pressable
        style={[styles.cta, styles.ctaPrimary]}
        onPress={() => router.push('/(tabs)/plan')}
      >
        <Text style={styles.ctaPrimaryText}>Start Planning →</Text>
      </Pressable>

      <Pressable
        style={[styles.cta, dark ? styles.ctaSecDark : styles.ctaSecLight]}
        onPress={() => router.push('/(tabs)/companion')}
      >
        <Text style={[styles.ctaSecText, dark ? styles.textLight : styles.textDark]}>Open Companion</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24 },
  containerLight: { backgroundColor: '#EDECE9' },
  containerDark: { backgroundColor: '#0D0C18' },
  hero: { flex: 1, justifyContent: 'center' },
  title: { fontSize: 40, fontWeight: '800', letterSpacing: -1, marginBottom: 12 },
  subtitle: { fontSize: 16, lineHeight: 24 },
  textDark: { color: '#111018' },
  textLight: { color: '#F0EFF8' },
  mutedLight: { color: '#6B6880' },
  mutedDark: { color: '#8A86A0' },
  cta: { borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 12 },
  ctaPrimary: { backgroundColor: '#1A56C4' },
  ctaPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ctaSecLight: { backgroundColor: '#FFFFFF' },
  ctaSecDark: { backgroundColor: '#191728' },
  ctaSecText: { fontWeight: '600', fontSize: 16 },
});
