import { defineConfig } from 'vitest/config'
// Only Vitest suites live here. The src/**/*.test.mjs files and the standalone
// node:test render-policy suite run through the isolated verify-contracts
// harness, not this Vitest glob.
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/kernel/render-policy.test.ts', '**/node_modules/**', '**/dist/**'],
  },
})
