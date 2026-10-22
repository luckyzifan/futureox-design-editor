import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { productionPublicAssets } from './scripts/production-public.mjs'
export default defineConfig({
  plugins: [react(), productionPublicAssets()],
  server: {
    port: 1430,
    proxy: {
      '/api/design': {
        target: process.env.DESIGN_BACKEND_URL || 'http://127.0.0.1:9430',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.DESIGN_BACKEND_URL || 'http://127.0.0.1:9430',
        changeOrigin: true,
      },
    },
  },
  build: { sourcemap: true },
})
