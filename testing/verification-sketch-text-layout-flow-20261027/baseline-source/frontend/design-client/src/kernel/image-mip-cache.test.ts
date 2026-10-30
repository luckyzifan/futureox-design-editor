import { expect, test, vi } from 'vitest'

// The persistent cache module must degrade silently when storage or the wasm
// asset is unavailable: keys turn undefined instead of keying unsafely.
vi.stubGlobal('indexedDB', undefined)
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no asset host'))))

test('imageCacheKey returns undefined when the kernel build digest is unavailable', async () => {
  const { imageCacheKey } = await import('./image-mip-cache')
  expect(await imageCacheKey('data:image/png;base64,AAA', 'byte', '')).toBeUndefined()
})

test('readCachedImage and writeCachedImage never throw without indexedDB', async () => {
  const { readCachedImage, writeCachedImage } = await import('./image-mip-cache')
  expect(await readCachedImage('k')).toBeUndefined()
  expect(() =>
    writeCachedImage('k', { width: 2, height: 2, data: new Uint8Array(16) }),
  ).not.toThrow()
})

test('keys bind variant and color settings distinctly', async () => {
  // Re-import with a working fetch/crypto to exercise key construction.
  vi.unstubAllGlobals()
  const wasm = new Uint8Array(32)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(wasm.buffer) })))
  vi.stubGlobal('crypto', { subtle: { digest: async (_a: string, b: BufferSource) => b } })
  vi.resetModules()
  const { imageCacheKey } = await import('./image-mip-cache')
  const a = await imageCacheKey('data:image/png;base64,AAA', 'byte', '')
  const b = await imageCacheKey('data:image/png;base64,AAA', 'linear', '')
  const c = await imageCacheKey('data:image/png;base64,AAA', 'byte', '{"documentSpace":"srgb"}')
  const d = await imageCacheKey('data:image/png;base64,BBB', 'byte', '')
  expect(a).toBeTruthy()
  expect(new Set([a, b, c, d]).size).toBe(4)
})
