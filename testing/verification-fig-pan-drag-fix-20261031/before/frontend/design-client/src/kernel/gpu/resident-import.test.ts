import { afterEach, expect, test, vi } from 'vitest'
import { PresenterPayloadLedger } from './presenter-payload-ledger'
import { ResidentPresenter } from './resident-presenter'
import { WebGpuDriver } from './webgpu'
afterEach(() => vi.unstubAllGlobals())
function fixture(failure?: 'budget' | 'copy') {
  const bitmap = { width: 16, height: 12, close: vi.fn() } as unknown as ImageBitmap
  const texture = {}, capture = vi.fn(() => {
    if (failure === 'budget') throw Error('GPU display resident budget exceeded')
    return { id: 42, texture }
  })
  const copy = vi.fn(() => { if (failure === 'copy') throw Error('copy rejected') })
  const presenter = Object.assign(Object.create(ResidentPresenter.prototype), {
    capture, release: vi.fn(), device: { queue: { copyExternalImageToTexture: copy } }, imports: 0,
  }) as ResidentPresenter
  return { bitmap, presenter, copy, texture }
}
test('successful bitmap import closes its input and retains its texture', () => {
  const f = fixture()
  expect(f.presenter.import(f.bitmap)).toBe(42)
  expect(f.bitmap.close).toHaveBeenCalledTimes(1)
  expect(f.presenter.release).not.toHaveBeenCalled()
  expect(f.copy).toHaveBeenCalledExactlyOnceWith({ source: f.bitmap },
    { texture: f.texture, premultipliedAlpha: true }, [16, 12])
})
test('budget rejection still closes the transferred bitmap exactly once', () => {
  const f = fixture('budget')
  expect(() => f.presenter.import(f.bitmap)).toThrow(/resident budget/)
  expect(f.bitmap.close).toHaveBeenCalledTimes(1)
  expect(f.copy).not.toHaveBeenCalled()
  expect(f.presenter.release).not.toHaveBeenCalled()
})
test('copy rejection releases the newly captured texture and closes the bitmap exactly once', () => {
  const f = fixture('copy')
  expect(() => f.presenter.import(f.bitmap)).toThrow(/copy rejected/)
  expect(f.bitmap.close).toHaveBeenCalledTimes(1)
  expect(f.presenter.release).toHaveBeenCalledExactlyOnceWith([42])
})

test('driver without a presenter still consumes the bitmap on handoff', () => {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap
  const driver = Object.create(WebGpuDriver.prototype) as WebGpuDriver
  expect(() => driver.importPresented(bitmap)).toThrow(/No resident display/)
  expect(bitmap.close).toHaveBeenCalledTimes(1)
})

test.each(['texture', 'view', 'bind'] as const)('capture %s failure preserves accounting and destroys only allocated texture', failure => {
  vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_DST: 4, COPY_SRC: 8 })
  const texture = { destroy: vi.fn(), createView: vi.fn(() => {
    if (failure === 'view') throw Error('view failure')
    return {}
  }) }
  const presenter = Object.assign(Object.create(ResidentPresenter.prototype), {
    disposed: false, bytes: 64, captures: 3, textures: new Map(), payload: new PresenterPayloadLedger(() => Promise.resolve(), 512*1024*1024), device: {
      createTexture: vi.fn(() => { if (failure === 'texture') throw Error('texture failure'); return texture }),
      createBindGroup: vi.fn(() => { throw Error('bind failure') }),
    },
  }) as ResidentPresenter
  const bitmap = { width: 16, height: 12, close: vi.fn() } as unknown as ImageBitmap
  expect(() => presenter.import(bitmap)).toThrow(`${failure} failure`)
  expect(texture.destroy).toHaveBeenCalledTimes(Number(failure !== 'texture'))
  expect(bitmap.close).toHaveBeenCalledTimes(1)
  expect(presenter.residentBytes).toBe(64)
  expect((presenter as any).captures).toBe(3)
  expect((presenter as any).textures.size).toBe(0)
})
