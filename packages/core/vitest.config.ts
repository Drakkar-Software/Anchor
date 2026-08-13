import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    // Node, deliberately, and not jsdom. Every hook test opts itself in with a
    // `// @vitest-environment jsdom` docblock instead.
    //
    // Flipping the default would hand the other 56 files a `localStorage`, a
    // `BroadcastChannel` and a `window` they do not have today — which is
    // exactly what `sync/crossTabSync.ts` and the persistence adapters branch
    // on. Their tests would start exercising a different path than the one they
    // were written against, and would still pass.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
