import { defineConfig } from 'vitest/config'

// Real desktop-dev kernel. Used to time editor.load on the same UI harness.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [],
    include: ['src/sketch-document-zones.test.tsx', 'src/workspace-document-chrome.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    env: { SKETCH_ZONE_KERNEL: '1' },
  },
})
