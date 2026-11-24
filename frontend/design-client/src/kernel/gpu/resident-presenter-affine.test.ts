import { afterEach, expect, test, vi } from 'vitest'
import { descriptorPresenter } from '../descriptor-presenter.test-helper'
import type { ResidentFrame } from './resident-presenter'
import type { Matrix } from '../../model'
afterEach(() => vi.unstubAllGlobals())

function fixture(atomic = false) {
  const f = descriptorPresenter(() => {}, atomic)
  const tile = f.presenter.capture(16, 16, undefined, { owner: {}, contract: 'page' })
  const affine: Matrix = [0, 1, -1, 0, 16, 0] // 90deg rotation about the viewport origin
  const frame = (extra?: Partial<ResidentFrame>): ResidentFrame => ({
    view: { x: 0, y: 0, zoom: 1 }, width: 16, height: 16, dpr: 1, interaction: true,
    input: { sequence: 1, at: 1 },
    items: [{ active: true, layer: 1, gutter: 0, tile: { key: 't', serial: 1, gpuTile: tile.id, x: 0, y: 0, width: 16, height: 16, zoom: 1 } }],
    ...extra,
  })
  return { ...f, tile, affine, frame }
}

test('an affine content preview draws through the affine pipeline and is marked preview', () => {
  const f = fixture()
  const pipelines = vi.spyOn(f.device, 'createRenderPipeline')
  const before = pipelines.mock.calls.length
  const writes: { offset: number; data: Float32Array }[] = []
  const originalWrite = f.queue.writeBuffer.bind(f.queue)
  f.queue.writeBuffer = ((buffer: unknown, offset: number, data: Float32Array) => {
    writes.push({ offset, data }); return originalWrite(buffer as never)
  }) as typeof f.queue.writeBuffer
  f.presenter.draw(f.frame({ affinePreview: true, items: [{ ...f.frame().items[0], affine: f.affine }] }))
  // The lazy affine pipeline is created exactly once for the preview draw.
  expect(pipelines.mock.calls.length).toBe(before + 1)
  const report = f.reports.at(-1) as Record<string, unknown>
  expect(report.affinePreview).toBe(true)
  expect(report.coverageDeferred).toBe(0)
  expect((report.presented as Record<string, unknown>).preview).toBe(true)
  // The 80-byte affine uniform carries the original box/uv plus the 2x3 matrix.
  const affineWrite = writes.find(w => w.data.length === 20)
  expect(affineWrite).toBeDefined()
  const data = affineWrite!.data
  expect([...data.slice(0, 4)]).toEqual([0, 0, 16, 16]) // box
  expect([...data.slice(4, 8)]).toEqual([0, 0, 1, 1]) // uv
  expect([...data.slice(8, 10)]).toEqual([16, 16]) // viewport
  expect([...data.slice(12, 16)]).toEqual([f.affine[0], f.affine[2], f.affine[4], 0]) // row0=(a,c,e,0)
  expect([...data.slice(16, 20)]).toEqual([f.affine[1], f.affine[3], f.affine[5], 0]) // row1=(b,d,f,0)
})

test('a motion affine preview is never captured as an exact interaction viewport', () => {
  const f = fixture(true)
  const preview = f.frame({ affinePreview: true, items: [{ ...f.frame().items[0], affine: f.affine }] })
  expect(f.presenter.captureInteractionViewport(preview)).toBeUndefined()
  // Even without the frame flag, an affine item cannot certify an exact capture.
  const affineItem = f.frame({ items: [{ ...f.frame().items[0], affine: f.affine }] })
  expect(f.presenter.captureInteractionViewport(affineItem)).toBeUndefined()
})

test('default presentation without affine is unchanged (no affine pipeline, no preview mark)', () => {
  const f = fixture()
  const pipelines = vi.spyOn(f.device, 'createRenderPipeline')
  const before = pipelines.mock.calls.length
  f.presenter.draw(f.frame())
  expect(pipelines.mock.calls.length).toBe(before)
  const report = f.reports.at(-1) as Record<string, unknown>
  expect(report.affinePreview).toBeUndefined()
  expect((report.presented as Record<string, unknown>).preview).toBe(false)
})