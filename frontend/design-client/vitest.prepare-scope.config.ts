import { defineConfig } from 'vitest/config'
// Pure scheduling tests. No WASM, GPU, or document kernel.
export default defineConfig({
  test: {
    include: [
      'src/kernel/tile-prepare-viewport.test.ts',
      'src/source-material-scope.test.ts',
      'src/kernel/preview-tiles.test.ts',
      'src/kernel/settled-blur-cohort.test.ts',
    ],
  },
})
