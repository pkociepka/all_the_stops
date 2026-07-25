import { Tabs } from 'expo-router';
import { Text, useColorScheme, type ColorValue } from 'react-native';
import React from 'react';

export default function TabLayout() {
  const dark = useColorScheme() === 'dark';
  const brand = dark ? '#4E80F0' : '#1A56C4';
  const bg = dark ? '#0D0C18' : '#EDECE9';
  const border = dark ? '#1E1C30' : '#D8D6E0';
  const inactive = dark ? '#524E62' : '#938FA6';

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: brand,
        tabBarInactiveTintColor: inactive,
        tabBarStyle: { backgroundColor: bg, borderTopColor: border, borderTopWidth: 0.5 },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color }) => <TabIcon glyph="⊙" color={color} /> }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan', tabBarIcon: ({ color }) => <TabIcon glyph="↗" color={color} /> }} />
      <Tabs.Screen name="companion" options={{ title: 'Companion', tabBarIcon: ({ color }) => <TabIcon glyph="◉" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} /> }} />
    </Tabs>
  );
}

function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}
