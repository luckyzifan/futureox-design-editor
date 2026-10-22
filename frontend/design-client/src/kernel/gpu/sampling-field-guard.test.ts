import { expect, test } from 'vitest'
import { samplingFieldOverGuard, isSamplingFieldOverGuardError } from './renderer'
import { image_sampling_axes_placed } from '../../generated/design-kernel/design_kernel'

// The kernel rejects dense grids over 4,194,304 pixels and axis proofs over
// 2,097,152 span entries. Oversize rects must route to the chunked regional
// path (3200% zoom regression), never fail the render request.
test('sampling field guard matches the kernel limits', () => {
  expect(samplingFieldOverGuard({ w: 2048, h: 2048 })).toBe(false)
  expect(samplingFieldOverGuard({ w: 2049, h: 2048 })).toBe(true)
  expect(samplingFieldOverGuard({ w: 2_097_153, h: 1 })).toBe(true)
  expect(samplingFieldOverGuard({ w: 2_097_152, h: 1 })).toBe(false)
})

test('kernel axes proof throws the oversize guard message the matcher expects', () => {
  const paint = JSON.stringify({ kind: 'image', color: '#ffffff', fit: 'cover' })
  let thrown: unknown
  try {
    image_sampling_axes_placed(
      JSON.stringify({ x: 0, y: 0, w: 2_500_000, h: 4 }),
      new Float64Array([1, 0, 0, 1, 0, 0]),
      new Float64Array([2_500_000, 4]),
      new Uint32Array([64, 64]),
      paint, 4, 0, new Int32Array([0, 0]))
  } catch (error) { thrown = error }
  expect(String(thrown)).toContain('exceeds 64 MiB')
  expect(isSamplingFieldOverGuardError(thrown)).toBe(true)
  expect(isSamplingFieldOverGuardError(new Error('GPU surface budget exceeded'))).toBe(false)
})
