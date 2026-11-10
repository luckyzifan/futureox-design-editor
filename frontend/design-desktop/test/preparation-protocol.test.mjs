import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { browserPreparationMethods, preparationProtocol, preparationProtocolSource, rendererHostMethods, validatePreparationProtocol } from '../src/preparation-protocol.mjs'

const expected = [
  ['warm_resources', 'all', true, 'renderer'],
  ['initialize', 'all', true, 'renderer'],
  ['load_document', 'all', true, 'renderer'],
  ['apply_document_patch_with_damage', 'all', true, 'renderer'],
  ['apply_interaction_transforms', 'all', true, 'renderer'],
  ['compile_gpu_packet', 'all', true, 'renderer'],
  ['render_linear', 'all', true, 'renderer'],
  ['render_png', 'all', true, 'renderer'],
  ['render_color_png', 'all', true, 'renderer'],
  ['render_region_png', 'all', true, 'renderer'],
  ['render_cpu_frame', 'all', true, 'renderer'],
  ['stats', 'all', true, 'renderer'],
  ['gpu_memory_breakdown', 'all', true, 'renderer'],
  ['preparation_capabilities_v1', 'all', true, 'renderer'],
  ['derive_document_v1', 'all', true, 'renderer'],
  ['load_source_snapshot', 'native', false, 'private'],
  ['source_hit', 'native', false, 'renderer'],
  ['interaction_pose_damage', 'all', true, 'renderer'],
]

test('the shared preparation protocol is the host and browser allowlist', () => {
  const source = readFileSync(new URL('../src/preparation-methods-v1.ts', import.meta.url), 'utf8')
  assert.deepEqual(preparationProtocolSource(source), preparationProtocol)
  assert.deepEqual(preparationProtocol.methods.map(method => [method.name, method.dispatch, method.browser, method.host]), expected)
  assert.deepEqual(preparationProtocol.methods.map(method => method.code), expected.map((_, index) => index + 1))
  assert.deepEqual([...rendererHostMethods()].sort(), [...preparationProtocol.codecMethods, ...expected.filter(method => method[3] === 'renderer').map(method => method[0])].sort())
  assert.deepEqual(browserPreparationMethods(), expected.filter(method => method[2]).map(method => method[0]))
  assert.equal(rendererHostMethods().has('interaction_pose_damage'), true)
  assert.equal(rendererHostMethods().has('load_source_snapshot'), false)
  assert.equal(rendererHostMethods().has('not-a-method'), false)
  assert.deepEqual(preparationProtocol.codecMethods, ['serialize', 'serialize_delta', 'parse'])
})

test('protocol validation rejects drifted names, codes, surfaces and unknown fields', () => {
  const broken = structuredClone(preparationProtocol)
  broken.methods.at(-1).host = 'none'
  assert.throws(() => validatePreparationProtocol(broken), /shared renderer admission/)
  const reordered = structuredClone(preparationProtocol)
  reordered.methods.push(reordered.methods.shift())
  assert.throws(() => validatePreparationProtocol(reordered), /protocol order/)
  const extra = structuredClone(preparationProtocol)
  extra.methods[0].unexpected = true
  assert.throws(() => validatePreparationProtocol(extra), /Invalid preparation method/)
  const unknown = structuredClone(preparationProtocol)
  unknown.methods.push({ name: 'extra_method', code: 99, dispatch: 'all', browser: false, host: 'renderer' })
  assert.throws(() => validatePreparationProtocol(unknown), /protocol order/)
  unknown.methods.at(-1).code = unknown.methods.length
  assert.doesNotThrow(() => validatePreparationProtocol(unknown))
  const overlap = structuredClone(preparationProtocol)
  overlap.codecMethods.push('stats')
  assert.throws(() => validatePreparationProtocol(overlap), /codec method/)
})
