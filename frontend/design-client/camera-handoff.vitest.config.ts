import { defineConfig } from 'vitest/config'

// These camera/coverage tests do not call the Rust picking kernel. Keep them
// runnable in a fresh checkout before building WASM or launching Electron.
export default defineConfig({
  test: {
    include: [
      'src/kernel/camera-reprojection.test.ts',
      'src/kernel/source-tile-retirement.test.ts',
      'src/kernel/progressive-quality.test.ts',
      'src/kernel/navigation-zoom.test.ts',
      'src/kernel/navigation-coverage.test.ts',
      'src/kernel/source-overview-handoff.test.ts',
      'src/kernel/source-material-refinement.test.ts',
      'src/kernel/native-navigation-handoff.test.ts',
      'src/kernel/frame-handoff.test.ts',
      'src/kernel/frame-acceptance.test.ts',
      'src/kernel/continuous-zoom-scale.test.ts',
      'src/kernel/zoom-in-frame.test.ts',
      'src/kernel/NativeSourceSurface.pipeline.test.tsx',
      'src/kernel/native-source-cpu-tiles.test.tsx',
],
  },
})
