import { expect, test } from 'vitest'
import { canvasLodScale, canvasRasterPlan, canvasRasterPhaseMatches, canvasSamplingScale, motionRasterScale } from './canvas-raster-plan'
import { planTiles, tilesCoverBounds } from './tile-cache'

test('pans share canonical samples; fractional zoom uses the actual Figma density', () => {
  const a = canvasRasterPlan({x:12.125,y:-13.375,zoom:2.72},2,800,600,{})
  const b = canvasRasterPlan({x:13.425,y:-19.65,zoom:2.72},2,800,600,{})
  expect(a.mode).toBe('density-cache')
  expect(a.camera).toEqual(b.camera)
  expect(a.phase).toEqual({x:0,y:0})
  expect(a.density).toBeGreaterThanOrEqual(2)
  expect(b.density).toBeGreaterThanOrEqual(2)
  const changed = canvasRasterPlan({x:13.425,y:-19.65,zoom:2.78},2,800,600,{})
  expect(changed.scale).toBe(2.78 * 2)
  expect(changed.camera).not.toEqual(a.camera)
})

test('completed density never undersamples normal or Retina displays', () => {
  for (const dpr of [1,1.25,1.5,2,3]) for (const zoom of [0.025,0.473,1,1.015,2.8,8,16]) {
    const plan = canvasRasterPlan({x:0.25,y:-0.375,zoom},dpr,1440,900,{rasterProfile:'figma'})
    expect(plan.density).toBeGreaterThanOrEqual(dpr)
    expect(plan.density).toBeCloseTo(dpr, 12)
  }
})

test('native pixel preview and screen chrome retain their exact camera phase', () => {
  for (const options of [{pixelPreview:1},{checkerboard:true},{grid:true}]) {
    const plan=canvasRasterPlan({x:0.125,y:-0.375,zoom:1.3},2,800,600,options)
    expect(plan.mode).toBe('native')
    expect(plan.scale).toBe(2.6)
    expect(plan.phase).toEqual({x:0.25,y:0.25})
  }
})

test('Retina viewport limits and far-world coordinates preserve native density', () => {
  const big=canvasRasterPlan({x:0,y:0,zoom:1.01},2,4000,3000,{})
  expect(big.scale).toBe(2.02)
  expect(big.density).toBe(2)
  expect(canvasRasterPlan({x:-5e7,y:0,zoom:1},2,800,600,{}).mode).toBe('native')
})

test('translation reuses covering tiles; increasing zoom requires new exact density', () => {
  const view={x:-100,y:-60,zoom:2.72}
  const a=canvasRasterPlan(view,2,800,600,{})
  const bounds={x:-view.x/view.zoom,y:-view.y/view.zoom,width:800/view.zoom,height:600/view.zoom}
  const tiles=planTiles(bounds,a.scale,256,a.phase)
  const b=canvasRasterPlan({...view,x:-101},2,800,600,{})
  const next={x:101/2.72,y:-view.y/2.72,width:800/2.72,height:600/2.72}
  expect(tilesCoverBounds(tiles,next,b.scale)).toBe(true)
  const c=canvasRasterPlan({...view,zoom:2.9},2,800,600,{})
  expect(c.scale).toBeGreaterThan(a.scale)
  expect(c.density).toBeGreaterThanOrEqual(2)
})

test('viewport LOD budget depends on screen pixels, not the zoomed document scale', () => {
  for (const zoom of [.01, .2, 1, 10, 64]) {
    expect(canvasLodScale(zoom, 2, 1920, 1080, 82)).toBe(zoom * 2)
    // A genuinely oversized screen still reduces its fallback density.
    expect(canvasLodScale(zoom, 2, 1920, 1080, 16)).toBe(zoom)
  }
})

test('debounced sampling keys retain identical scale bits throughout a moving camera', () => {
  const scale = 1.3
  for (let i = 1; i <= 100; i++) {
    const zoom = .1 + i * .017, view = { x: 12.125 + i, y: -13.375 - i, zoom }
    const plan = canvasRasterPlan(view, scale / zoom, 300, 200, { samplingScale: scale })
    expect(plan.scale).toBe(scale)
    expect(plan.camera).toEqual({ x: 0, y: 0, zoom: scale })
  }
})

test('zoom-out cannot allocate an oversized stale-density Retina frame', () => {
  const view = { x: 0, y: 0, zoom: .51 }
  expect(canvasSamplingScale(view, 2, 2560, 1440, 2)).toBe(1.02)
  expect(canvasSamplingScale(view, 2, 1000, 640, 2)).toBe(2)
  expect(canvasSamplingScale({ ...view, zoom: 2 }, 2, 2560, 1440, 2)).toBe(4)
})

test('active zoom admits sharp reusable density without waiting for the gesture to stop', () => {
  for (const zoom of [.025, .26, .51, .55, 1.01, 2.1, 10, 31]) {
    const scale = motionRasterScale({ x: 0, y: 0, zoom }, 2, 1000, 640)
    expect(scale).toBeGreaterThanOrEqual(zoom * 2)
    expect(scale / (zoom * 2)).toBeLessThanOrEqual(2 ** .5 + 1e-10)
  }
  expect(motionRasterScale({ x: 0, y: 0, zoom: .51 }, 2, 1000, 640))
    .toBe(motionRasterScale({ x: 20, y: -40, zoom: .55 }, 2, 1000, 640))
  expect(canvasRasterPlan({ x: 0, y: 0, zoom: .55 }, 2, 1000, 640, {}).scale).toBe(1.1)
})

test('motion density headroom never raises the maximum display budget', () => {
  expect(motionRasterScale({ x: 0, y: 0, zoom: .51 }, 2, 3200, 2000)).toBe(1.02)
})

test('settled fractional pans choose the native device phase while motion stays reusable', () => {
  for (const dpr of [1, 1.25, 2, 3]) for (const zoom of [1, 8, 32]) {
    const view = { x: .1, y: -.375, zoom }
    const moving = canvasRasterPlan(view, dpr, 800, 600, { exactPhase: false })
    const settled = canvasRasterPlan(view, dpr, 800, 600, { exactPhase: true })
    expect(moving.mode).toBe('density-cache')
    expect(settled.mode).toBe('native')
    expect(settled.phase).toEqual({ x: view.x * dpr - Math.floor(view.x * dpr),
      y: view.y * dpr - Math.floor(view.y * dpr) })
    const bounds = { x: -view.x / zoom, y: -view.y / zoom, width: 800 / zoom, height: 600 / zoom }
    const exact = planTiles(bounds, settled.scale, 256, settled.phase)
    const previous = planTiles(bounds, moving.scale, 256, moving.phase)
    expect(exact.some(tile => previous.some(old => old.key === tile.key))).toBe(false)
    for (const tile of exact) {
      const x = tile.x - (tile.phaseX || 0) + view.x * dpr
      const y = tile.y - (tile.phaseY || 0) + view.y * dpr
      expect(x).toBeCloseTo(Math.round(x), 10)
      expect(y).toBeCloseTo(Math.round(y), 10)
    }
  }
})

test('stable integer-device-pixel pans retain the world cache and repeated fractional plans are identical', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const view = { x: 12 / dpr, y: -20 / dpr, zoom: 32 }
    const a = canvasRasterPlan(view, dpr, 800, 600, { exactPhase: true })
    const b = canvasRasterPlan({ ...view, x: 13 / dpr }, dpr, 800, 600, { exactPhase: true })
    expect(a.mode).toBe('density-cache')
    expect(b.camera).toEqual(a.camera)
    const fractional = { ...view, x: .125 }
    expect(canvasRasterPlan(fractional, dpr, 800, 600, { exactPhase: true }))
      .toEqual(canvasRasterPlan(fractional, dpr, 800, 600, { exactPhase: true }))
  }
})


test('phase readiness rejects full-density resampling and admits only matching native samples', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const view = { x: .1, y: -.375, zoom: 32 }
    const native = canvasRasterPlan(view, dpr, 800, 600, { exactPhase: true })
    expect(canvasRasterPhaseMatches(view, dpr, native.scale, native.phase)).toBe(true)
    expect(canvasRasterPhaseMatches(view, dpr, native.scale, { x: 0, y: 0 })).toBe(false)
    expect(canvasRasterPhaseMatches(view, dpr, native.scale / 2, native.phase)).toBe(false)
    expect(canvasRasterPhaseMatches(view, dpr, native.scale * 2, native.phase)).toBe(false)
    expect(canvasRasterPhaseMatches({ ...view, x: 2 / dpr, y: -3 / dpr }, dpr, native.scale, { x: 0, y: 0 })).toBe(true)
  }
})
