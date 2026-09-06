import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  external: ["@drakkar.software/anchor"],
  format: ["esm", "cjs"],
  sourcemap: true,
  splitting: false,
})
