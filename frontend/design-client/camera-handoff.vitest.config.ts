import { defineConfig } from 'vitest/config'

// Coverage geometry here does not call picking. The native source surface now
// asks the kernel for zoom-refine scheduling, so this suite initializes that
// module. A checkout without the built kernel fails this setup instead of
// skipping the surface.
export default defineConfig({
  test: {
    setupFiles: ['./src/kernel/camera-handoff-kernel-setup.ts'],
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
