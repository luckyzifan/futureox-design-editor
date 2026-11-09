import { expect, test, vi } from 'vitest'
import { ExactTileCache, compilationWitness } from './exact-tile-cache'
import { retireFailedTileRenderer, recoverFailedTileRenderer } from './tile-failure'

test('budget renderer retirement preserves independent CPU pixels and existing revocations', () => {
  const cache = new ExactTileCache<Uint8Array>(), witness = compilationWitness('actual-compiled-scene')
  const pixels = new Uint8Array([21, 42, 63, 255])
  cache.reserve(512); cache.set('untouched', witness, pixels, pixels.byteLength)
  cache.set('damaged', witness, pixels.slice(), pixels.byteLength)
  cache.revoke(value => value !== pixels)
  const bytes = cache.bytes, invalidate = vi.fn(() => cache.clear()), dispose = vi.fn()
  retireFailedTileRenderer(new Error('GPU 表面内存预算超限'), { driver: { lost: false }, dispose }, invalidate)
  expect(dispose).toHaveBeenCalledOnce(); expect(invalidate).not.toHaveBeenCalled()
  expect(cache.bytes).toBe(bytes)
  expect(cache.certified('untouched')).toBe(pixels)
  expect(cache.certified('damaged')).toBeUndefined()
  // The retired renderer cannot create a new witness or repair a revoked one.
  expect(cache.get('damaged', compilationWitness('changed-scene'))).toBeUndefined()
})

test.each([
  { error: 'GPU 表面内存预算超限; device lost', lost: false },
  { error: 'GPU 表面内存预算超限', lost: true },
  { error: 'GPU 设备已丢失', lost: false },
  { error: 'shader validation failed', lost: false },
  { error: 'Invalid GPU viewport', lost: false },
  { error: 'Unknown error: GPU 表面内存预算超限', lost: false },
])('loss and untrusted failures invalidate retained pixels: $error / $lost', ({ error, lost }) => {
  const cache = new ExactTileCache<Uint8Array>(), pixels = new Uint8Array([1, 2, 3, 255])
  cache.set('old', compilationWitness('scene'), pixels, pixels.byteLength)
  const invalidate = vi.fn(() => cache.clear()), dispose = vi.fn()
  retireFailedTileRenderer(new Error(error), { driver: { lost }, dispose }, invalidate)
  expect(invalidate).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce()
  expect(cache.size).toBe(0); expect(cache.certified('old')).toBeUndefined()
})

test('budget fault injection before renderer creation preserves the current namespace payloads', () => {
  const invalidate = vi.fn()
  retireFailedTileRenderer(new Error('GPU 表面内存预算超限 (explicit first-attempt test injection)'), undefined, invalidate)
  expect(invalidate).not.toHaveBeenCalled()
})
test.each(['GPU 表面内存预算超限','GPU surface budget exceeded'])('resident allocation recovery (%s) waits without destroying displayed textures',async(message)=>{
  let complete!:()=>void
  const abortFrameAndReleaseFilterScratch=vi.fn(()=>new Promise<void>(resolve=>{complete=resolve}))
  const dispose=vi.fn(),invalidate=vi.fn(),renderer={driver:{lost:false,abortFrameAndReleaseFilterScratch},dispose}
  const recovered=recoverFailedTileRenderer(Error(message),renderer,invalidate,true)
  expect(dispose).not.toHaveBeenCalled();expect(invalidate).not.toHaveBeenCalled()
  complete();expect(await recovered).toBe(true)
  expect(abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce()
  expect(dispose).not.toHaveBeenCalled()
  expect(await recoverFailedTileRenderer(Error('device lost'),renderer,invalidate,true)).toBe(false)
  expect(dispose).toHaveBeenCalledOnce();expect(invalidate).toHaveBeenCalledOnce()
})
test('failed resident frame retirement surfaces the failure and revokes the device',async()=>{
  const dispose=vi.fn(),invalidate=vi.fn()
  await expect(recoverFailedTileRenderer(Error('GPU 表面内存预算超限'),{driver:{
    abortFrameAndReleaseFilterScratch:async()=>{throw Error('lost while retiring')}
  },dispose},invalidate,true)).rejects.toThrow(/recovery failed/)
  expect(dispose).toHaveBeenCalledOnce();expect(invalidate).toHaveBeenCalledOnce()
})
