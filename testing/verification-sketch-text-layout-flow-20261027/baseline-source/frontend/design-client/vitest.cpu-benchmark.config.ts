import { defineConfig } from 'vitest/config'

// Explicit performance runner, outside the default functional-test discovery.
// CPU_INCREMENTAL_BENCH=1 CPU_INCREMENTAL_REPORT=/absolute/report.json \
//   bun run test -- --config vitest.cpu-benchmark.config.ts
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/cpu-incremental.benchmark.ts'],
    maxWorkers: 1,
  },
})
