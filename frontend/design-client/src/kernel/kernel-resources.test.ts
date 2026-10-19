import { expect, test, vi } from 'vitest'
import { loadKernelResourcePair, loadKernelResources } from './kernel-resources'
import { InitializationGate, type InitializationLease } from './initialization'

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

test('bounded picking-font reader overlaps WASM but publication waits for both', async () => {
  let completeWasm!: () => void, completeFont!: (font: Uint8Array) => void
  const wasm = new Promise<void>(resolve => completeWasm = resolve)
  const font = new Promise<Uint8Array>(resolve => completeFont = resolve)
  const loadFont = vi.fn(() => font), publish = vi.fn()
  const gate = new InitializationGate()
  const work = vi.fn(async (lease: InitializationLease) => {
    const bytes = await loadKernelResourcePair(() => wasm, loadFont)
    lease.assertCurrent()
    lease.commit(() => publish(bytes))
  })
  const first = gate.run(work), second = gate.run(work)
  await Promise.resolve()
  expect(loadFont).toHaveBeenCalledOnce()
  completeWasm()
  await Promise.resolve()
  expect(publish).not.toHaveBeenCalled()
  const bytes = new Uint8Array([3, 7, 11])
  completeFont(bytes)
  await Promise.all([first, second])
  expect(work).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledExactlyOnceWith(bytes)
})

test('failed bounded font read aborts its lease and cannot publish after WASM completes', async () => {
  let completeWasm!: () => void
  const wasm = new Promise<void>(resolve => completeWasm = resolve)
  const publish = vi.fn(), failure = Error('font byte limit exceeded')
  let signal: AbortSignal | undefined
  const gate = new InitializationGate()
  await expect(gate.run(async lease => {
    signal = lease.signal
    await loadKernelResourcePair(() => wasm, async () => { throw failure })
    lease.assertCurrent()
    lease.commit(publish)
  })).rejects.toBe(failure)
  expect(signal?.aborted).toBe(true)
  completeWasm()
  await Promise.resolve()
  expect(publish).not.toHaveBeenCalled()
})
