import { defineConfig } from 'vitest/config'
// Only Vitest suites live here. The src/**/*.test.mjs files and the standalone
// node:test render-policy suite run through the isolated verify-contracts
// harness, not this Vitest glob.
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
