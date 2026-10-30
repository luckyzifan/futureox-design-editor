import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SketchPreviewRequest, sketchPreviewKey } from './sketch-preview-request.ts'
import { admitSessionPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
const source = JSON.parse(readFileSync(new URL('../../design-desktop/test/fixtures/sketch-session-preview.json', import.meta.url), 'utf8'))
test('actual live-session frame binds revision/page; stale results retire and save-only state retains preview identity', async () => {
  assert.equal(source.revision, 1)
  assert.equal(admitSessionPreview(source, source.owner, 1, 'P').preview.pageName, 'Unsaved page')
  assert.throws(() => admitSessionPreview(source, source.owner, 0, 'P'))
  assert.throws(() => admitSessionPreview(source, source.owner, 1, 'Other'))
  assert.throws(() => admitSessionPreview(source, { ...source.owner, session_epoch: 8 }, 1, 'P'))
  const key = sketchPreviewKey(source, 'P')
  assert.equal(sketchPreviewKey({ ...source, dirty: false, savedRevision: 1 }, 'P'), key)
  assert.notEqual(sketchPreviewKey({ ...source, revision: 2 }, 'P'), key)
  const pending = [], bridge = { preview: request => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) }
  const requests = new SketchPreviewRequest()
  const old = requests.read(bridge, source.owner, 1, 'P')
  const current = requests.read(bridge, source.owner, 1, 'Other')
  pending[1].resolve({ status: 'ok', ...source, pageId: 'Other', preview: { status: 'unavailable', reason: 'Unsupported text' } })
  assert.equal((await current).preview.reason, 'Unsupported text')
  pending[0].resolve({ status: 'ok', ...source }); assert.equal(await old, undefined)
  const disposed = requests.read(bridge, source.owner, 1, 'P')
  requests.invalidate(); pending[2].reject(new Error('late failure')); assert.equal(await disposed, undefined)
  const wrong = requests.read(bridge, source.owner, 1, 'P')
  pending[3].resolve({ status: 'ok', ...source, revision: 2 }); await assert.rejects(wrong)
})
