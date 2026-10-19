// Compile only the shared validation pages. Native product binaries are built
// separately by build.mjs. No UI automation or remote debugger is started here.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { build } from '../../design-client/node_modules/vite/dist/node/index.js'
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..'), client = path.join(core, 'frontend/design-client')
const [destination, baseline] = process.argv.slice(2)
if (!destination) throw Error('Expected output directory, optionally a frozen source directory')
const output = path.resolve(destination), frozen = baseline && path.resolve(baseline)
const pages = ['interaction-surface-check', 'zoom-clarity-check', 'canvas-alignment-check', 'display-seams-check', 'figma-reference-check', 'optical-field-check', 'display-order-check']
await build({ root: client, configFile: path.join(client, 'vite.config.ts'), base: './',
  // Both A/B builds expose the existing bounded diagnostic counters. These
  // instrumented runs are reported separately from production input latency.
  define: { 'import.meta.env.DEV': 'true' },
  plugins: frozen ? [{ name: 'frozen-render-baseline', enforce: 'pre', async transform(code, id) {
    const clean = id.split('?')[0]
    if (!clean.startsWith(path.join(client, 'src')) || !/\.(?:tsx?|js)$/.test(clean) || clean.includes('-check.') || clean.endsWith('/TileCompositeSurface.tsx')) return
    try { return { code: await readFile(path.join(frozen, path.relative(core, clean)), 'utf8'), map: null } }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  } }] : [],
  build: { outDir: output, emptyOutDir: true, rollupOptions: { input: Object.fromEntries(pages.map(name => [name, path.join(client, `${name}.html`)])) } },
})
if (frozen) {
  await mkdir(path.join(output, 'kernel'), { recursive: true })
  await copyFile(path.join(frozen, 'frontend/design-client/public/kernel/design_kernel_bg.wasm'), path.join(output, 'kernel/design_kernel_bg.wasm'))
}
console.log(`Render checks built in ${output}${frozen ? ' (frozen baseline)' : ''}`)
