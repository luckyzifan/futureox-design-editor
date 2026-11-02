import { afterEach, expect, test, vi } from 'vitest'
import { descriptorPresenter } from '../descriptor-presenter.test-helper'
import { ResidentPresentation } from '../resident-presentation'
import { cameraPreviewCoverage } from './camera-preview'
import type { ResidentFrame } from './resident-presenter'
import type { PresentedFrame } from '../Surface'

afterEach(() => vi.unstubAllGlobals())
const proof = () => ({ owner: {}, contract: 'same-page-and-render-policy' })
const item = (id: number, x = 0, width = 16, layer = 1) => ({ active: true, layer, gutter: 0,
  tile: { key: String(id), gpuTile: id, serial: id, x, y: 0, width, height: 16, zoom: 1 } })
const frame = (items: ReturnType<typeof item>[], x = 0): ResidentFrame => ({
  presentationId: 'camera', view: { x, y: 0, zoom: 1 }, width: 16, height: 16, dpr: 1, items,
})

test('uncached camera edge presents immediately, with exact pending pixel ownership and no terminal claim', () => {
  const f = descriptorPresenter(() => {}), content = proof(), tile = f.presenter.capture(16, 16, undefined, content)
  f.presenter.draw(frame([item(tile.id)]))
  const before = f.queue.epoch, bytes = f.presenter.residentBytes
  const moved = { ...frame([item(tile.id)], 4), cameraPreview: { anchor: tile.id },
    terminalQuality: { qualitySequence: 1, qualityRevision: 1, pageToken: 1 } }
  f.presenter.draw(moved)
  expect(f.queue.epoch).toBeGreaterThan(before)
  expect(f.presenter.residentBytes).toBe(bytes)
  expect(f.reports.at(-1)).toMatchObject({ coverageDeferred: 0, cameraPreview: true,
    previewPendingPixels: 64, previewCachedPixels: 192, pixelCoverageComplete: false,
    nativeCoverageComplete: false, qualityTerminal: false,
    presented: { preview: true, presentationId: 'camera', view: moved.view } })
  expect((f.presenter as any).contentFrame().preview).toBe(true)
  // Exact arrival overwrites its actual region and independently ends preview.
  const entering = f.presenter.capture(4, 16, undefined, content)
  f.presenter.draw({ ...moved, items: [...moved.items, item(entering.id, -4, 4, 2)] })
  expect(f.reports.at(-1)).toMatchObject({ cameraPreview: false, previewPendingPixels: 0, presented: { preview: false } })
})

test('complete cache leaving the viewport still acknowledges the new camera as pending, never transparent exact', () => {
  const f = descriptorPresenter(() => {}), tile = f.presenter.capture(16, 16, undefined, proof())
  f.presenter.draw(frame([item(tile.id)]))
  f.presenter.draw({ ...frame([], 40), cameraPreview: { anchor: tile.id } })
  expect(f.reports.at(-1)).toMatchObject({ previewPendingPixels: 256, previewCachedPixels: 0,
    presented: { view: { x: 40 }, preview: true, ids: [] } })
})

test.each(['missing-anchor', 'mixed-owner', 'changed-contract', 'interaction', 'linear', 'unknown-content'])(
  'preview does not bypass %s ownership or layer semantics', reason => {
    const f = descriptorPresenter(() => {}), content = proof(), tile = f.presenter.capture(16, 16, undefined, content)
    const other = reason === 'mixed-owner' ? proof() : reason === 'changed-contract' ? { ...content, contract: 'other' } : content
    const half = f.presenter.capture(8, 16, undefined, reason === 'unknown-content' ? undefined : other)
    f.presenter.draw(frame([item(tile.id)])); const before = f.queue.epoch
    f.presenter.draw({ ...frame([item(half.id, 8, 8)]), cameraPreview: { anchor: reason === 'missing-anchor' ? 999 : tile.id },
      interaction: reason === 'interaction', linearBlend: reason === 'linear' })
    expect(f.queue.epoch).toBe(before)
    expect(f.reports.at(-1)?.coverageDeferred).toBe(1)
  })

test('one-pixel holes remain pending and blend layers cannot certify underlying content', () => {
  const content = proof()
  const rows = [{ x: 0, y: 0, width: 7, height: 16, content }, { x: 8, y: 0, width: 8, height: 16, content }]
  expect(cameraPreviewCoverage(content, rows, 16, 16)).toEqual({ gaps: [{ x: 7, y: 0, width: 1, height: 16 }], pendingPixels: 16 })
  expect(cameraPreviewCoverage(content, [{ ...rows[0], blend: true }], 16, 16)).toBeUndefined()
})

test('the accepted backbuffer retains its actual pixel receipt after source textures retire', () => {
  const f = descriptorPresenter(() => {}), tile = f.presenter.capture(16,16,undefined,proof())
  f.presenter.draw(frame([item(tile.id)]))
  f.presenter.release([tile.id])
  expect((f.presenter as any).contentFrame()).toMatchObject({preview:false,ids:[tile.id]})
})

test('actual placeholder receipt cannot promote an exact staged context or a snapshot', () => {
  const p = new ResidentPresentation(), source = { document: {}, pageId: 'p', epoch: 1,
    view: { x: 0, y: 0, zoom: 1 }, width: 16, height: 16, pixelRatio: 1 } as PresentedFrame
  const id = p.stage(source), snapshot = p.snapshotResolver()
  const actual = { presentationId: id, view: source.view, width: 16, height: 16, dpr: 1, interaction: false, ids: [], preview: true }
  expect(p.resolve(actual)?.preview).toBe(true)
  expect(snapshot(actual)?.preview).toBe(true)
  expect(p.resolve({ ...actual, preview: false })?.preview).toBe(false)
})
