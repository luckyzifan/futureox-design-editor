import { defineConfig } from 'vitest/config'

/** Isolated from the default suite. One process, release kernel already built. */
export default defineConfig({
  test: {
    testTimeout: 600_000,
    hookTimeout: 180_000,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/kernel/pointer-up-e2e-bench.measure.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
})
