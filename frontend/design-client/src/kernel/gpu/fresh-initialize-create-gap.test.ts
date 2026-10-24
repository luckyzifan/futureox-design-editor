import { expect, test } from 'vitest'
import { deviceBoundary, startCreate, nextTurn, expectHeld, expectBefore, expectLostError,
  finish, expectNextFresh } from './fresh-initialize-boundary'

test('fresh create rejects loss in initialize resolution microtask gap', async () => {
  const boundary = deviceBoundary('gap-loss'), pending = startCreate(boundary)
  try {
    await expectHeld(boundary, pending)
    boundary.fulfillFence(); await nextTurn()
    expect(pending.settled()).toBe(true)
    expect(boundary.fenceState()).toBe(1)
    expect(boundary.counts.gapAnchors).toBe(1); expect(boundary.counts.gapJobs).toBe(1)
    expect(boundary.counts.callbackEvents).toBe(1)
    expectBefore(boundary, 'fence-fulfilled', 'gap-anchor')
    expectBefore(boundary, 'gap-anchor', 'gap-job')
    expectBefore(boundary, 'gap-job', 'loss-callback-event')
    expectBefore(boundary, 'loss-callback-event', 'texture-destroy')
    const outcome = await pending.result, catchDestroyed = boundary.counts.deviceDestroy === 1
    // Both old and initialize-only mutant should reach this genuine callback
    // before the public outcome; only the two-guard candidate should reject.
    expectBefore(boundary, 'texture-destroy', outcome.ok ? 'public-fulfilled' : 'public-rejected')
    await finish(boundary); await expectNextFresh(boundary)
    expect(outcome.ok, 'FRESH_CREATE_RETURNED_TERMINAL_OWNER_AFTER_INITIALIZE').toBe(false)
    expectLostError(outcome)
    expect(catchDestroyed, 'FRESH_CREATE_CATCH_MUST_DESTROY_WITHOUT_PARK').toBe(true)
  } finally { await finish(boundary) }
})

test('fresh create gap timing fixture without loss still succeeds', async () => {
  const boundary = deviceBoundary('gap-no-loss'), pending = startCreate(boundary)
  try {
    await expectHeld(boundary, pending)
    boundary.fulfillFence(); await nextTurn()
    expect(pending.settled()).toBe(true)
    expect(boundary.counts.gapAnchors).toBe(1); expect(boundary.counts.gapJobs).toBe(1)
    expect(boundary.counts.callbackEvents).toBe(0)
    expect(boundary.lossResolved()).toBe(false)
    expect(boundary.counts.textureDestroy).toBe(0); expect(boundary.counts.deviceDestroy).toBe(0)
    const outcome = await pending.result
    expect(outcome.ok, 'NO_LOSS_GAP_FIXTURE_MUST_SUCCEED').toBe(true)
    if (outcome.ok) expect(outcome.value.stats().deviceLost).toBe(false)
    expectBefore(boundary, 'gap-anchor', 'gap-job')
    expectBefore(boundary, 'gap-job', 'public-fulfilled')
    await finish(boundary); await expectNextFresh(boundary)
  } finally { await finish(boundary) }
})
