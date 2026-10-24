import { readFile, writeFile, mkdir, cp, copyFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = process.cwd(), out = path.join(root, 'testing/verification-complete-presentation-20261024')
const baseline = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
Object.assign(process.env, baseline.configuration)
const name = process.argv[2], expected = process.argv[3] || 'candidate', host = path.join(baseline.runtime, name)
await mkdir(host)
for (const dir of ['src', 'assets']) await cp(path.join(root, 'frontend/design-desktop', dir), path.join(host, dir), { recursive: true })
for (const dir of ['bin', 'sidecar', 'fonts']) await cp(path.join(baseline.host, 'dist', dir), path.join(host, 'dist', dir), { recursive: true })
await writeFile(path.join(host, 'package.json'), JSON.stringify({ name: 'owned-complete-presentation', version: '0.0.0', type: 'module', main: 'src/main.mjs' }))
const client = path.join(root, 'frontend/design-client'), { build } = await import(path.join(client, 'node_modules/vite/dist/node/index.js'))
await build({ root: out, publicDir: path.join(client, 'public'), configFile: path.join(client, 'vite.config.ts'), base: './',
  build: { outDir: path.join(host, 'dist/renderer'), emptyOutDir: true, rolldownOptions: { input: path.join(out, 'presentation-check.html') } } })
async function entry(dir) { for (const item of await readdir(dir, { withFileTypes: true })) {
  const file = path.join(dir, item.name)
  if (item.isDirectory()) { const found = await entry(file); if (found) return found }
  else if (item.name === 'presentation-check.html') return file
} }
await copyFile(await entry(path.join(host, 'dist/renderer')), path.join(host, 'dist/renderer/optical-field-check.html'))
await writeFile(path.join(host, 'fixture.json'), '{}')
const require = createRequire(path.join(client, 'package.json')), { _electron } = require('@playwright/test')
const app = await _electron.launch({ executablePath: path.join(root, 'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [host, '--desktop-isolated-profile', '--desktop-render-check=optical', '--desktop-render-check-root=' + path.join(host, 'dist/renderer'),
    '--desktop-render-check-fixture=' + path.join(host, 'fixture.json'), '--desktop-render-check-query=expected=' + expected],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'CORE_GPU_WORKING_BUDGET_MIB'].includes(key))), TMPDIR: host }, timeout: 60000 })
let log = ''; for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { log += data })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => ['passed', 'baseline-reproduced', 'failed'].includes(JSON.parse(document.querySelector('#results')?.textContent || '{}').status), null, { timeout: 60000 })
  const report = await page.evaluate(() => window.__presentationReport)
  await writeFile(path.join(out, name + '.json'), JSON.stringify({ host, ...report }, null, 2))
  console.log(report.status, report.error || '')
  if (report.status === 'failed') process.exitCode = 1
} finally { await writeFile(path.join(out, name + '.log'), log); await app.close() }
