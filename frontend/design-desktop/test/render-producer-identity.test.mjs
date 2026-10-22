import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { renderDiagnosticBuildIdentity, identityFingerprint } from '../scripts/render-diagnostic-build.mjs'
import { sanitizeProducerIdentity, producerIdentityFields } from '../src/render-diagnostic-identity.mjs'
import { createRenderDiagnostics, sanitizeRecord, sanitizeBatch } from '../src/render-terminal-diagnostics.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const source = { 'frontend/design-client/src/kernel/render-failure-telemetry.ts': sha('dictionary'), 'dirty-source.ts': sha('source') }
const dependencies = extra => ({ sources: async () => source, head: async () => 'a'.repeat(40), list: async () => ['design_kernel_bg.wasm'], read: async () => Buffer.from('wasm bytes'), ...extra })
test('build identity binds actual source, dictionary, WASM input and optional HEAD separately', async () => {
  const identity = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies())
  assert.deepEqual(identity, { producerIdentityStatus: 2, producerCommitStatus: 1, producerBuildMode: 1,
    producerCommit: 'a'.repeat(40), producerSourceSha256: identityFingerprint(source),
    failureDictionarySha256: sha('dictionary'), producerWasmInputSha256: sha('wasm bytes') })
  assert.equal(identityFingerprint(source), identityFingerprint(Object.fromEntries(Object.entries(source).reverse())))
  const dirty = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies({ sources: async () => ({ ...source, 'dirty-source.ts': sha('changed') }) }))
  assert.equal(dirty.producerCommit, identity.producerCommit)
  assert.notEqual(dirty.producerSourceSha256, identity.producerSourceSha256)
  const wasm = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies({ read: async () => Buffer.from('different WASM') }))
  assert.notEqual(wasm.producerWasmInputSha256, identity.producerWasmInputSha256)
})
test('missing Git, source, dictionary or unambiguous WASM is explicit unknown without leaking failures', async () => {
  const fail = async () => { throw Error('/private/machine/credentials') }
  const noGit = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies({ head: fail }))
  assert.equal(noGit.producerCommitStatus, 0); assert(!('producerCommit' in noGit)); assert.equal(noGit.producerIdentityStatus, 2)
  for (const extra of [{ sources: fail }, { sources: async () => ({}) }, { sources: async () => ({ secret: 'private' }) }]) {
    const unknown = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies(extra))
    assert.equal(unknown.producerIdentityStatus, 0); assert(!('producerSourceSha256' in unknown))
  }
  for (const extra of [{ list: fail }, { list: async () => [] }, { list: async () => ['a.wasm', 'b.wasm'] }, { read: fail }]) {
    const partial = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies(extra))
    assert.equal(partial.producerIdentityStatus, 1); assert(!('producerWasmInputSha256' in partial))
    assert(!JSON.stringify(partial).includes('private'))
  }
})
test('identity sanitizer permits only fixed length digests, optional HEAD and bounded enums', () => {
  const hashes = { producerSourceSha256: 'a'.repeat(64), producerWasmInputSha256: 'b'.repeat(64), failureDictionarySha256: 'c'.repeat(64), producerCommit: 'd'.repeat(40) }
  assert.deepEqual(sanitizeProducerIdentity({ ...hashes, path: 'private', url: 'private', document: 'private' }), hashes)
  for (const value of ['private', 'a'.repeat(63), 'F'.repeat(64), 123, {}, null, Infinity, -1, true])
    assert.deepEqual(sanitizeProducerIdentity(Object.fromEntries(Object.keys(hashes).map(k => [k, value]))), {})
  assert.deepEqual(sanitizeProducerIdentity({ producerIdentityStatus: 3, producerCommitStatus: 2, producerBuildMode: 3 }), {})
  assert.equal(producerIdentityFields().producerIdentityStatus, 0) // Node is not a bundled renderer.
})
test('literal-injected producer has immutable identity and survives both relay sanitizers', async () => {
  const identity = await renderDiagnosticBuildIdentity('/unused', 'build', dependencies())
  const original = await readFile(new URL('../src/render-diagnostic-identity.mjs', import.meta.url), 'utf8')
  const injected = original.replaceAll('__CORE_RENDER_DIAGNOSTIC_BUILD__', JSON.stringify(identity))
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`)
  const values = runtime.producerIdentityFields(); values.producerSourceSha256 = 'e'.repeat(64)
  assert.equal(runtime.producerIdentityFields().producerSourceSha256, identity.producerSourceSha256)
  const record = { v: 1, source: 'worker', session: 4, seq: 5, at: 6, event: 'error', requestId: 7, ...runtime.producerIdentityFields() }
  assert.deepEqual(sanitizeRecord(sanitizeBatch([record])[0]), record)
})
test('provenance adds no events or per-frame work and remains on error and dropped-ring summary', () => {
  const rows = [], d = createRenderDiagnostics({ enabled: true, detail: true, source: 'worker', session: 9,
    sink: row => rows.push(row), now: () => 1, schedule: () => 1, cancel: () => {} })
  d.record('queue-start', { requestId: 1 }); d.record('tile', { requestId: 1 }); d.record('error', { requestId: 1, failureCode: 20 }); d.flush()
  assert.equal(rows.length, 3); assert.equal(rows[0].diagnosticProducerVersion, 1)
  assert(!('producerIdentityStatus' in rows[1])); assert.equal(rows[2].failureDictionaryVersion, 1)
  rows.length = 0
  for (let i = 0; i < 2000; i++) d.record('tile', { requestId: 1 })
  d.flush(); assert.equal(rows.length, 513); assert.equal(rows.at(-1).dropped, 1488)
  assert.equal(rows.at(-1).producerIdentityStatus, 0)
  d.close()
})

test('serve/HMR deliberately reports unknown and does not hash a stale startup snapshot', async () => {
  const fail = () => { throw Error('must not read') }
  assert.deepEqual(await renderDiagnosticBuildIdentity('/unused', 'serve', { sources: fail, head: fail, list: fail, read: fail }),
    { producerIdentityStatus: 0, producerCommitStatus: 0, producerBuildMode: 2 })
})
