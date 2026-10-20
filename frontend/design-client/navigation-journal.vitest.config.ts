import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['src/kernel/navigation-journal.test.ts'], testTimeout: 5000, maxWorkers: 1 } })
