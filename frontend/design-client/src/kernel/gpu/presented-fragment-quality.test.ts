import { afterEach, expect, test, vi } from 'vitest'
import { presentedFragmentQuality, type PresentedFragment } from './presented-fragment-quality'
import { ResidentPresenter, type ResidentFrame } from './resident-presenter'
import { TerminalQualityGate } from './terminal-quality'
import { setGpuDiagnosticsDetail } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGpuDiagnosticsDetail(false) })
const row = (x: number, width: number, density = 1, blend = false): PresentedFragment => ({
  x, y: 0, width, height: 100, sourceWidth: width * density, sourceHeight: 100 * density, uv: [0, 0, 1, 1], blend,
})
test('a one-pixel coarse sliver and a one-pixel hole cannot hide between the 96 sample points', () => {
  const sides = [row(0, 31), row(32, 68)]
  expect(presentedFragmentQuality(sides, 100, 100)).toMatchObject({ coverage: 1, sharpCoverage: 1,
    pixelCoverageComplete: false, nativeCoverageComplete: false })
  expect(presentedFragmentQuality([...sides, row(31, 1, .5)], 100, 100)).toMatchObject({ coverage: 1, sharpCoverage: 1,
    pixelCoverageComplete: true, nativeCoverageComplete: false, maxUpscale: 2 })
  expect(presentedFragmentQuality([...sides, row(31, 1)], 100, 100).nativeCoverageComplete).toBe(true)
})
test('sharp backgrounds cannot conceal coarse blended content, and sharp overlays cannot certify coarse backgrounds', () => {
  expect(presentedFragmentQuality([row(0, 100), row(31, 1, .25, true)], 100, 100)).toMatchObject({
    sharpCoverage: 1, maxUpscale: 4, pixelCoverageComplete: true, nativeCoverageComplete: false,
  })
  expect(presentedFragmentQuality([row(0, 100, .5), row(0, 100, 1, true)], 100, 100)).toMatchObject({
    sharpCoverage: 0, maxUpscale: 2, nativePhaseCoverage: 0, nativeCoverageComplete: false,
  })
  expect(presentedFragmentQuality([row(0, 100, 1, true)], 100, 100)).toMatchObject({
    coverage: 0, pixelCoverageComplete: false, nativeCoverageComplete: false,
  })
})
test('density and phase use the actual physical draw and sampled UV range, including fractional DPR rounding', () => {
  const fragment: PresentedFragment = { x: 0, y: 0, width: 126, height: 83, sourceWidth: 252, sourceHeight: 166, uv: [0, 0, .5, .5] }
  expect(presentedFragmentQuality([fragment], 126, 83)).toMatchObject({ sharpCoverage: 1, nativePhaseCoverage: 1, maxUpscale: 1, nativeCoverageComplete: true })
  expect(presentedFragmentQuality([{ ...fragment, uv: [.25 / 252, 0, .5, .5] }], 126, 83)).toMatchObject({
    sharpCoverage: 1, nativePhaseCoverage: 0, nativeCoverageComplete: true,
  })
  expect(presentedFragmentQuality([{ ...fragment, uv: [0, 0, 1, 1] }], 126, 83)).toMatchObject({
    sharpCoverage: 1, nativePhaseCoverage: 0, nativeCoverageComplete: true,
  })
})

function fixture() {
  vi.stubEnv('DEV', false)
  const reports: any[] = [], draw = vi.fn(), submit = vi.fn(), wait = vi.fn(() => { throw Error('Unexpected diagnostic GPU wait') })
  const pass = { setScissorRect() {}, setPipeline() {}, setBindGroup() {}, draw, end() {} }
  const presenter = Object.assign(Object.create(ResidentPresenter.prototype), {
    terminalQualityGate: new TerminalQualityGate(), diagnosticCoverageAt: 100, diagnosticFields: () => ({}),
    payload: { assertOpen() {} }, frames: 0, imports: 0, captures: 0, bytes: 0,
    device: { limits: { maxTextureDimension2D: 4096 }, queue: { submit, onSubmittedWorkDone: wait },
      createCommandEncoder: () => ({ beginRenderPass: () => pass, copyTextureToTexture() {}, finish() { return {} } }) },
    textures: new Map([[42, { texture: { width: 100, height: 100 }, bind: {}, bytes: 40000 }],
      [43, { texture: { width: 10, height: 10 }, bind: {}, bytes: 400 }]]),
    canvas: { width: 100, height: 100 }, context: { getCurrentTexture: () => ({}) },
    backbuffer: { width: 100, height: 100, texture: { createView: () => ({}) } },
    transformData: { begin() {}, set() {}, changed() { return undefined } }, report: (r: unknown) => reports.push(r),
  }) as ResidentPresenter
  const item = (id: number, x = 0, layer = 1, zoom = 1) => ({ active: true, layer, gutter: 0,
    tile: { gpuTile: id, key: `fixture-${id}`, serial: id, x, y: 0, width: 100, height: 100, zoom } })
  const frame: ResidentFrame = { view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 100, dpr: 1, items: [item(42)] }
  return { presenter, frame, item, reports, draw, submit, wait }
}
test('strict detailed mode measures every submitted camera frame inside the old throttle without changing the draws', () => {
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '1'); setGpuDiagnosticsDetail(true)
  const f = fixture(); vi.spyOn(performance, 'now').mockReturnValue(101)
  f.presenter.draw(f.frame)
  expect(f.reports.at(-1)).toMatchObject({ coverageMeasured: true, sharpCoverage: 1, maxUpscale: 1, nativeCoverageComplete: true })
  const zoomed = { ...f.frame, view: { x: 0, y: 0, zoom: 2 } }
  f.presenter.draw(zoomed)
  expect(f.reports.at(-1)).toMatchObject({ coverageMeasured: true, sharpCoverage: 0, maxUpscale: 2,
    pixelCoverageComplete: true, nativeCoverageComplete: false, presented: { view: zoomed.view } })
  expect(f.submit).toHaveBeenCalledTimes(2); expect(f.draw).toHaveBeenCalledTimes(2); expect(f.wait).not.toHaveBeenCalled()
})
test('default and diagnostics-off modes retain the original throttle', () => {
  for (const [flag, details] of [['0', true], ['1', false]] as const) {
    vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', flag); setGpuDiagnosticsDetail(details)
    const f = fixture(); vi.spyOn(performance, 'now').mockReturnValue(101)
    f.presenter.draw(f.frame); f.presenter.draw(f.frame)
    expect(f.reports.at(-1).coverageMeasured).toBe(false)
    expect(f.reports.at(-1).maxUpscale).toBeUndefined()
    expect(f.submit).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  }
})
test('quality uses only visible post-occlusion fragments and actual texture dimensions; invisible missing handles are excluded', () => {
  vi.stubEnv('VITE_DESIGN_SHARP_ZOOM', '1'); setGpuDiagnosticsDetail(true)
  const f = fixture(); vi.spyOn(performance, 'now').mockReturnValue(101)
  // Coarse resident 43 and absent 99 are below an opaque complete foreground.
  // Absent 100 is outside the viewport. None should alter the visible metrics.
  f.presenter.draw({ ...f.frame, items: [f.item(43, 0, 0), f.item(99, 0, 0), f.item(100, 300, 3), f.item(42, 0, 2)] })
  expect(f.reports.at(-1)).toMatchObject({ compositorDraws: 1, missingTextureCount: 0, maxUpscale: 1, nativeCoverageComplete: true })
  expect(f.reports.some(r => r.missingGpuTiles)).toBe(false)
  // Nominal tile metadata claims 100x100, but the texture bound to the GPU is
  // actually 10x10. The diagnostic must measure those submitted texels.
  f.presenter.draw({ ...f.frame, items: [f.item(43)] })
  expect(f.reports.at(-1)).toMatchObject({ maxUpscale: 10, sharpCoverage: 0, nativeCoverageComplete: false })
  f.presenter.draw({ ...f.frame, items: [f.item(42), f.item(99, 0, 2)] })
  expect(f.reports.at(-1)).toMatchObject({ missingTextureCount: 1, pixelCoverageComplete: true, nativeCoverageComplete: true })
  // Missing requested pixels have an actual complete fallback; that is not a
  // blank frame, and the visible fallback has really been submitted.
  expect(f.submit).toHaveBeenCalledTimes(3)
})
