import { afterEach, expect, test, vi } from 'vitest'
import { descriptorPresenter } from '../descriptor-presenter.test-helper'
import type { ResidentFrame } from './resident-presenter'
import type { Matrix } from '../../model'
import { setGpuDiagnosticsDetail } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(() => { vi.unstubAllGlobals(); setGpuDiagnosticsDetail(false) })

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

async function acceptBitmap(f: ReturnType<typeof fixture>) {
  f.queue.completeThrough(f.queue.epoch)
  await Promise.resolve()
  await Promise.resolve()
  const report = f.reports.at(-1) as { bitmap: ImageBitmap; presented: { presentationToken: number } }
  expect(report.bitmap).toBeDefined()
  report.bitmap.close()
  f.presenter.acceptPresentation(report.presented.presentationToken)
  return report
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

test('an affine preview never claims terminal quality, and the exact frame after it still can', () => {
  setGpuDiagnosticsDetail(true)
  const f = fixture()
  const marker = { qualitySequence: 1, qualityRevision: 1, pageToken: 1 }
  f.presenter.draw(f.frame({ terminalQuality: marker }))
  expect((f.reports.at(-1) as Record<string, unknown>).qualityTerminal).toBe(true)
  // The preview consumes no completion marker: the gate must stay free for the
  // exact frame that replaces this transient reprojection.
  f.presenter.draw(f.frame({ affinePreview: true, items: [{ ...f.frame().items[0], affine: f.affine }],
    terminalQuality: { ...marker, qualitySequence: 2 } }))
  const preview = f.reports.at(-1) as Record<string, unknown>
  expect(preview.affinePreview).toBe(true)
  expect(preview.qualityTerminal).toBeUndefined()
  expect(preview.terminalQuality).toBeUndefined()
  f.presenter.draw(f.frame({ terminalQuality: { ...marker, qualitySequence: 2 } }))
  expect((f.reports.at(-1) as Record<string, unknown>).qualityTerminal).toBe(true)
})

test('a later exact draw retires the preview mark instead of keeping the transient state', () => {
  const f = fixture()
  f.presenter.draw(f.frame({ affinePreview: true, items: [{ ...f.frame().items[0], affine: f.affine }] }))
  expect((f.reports.at(-1) as Record<string, unknown>).affinePreview).toBe(true)
  expect(((f.reports.at(-1) as Record<string, unknown>).presented as Record<string, unknown>).preview).toBe(true)
  f.presenter.draw(f.frame())
  const exact = f.reports.at(-1) as Record<string, unknown>
  expect(exact.affinePreview).toBeUndefined()
  expect((exact.presented as Record<string, unknown>).preview).toBe(false)
})

test('late bitmap ACK holds the last frame after the queued affine texture is retired', async () => {
  const f = fixture(true)
  try {
    const retiring = f.presenter.capture(16, 16)
    const input = { sequence: 2, at: 2, owner: 'rotate' }
    f.presenter.draw(f.frame({ presentationId: 'accepted-before-retirement' }))
    const submitted = f.queue.epoch
    const [item] = f.frame().items
    f.presenter.draw(f.frame({ presentationId: 'queued-affine', affinePreview: true, input,
      items: [{ ...item, affine: f.affine, tile: { ...item.tile, gpuTile: retiring.id } }],
    }))
    expect(f.queue.epoch).toBe(submitted)
    f.presenter.release([retiring.id])

    await acceptBitmap(f)
    f.queue.completeThrough(f.queue.epoch)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.reports.at(-1)).toMatchObject({ coverageDeferred: 1, missingTextureCount: 1,
      coverageDeferredPresentationId: 'queued-affine', input })
    expect(f.reports.at(-1)?.presented).toBeUndefined()
    expect(f.queue.epoch).toBe(submitted)

    const fresh = f.presenter.capture(16, 16)
    f.presenter.draw(f.frame({ presentationId: 'current-exact', input: { ...input, sequence: 3 },
      items: [{ ...item, tile: { ...item.tile, gpuTile: fresh.id } }],
    }))
    const recovered = await acceptBitmap(f)
    expect(recovered).toMatchObject({ missingTextureCount: 0, presented: {
      presentationId: 'current-exact', preview: false, ids: [fresh.id],
    }, input: { sequence: 3, owner: 'rotate' } })
  } finally {
    f.presenter.dispose()
  }
})

test('active affine sources remain required under detailed sharpness diagnostics', () => {
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '1')
  setGpuDiagnosticsDetail(true)
  const f = fixture()
  try {
    const retiring = f.presenter.capture(16, 16)
    const [item] = f.frame().items
    f.presenter.draw(f.frame())
    const submitted = f.queue.epoch
    f.presenter.release([retiring.id])
    // The normal axis-aligned plan can hide this lower layer completely;
    // its source remains required when the frame requests an affine draw.
    f.presenter.draw(f.frame({ affinePreview: true, items: [
      { ...item, affine: f.affine, layer: 0, tile: { ...item.tile, gpuTile: retiring.id } },
      { ...item, affine: f.affine },
    ] }))
    expect(f.reports.at(-1)).toMatchObject({ coverageDeferred: 1, missingTextureCount: 1 })
    expect(f.queue.epoch).toBe(submitted)
  } finally {
    f.presenter.dispose()
  }
})

test('an ordinary backing does not substitute for an affine draw outside the viewport', () => {
  const f = fixture()
  try {
    const [item] = f.frame().items
    f.presenter.draw(f.frame())
    const submitted = f.queue.epoch
    f.presenter.draw(f.frame({ affinePreview: true, items: [
      item, { ...item, affine: f.affine, tile: { ...item.tile, x: 32 } },
    ] }))
    expect(f.reports.at(-1)).toMatchObject({ coverageDeferred: 1, missingTextureCount: 0 })
    expect(f.queue.epoch).toBe(submitted)
  } finally {
    f.presenter.dispose()
  }
})
