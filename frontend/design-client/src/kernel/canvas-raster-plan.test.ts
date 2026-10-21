import { afterEach, expect, test, vi } from 'vitest'
import { preservesNativePanPhase, canvasLodScale, canvasRasterPlan, canvasRasterPhaseMatches, canvasSamplingScale, gestureRasterScale, gestureViewportCapture, motionRasterScale } from './canvas-raster-plan'
import { displayTileBudget, MAX_DISPLAY_TILE_BYTES, planTiles, tilesCoverBounds } from './tile-cache'
import { createRenderPolicy } from './render-policy'

afterEach(() => vi.unstubAllEnvs())

const gesturePolicy = createRenderPolicy(false, false, false, false, true, true)
const gestureRequest = { policy: gesturePolicy, active: true,
  request: { renderIntent: 'preview', rasterProfile: 'figma' } }
const aheadRung = (scale: number) => 2 ** ((Math.ceil(Math.log2(scale) * 4) + 1) / 4)

test('quarter-octave gesture density requires the explicit default-off flag', () => {
  const view = { x: .125, y: -.375, zoom: .55 }
  for (const flag of [undefined, '', '0', 'true', '01']) {
    vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', flag)
    expect(gestureRasterScale(view, 2, 800, 600, gestureRequest)).toBeUndefined()
  }
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  expect(gestureRasterScale(view, 2, 800, 600, gestureRequest)).toBe(aheadRung(1.1))
})

test('gesture headroom pre-generates one quarter-octave rung beyond the next tile level without reducing density', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  for (const dpr of [1, 1.25, 2, 3]) for (const zoom of [.025, .26, .51, .55, 1.01, 2.1, 10, 16]) {
    const requested = zoom * dpr
    const scale = gestureRasterScale({ x: .125, y: -.375, zoom }, dpr, 800, 600, gestureRequest)!
    expect(scale).toBe(aheadRung(requested))
    expect(scale).toBeGreaterThanOrEqual(requested)
    expect(scale / requested).toBeGreaterThanOrEqual(2 ** .25 - Number.EPSILON * 8)
    expect(scale / requested).toBeLessThanOrEqual(Math.SQRT2 + Number.EPSILON * 8)
    expect(displayTileBudget(800, 600, scale / zoom, false)).toBeLessThanOrEqual(MAX_DISPLAY_TILE_BYTES)
  }
  for (const scale of [1 / 512, .25, 1, 2, 32])
    expect(gestureRasterScale({ x: 0, y: 0, zoom: scale / 2 }, 2, 800, 600, gestureRequest)).toBe(aheadRung(scale))
  expect(gestureRasterScale({ x: 0, y: 0, zoom: 32 }, 2, 800, 600, gestureRequest)).toBeUndefined()
})

test('adjacent gesture zooms share canonical world tiles without a native-phase certificate', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  const views = [{ x: -10.125, y: -20.375, zoom: .51 }, { x: -10.125, y: -20.375, zoom: .55 }]
  const plans = views.map(view => {
    const scale = gestureRasterScale(view, 2, 800, 600, gestureRequest)!
    return canvasRasterPlan(view, scale / view.zoom, 800, 600, { rasterProfile: 'figma', samplingScale: scale })
  })
  expect(plans[1].scale).toBe(plans[0].scale)
  expect(plans[1].camera).toEqual(plans[0].camera)
  expect(plans[0].camera).toEqual({ x: 0, y: 0, zoom: aheadRung(1.02) })
  const [first, next] = views.map(view => ({ x: -view.x / view.zoom, y: -view.y / view.zoom,
    width: 800 / view.zoom, height: 600 / view.zoom }))
  const tiles = planTiles(first, plans[0].scale)
  expect(tilesCoverBounds(tiles, next, plans[1].scale)).toBe(true)
  expect(planTiles(next, plans[1].scale).every(tile => tiles.some(previous => previous.key === tile.key))).toBe(true)
  for (let i = 0; i < views.length; i++)
    expect(canvasRasterPhaseMatches(views[i], 2, plans[i].scale, plans[i].phase)).toBe(false)
})

test('settle preserves ordinary exact density and phase while all non-display requests reject headroom', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  const view = { x: .125, y: -.375, zoom: .55 }
  expect(gestureRasterScale(view, 2, 800, 600, { ...gestureRequest, active: false })).toBeUndefined()
  const settled = canvasRasterPlan(view, 2, 800, 600, { rasterProfile: 'figma', exactPhase: true })
  expect(settled.scale).toBe(1.1)
  expect(canvasRasterPhaseMatches(view, 2, settled.scale, settled.phase)).toBe(true)
  for (const request of [{ renderIntent: 'settle' }, { renderIntent: 'export' },
    { renderIntent: 'preview', readback: true }, { renderIntent: 'preview', png: true },
    { renderIntent: 'preview', exportFormat: 'png' }, { renderIntent: 'preview', exportRegion: {} },
    { renderIntent: 'preview', pixelPreview: 1 }, { renderIntent: 'preview', rasterProfile: 'figmaSoftware' }])
    expect(gestureRasterScale(view, 2, 800, 600, { ...gestureRequest, request })).toBeUndefined()
  for (const policy of [createRenderPolicy(false), createRenderPolicy(true, false, false, false, true, true),
    createRenderPolicy(false, true, false, false, true, true), createRenderPolicy(false, false, false, false, false, true)])
    expect(gestureRasterScale(view, 2, 800, 600, { ...gestureRequest, policy })).toBeUndefined()
  for (const chrome of [{ grid: true }, { checkerboard: true }])
    expect(gestureRasterScale(view, 2, 800, 600, { ...gestureRequest, ...chrome })).toBeUndefined()
})

test('gesture headroom falls back instead of raising limits, undersampling or shifting far-world coordinates', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  expect(gestureRasterScale({ x: 0, y: 0, zoom: .51 }, 2, 3200, 2000, gestureRequest)).toBeUndefined()
  expect(gestureRasterScale({ x: -5e7, y: 0, zoom: 1 }, 2, 800, 600, gestureRequest)).toBeUndefined()
  for (const zoom of [0, -1, NaN, Infinity, 1e-12, 33, 65, Number.MAX_VALUE])
    expect(gestureRasterScale({ x: 0, y: 0, zoom }, 2, 800, 600, gestureRequest)).toBeUndefined()
  for (const [dpr, width, height] of [[0, 800, 600], [Infinity, 800, 600], [2, -1, 600], [2, 800, NaN]])
    expect(gestureRasterScale({ x: 0, y: 0, zoom: 1 }, dpr, width, height, gestureRequest)).toBeUndefined()
})

test('gesture captures use fixed 128-pixel world cells and cover every current viewport at the admitted density', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  for (const dpr of [1, 1.25, 2, 3]) for (const zoom of [.025, .51, 1.01, 8, 16]) {
    const view = { x: -120.125, y: 87.375, zoom }, width = 640, height = 480
    const scale = gestureRasterScale(view, dpr, width, height, gestureRequest)!
    const capture = gestureViewportCapture(view, dpr, width, height, scale)!
    expect(capture).toBeDefined()
    const { tile, camera } = capture
    expect(Math.abs(tile.x % 128)).toBe(0); expect(Math.abs(tile.y % 128)).toBe(0)
    expect(tile.w).toBe(Math.ceil((width * dpr * Math.SQRT2 + 128) / 128) * 128)
    expect(tile.h).toBe(Math.ceil((height * dpr * Math.SQRT2 + 128) / 128) * 128)
    expect(tile.w * tile.h).toBeLessThanOrEqual(8_388_608)
    expect(camera).toEqual({ x: -tile.x, y: -tile.y, zoom: scale })
    const left = -view.x / zoom * scale, top = -view.y / zoom * scale
    const right = (width - view.x) / zoom * scale, bottom = (height - view.y) / zoom * scale
    expect(left).toBeGreaterThanOrEqual(tile.x); expect(top).toBeGreaterThanOrEqual(tile.y)
    expect(right).toBeLessThanOrEqual(tile.x + tile.w); expect(bottom).toBeLessThanOrEqual(tile.y + tile.h)
  }
})

test('small inputs within a gesture rung and world cell reuse the exact capture camera and shape', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  const a = { x: -12, y: -20, zoom: .51 }, b = { x: -13, y: -21, zoom: .55 }
  const scale = gestureRasterScale(a, 2, 855, 888, gestureRequest)!
  expect(gestureRasterScale(b, 2, 855, 888, gestureRequest)).toBe(scale)
  const first = gestureViewportCapture(a, 2, 855, 888, scale)!
  const next = gestureViewportCapture(b, 2, 855, 888, scale)!
  expect(next).toEqual(first)
  expect(first.tile.w).toBe(2560); expect(first.tile.h).toBe(2688)
  expect(canvasRasterPhaseMatches(a, 2, scale, { x: 0, y: 0 })).toBe(false)
  expect(canvasRasterPhaseMatches(b, 2, scale, { x: 0, y: 0 })).toBe(false)
})

test('different density rungs retain the same physical target dimensions and preserve the world anchor', () => {
  vi.stubEnv('VITE_DESIGN_GESTURE_DENSITY_HEADROOM', '1')
  let dimensions: number[] | undefined
  for (const zoom of [.1, 1.01, 2.8, 8.1, 26.7]) {
    const view = { x: -128.375, y: 96.125, zoom }, dpr = 2
    const scale = gestureRasterScale(view, dpr, 855, 888, gestureRequest)!
    const capture = gestureViewportCapture(view, dpr, 855, 888, scale)!
    const size = [capture.tile.w, capture.tile.h]
    expect(dimensions ?? size).toEqual(size); dimensions = size
    // A world point uses the same scale before and after the local capture
    // translation; only the target origin changes. No PathMesh is modified.
    const point = { x: 17.25, y: -9.375 }
    expect(point.x * scale + capture.camera.x + capture.tile.x).toBeCloseTo(point.x * scale, 12)
    expect(point.y * scale + capture.camera.y + capture.tile.y).toBeCloseTo(point.y * scale, 12)
  }
})

test('capture origin crosses positive and negative world-cell boundaries without dropping visible edges', () => {
  for (const [x, expected] of [[-127.75, 0], [-128, 128], [-128.25, 128], [.25, -128], [128.25, -256]]) {
    const capture = gestureViewportCapture({ x, y: -.25, zoom: 1 }, 1, 256, 128, 1)!
    expect(capture.tile.x).toBe(expected)
    expect(capture.tile.x).toBeLessThanOrEqual(-x)
    expect(capture.tile.x + capture.tile.w).toBeGreaterThanOrEqual(256 - x)
  }
})

test('capture rejects oversized targets and unsafe coordinates without reducing density or expanding limits', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  expect(gestureViewportCapture(view, 2, 855, 888, 2.5)).toBeDefined()
  expect(gestureViewportCapture(view, 2, 2000, 2000, 2.5)).toBeUndefined() // >8 Mi pixels
  expect(gestureViewportCapture(view, 1, 6000, 1, 1)).toBeUndefined() // >8192 per side
  expect(gestureViewportCapture({ ...view, x: -3_999_900 }, 1, 256, 128, 1)).toBeUndefined() // padded target crosses limit
  for (const scale of [0, -1, NaN, Infinity, .999, 1.5, 129])
    expect(gestureViewportCapture(view, 1, 256, 128, scale)).toBeUndefined()
  for (const invalid of [{ ...view, zoom: 0 }, { ...view, zoom: 1e-308 }, { ...view, x: NaN }, { ...view, y: -5e7 }])
    expect(gestureViewportCapture(invalid, 1, 256, 128, 1)).toBeUndefined()
  for (const [dpr, width, height] of [[0, 256, 128], [Infinity, 256, 128], [1, 0, 128], [1, 256, -1], [1, Number.MAX_VALUE, 128]])
    expect(gestureViewportCapture(view, dpr, width, height, 1)).toBeUndefined()
})

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

test('same-density whole-device-pixel pan retains prior native phase through moving and settle plans', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const initial = { x: -1122.875 / dpr, y: -135.375 / dpr, zoom: .293650625 }
    const first = canvasRasterPlan(initial, dpr, 855, 836, { exactPhase: true })
    const previous = { view: initial, dpr, rasterScale: first.scale, samplingMode: first.mode }
    const view = { ...initial, x: (-1122.875 - 64) / dpr, y: (-135.375 + 746) / dpr }
    const preserve = preservesNativePanPhase(view, dpr, first.scale, false, previous)
    expect(preserve).toBe(true)
    const moving = canvasRasterPlan(view, dpr, 855, 836, { exactPhase: preserve })
    const settled = canvasRasterPlan(view, dpr, 855, 836, { exactPhase: true })
    expect(moving).toEqual(settled)
    expect(moving.phase).toEqual(first.phase)
    expect(canvasRasterPhaseMatches(view, dpr, moving.scale, moving.phase)).toBe(true)
    const bounds = { x: -view.x / view.zoom, y: -view.y / view.zoom, width: 855 / view.zoom, height: 836 / view.zoom }
    const movingKeys = planTiles(bounds, moving.scale, 256, moving.phase).map(tile => tile.key)
    const settledKeys = planTiles(bounds, settled.scale, 256, settled.phase).map(tile => tile.key)
    expect(movingKeys).toEqual(settledKeys)
    const oldMoving = canvasRasterPlan(view, dpr, 855, 836, { exactPhase: false })
    expect(oldMoving.phase).not.toEqual(settled.phase)
  }
})

test('phase retention refuses fractional motion, changed density/dpr and camera-dependent pixels', () => {
  const view = { x: .125, y: -.375, zoom: .3 }, dpr = 2, scale = .6
  const previous = { view, dpr, rasterScale: scale, samplingMode: 'native' }
  expect(preservesNativePanPhase({ ...view, x: view.x + .5 }, dpr, scale, false, previous)).toBe(true)
  for (const next of [{ ...view, x: view.x + .125 }, { ...view, y: view.y + .125 }, { ...view, zoom: .31 }, { ...view, x: NaN }])
    expect(preservesNativePanPhase(next, dpr, scale, false, previous)).toBe(false)
  expect(preservesNativePanPhase(view, 1, scale, false, previous)).toBe(false)
  expect(preservesNativePanPhase(view, dpr, scale * 2, false, previous)).toBe(false)
  expect(preservesNativePanPhase(view, dpr, scale, true, previous)).toBe(false)
  expect(preservesNativePanPhase(view, dpr, scale, false, { ...previous, samplingMode: 'density-cache' })).toBe(false)
  expect(preservesNativePanPhase(view, dpr, scale, false)).toBe(false)
})

test('large zoom reversal cannot borrow a high-density native pan certificate', () => {
  const view = { x: .125, y: -.375, zoom: 32 }, previous = { view, dpr: 2, rasterScale: 64, samplingMode: 'native' }
  expect(preservesNativePanPhase({ ...view, zoom: .293650625 }, 2, .58730125, false, previous)).toBe(false)
})
test('near-integral movement is not rounded into native phase compatibility', () => {
  const view = { x: -.125, y: -.375, zoom: 32 }, previous = { view, dpr: 2, rasterScale: 64, samplingMode: 'native' }
  for (const delta of [1 + 1e-12, 1 - 1e-12, .99999999])
    expect(preservesNativePanPhase({ ...view, x: view.x + delta / 2 }, 2, 64, false, previous)).toBe(false)
})

test('logged reversal camera pair satisfies the strict geometry guard only when camera-independent', () => {
  const view = { x: -1122.9245768627336, y: -135.69254710438327, zoom: .29365062897155003 }
  const next = { x: -1154.9245768627336, y: 237.30745289561673, zoom: view.zoom }
  const previous = { view, dpr: 2, rasterScale: .5873012579431001, samplingMode: 'native' }
  expect(preservesNativePanPhase(next, 2, previous.rasterScale, false, previous)).toBe(true)
  expect(preservesNativePanPhase(next, 2, previous.rasterScale, true, previous)).toBe(false)
  const a = canvasRasterPlan(view, 2, 855, 836, { exactPhase: true })
  const b = canvasRasterPlan(next, 2, 855, 836, { exactPhase: true })
  expect(b.phase).toEqual(a.phase)
  expect(b.phase).toEqual({ x: .1508462745327961, y: .6149057912334683 })
})
