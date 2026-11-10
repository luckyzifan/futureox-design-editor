import { defineConfig } from 'vitest/config'
// Node test suites (*.test.mjs and render-policy.test.ts) use node --test.
export default defineConfig({
  test: {
    // Functional suites decode and reshape real fonts with the portable scalar
    // dev WASM. Keep a finite bound without mistaking a >5s font fixture for a
    // failed assertion on slower CI hosts. Performance limits live in explicit
    // benchmarks; the runner still rejects hangs/nonzero exits and all-skips.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/kernel/render-policy.test.ts', '**/node_modules/**', '**/dist/**'],
  },
})
