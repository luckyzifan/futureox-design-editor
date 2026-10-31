import { createServer } from '../../frontend/design-client/node_modules/vite/dist/node/index.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const root = process.cwd(), out = process.argv[2], pageName = process.argv[3] || 'hardware'
if (!out || !path.isAbsolute(out) || !['hardware', 'scene', 'topology', 'full-topology', 'spatial-hardware'].includes(pageName)) throw Error('New absolute output directory and known page required')
await fs.mkdir(out)
const inputs: Record<string, string> = {}
for (const directory of ['frontend/design-client/src/kernel/gpu', 'frontend/design-client/src/kernel', 'frontend/design-client/public/kernel', 'testing/verification-render-dataflow-implementation-20261031']) {
  for (const name of await fs.readdir(path.join(root, directory))) {
    if (directory.startsWith('testing/') && !/\.(ts|html)$/.test(name)) continue
    const file = path.join(directory, name), stat = await fs.stat(file)
    if (stat.isFile()) inputs[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex')
  }
}
await fs.writeFile(path.join(out, 'inputs.json'), JSON.stringify(inputs, null, 2))
const server = await createServer({ root, configFile: path.join(root, 'frontend/design-client/vite.config.ts'), publicDir: path.join(root, 'frontend/design-client/public'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, strictPort: true, watch: { ignored: ['**/verification-render-dataflow-implementation-20261031/operator-*/**', '**/verification-render-dataflow-implementation-20261031/scene-*/**', '**/verification-render-dataflow-implementation-20261031/topology-run-*/**', '**/verification-render-dataflow-implementation-20261031/full-topology-run-*/**', '**/verification-render-dataflow-implementation-20261031/spatial-run-*/**'] } }, plugins: [{ name: 'local-blur-evidence', configureServer(s) {
    s.middlewares.use('/full-topology/',async(req,res)=>{
      const name=req.url?.split('?')[0].replace(/^\//,'')
      if(!['manifest.json','packet-0.fgsc','packet-1.fgsc','packet-2.fgsc'].includes(name||'')){res.statusCode=404;res.end();return}
      try{res.end(await fs.readFile(path.join('/tmp/futureox-topology-blur-full-edges-20261029',name!)))}catch{res.statusCode=404;res.end()}
    })
    s.middlewares.use('/topology-inputs/', async (req, res) => {
      const name = req.url?.split('?')[0].replace(/^\//, '')
      if (!['manifest.json','blur-type0.json','blur-type1.json','blur-type3.json','blurs-type0.json','innerShadows.json','shadows.json'].includes(name || '')) { res.statusCode=404;res.end();return }
      try {res.setHeader('Content-Type','application/json');res.end(await fs.readFile(path.join('/tmp/futureox-topology-blur-native-fixed-20261029',name!)))}
      catch {res.statusCode=404;res.end()}
    })
    s.middlewares.use('/real-inputs/', async (req, res) => {
      const name = req.url?.split('?')[0].replace(/^\//, '')
      if (!['117.json', 'fig.json', 'manifest.json'].includes(name || '')) { res.statusCode = 404; res.end(); return }
      try { res.setHeader('Content-Type', 'application/json'); res.end(await fs.readFile(path.join('/tmp/futureox-work-reduction-real-inputs-20261028', name!))) }
      catch { res.statusCode = 404; res.end() }
    })
    s.middlewares.use('/report', async (req, res) => {
      try { let body = ''; for await (const part of req) { body += part; if (body.length > 8 * 1024 * 1024) throw Error('Report limit') }
        await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(JSON.parse(body), null, 2)); res.end('ok')
      } catch (e) { res.statusCode = 500; res.end(String(e)) }
    })
  } }] })
await server.listen()
const url = server.resolvedUrls!.local[0] + `testing/verification-render-dataflow-implementation-20261031/${pageName}.html` + (process.argv[4] ? '?case=' + encodeURIComponent(process.argv[4]) : '')
const require = createRequire(path.join(root, 'frontend/design-client/package.json')), { _electron } = require('@playwright/test')
const electronRequire = createRequire(path.join(root, 'frontend/design-desktop/package.json'))
const host = path.join(out, 'main.cjs')
await fs.writeFile(host, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(url)});});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await _electron.launch({ executablePath: electronRequire('electron'), args: [host], env, chromiumSandbox: true, timeout: 45000 })
  const page = await app.firstWindow()
  page.on('pageerror', (e: Error) => fs.appendFile(path.join(out, 'errors.log'), String(e) + '\n'))
  page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') fs.appendFile(path.join(out, 'console.log'), m.text() + '\n') })
  await page.waitForFunction(() => { try { return ['passed','failed','performance-failed'].includes(JSON.parse(document.querySelector('#result')?.textContent || '{}').status) } catch { return false } }, {}, { timeout: 900000 })
  if (['scene','topology','full-topology'].includes(pageName)) await page.locator('#previews').screenshot({ path: path.join(out, 'comparison.png') })
  else await page.screenshot({ path: path.join(out, 'comparison.png') })
  const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'))
  console.log(JSON.stringify({ status: report.status, error: report.error, adapter: report.adapter, cases: report.cases.length, timings: report.timings }))
  if (report.status !== 'passed') process.exitCode = 1
  const drift = []
  for (const [file, hash] of Object.entries(inputs)) if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== hash) drift.push(file)
  await fs.writeFile(path.join(out, 'source-drift.json'), JSON.stringify(drift))
  if (drift.length) throw Error('Measured inputs changed')
} finally { await app?.close(); await server.close() }
