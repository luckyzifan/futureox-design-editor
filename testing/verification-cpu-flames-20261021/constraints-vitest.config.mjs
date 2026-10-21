import { fileURLToPath } from 'node:url'
const client = fileURLToPath(new URL('../../frontend/design-client/', import.meta.url))
export default {
  root: client,
  test: {
    include: ['src/components.test.ts', 'src/kernel/translation-preview.test.ts', 'src/kernel/translation-preview-kernel.test.ts', '../../testing/verification-cpu-flames-20261021/constraints-fig-oracle.test.ts'],
    setupFiles: [client + 'src/test-setup.ts'], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120000, hookTimeout: 30000,
  },
}
