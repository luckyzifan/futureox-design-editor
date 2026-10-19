import { fileURLToPath } from 'node:url'
const client = fileURLToPath(new URL('../../frontend/design-client/', import.meta.url))
export default { root: client, resolve: { alias: { 'react-dom/client': client + 'node_modules/react-dom/client.js', react: client + 'node_modules/react', jsdom: client + 'node_modules/jsdom/lib/api.js' } }, test: { setupFiles: [client + 'src/test-setup.ts'], include: [fileURLToPath(new URL('./*.test.tsx', import.meta.url))], maxWorkers: 1 } }
