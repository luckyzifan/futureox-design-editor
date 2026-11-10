import { defineConfig } from 'vitest/config'
// This renderer test does not execute the kernel. The default suite still
// loads the built kernel through src/test-setup.ts.
export default defineConfig({
  test: { include: ['src/kernel/gpu/stacked-leaf-paint.test.ts'] },
})
