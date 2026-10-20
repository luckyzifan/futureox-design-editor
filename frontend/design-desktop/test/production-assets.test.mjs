import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises'
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
    for (const name of ['manifest.webmanifest', 'fonts/NotoSansSC.ttf', 'fonts/OFL.txt', 'fonts/source.json', 'branding/futureox-desgin.svg', 'licenses/lucide-react-LICENSE.txt', 'licenses/NotoSansSC-OFL.txt', 'licenses/inventory.json']) {
      assert.deepEqual(await readFile(path.join(temp, 'dist', name)), await readFile(path.join(publicDir, name)))
    }
    // Exclusion must never delete the original reference/evidence source.
    await access(path.join(publicDir, 'fidelity/mcp-2026-10-06/provenance.json'))
    await access(path.join(publicDir, 'figma-blur-verify.html'))
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
  assert.match(packageSource, /dist\/renderer\/figma-blur-verify\.html/)
  const lucide = await readFile(path.join(publicDir, 'licenses/lucide-react-LICENSE.txt'), 'utf8')
  assert.match(lucide, /ISC License/); assert.match(lucide, /Cole Bemis/); assert.match(lucide, /The MIT License/)
})

test('distributed notices match installed runtime packages and configuration activates filtering', async () => {
  const inventory = JSON.parse(await readFile(path.join(publicDir, 'licenses/inventory.json'), 'utf8'))
  for (const item of inventory.packages) {
    const installed = path.join(root, 'frontend/design-client/node_modules', item.package)
    const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
    assert.equal(item.version, metadata.version, `Refresh notice inventory for ${item.package}`)
    if (item.package !== 'kiwi-schema') assert.deepEqual(await readFile(path.join(publicDir, 'licenses', item.file)), await readFile(path.join(installed, 'LICENSE')))
  }
  const config = await readFile(path.join(root, 'frontend/design-client/vite.config.ts'), 'utf8')
  assert.match(config, /plugins: \[react\(\), productionPublicAssets\(\)\]/)
})
