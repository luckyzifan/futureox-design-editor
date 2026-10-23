import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['verification/zoom-refinement/*.test.{ts,tsx}'], maxWorkers: 1, fileParallelism: false, environment: 'jsdom', testTimeout: 30000, hookTimeout: 30000 }, define: { __CORE_RENDER_DIAGNOSTIC_BUILD__: '{}' } })
