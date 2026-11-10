import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { admitSketchPreview, MAX_PREVIEW_BYTES } from '../src/sketch-preview-contract.mjs'
import { sketchInspection } from '../src/kernel-admission.mjs'
// Produced by the production Rust inspect module through the standalone CPU test.
const source = readFileSync(new URL('./fixtures/sketch-preview-frame.json', import.meta.url), 'utf8')
const original = JSON.parse(source)
test('actual Rust rectangle/cubic scene admits; corrupted transport and stale ownership fail closed', () => {
  assert.deepEqual(admitSketchPreview(source, original.owner).scene.roots, ['R', 'C'])
  for (const mutate of [
    f => f.owner.session_epoch++, f => f.owner.document_id = 'other',
    f => f.owner.kernel_id = 'figma', f => f.owner.document_schema = 'unknown', f => f.revision++,
    f => f.scene.nodes.R.fill.area.first = 999999,
    f => f.scene.nodes.R.fill.area.count = 999999,
    f => f.scene.curves[f.scene.nodes.C.fill.area.first * 4 + 4] = 999999,
    f => f.scene.curves[4] = null, f => f.scene.roots.push('R'),
    f => f.scene.nodes.R.fills[0].image = 'https://example.invalid/image',
    f => f.scene.nodes.R.matrix[0] = 2, f => f.scene.width = 65536,
  ]) {
    const frame = structuredClone(original); mutate(frame)
    assert.throws(() => admitSketchPreview(JSON.stringify(frame), original.owner))
  }
  assert.throws(() => admitSketchPreview(' '.repeat(MAX_PREVIEW_BYTES + 1), original.owner))
  assert.throws(() => admitSketchPreview(source.replace('512', '1e999'), original.owner))
  const summary = { owner: original.owner, pageCount: 1, layerCount: 3, editable: false, renderable: false,
    preview: { status: 'ready', frameJson: source, pageName: '首页', pageId: 'P' } }
  assert.equal(sketchInspection(summary, 'host-document', 7, 'file.sketch').preview.status, 'ready')
  assert.throws(() => sketchInspection({ ...summary, preview: { ...summary.preview, pageId: 'other' } }, 'host-document', 7, 'file.sketch'))
})

test('encoded Sketch previews omit color management; linear frames still require it', () => {
  const encoded = structuredClone(original)
  encoded.scene.floatCompositing = false
  delete encoded.scene.colorManagement
  encoded.scene.colors['color(srgb 0.125 0.5 1 / 1)'] = [0.125, 0.5, 1, 1]
  assert.equal(admitSketchPreview(JSON.stringify(encoded), original.owner).scene.floatCompositing, false)
  const mixed = structuredClone(encoded)
  mixed.scene.colorManagement = original.scene.colorManagement
  assert.throws(() => admitSketchPreview(JSON.stringify(mixed), original.owner))
  const cleared = structuredClone(original)
  delete cleared.scene.colorManagement
  assert.throws(() => admitSketchPreview(JSON.stringify(cleared), original.owner))
})
