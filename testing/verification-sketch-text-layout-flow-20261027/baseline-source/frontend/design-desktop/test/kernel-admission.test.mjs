import assert from 'node:assert/strict'
import test from 'node:test'
import { formatForNativePath, sketchInspection } from '../src/kernel-admission.mjs'
import { BUILD_DIRECTORIES, BUILD_FILES } from '../scripts/build-inputs.mjs'

test('native file formats select adapters inside the shared design kernel', () => {
  assert.ok(BUILD_DIRECTORIES.includes('design-studio/crates/design-kernel/src'))
  assert.ok(BUILD_FILES.includes('design-studio/crates/design-kernel/Cargo.toml'))
  assert.ok(!BUILD_DIRECTORIES.some(value => /crates\/sketch-(kernel|render)/.test(value)))
  assert.equal(formatForNativePath('/tmp/design.fd'), 'fd')
  assert.equal(formatForNativePath('/tmp/design.FD'), 'fd')
  assert.equal(formatForNativePath('/tmp/design.SKETCH'), 'sketch')
  for (const path of ['/tmp/design.forma', '/tmp/design.FORMA', '/tmp/design.json', '/tmp/a.sketch.fd.exe', '../a.sketch', '/tmp/\0a.sketch'])
    assert.throws(() => formatForNativePath(path))
})
test('inspection accepts only exact Sketch schema/owner and strips private backend payloads', () => {
  const result = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: 'owned', session_epoch: 4 }, pageCount: 1, layerCount: 3, editable: false, renderable: false, path: '/private/file', documentJson: 'private' }
  const accepted = sketchInspection(result, 'owned', 4, 'file.sketch')
  assert.equal(accepted.path, undefined); assert.equal(accepted.documentJson, undefined)
  for (const changed of [
    { owner: { ...result.owner, document_schema: 'sketch-native-v2' } },
    { owner: { ...result.owner, kernel_id: 'figma' } },
    { owner: { ...result.owner, document_id: 'foreign' } },
    { owner: { ...result.owner, session_epoch: 3 } },
    { editable: true }, { renderable: true }, { layerCount: 0 }, { pageCount: 101 },
  ]) assert.throws(() => sketchInspection({ ...result, ...changed }, 'owned', 4, 'file.sketch'))
})
