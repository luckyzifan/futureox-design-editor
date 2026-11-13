import test from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../../design-client/node_modules/vite/dist/node/index.js'
import { productionPublicAssets, copyProductionPublic } from '../../design-client/scripts/production-public.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const publicDir = path.join(root, 'frontend/design-client/public')

test('actual Vite production build excludes references and preserves font, branding and licenses', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'futureox-distribution-'))
  try {
    await writeFile(path.join(temp, 'index.html'), '<!doctype html><title>Distribution contract</title>')
    await build({ configFile: false, root: temp, publicDir, plugins: [productionPublicAssets()], logLevel: 'silent', build: { outDir: 'dist', emptyOutDir: true } })
    await assert.rejects(access(path.join(temp, 'dist/fidelity')), { code: 'ENOENT' })
    await assert.rejects(access(path.join(temp, 'dist/figma-blur-verify.html')), { code: 'ENOENT' })
    await assert.rejects(access(path.join(temp, 'dist/canvas-chrome-verify.html')), { code: 'ENOENT' })
    await assert.rejects(access(path.join(temp, 'dist/sdf-shadow-verify.html')), { code: 'ENOENT' })
    await access(path.join(temp, 'dist/color-fixtures/PROVENANCE.json'))
    await access(path.join(temp, 'dist/color-fixtures/p3-red-icc.png'))
    for (const name of ['manifest.webmanifest', 'fonts/NotoSansSC.ttf', 'fonts/OFL.txt', 'fonts/source.json', 'branding/futureox-desgin.svg', 'licenses/lucide-react-LICENSE.txt', 'licenses/NotoSansSC-OFL.txt', 'licenses/inventory.json']) {
      assert.deepEqual(await readFile(path.join(temp, 'dist', name)), await readFile(path.join(publicDir, name)))
    }
    // Exclusion must never delete the original reference/evidence source.
    await access(path.join(publicDir, 'fidelity/mcp-2026-10-06/provenance.json'))
    await access(path.join(publicDir, 'figma-blur-verify.html'))
    await access(path.join(publicDir, 'canvas-chrome-verify.html'))
    await access(path.join(publicDir, 'sdf-shadow-verify.html'))
  } finally { await rm(temp, { recursive: true, force: true }) }
})
test('asset copier refuses source/output overlap', async () => {
  await assert.rejects(copyProductionPublic(publicDir, publicDir), /separate directories/)
  await assert.rejects(copyProductionPublic(publicDir, path.join(publicDir, 'dist')), /separate directories/)
})
test('native font and package paths retain notices and reject stale reference output', async () => {
  const buildSource = await readFile(path.join(root, 'frontend/design-desktop/scripts/build.mjs'), 'utf8')
  assert.match(buildSource, /\['OFL.txt', 'source.json'\]/)
  const packageSource = await readFile(path.join(root, 'frontend/design-desktop/scripts/package.mjs'), 'utf8')
  assert.match(packageSource, /dist\/renderer\/fidelity/)
  assert.match(packageSource, /figma-blur-verify\.html/)
  assert.match(packageSource, /canvas-chrome-verify\.html/)
  assert.match(packageSource, /sdf-shadow-verify\.html/)
  const lucide = await readFile(path.join(publicDir, 'licenses/lucide-react-LICENSE.txt'), 'utf8')
  assert.match(lucide, /ISC License/); assert.match(lucide, /Cole Bemis/); assert.match(lucide, /The MIT License/)
})

test('distributed notices match installed runtime packages', async () => {
  const inventory = JSON.parse(await readFile(path.join(publicDir, 'licenses/inventory.json'), 'utf8'))
  for (const item of inventory.packages) {
    if(item.package==='flo_curves'){
      const vendored=path.join(root,'vendor/flo_curves')
      const cargo=await readFile(path.join(vendored,'Cargo.toml'),'utf8')
      assert.equal(item.version,cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1])
      assert.deepEqual(await readFile(path.join(publicDir,'licenses',item.file)),await readFile(path.join(vendored,'LICENSE')))
      continue
    }
    if (item.source?.startsWith('https://crates.io/crates/')) {
      const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1',
        '--manifest-path', path.join(root, 'design-studio/Cargo.toml')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
      const installed = metadata.packages.find(p => p.name === item.package && p.version === item.version)
      assert.ok(installed, `Missing native dependency ${item.package}`)
      assert.deepEqual(await readFile(path.join(publicDir, 'licenses', item.file)),
        await readFile(path.join(path.dirname(installed.manifest_path), 'LICENSE')))
      continue
    }
    const installed = path.join(root, 'frontend/design-client/node_modules', item.package)
    const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
    assert.equal(item.version, metadata.version, `Refresh notice inventory for ${item.package}`)
    if (item.package !== 'kiwi-schema') assert.deepEqual(await readFile(path.join(publicDir, 'licenses', item.file)), await readFile(path.join(installed, 'LICENSE')))
  }
})

test('configuration passes its actual captured WASM identity into the production copy plugin', async () => {
  const { default: configure } = await import('../../design-client/vite.config.ts')
  const config = await configure({ command: 'build', mode: 'production' })
  const identity = JSON.parse(config.define.__CORE_RENDER_DIAGNOSTIC_BUILD__)
  assert.equal(identity.producerIdentityStatus, 2)
  const plugin = config.plugins.find(value => value.name === 'futureox-production-public-assets')
  const temp = await mkdtemp(path.join(tmpdir(), 'futureox-config-wasm-'))
  try {
    const from = path.join(temp, 'public'), to = path.join(temp, 'dist')
    await mkdir(path.join(from, 'kernel'), { recursive: true })
    await copyFile(path.join(publicDir, 'kernel/design_kernel_bg.wasm'), path.join(from, 'kernel/design_kernel_bg.wasm'))
    plugin.configResolved({ root: path.join(root, 'frontend/design-client'), publicDir: from, build: { outDir: to } })
    await plugin.writeBundle()
    assert.deepEqual(await readFile(path.join(to, 'kernel/design_kernel_bg.wasm')), await readFile(path.join(publicDir, 'kernel/design_kernel_bg.wasm')))
    await writeFile(path.join(from, 'kernel/design_kernel_bg.wasm'), 'different bytes')
    await assert.rejects(plugin.writeBundle(), /WASM/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
