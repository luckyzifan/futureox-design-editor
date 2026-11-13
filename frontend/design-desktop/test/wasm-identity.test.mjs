import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyWasmIdentity } from '../scripts/wasm-identity.mjs'

const inputs = [{ name: 'kernel/design_kernel_bg.wasm', sha256: 'current-bytes' }]
test('packaged WASM accepts canonical and Vite-hashed names only with exact source bytes', () => {
  for (const name of ['kernel/design_kernel_bg.wasm', 'assets/design_kernel_bg-ByeX8jyP.wasm']) {
    assert.equal(verifyWasmIdentity(name, 'current-bytes', inputs), inputs[0].name)
    assert.throws(() => verifyWasmIdentity(name, 'stale-bytes', inputs), /Stale WASM/)
  }
})
test('packaged WASM rejects missing, unrelated and ambiguous source mappings', () => {
  assert.throws(
    () => verifyWasmIdentity('assets/other-AbCd.wasm', 'current-bytes', inputs),
    /Missing WASM source/,
  )
  assert.throws(
    () => verifyWasmIdentity('assets/design_kernel_bg-.wasm', 'current-bytes', inputs),
    /Missing WASM source/,
  )
  assert.throws(
    () =>
      verifyWasmIdentity('assets/design_kernel_bg-AbCd.wasm', 'current-bytes', [
        ...inputs,
        { name: 'other/design_kernel_bg.wasm', sha256: 'current-bytes' },
      ]),
    /Ambiguous WASM source/,
  )
})

test('shared QuickJS basenames resolve by exact bytes and reject a stale variant', () => {
  const sources = [
    { name: 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', sha256: 'sync' },
    { name: 'node_modules/@jitl/quickjs-wasmfile-release-asyncify/dist/emscripten-module.wasm', sha256: 'async' },
  ]
  assert.equal(
    verifyWasmIdentity('assets/emscripten-module-B1g2L2eS.wasm', 'sync', sources),
    sources[0].name,
  )
  assert.equal(
    verifyWasmIdentity('assets/emscripten-module-ZrHFMo7O.wasm', 'async', sources),
    sources[1].name,
  )
  assert.throws(() => verifyWasmIdentity('assets/emscripten-module-B1g2L2eS.wasm', 'stale', sources), /Stale WASM/)
})
