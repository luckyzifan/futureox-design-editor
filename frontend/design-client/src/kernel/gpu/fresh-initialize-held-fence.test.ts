import { expect, test } from 'vitest'
import { deviceBoundary, startCreate, nextTurn, expectHeld, expectBefore, expectLostError,
  finish, expectNextFresh } from './fresh-initialize-boundary'

for (const mode of ['off', 'ordinary', 'throwing'] as const) {
  test(`fresh held final fence rejects observed loss diagnostics=${mode}`, async () => {
    const boundary = deviceBoundary(mode), pending = startCreate(boundary)
    try {
      await expectHeld(boundary, pending)
      boundary.resolveLoss(); await nextTurn()
      // No public owner/dispose exists yet and the final fence is still held.
      // Destroying the initialized blank texture witnesses the real loss
      // callback's releaseLostResources path even with diagnostics OFF.
      expect(pending.settled()).toBe(false)
      expect(boundary.fenceState()).toBe(0)
      expect(boundary.counts.deviceDestroy).toBe(0)
      expect(boundary.counts.textureDestroy).toBeGreaterThan(0)
      if (mode === 'off') expect(boundary.counts.sinkCalls).toBe(0)
      else expect(boundary.counts.callbackEvents).toBe(1)
      if (mode === 'throwing') expect(boundary.counts.sinkThrows).toBeGreaterThan(0)
      boundary.fulfillFence(); await nextTurn()
      expect(boundary.fenceState()).toBe(1)
      expectBefore(boundary, 'loss-resolved', 'texture-destroy')
      expectBefore(boundary, 'texture-destroy', 'fence-fulfilled')
      expect(pending.settled()).toBe(true)
      const outcome = await pending.result, catchDestroyed = boundary.counts.deviceDestroy === 1
      const returnedLost = outcome.ok && outcome.value.stats().deviceLost === true
      // Preserve teardown/next-fresh controls even on an expected OLD failure.
      await finish(boundary); await expectNextFresh(boundary)
      expect(outcome.ok, 'FRESH_INITIALIZE_RETURNED_TERMINAL_OWNER').toBe(false)
      expect(returnedLost).toBe(false)
      expectLostError(outcome)
      expect(catchDestroyed, 'FRESH_INITIALIZE_CATCH_MUST_DESTROY_WITHOUT_PARK').toBe(true)
      expectBefore(boundary, 'fence-fulfilled', 'public-rejected')
    } finally { await finish(boundary) }
  })
}
