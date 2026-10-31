import { expect, test, vi } from 'vitest'
import { recoverPreviewBudget, isRecoverablePreviewBudget } from './preview-budget-recovery'

function fixture() {
  const abort = vi.fn(async () => {})
  const renderer = { driver: { lost: false, abortFrameAndReleaseFilterScratch: abort },
    abortFrameAndReleaseFilterScratch: vi.fn(async () => { await abort() }), dispose: vi.fn() }
  return { renderer, invalidate: vi.fn() }
}

test('classification cannot relabel device loss as a preview-budget retry', () => {
  expect(isRecoverablePreviewBudget(Error('GPU 表面内存预算超限'))).toBe(true)
  expect(isRecoverablePreviewBudget(Error('GPU 表面内存预算超限'), true)).toBe(false)
  expect(isRecoverablePreviewBudget(Error('GPU surface budget exceeded; device lost'))).toBe(false)
})

test.each(['GPU 表面内存预算超限', 'GPU surface budget exceeded',
  'GPU analytic interval program budget exceeded', 'Scene path budget exceeded', 'Invalid GPU viewport', 'Invalid GPU tile viewport'])
('optional preview preserves the device and resident certificates after %s', async message => {
  const { renderer, invalidate } = fixture()
  expect(await recoverPreviewBudget(Error(message), renderer, invalidate)).toBe(true)
  expect(renderer.abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce()
  expect(renderer.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce()
  expect(invalidate).not.toHaveBeenCalled()
  expect(renderer.dispose).not.toHaveBeenCalled()
})

test('a new render cannot start before old submitted work has retired', async () => {
  const { renderer, invalidate } = fixture()
  let release!: () => void, completed = false
  renderer.abortFrameAndReleaseFilterScratch.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = recoverPreviewBudget(Error('GPU 表面内存预算超限'), renderer, invalidate).then(result => { completed = true; return result })
  await Promise.resolve()
  expect(completed).toBe(false)
  release()
  expect(await pending).toBe(true)
  expect(renderer.dispose).not.toHaveBeenCalled()
})

test.each(['GPU 表面内存预算超限; device lost', 'GPU device lost', 'GPU display resident budget exceeded',
  'GPU linear display budget exceeded', 'shader validation failed', 'PREVIEW_CANCELLED',
  'Unknown error: GPU 表面内存预算超限'])
('unrelated, display-owned, and lost-device failures retain ordinary recovery: %s', async message => {
  const { renderer, invalidate } = fixture()
  expect(await recoverPreviewBudget(Error(message), renderer, invalidate)).toBe(false)
  expect(renderer.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
  expect(invalidate).not.toHaveBeenCalled()
})

test('unsupported drivers and an absent renderer cannot claim encoder recovery', async () => {
  const invalidate = vi.fn(), renderer = { driver: {}, abortFrameAndReleaseFilterScratch: vi.fn(), dispose: vi.fn() }
  expect(await recoverPreviewBudget(Error('GPU 表面内存预算超限'), renderer, invalidate)).toBe(false)
  expect(await recoverPreviewBudget(Error('GPU 表面内存预算超限'), undefined, invalidate)).toBe(false)
  expect(renderer.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
})

test('abort failure revokes and disposes the renderer instead of reusing a broken encoder', async () => {
  const { renderer, invalidate } = fixture()
  renderer.abortFrameAndReleaseFilterScratch.mockRejectedValue(Error('queue completion failed'))
  await expect(recoverPreviewBudget(Error('GPU 表面内存预算超限'), renderer, invalidate))
    .rejects.toThrow('GPU device preview recovery failed')
  expect(invalidate).toHaveBeenCalledOnce()
  expect(renderer.dispose).toHaveBeenCalledOnce()
})

test('device loss during retirement cannot be reported as preserved', async () => {
  const { renderer, invalidate } = fixture()
  renderer.abortFrameAndReleaseFilterScratch.mockImplementation(async () => { renderer.driver.lost = true })
  await expect(recoverPreviewBudget(Error('GPU 表面内存预算超限'), renderer, invalidate))
    .rejects.toThrow('GPU device preview recovery failed')
  expect(invalidate).toHaveBeenCalledOnce()
  expect(renderer.dispose).toHaveBeenCalledOnce()
})
