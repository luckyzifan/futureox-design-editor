/** Isolated local harness. Open its printed URL in a real GPU browser.
 * Usage: bun scripts/serve-render-regression.ts [request.json] */
import { createServer } from 'vite'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const fixture = process.argv[2] ? await readFile(path.resolve(process.argv[2])) : undefined
const output = await mkdtemp(path.join(tmpdir(), 'web-render-regression-'))
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: true }, plugins: [{ name: 'render-regression-fixture',
    configureServer(server) {
      server.middlewares.use('/__render_fixture', (_req, res) => {
        res.statusCode = fixture ? 200 : 404; res.setHeader('Content-Type', 'application/json'); res.end(fixture || '{}')
      })
      server.middlewares.use('/__render_report', (req, res) => {
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 1_048_576) req.destroy() })
        req.on('end', () => {
          void writeFile(path.join(output, 'results.json'), body).then(() => { res.end('ok') }, error => { res.statusCode = 500; res.end(String(error)) })
        })
      })
    },
  }] })
await server.listen()
console.log(JSON.stringify({ url: `${server.resolvedUrls!.local[0]}render-regression-check.html${fixture ? '?fixture' : ''}`, output }))
process.on('SIGINT', () => { void server.close().then(() => process.exit(0)) })
