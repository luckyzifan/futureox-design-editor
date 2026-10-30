import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderDiagnosticBuildIdentity } from '../scripts/render-diagnostic-build.mjs'
import { copyProductionPublic, assertPublicWasmHash, productionPublicAssets } from '../../design-client/scripts/production-public.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
// Minimal valid empty WASM modules; these test artifact identity, not execution.
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
const otherWasm = Buffer.concat([wasm, Buffer.from([0, 2, 1, 120])])
const publicPath = 'frontend/design-client/public/kernel/design_kernel_bg.wasm'
const generatedPath = 'frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm'
const dependencies = { sources: async () => ({ 'frontend/design-client/src/kernel/render-failure-telemetry.ts': sha('dictionary') }), head: async () => { throw Error('archive has no Git') } }
async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-runtime-wasm-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [file, bytes] of Object.entries(files)) {
    const name = path.join(root, file); await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, bytes)
  }
  return root
}
async function identity(root) { return renderDiagnosticBuildIdentity(root, 'build', dependencies) }
function assertUnknownWasm(value) { assert.equal(value.producerIdentityStatus, 1); assert(!('producerWasmInputSha256' in value)) }

test('public-only archive identity hashes the actual asset copied to runtime URL', async t => {
  const root = await fixture(t, { [publicPath]: wasm })
  const value = await identity(root)
  assert.equal(value.producerIdentityStatus, 2)
  assert.equal(value.producerCommitStatus, 0)
  await copyProductionPublic(path.join(root, 'frontend/design-client/public'), path.join(root, 'dist'))
  assert.equal(value.producerWasmInputSha256, sha(await readFile(path.join(root, 'dist/kernel/design_kernel_bg.wasm'))))
})
test('JS/type-only generated directory does not hide the public runtime WASM', async t => {
  const root = await fixture(t, { [publicPath]: wasm, [generatedPath.replace('.wasm', '.wasm.d.ts')]: 'types', [generatedPath.replace('_bg.wasm', '.js')]: 'binding' })
  assert.equal((await identity(root)).producerWasmInputSha256, sha(wasm))
})
test('matching generated/public artifacts have the public runtime identity', async t => {
  const root = await fixture(t, { [publicPath]: wasm, [generatedPath]: wasm })
  assert.equal((await identity(root)).producerWasmInputSha256, sha(wasm))
})
test('generated-only artifact is not a fallback for missing public runtime WASM', async t => {
  const root = await fixture(t, { [generatedPath]: wasm })
  assertUnknownWasm(await identity(root))
})
test('mismatched generated/public artifacts never claim a verified WASM identity', async t => {
  const root = await fixture(t, { [publicPath]: wasm, [generatedPath]: otherWasm })
  assertUnknownWasm(await identity(root))
})
test('unexpected or multiple generated WASM names leave identity unverified', async t => {
  for (const extra of [{ [generatedPath.replace('design_kernel_bg', 'other')]: wasm }, { [generatedPath]: wasm, [generatedPath.replace('design_kernel_bg', 'other')]: wasm }]) {
    const root = await fixture(t, { [publicPath]: wasm, ...extra })
    assertUnknownWasm(await identity(root))
  }
})

function copyIdentity(root, expected = sha(wasm)) {
  return { expectedWasmSha256: expected, generatedDirectory: path.join(root, 'frontend/design-client/src/generated/design-kernel') }
}
test('expected public WASM hash survives real production copy', async t => {
  const root = await fixture(t, { [publicPath]: wasm, [generatedPath]: wasm })
  const value = await identity(root)
  const output = path.join(root, 'dist')
  await copyProductionPublic(path.join(root, 'frontend/design-client/public'), output, copyIdentity(root, value.producerWasmInputSha256))
  assert.equal(sha(await readFile(path.join(output, 'kernel/design_kernel_bg.wasm'))), value.producerWasmInputSha256)
})
test('copy rejects a public input changed after expected identity capture', async t => {
  const root = await fixture(t, { [publicPath]: wasm })
  const value = await identity(root)
  await writeFile(path.join(root, publicPath), otherWasm)
  await assert.rejects(copyProductionPublic(path.join(root, 'frontend/design-client/public'), path.join(root, 'dist'), copyIdentity(root, value.producerWasmInputSha256)), /WASM/)
})
test('copy rejects generated/public divergence introduced after identity capture', async t => {
  const root = await fixture(t, { [publicPath]: wasm, [generatedPath]: wasm })
  const value = await identity(root)
  await writeFile(path.join(root, generatedPath), otherWasm)
  await assert.rejects(copyProductionPublic(path.join(root, 'frontend/design-client/public'), path.join(root, 'dist'), copyIdentity(root, value.producerWasmInputSha256)), /WASM/)
})
test('copy without an expected identity preserves the explicit unverified path', async t => {
  const root = await fixture(t, { 'frontend/design-client/public/manifest.webmanifest': '{}' })
  await copyProductionPublic(path.join(root, 'frontend/design-client/public'), path.join(root, 'dist'))
  assert.equal(await readFile(path.join(root, 'dist/manifest.webmanifest'), 'utf8'), '{}')
})

test('post-copy guard checks actual output bytes, not merely the unchanged input', async t => {
  const root = await fixture(t, { [publicPath]: wasm })
  const output = path.join(root, 'dist')
  await copyProductionPublic(path.join(root, 'frontend/design-client/public'), output)
  await writeFile(path.join(output, 'kernel/design_kernel_bg.wasm'), otherWasm)
  assert.equal(sha(await readFile(path.join(root, publicPath))), sha(wasm))
  await assert.rejects(assertPublicWasmHash(output, sha(wasm)), /WASM/)
})
test('production plugin passes captured identity to its real writeBundle copy', async t => {
  const root = await fixture(t, { [publicPath]: wasm })
  const client = path.join(root, 'frontend/design-client')
  const plugin = productionPublicAssets({ expectedWasmSha256: sha(wasm) })
  plugin.configResolved({ publicDir: path.join(client, 'public'), root: client, build: { outDir: 'dist' } })
  await plugin.writeBundle()
  assert.equal(sha(await readFile(path.join(client, 'dist/kernel/design_kernel_bg.wasm'))), sha(wasm))
  await writeFile(path.join(root, publicPath), otherWasm)
  await assert.rejects(plugin.writeBundle(), /WASM/)
})
test('expected identity rejects missing or invalid public WASM rather than silently disabling checks', async t => {
  const root = await fixture(t, { 'frontend/design-client/public/manifest.webmanifest': '{}' })
  const source = path.join(root, 'frontend/design-client/public')
  await assert.rejects(copyProductionPublic(source, path.join(root, 'dist'), copyIdentity(root)))
  await assert.rejects(copyProductionPublic(source, path.join(root, 'dist'), copyIdentity(root, 'invalid')), /expected public WASM hash/)
})

// The wrapper still performs the real fs.cp. It changes one file only after
// cp has returned, so rejection proves the copier's own post-copy wiring.
for (const changed of ['output', 'source']) {
  test(`copy rejects ${changed} changed after real cp returns`, async t => {
    const root = await fixture(t, { [publicPath]: wasm })
    const from = path.join(root, 'frontend/design-client/public'), to = path.join(root, 'dist')
    const original = fs.promises.cp
    let copied = 0
    fs.promises.cp = async (...args) => {
      await original(...args)
      copied++
      await writeFile(path.join(changed === 'output' ? to : from, 'kernel/design_kernel_bg.wasm'), otherWasm)
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(copyProductionPublic(from, to, copyIdentity(root)), /WASM/)
      assert.equal(copied, 1, 'negative control must pass the real copy boundary')
    } finally {
      fs.promises.cp = original
      syncBuiltinESMExports()
    }
  })
}
