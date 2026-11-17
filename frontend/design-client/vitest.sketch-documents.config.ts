import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// This UI gate does not execute kernel exports. Resolve the generated module
// to a throwing stub so the suite can run before a local WASM build exists.
const stub = fileURLToPath(new URL('./src/testing/design-kernel-stub.ts', import.meta.url))

export default defineConfig({
  plugins: [{
    name: 'design-kernel-stub',
    enforce: 'pre',
    resolveId(source) {
      if (source.includes('generated/design-kernel/design_kernel')) return stub
    },
  }],
  test: {
    environment: 'jsdom',
    setupFiles: [],
    include: ['src/sketch-document-zones.test.tsx', 'src/workspace-document-chrome.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
