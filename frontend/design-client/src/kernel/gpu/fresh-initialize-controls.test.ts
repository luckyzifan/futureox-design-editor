import { expect, test } from 'vitest'
import { deviceBoundary, startCreate, nextTurn, expectHeld, expectBefore, finish,
  expectNextFresh } from './fresh-initialize-boundary'

for (const mode of ['off', 'throwing'] as const) {
  test(`fresh live fence succeeds diagnostics=${mode}`, async () => {
    const boundary = deviceBoundary(mode), pending = startCreate(boundary)
    try {
      await expectHeld(boundary, pending)
      boundary.fulfillFence(); await nextTurn()
      expect(pending.settled()).toBe(true)
      const outcome = await pending.result
      expect(outcome.ok, 'LIVE_INITIALIZATION_MUST_SUCCEED').toBe(true)
      if (outcome.ok) expect(outcome.value.stats().deviceLost).toBe(false)
      expect(boundary.lossResolved()).toBe(false)
      expect(boundary.counts.deviceDestroy).toBe(0); expect(boundary.counts.textureDestroy).toBe(0)
      expectBefore(boundary, 'fence-fulfilled', 'public-fulfilled')
      if (mode === 'throwing') expect(boundary.counts.sinkThrows).toBeGreaterThan(0)
      await finish(boundary); await expectNextFresh(boundary)
    } finally { await finish(boundary) }
  })
}

for (const mode of ['off', 'throwing'] as const) for (const observedLoss of [false, true]) {
  test(`fresh native fence rejection preserves identity loss=${observedLoss} diagnostics=${mode}`, async () => {
    const boundary = deviceBoundary(mode), pending = startCreate(boundary)
    const nativeError = new Error('FreshInitializeNativeFenceFailure')
    try {
      await expectHeld(boundary, pending)
      if (observedLoss) {
        boundary.resolveLoss(); await nextTurn()
        expect(boundary.counts.textureDestroy).toBeGreaterThan(0)
        expect(boundary.counts.deviceDestroy).toBe(0)
        expect(pending.settled()).toBe(false)
      } else expect(boundary.lossResolved()).toBe(false)
      boundary.rejectFence(nativeError); await nextTurn()
      expect(boundary.fenceState()).toBe(2)
      expect(pending.settled()).toBe(true)
      const outcome = await pending.result
      expect(outcome.ok, 'NATIVE_REJECTION_MUST_REJECT').toBe(false)
      expect(!outcome.ok && outcome.error === nativeError, 'NATIVE_REJECTION_IDENTITY_MUST_SURVIVE').toBe(true)
      expect(boundary.counts.deviceDestroy, 'NATIVE_REJECTION_CATCH_MUST_DESTROY').toBe(1)
      expectBefore(boundary, 'fence-rejected', 'public-rejected')
      if (observedLoss) expectBefore(boundary, 'texture-destroy', 'fence-rejected')
      if (mode === 'throwing') expect(boundary.counts.sinkThrows).toBeGreaterThan(0)
      await finish(boundary); await expectNextFresh(boundary)
    } finally { await finish(boundary) }
  })
}
