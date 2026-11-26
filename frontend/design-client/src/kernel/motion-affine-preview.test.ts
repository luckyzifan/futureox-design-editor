import { afterEach, expect, test, vi } from 'vitest'
import { MotionAffineQuietWindow, motionAffineEligible, type MotionAffineAdmission } from './motion-affine-preview'

afterEach(() => vi.useRealTimers())

function admission(extra: Partial<MotionAffineAdmission> = {}): MotionAffineAdmission {
  return {
    enabled: true,
    coversDisplay: true,
    transforms: { 'node-1': [0, 1, -1, 0, 30, 20] },
    session: { native: true, affine: true, fixedWindow: true, stopped: false },
    scene: {},
    ...extra,
  }
}

test('a single-selection full-viewport rotation pose is admitted', () => {
  expect(motionAffineEligible(admission())).toBe(true)
})

test('default-off and every exact/explicit pose keep the native path', () => {
  expect(motionAffineEligible(admission({ enabled: false }))).toBe(false)
  // Terminal/release and quiet-window re-queues must render exact immediately.
  expect(motionAffineEligible(admission({ terminal: true }))).toBe(false)
  expect(motionAffineEligible(admission({ forceExact: true }))).toBe(false)
  expect(motionAffineEligible(admission({ coversDisplay: false }))).toBe(false)
})

test('resize and other non-affine or structural sessions are not covered', () => {
  // Resize is not an affine gesture: interaction-renderer only marks rotate and
  // scale residents affine, so a resize pose keeps the exact per-sample render.
  expect(motionAffineEligible(admission({ session: { ...admission().session, affine: false } }))).toBe(false)
  expect(motionAffineEligible(admission({ session: { ...admission().session, fixedWindow: false } }))).toBe(false)
  expect(motionAffineEligible(admission({ session: { ...admission().session, native: false } }))).toBe(false)
  expect(motionAffineEligible(admission({ transforms: { a: [1, 0, 0, 1, 0, 0], b: [1, 0, 0, 1, 1, 1] } }))).toBe(false)
  for (const scene of [{ interactionLocalFootprint: true }, { interactionFixedMask: true }, { displayFilters: true },
    { displayMaterialSource: true }, { displayImageSource: true }, { linearRetainedCapture: true },
    { resolve: true }, { presentation: true }, { softwareRaster: true }])
    expect(motionAffineEligible(admission({ scene }))).toBe(false)
  expect(motionAffineEligible(admission({ session: { ...admission().session, stopped: true } }))).toBe(false)
})

test('the quiet window fires once with the latest armed pose', () => {
  vi.useFakeTimers()
  const fired: { session: number; pose: string }[] = []
  const quiet = new MotionAffineQuietWindow<{ slot: number }, string>(80, (session, pose) => fired.push({ session: session.slot, pose }))
  quiet.arm({ slot: 7 }, 'first')
  vi.advanceTimersByTime(40)
  quiet.arm({ slot: 7 }, 'second')
  vi.advanceTimersByTime(79)
  expect(fired).toEqual([])
  vi.advanceTimersByTime(1)
  expect(fired).toEqual([{ session: 7, pose: 'second' }])
  expect(quiet.session).toBeUndefined()
  vi.advanceTimersByTime(200)
  expect(fired).toHaveLength(1)
})

test('cancelling the quiet window prevents an exact re-queue', () => {
  vi.useFakeTimers()
  const fire = vi.fn()
  const quiet = new MotionAffineQuietWindow<{ slot: number }, string>(80, fire)
  quiet.arm({ slot: 7 }, 'pose')
  quiet.cancel()
  vi.advanceTimersByTime(200)
  expect(fire).not.toHaveBeenCalled()
  quiet.arm({ slot: 7 }, 'pose')
  quiet.cancel({ slot: 8 })
  vi.advanceTimersByTime(200)
  expect(fire).toHaveBeenCalledTimes(1)
  quiet.cancel({ slot: 7 })
  vi.advanceTimersByTime(200)
  expect(fire).toHaveBeenCalledTimes(1)
})