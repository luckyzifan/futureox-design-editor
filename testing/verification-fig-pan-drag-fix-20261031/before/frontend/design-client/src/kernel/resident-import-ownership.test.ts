import { expect, test, vi } from 'vitest'
import { settleResidentImport } from './resident-import-ownership'
function fixture() {
  const tile = { serial: 1, gpuTile: undefined as number | undefined }
  let resolve!: (id: number) => void, reject!: (error: unknown) => void
  const pending = new Promise<number>((yes, no) => { resolve = yes; reject = no })
  const state = { attached: true, session: {}, items: [tile] }
  const session = state.session, token = {}, importing = new Map([[tile.serial, token]])
  const release = vi.fn(), failed = vi.fn(), publish = vi.fn((id: number) => { tile.gpuTile = id })
  const done = settleResidentImport(pending,
    () => state.attached && state.session === session && state.items.includes(tile),
    publish, release, failed, () => { if (importing.get(tile.serial) === token) importing.delete(tile.serial) })
  return { tile, state, importing, resolve, reject, release, failed, publish, done }
}
test('a current imported texture is published once', async () => {
  const f = fixture(); f.resolve(12); await f.done
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(12)
  expect(f.release).not.toHaveBeenCalled()
  expect(f.importing.size).toBe(0)
})
test.each(['evicted', 'replaced', 'unmounted', 'new-session'] as const)('%s import completion releases exactly once', async mode => {
  const f = fixture(), replacement = { serial: 1, gpuTile: undefined as number | undefined }, replacementToken = {}
  if (mode === 'evicted') f.state.items = []
  if (mode === 'replaced') f.state.items = [replacement]
  if (mode === 'unmounted') f.state.attached = false
  if (mode === 'new-session') f.state.session = {}
  f.importing.set(1, replacementToken)
  f.resolve(13); await f.done
  expect(f.release).toHaveBeenCalledExactlyOnceWith(13)
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.tile.gpuTile).toBeUndefined()
  expect(replacement.gpuTile).toBeUndefined()
  expect(f.importing.get(1)).toBe(replacementToken)
})
test.each([true, false])('import rejection reports only to a current owner: %s', async current => {
  const f = fixture(); if (!current) f.state.items = []
  const error = Error('GPU display resident budget exceeded'); f.reject(error); await f.done
  expect(f.failed).toHaveBeenCalledTimes(Number(current))
  expect(f.release).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.importing.size).toBe(0)
})
