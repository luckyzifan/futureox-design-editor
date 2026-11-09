import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { renderDiagnosticBuildIdentity } from '../design-desktop/scripts/render-diagnostic-build.mjs'
import { productionPublicAssets } from './scripts/production-public.mjs'
export default defineConfig(async ({ command }) => {
  const identity = await renderDiagnosticBuildIdentity(fileURLToPath(new URL('../../', import.meta.url)), command)
  return {
    define: { __CORE_RENDER_DIAGNOSTIC_BUILD__: JSON.stringify(identity) },
    plugins: [react(), productionPublicAssets({ expectedWasmSha256: identity.producerWasmInputSha256 })],
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
        '/api/agent': {
          target: process.env.DESIGN_AGENT_URL || 'http://127.0.0.1:3927',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/agent/, ''),
        },
      },
    },
    build: { sourcemap: true },
  }
})
