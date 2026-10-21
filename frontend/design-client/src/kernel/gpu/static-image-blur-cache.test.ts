import { expect, test } from 'vitest'
import { StaticImageBlurCache, STATIC_IMAGE_BLUR_CACHE_BYTES, largeStaticImageBlurWindow } from './static-image-blur-cache'
import type { Rect, Texture } from './types'
import { TILE_SIDE } from '../tile-cache'

const rect: Rect = { x: 10, y: 20, w: 8, h: 8 }
const input: Rect = { x: -30, y: -20, w: 88, h: 88 }
const plane = (r = rect) => ({ rect: r, texture: { width: r.w, height: r.h, bytes: r.w * r.h * 16, resource: {} } as Texture })
function fixture() {
  const released: Texture[] = [], proofs = new WeakMap<Texture, object>()
  const cache = new StaticImageBlurCache(p => released.push(p.texture), texture => proofs.get(texture))
  const image = plane().texture, proof = Object.freeze({})
  proofs.set(image, proof)
  const source = cache.registerUpload(image, proof, 'actual-upload', 'color/adjust')!
  cache.begin('zoom/policy', 1)
  return { cache, released, proofs, source, image, proof }
}
test('a successful frame and a completed GPU epoch are both required for exact-window reuse', () => {
  const f = fixture(), p = plane()
  expect(f.cache.stage(f.source, 'mapping', input, p, 2)).toBe(true)
  expect(f.cache.borrow(f.source, 'mapping', input, rect, 1, 3)).toBeUndefined()
  f.cache.finish(true, 1)
  expect(f.cache.borrow(f.source, 'mapping', input, rect, 1, 3)).toBeUndefined()
  const hit = f.cache.borrow(f.source, 'mapping', input, rect, 2, 3)!
  expect(hit.plane.texture).toBe(p.texture); hit.release()
  expect(f.cache.borrow({} as any, 'mapping', input, rect, 2, 3)).toBeUndefined()
  expect(f.cache.borrow(f.source, 'other', input, rect, 2, 3)).toBeUndefined()
  expect(f.cache.borrow(f.source, 'mapping', { ...input, w: 89 }, rect, 2, 3)).toBeUndefined()
  expect(f.cache.borrow(f.source, 'mapping', input, { ...rect, x: 11 }, 2, 3)).toBeUndefined()
})
test('a cleared borrowed result and its source stay pinned until readers and their submitted epoch retire', () => {
  const f = fixture(), p = plane()
  f.cache.stage(f.source, 'mapping', input, p, 2); f.cache.finish(true, 2)
  const hit = f.cache.borrow(f.source, 'mapping', input, rect, 2, 3)!
  f.cache.clear(); f.cache.collect(3)
  expect(f.cache.has(p.texture)).toBe(true); expect(f.cache.pinsSource(f.image)).toBe(true)
  expect(f.released).toEqual([])
  hit.release(); hit.release()
  expect(f.released).toEqual([p.texture]); expect(f.cache.pinsSource(f.image)).toBe(false)
  expect(f.cache.bytes).toBe(0)
})
test('returning a borrow before its fence cannot recycle the plane', () => {
  const f = fixture(), p = plane()
  f.cache.stage(f.source, 'mapping', input, p, 2); f.cache.finish(true, 2)
  const hit = f.cache.borrow(f.source, 'mapping', input, rect, 2, 4)!
  f.cache.clear(); hit.release(); f.cache.collect(3)
  expect(f.released).toEqual([])
  f.cache.collect(4); expect(f.released).toEqual([p.texture])
})
test('unknown upload proofs, copied textures, changed resource/shape and revoked writers cannot authorize a hit', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.proofs.delete(f.image) },
    (f: ReturnType<typeof fixture>) => { f.image.resource = {} },
    (f: ReturnType<typeof fixture>) => { f.image.width++ },
    (f: ReturnType<typeof fixture>) => { f.image.height++ },
  ]) {
    const f = fixture(), p = plane()
    expect(f.cache.registerUpload(plane().texture, f.proof, 'actual-upload', 'color/adjust')).toBeUndefined()
    expect(f.cache.source({ ...f.image }, 'actual-upload', 'color/adjust')).toBeUndefined()
    f.cache.stage(f.source, 'mapping', input, p, 2); f.cache.finish(true, 2)
    change(f); f.image.finitePixels = true
    expect(f.cache.source(f.image, 'actual-upload', 'color/adjust')).toBeUndefined()
    expect(f.cache.borrow(f.source, 'mapping', input, rect, 2, 3)).toBeUndefined()
    expect(f.released).toEqual([p.texture])
  }
})
test('one-slot and 17 MiB limits include pending/retired storage', () => {
  const f = fixture()
  const huge = plane({ x: 0, y: 0, w: 1088, h: 1024 })
  expect(huge.texture.bytes).toBe(STATIC_IMAGE_BLUR_CACHE_BYTES)
  expect(f.cache.stage(f.source, 'huge', huge.rect, huge, 3)).toBe(true)
  expect(f.cache.stage(f.source, 'another', input, plane(), 3)).toBe(false)
  expect(f.cache.bytes).toBe(STATIC_IMAGE_BLUR_CACHE_BYTES)
  f.cache.finish(true, 3)
  expect(f.cache.stage(f.source, 'another', input, plane(), 4)).toBe(true)
  expect(f.cache.count).toBe(1)
  expect(f.cache.bytes).toBe(1024)
})
test('large-window admission keeps a complete padded tile and rejects narrow edges or excess storage', () => {
  const native = { x: 1275, y: 874, w: TILE_SIDE + 2, h: TILE_SIDE + 2 }
  expect(largeStaticImageBlurWindow({ x: 1275, y: 874, w: 1032, h: 1032 }, native)).toBe(true)
  expect(largeStaticImageBlurWindow({ x: 0, y: 0, w: 1088, h: 1024 }, native)).toBe(true)
  for (const r of [{ w: 514, h: 1032 }, { w: 686, h: 1032 }, { w: 1032, h: 134 },
    { w: 1089, h: 1024 }, { w: 1032.5, h: 1032 }, { w: Infinity, h: 1032 }, { w: -1032, h: 1032 }])
    expect(largeStaticImageBlurWindow({ x: 0, y: 0, ...r }, native)).toBe(false)
  // Near-full edge pieces still exceed the area heuristic; only the native
  // tile crop identifies them as partial, independently of request union size.
  expect(largeStaticImageBlurWindow({ x: 0, y: 0, w: 1026, h: 1032 }, { ...native, w: TILE_SIDE - 1 })).toBe(false)
  expect(largeStaticImageBlurWindow({ x: 0, y: 0, w: 1032, h: 1026 }, { ...native, h: TILE_SIDE - 1 })).toBe(false)
  expect(largeStaticImageBlurWindow({ x: 0, y: 0, w: 1032, h: 1032 })).toBe(false)
})
test('URI and small policy strings remain separate exact source bindings', () => {
  const f = fixture(), uri = 'data:image/png;base64,' + 'A'.repeat(100_000)
  const token = f.cache.registerUpload(f.image, f.proof, uri, 'complete-color/adjust-policy')
  expect(f.cache.source(f.image, uri, 'complete-color/adjust-policy')).toBe(token)
  expect(f.cache.source(f.image, uri.slice(0, -1) + 'B', 'complete-color/adjust-policy')).toBeUndefined()
  expect(f.cache.source(f.image, uri, 'different-working-color')).toBeUndefined()
})
test('failure and a new frame cannot accidentally publish abandoned work', () => {
  const f = fixture(), first = plane(), second = plane()
  f.cache.stage(f.source, 'failed', input, first, 2); f.cache.finish(false, 1)
  f.cache.begin('zoom/policy', 2); f.cache.finish(true, 2)
  expect(f.cache.borrow(f.source, 'failed', input, rect, 2, 3)).toBeUndefined()
  f.cache.stage(f.source, 'unfinished', input, second, 3)
  f.cache.begin('zoom/policy', 3); f.cache.finish(true, 3)
  expect(f.cache.borrow(f.source, 'unfinished', input, rect, 3, 4)).toBeUndefined()
  expect(f.released).toEqual([first.texture, second.texture])
})
test('pressure can return only unpublished current-frame work to the ordered pool', () => {
  const f = fixture(), p = plane()
  f.cache.stage(f.source, 'pending', input, p, 3)
  f.cache.discardPending(2); expect(f.released).toEqual([])
  f.cache.discardPending(3); expect(f.released).toEqual([p.texture])
  const ready = plane(); f.cache.stage(f.source, 'ready', input, ready, 4); f.cache.finish(true, 3)
  f.cache.discardPending(4); expect(f.cache.has(ready.texture)).toBe(true)
  f.cache.collect(4); f.cache.begin('different zoom', 4)
  expect(f.released).toEqual([p.texture, ready.texture])
})
test('malformed geometry, epochs and storage layouts keep ownership with the caller', () => {
  const f = fixture()
  for (const epoch of [undefined, 0, -1, 1.5, NaN]) expect(f.cache.stage(f.source, 'key', input, plane(), epoch)).toBe(false)
  const bad = plane(); bad.texture.bytes--
  expect(f.cache.stage(f.source, 'key', input, bad, 2)).toBe(false)
  expect(f.cache.stage(f.source, 'key', input, plane({ ...rect, x: 0.5 }), 2)).toBe(false)
  expect(f.cache.stage(f.source, 'key', rect, plane({ ...rect, x: 9 }), 2)).toBe(false)
  expect(f.released).toEqual([])
})
