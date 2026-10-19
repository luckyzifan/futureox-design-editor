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
