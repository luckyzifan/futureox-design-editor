import { expect, test } from 'vitest'
import { validStartupPreview, type StartupPreview } from './startup-preview'
import { SaveCoordinator } from './local-store'
import { blank } from './model'

test('startup pixels are bound to the durable revision and reject invalid envelopes', () => {
  const preview: StartupPreview = { documentId: 'A', revision: 2, pageId: 'P', width: 800, height: 600,
    view: { x: 10, y: 20, zoom: .5 }, background: '#fff', image: new Blob(['pixels'], { type: 'image/webp' }) }
  expect(validStartupPreview(preview, 'A', 2)).toBe(true)
  expect(validStartupPreview(preview, 'B', 2)).toBe(false)
  expect(validStartupPreview(preview, 'A', 3)).toBe(false)
  for (const change of [{ width: 0 }, { view: { x: 0, y: 0, zoom: Infinity } }, { image: new Blob(['<svg/>'], { type: 'image/svg+xml' }) },
    { image: new Blob([new Uint8Array(1_048_577)], { type: 'image/webp' }) }])
    expect(validStartupPreview({ ...preview, ...change }, 'A', 2)).toBe(false)
})

test('late pixel encodes cannot certify an older editor version as a newer durable revision', async () => {
  const saver = new SaveCoordinator(async (document, revision = 0) => ({ document, revision: revision + 1, updatedAt: 0 }))
  const doc = blank()
  expect(saver.durableRevision(doc.id, 1)).toBeUndefined()
  await saver.save(doc, 1)
  expect(saver.durableRevision(doc.id, 1)).toBe(1)
  await saver.save({ ...doc, name: 'new' }, 2)
  expect(saver.durableRevision(doc.id, 1)).toBeUndefined()
  expect(saver.durableRevision(doc.id, 2)).toBe(2)
})
