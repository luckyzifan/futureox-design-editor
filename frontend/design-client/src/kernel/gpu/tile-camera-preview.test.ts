import { expect, test, vi } from 'vitest'
import { TileCompositor } from './tile-compositor'

function fixture() {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {}
  const gl = new Proxy({}, { get(_target, name: string) {
    if (name === 'MAX_TEXTURE_SIZE') return 3379
    if (name.toUpperCase() === name) return name
    return calls[name] ??= vi.fn((...args: unknown[]) => {
      if (name === 'getError') return 'NO_ERROR'
      if (name === 'getParameter') return 16384
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return true
      if (name === 'isContextLost') return false
      if (name.startsWith('create') || name === 'getUniformLocation') return { name, args }
    })
  } })
  const canvas = { width: 16, height: 16, dataset: {}, getContext: () => gl } as unknown as HTMLCanvasElement
  const compositor = new TileCompositor(canvas)
  const tile = { key: 'content', serial: 1, x: 0, y: 0, width: 16, height: 16, zoom: 1, bytes: new Uint8Array(16 * 16 * 4) }
  compositor.upload(tile)
  return { compositor, canvas, calls, item: { tile, active: true, layer: 1, gutter: 0 } }
}

test('bitmap navigation marks its uncovered strip opaque and separately publishes preview status', () => {
  const f = fixture(), view = { x: 4, y: 0, zoom: 1 }
  expect(f.compositor.draw([f.item], view, 16, 16, 1)).toBe(false)
  expect(f.compositor.draw([f.item], view, 16, 16, 1, false, true)).toBe(true)
  expect(f.compositor.preview).toBe(true)
  expect(f.canvas.dataset.previewPendingPixels).toBe('64')
  expect(f.calls.clearColor).toHaveBeenLastCalledWith(1, 1, 1, 1)
  expect(f.compositor.draw([f.item], { ...view, x: 0 }, 16, 16, 1, false, true)).toBe(true)
  expect(f.compositor.preview).toBe(false)
  expect(f.calls.clearColor).toHaveBeenLastCalledWith(0, 0, 0, 0)
})

test('a camera without remaining cached pixels can still present a marked pending background', () => {
  const f = fixture(); f.compositor.retain(new Set())
  expect(f.compositor.draw([], { x: 100, y: 0, zoom: 1 }, 16, 16, 1, false, true)).toBe(true)
  expect(f.canvas.dataset.previewPendingPixels).toBe('256')
  expect(f.calls.clearColor).toHaveBeenLastCalledWith(1, 1, 1, 1)
  expect(f.calls.drawArrays).toBeUndefined()
})

test('camera preview cannot fill holes under isolated compositing layers', () => {
  const f = fixture()
  expect(f.compositor.draw([{ ...f.item, blend: true }], { x: 4, y: 0, zoom: 1 }, 16, 16, 1, false, true)).toBe(false)
})
