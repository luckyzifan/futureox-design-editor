import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultColorSettings } from '../color'
import { blank } from '../model'
import { ProgressiveSurfaceImpl as ProgressiveSurface } from './ProgressiveSurface'

const display = vi.hoisted(() => ({ create: vi.fn(), present: vi.fn(), dispose: vi.fn() }))
vi.mock('./color-presenter', () => ({ ColorPresenter: { create: display.create } }))

// Execute the actual private Tile component's async effect, without workers,
// DOM rendering or a GPU. The browser gate separately verifies complete frames.
function renderTile(managed = true, linear = true) {
  const doc = blank()
  if (managed) doc.colorManagement = defaultColorSettings()
  const tile = {
    key: 'test-tile', revision: 1, serial: 1, x: 0, y: 0, width: 2, height: 1,
    zoom: 2, backend: 'webgpu', color: doc.colorManagement,
    bytes: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    linear: linear ? new Float32Array([2, 0, 0, 1, 0, 1.5, 0, 1]) : undefined,
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previous = internals.H
  const baseHooks = {
    useState(init: any) {
      const value = typeof init === 'function' ? init() : init
      return [value instanceof Map ? new Map([[tile.key, tile]]) : value, vi.fn()]
    },
    useRef(value: any) { return { current: value } },
    useMemo(fn: () => unknown) { return fn() },
    useSyncExternalStore(_: unknown, read: () => unknown) { return read() },
    useEffect() {}, useLayoutEffect() {},
  }
  let element: any
  try {
    internals.H = baseHooks
    const tree = ProgressiveSurface({
      document: doc, pageId: doc.pages[0].id, width: 100, height: 100,
      view: { x: 0, y: 0, zoom: 1 }, grid: false, backend: 'webgpu',
      onFallback: vi.fn(),
    })
    const tiles = tree.props.children.find((child: any) => child?.props?.className === 'kernel-tiles')
    element = tiles.props.children[0]
  } finally { internals.H = previous }

  const onReady = vi.fn(), onError = vi.fn(), putImageData = vi.fn()
  const getContext = vi.fn(() => ({ putImageData }))
  const effects: (() => (() => void) | undefined)[] = []
  try {
    internals.H = {
      ...baseHooks,
      useRef() { return { current: { width: 0, height: 0, getContext } } },
      useEffect(fn: () => (() => void) | undefined) { effects.push(fn) },
    }
    element.type.type({ ...element.props, onReady, onError, onGone: vi.fn() })
  } finally { internals.H = previous }
  const cleanups = effects.map((effect) => effect())
  const cleanup = () => cleanups.forEach((c) => c?.())
  return { onReady, onError, getContext, putImageData, cleanup, owner: element.props.owner }
}

beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  vi.stubGlobal('document', { createElement: () => ({}) })
  vi.stubGlobal('ImageData', class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  })
  display.create.mockReset()
  display.present.mockReset()
  display.dispose.mockReset()
  display.create.mockResolvedValue({
    fork: () => ({ present: display.present, dispose: display.dispose }), dispose: vi.fn(),
  })
})
afterEach(() => vi.unstubAllGlobals())

test('failed managed tile presentation never marks an SDR replacement ready', async () => {
  display.present.mockRejectedValue(new Error('injected display failure'))
  const tile = renderTile()
  await vi.waitFor(() => expect(tile.onError).toHaveBeenCalled())
  expect(tile.onReady).not.toHaveBeenCalled()
  expect(tile.getContext).not.toHaveBeenCalled()
  expect(display.dispose).toHaveBeenCalledOnce()
  tile.cleanup?.()
})

test('managed tile missing its float payload fails before any byte presentation', async () => {
  const tile = renderTile(true, false)
  await vi.waitFor(() => expect(tile.onError).toHaveBeenCalled())
  expect(tile.onReady).not.toHaveBeenCalled()
  expect(tile.getContext).not.toHaveBeenCalled()
  expect(display.create).not.toHaveBeenCalled()
  tile.cleanup?.()
})

test('SDR tile still presents original bytes and becomes ready without a GPU presenter', async () => {
  const tile = renderTile(false, false)
  await vi.waitFor(() => expect(tile.onReady).toHaveBeenCalledWith('test-tile', 1, false))
  expect(tile.onError).not.toHaveBeenCalled()
  expect(tile.putImageData).toHaveBeenCalledOnce()
  expect([...tile.putImageData.mock.calls[0][0].data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
  expect(display.create).not.toHaveBeenCalled()
  tile.cleanup?.()
})

test('a cancelled managed tile closes its presenter without committing a late result', async () => {
  let finish!: () => void
  display.present.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const tile = renderTile()
  await vi.waitFor(() => expect(display.present).toHaveBeenCalledOnce())
  tile.cleanup?.()
  finish()
  await Promise.resolve()
  expect(tile.onReady).not.toHaveBeenCalled()
  expect(tile.onError).not.toHaveBeenCalled()
  expect(tile.getContext).not.toHaveBeenCalled()
})

test('failed presenter creation is retired so a later request can acquire a fresh display', async () => {
  display.create.mockRejectedValueOnce(new Error('temporary adapter failure'))
  const tile = renderTile()
  await vi.waitFor(() => expect(tile.onError).toHaveBeenCalled())
  const later = await tile.owner.acquire({})
  expect(display.create).toHaveBeenCalledTimes(2)
  expect(later.present).toBe(display.present)
  later.dispose()
  tile.owner.dispose()
  tile.cleanup?.()
})
