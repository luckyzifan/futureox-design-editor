import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
const root = process.cwd(), out = path.join(root, 'testing/verification-render-r2-20261024')
const baseline = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
const name = process.argv[2], build = path.join(baseline.runtime, 'build-' + name), host = path.join(baseline.runtime, 'host-' + name)
await mkdir(host)
for (const dir of ['src', 'assets']) await cp(path.join(root, 'frontend/design-desktop', dir), path.join(host, dir), { recursive: true })
await cp(build, path.join(host, 'dist'), { recursive: true })
await writeFile(path.join(host, 'package.json'), JSON.stringify({ name: 'owned-render-verification', version: '0.0.0', type: 'module', main: 'src/main.mjs' }))
const artifacts = {}
for (const file of ['dist/build-manifest.json', 'dist/renderer/kernel/design_kernel_bg.wasm', 'dist/bin/design-prepare', 'dist/sidecar/futureox-design-desktop-backend'])
  artifacts[file] = createHash('sha256').update(await readFile(path.join(host, file))).digest('hex')
const configuration = process.argv[3] ? JSON.parse(process.argv[3]) : { VITE_DESIGN_NATIVE_VISIBLE_TILES: '1', VITE_DESIGN_EXACT_CLAMP_PREFIX: '0', VITE_DESIGN_MOTION_QUALITY_TRACE: '0' }
await writeFile(path.join(out, 'candidate-' + name + '.json'), JSON.stringify({ host, configuration, artifacts }, null, 2))
console.log(host)
