import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Settings list behavior does not call the Rust picking kernel. Keep this
// runnable before a WASM build. Electron still has to prove the real window.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/design-ai/agent-settings.test.tsx'],
    testTimeout: 20_000,
  },
})
