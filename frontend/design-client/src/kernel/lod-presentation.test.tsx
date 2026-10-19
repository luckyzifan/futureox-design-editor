import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { blank } from '../model'
import { ProgressiveSurfaceImpl as ProgressiveSurface } from './ProgressiveSurface'
import { lodBucketScale, exactBucketScale } from './tile-cache'

/** The TS mirror must track the kernel export bit-for-bit across the whole
 * bucket table, including the halving tail below 0.1. */
test('lodBucketScale matches the wasm kernel export', async () => {
  const { initializeKernelModule } = await import('./module')
  const wasm = new Uint8Array(
    await readFile(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)),
  )
  await initializeKernelModule(wasm)
  const { lod_bucket_scale } = await import('../generated/design-kernel/design_kernel')
  const samples: number[] = []
  for (let i = 1; i <= 500; i++) samples.push(i / 100)
  for (const v of [0.099, 0.05, 0.02, 0.011, 0.003, 1.999, 2.001, 4, 8]) samples.push(v)
  for (const scale of samples)
    expect(lodBucketScale(scale)).toBe(lod_bucket_scale(scale))
})

/** The exact mipmap ladder mirror: pinned 0.1/0.25/0.5/1/2 rungs with
 * power-of-two steps above 2 (level [5] pinned deterministically). */
test('exactBucketScale matches the wasm kernel export', async () => {
  const { initializeKernelModule } = await import('./module')
  const wasm = new Uint8Array(
    await readFile(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)),
  )
  await initializeKernelModule(wasm)
  const { exact_bucket_scale } = await import('../generated/design-kernel/design_kernel')
  const samples: number[] = []
  for (let i = 1; i <= 900; i++) samples.push(i / 100)
  for (const v of [0.001, 0.05, 0.0999, 0.1, 0.1001, 1.999, 2, 2.001, 3.999, 4, 7.9, 64]) samples.push(v)
  for (const scale of samples)
    expect(exactBucketScale(scale)).toBe(exact_bucket_scale(scale))
})

test('exactBucketScale pins the ladder from above so in-bucket zooms share tiles', () => {
  expect(exactBucketScale(0.05)).toBe(0.1)
  expect(exactBucketScale(0.15)).toBe(0.25)
  expect(exactBucketScale(0.75)).toBe(1)
  expect(exactBucketScale(1.5)).toBe(2)
  expect(exactBucketScale(2.5)).toBe(4)
  // Never below the requested scale; the over-render bound holds above the
  // [0] rung (below 0.1 Sketch reuses level [0] for every smaller zoom, so the
  // upscale factor is intentionally unbounded there).
  for (let i = 1; i <= 900; i++) {
    const scale = i / 100
    const bucket = exactBucketScale(scale)
    expect(bucket).toBeGreaterThanOrEqual(scale)
    if (scale > 0.1)
      expect(bucket / scale).toBeLessThanOrEqual(scale <= 0.25 ? 2.5 : 2)
  }
})

test('lodBucketScale never exceeds the requested scale and engages only below 2x', () => {
  for (let i = 1; i <= 600; i++) {
    const scale = i / 100
    expect(lodBucketScale(scale)).toBeLessThanOrEqual(scale)
  }
  expect(lodBucketScale(3.7)).toBe(3.7)
  expect(lodBucketScale(2)).toBe(1)
  expect(lodBucketScale(1)).toBe(0.5)
})

// Execute the private Tile component's render with a LOD tile and verify the
// placement geometry + z-order + data attributes without workers or a GPU.
function renderLodTile(zoom: number, detailLevel: number, view: { x: number; y: number }, dpr: number, requested = view) {
  const doc = blank()
  const tile = {
    key: '0.25:0:0:3:4', revision: 1, serial: 1, x: 3 * 258, y: 4 * 258,
    width: 258, height: 258, zoom, backend: 'webgpu',
    bytes: new Uint8Array(4), lod: true as const, document: doc,
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previous = internals.H
  const baseHooks = {
    useState(init: any) {
      const value = typeof init === 'function' ? init() : init
      return [value instanceof Map ? new Map([[tile.key, tile]]) : value, vi.fn()]
    },
    useRef(value: any) { return { current: value instanceof Set ? new Set([tile.key]) : value } },
    useMemo(fn: () => unknown) { return fn() },
    useSyncExternalStore(_: unknown, read: () => unknown) { return read() },
    useEffect() {}, useLayoutEffect() {},
  }
  let element: any
  try {
    internals.H = baseHooks
    const tree = ProgressiveSurface({
      document: doc, pageId: doc.pages[0].id, width: 1024, height: 1024,
      view: { ...view, zoom: detailLevel / dpr }, grid: false, backend: 'webgpu',
      requestedView: { ...requested, zoom: detailLevel / dpr },
      onFallback: vi.fn(),
    })
    const tiles = tree.props.children.find((child: any) => child?.props?.className === 'kernel-tiles')
    const lodTile = tiles.props.children[0]
    expect(lodTile.props.tile.lod).toBe(true)
    const ratio = detailLevel / zoom
    const expected = {
      // Fractional device placement: the camera offset resolves as compositor
      // subpixels instead of snapping the coarse layer to integer pixels.
      left: (tile.x * ratio + requested.x * dpr) / dpr,
      top: (tile.y * ratio + requested.y * dpr) / dpr,
      width: (tile.width * ratio) / dpr,
      height: (tile.height * ratio) / dpr,
    }
    let screenPlacement = lodTile.props.placement
    if (lodTile.props.active) {
      const [, x, y, scale] = /translate\((.*?)px,(.*?)px\) scale\((.*?)\)/.exec(tiles.props.style.transform)!
      const child = lodTile.props.placement
      const actual = { left: child.left * Number(scale) + Number(x), top: child.top * Number(scale) + Number(y),
        width: child.width * Number(scale), height: child.height * Number(scale) }
      screenPlacement = actual
      for (const key of Object.keys(expected))
        expect(actual[key as keyof typeof actual]).toBeCloseTo(expected[key as keyof typeof expected], 10)
    }
    return { ...lodTile, screenPlacement }
  } finally { internals.H = previous }
}

beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  vi.stubGlobal('document', { createElement: () => ({}) })
})
afterEach(() => vi.unstubAllGlobals())

test('LOD tiles place from the requested camera, upscaled and beneath exact tiles', () => {
  // detailLevel 0.75 (zoom 0.375 @ dpr 2) falls into the 0.5 bucket.
  const element = renderLodTile(0.5, 0.75, { x: 11.25, y: -7.5 }, 2)
  expect(element).toBeTruthy()
})

test('cached LOD tiles outside the viewport do not remain active', () => {
  // This old tile is outside the viewport after zooming in to 1.75 density.
  const element = renderLodTile(0.5, 1.75, { x: 0, y: 0 }, 2)
  expect(element.props.active).toBe(false)
})

test('a pending exact camera cannot hold the coarse preview at the previous pointer position', () => {
  const previous = renderLodTile(0.5, 0.75, { x: 10, y: 20 }, 2)
  const moving = renderLodTile(0.5, 0.75, { x: 10, y: 20 }, 2, { x: 110, y: 60 })
  expect(moving.screenPlacement.left - previous.screenPlacement.left).toBe(100)
  expect(moving.screenPlacement.top - previous.screenPlacement.top).toBe(40)
  expect(moving.props.placement).toEqual(previous.props.placement)
  expect(moving.props.active).toBe(true)
})
