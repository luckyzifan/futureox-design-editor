import { readFile, writeFile, mkdir, cp, copyFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = process.cwd(), out = path.join(root, 'testing/verification-render-core-20261024')
// Candidate and disabled-method control use one compiled renderer.
Object.assign(process.env,{VITE_DESIGN_DYNAMIC_UNIFORMS:'1',VITE_DESIGN_CERTIFIED_TENT_PREFIX:'1',VITE_DESIGN_OPAQUE_SOLID_BATCH:'1',VITE_DESIGN_PARENT_SUFFIX:'0',VITE_DESIGN_EXACT_CLAMP_PREFIX:'0',VITE_DESIGN_IMAGE_ASSET_RESIDENCY:'0'})
const baseline = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
const targetOut=path.join(root,'testing/verification-drag-response-20261024'); const name = process.argv[2], host = path.join(baseline.runtime, name), client = path.join(root, 'frontend/design-client')
await mkdir(host)
for (const dir of ['src', 'assets']) await cp(path.join(root, 'frontend/design-desktop', dir), path.join(host, dir), { recursive: true })
for (const dir of ['bin', 'sidecar', 'fonts']) await cp(path.join(baseline.host, 'dist', dir), path.join(host, 'dist', dir), { recursive: true })
await writeFile(path.join(host, 'package.json'), JSON.stringify({ name: 'owned-heavy-tiles', version: '0.0.0', type: 'module', main: 'src/main.mjs' }))
const { build } = await import(path.join(client, 'node_modules/vite/dist/node/index.js'))
await build({ plugins:[{name:'owned-reference-renderer',enforce:'pre',load(id){
  if(id.endsWith('/factory.ts?reference'))return readFile(path.join(client,'src/kernel/gpu/factory.ts'),'utf8').then(text=>text.replaceAll("from './webgpu'","from './webgpu?staticUniforms'"))
  if(id.endsWith('/webgpu.ts?staticUniforms'))return readFile(path.join(client,'src/kernel/gpu/webgpu.ts'),'utf8').then(text=>text.replace("import.meta.env.VITE_DESIGN_DYNAMIC_UNIFORMS === '1'",'false'))
}}], root: targetOut, publicDir: path.join(client, 'public'), configFile: path.join(client, 'vite.config.ts'), base: './', build: { outDir: path.join(host, 'dist/renderer'), emptyOutDir: true, rolldownOptions: { input: path.join(targetOut, 'root-check.html') } } })
async function entry(dir) { for (const value of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, value.name); if (value.isDirectory()) { const result = await entry(p); if (result) return result } else if (value.name === 'root-check.html') return p } }
await copyFile(await entry(path.join(host, 'dist/renderer')), path.join(host, 'dist/renderer/optical-field-check.html'))
const prior = JSON.parse(await readFile(path.join(root, 'testing/verification-fig-import-20261024/baseline.json'), 'utf8'))
const fixtures = [
  { file: 'fig.json', rasterProfile: 'analytic', source: '/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/heavy-motion-20261024-hjpt7asv/fig-combined-1/original.json', samples: [
    { view: { x: 0, y: 0, zoom: .25 }, region: { x: -1, y: -1, w: 514, h: 514 } }] },
  { file: '117.json', source: path.join(prior.runtime, 'reference-snapshot/117-revision-3.json'), samples: [
    { view: { x: 0, y: 0, zoom: 3.5290997520720855 }, region: { x: 511, y: 2559, w: 514, h: 514 } },
    { view: { x: 0, y: 0, zoom: 1 }, region: { x: -1, y: 1023, w: 514, h: 514 } },
    { view: { x: 137.99050400455386, y: -3282.5842223116624, zoom: 5.150237399886167 }, region: { x: -376, y: 1324, w: 514, h: 514 } }] },
  { file: 'controls.json', source: '/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/topology-cause-probe-gllbs6sk/controls-scene.json', samples: [
    { view: { x: 0, y: 0, zoom: 16 }, region: { x: 41983, y: 22527, w: 514, h: 514 } }] },
]
for (const fixture of fixtures) await copyFile(fixture.source, path.join(host, 'dist/renderer', fixture.file))
await writeFile(path.join(host, 'dist/renderer/fixtures.json'), JSON.stringify(fixtures))
const require = createRequire(path.join(client, 'package.json')), { _electron } = require('@playwright/test')
const app = await _electron.launch({ executablePath: path.join(root, 'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [host, '--desktop-isolated-profile', '--desktop-render-check=optical', '--desktop-render-check-root=' + path.join(host, 'dist/renderer'), '--desktop-render-check-fixture=' + fixtures[0].source,
    ...(process.env.TEST_BACKEND === 'webgpu' ? ['--desktop-render-check-query=backend=webgpu'] : [])],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')), TMPDIR: host }, timeout: 60000 })
let log = ''; for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { log += data })
try {
  const page = await app.firstWindow()
  let cdp
  if (process.env.UNIT_PROFILE === '1') { cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
  await page.waitForFunction(() => ['passed', 'failed'].includes(JSON.parse(document.querySelector('#results')?.textContent || '{}').status), null, { timeout: 240000 })
  if (cdp) { const { profile } = await cdp.send('Profiler.stop'); await writeFile(path.join(targetOut, name + '.cpuprofile'), JSON.stringify(profile)); await cdp.detach() }
  const result = await page.evaluate(() => window.__tileReport); await writeFile(path.join(targetOut, name + '.json'), JSON.stringify({ host, cpuSampler: process.env.UNIT_PROFILE === '1', ...result }, null, 2))
  console.log(result.status, result.error || '', result.cases?.length); if (result.status !== 'passed') process.exitCode = 1
} finally { await writeFile(path.join(targetOut, name + '.log'), log); await app.close() }
