import { fileURLToPath } from 'node:url'
export default {
  root: fileURLToPath(new URL('../../frontend/design-client', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.cache', import.meta.url)),
  test: {
    include: [
      'src/kernel/gpu/large-exact-whole-tent.test.ts',
      'src/kernel/gpu/exact-filter-packet-layout.test.ts',
      'src/kernel/gpu/managed-background.test.ts',
      'src/kernel/gpu/empty-scene-compose.test.ts',
      'src/kernel/pose-failed-cause.test.ts',
      'src/document-preparation-worker.test.ts',
    ],
    setupFiles: [], environment: 'node', maxWorkers: 1,
    fileParallelism: false, allowOnly: false, passWithNoTests: false,
  },
}
