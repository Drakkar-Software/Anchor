import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],

  external: [
    "@drakkar.software/anchor",
    "expo-sqlite",
    "@react-native-async-storage/async-storage",
    "@react-native-community/netinfo",
    "react-native",
    "expo-task-manager",
    "expo-background-fetch",
    "expo-linking",
    "@supabase/supabase-js",
  ],

  format: ["esm", "cjs"],
  sourcemap: true,
  splitting: false,
})
