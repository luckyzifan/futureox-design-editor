import { expect, test, vi } from 'vitest'
import { loadKernelResources } from './kernel-resources'

test('font download starts while WASM is unresolved, and boot waits for both', async () => {
  let complete!: () => void
  const wasm = new Promise<void>(resolve => complete = resolve)
  const fetchFont = vi.fn(async () => new Response(new Uint8Array([7, 9, 11])))
  let ready = false
  const boot = loadKernelResources(() => wasm, fetchFont).then(font => { ready = true; return font })
  expect(fetchFont).toHaveBeenCalledWith('/fonts/NotoSansSC.ttf')
  await Promise.resolve(); expect(ready).toBe(false)
  complete(); expect(await boot).toEqual(new Uint8Array([7, 9, 11]))
})

test('missing font or failed WASM remains a visible initialization failure', async () => {
  await expect(loadKernelResources(async () => {}, async () => new Response('', { status: 404 })))
    .rejects.toThrow('无法载入矢量字形字体')
  await expect(loadKernelResources(async () => { throw Error('bad wasm') }, async () => new Response('font')))
    .rejects.toThrow('bad wasm')
})
