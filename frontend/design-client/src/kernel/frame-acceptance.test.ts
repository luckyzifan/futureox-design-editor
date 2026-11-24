import { expect, test } from 'vitest'
import { frameHandoff } from './frame-handoff'
import { acceptFrameClarity, classifyFrameArrival, motionPartialSharpAllowed } from './frame-acceptance'

const camera = { x: -12.5, y: 4, zoom: 2 }
const live = {
  sampleRevision: 7,
  demandRevision: 7,
  sampleCamera: camera,
  demandCamera: camera,
  nativeDensity: true,
  nativePhase: true,
  coverage: 'full' as const,
  generation: 4,
  acceptedGeneration: 4,
}

test('screen ready requires revision, camera, density, phase and full coverage', () => {
  expect(acceptFrameClarity(live)).toMatchObject({ arrival: 'current', verdict: 'screen-ready', screenReady: true, partialSharp: false })
  expect(acceptFrameClarity({ ...live, nativeDensity: false })).toMatchObject({ verdict: 'preview', screenReady: false, partialSharp: false })
  expect(acceptFrameClarity({ ...live, nativePhase: false })).toMatchObject({ verdict: 'preview', screenReady: false, partialSharp: false })
  expect(acceptFrameClarity({ ...live, coverage: 'uncovered' })).toMatchObject({ verdict: 'preview', screenReady: false, partialSharp: false })
  expect(acceptFrameClarity({ ...live, sampleCamera: undefined })).toMatchObject({ arrival: 'zoom', verdict: 'preview', screenReady: false })
  expect(acceptFrameClarity({ ...live, demandCamera: { ...camera, zoom: Number.NaN } }).screenReady).toBe(false)
})

test('a mismatched revision cannot be accepted by stubbing the version as matching', () => {
  const foreign = acceptFrameClarity({ ...live, demandRevision: 8 })
  expect(foreign).toMatchObject({ arrival: 'foreign-revision', verdict: 'reject', screenReady: false, partialSharp: false })
  expect(acceptFrameClarity({ ...live, sampleRevision: undefined }).verdict).toBe('reject')
  expect(acceptFrameClarity({ ...live, demandRevision: undefined }).verdict).toBe('reject')
  // The old surface call passed sameRevision: true and would have certified this.
  expect(frameHandoff({
    sameRevision: true, sameCamera: true, nativeDensity: true, nativePhase: true, viewportCovered: true, regional: false,
  })).toBe('screen-ready')
})

test('partial coverage is partial-sharp and never screen-ready', () => {
  const partial = acceptFrameClarity({ ...live, coverage: 'partial' })
  expect(partial).toMatchObject({ verdict: 'partial-sharp', screenReady: false, partialSharp: true })
  expect(acceptFrameClarity({ ...live, coverage: 'partial', nativePhase: false })).toMatchObject({
    verdict: 'preview', partialSharp: false, screenReady: false,
  })
  expect(acceptFrameClarity({ ...live, coverage: 'partial', nativeDensity: false }).partialSharp).toBe(false)
})

test('zoom, pan and stale arrivals stay previews for both surfaces', () => {
  const zoom = acceptFrameClarity({ ...live, sampleCamera: { ...camera, zoom: 32 }, coverage: 'partial' })
  const pan = acceptFrameClarity({ ...live, sampleCamera: { ...camera, x: camera.x - 40 } })
  const stale = acceptFrameClarity({ ...live, generation: 3, acceptedGeneration: 4 })
  expect(zoom).toMatchObject({ arrival: 'zoom', verdict: 'preview', screenReady: false, partialSharp: false })
  expect(pan).toMatchObject({ arrival: 'same-zoom-pan', verdict: 'preview', screenReady: false, partialSharp: false })
  expect(stale).toMatchObject({ arrival: 'stale', verdict: 'preview', screenReady: false, partialSharp: false })
  expect(acceptFrameClarity({ ...live, generation: Number.NaN, acceptedGeneration: 4 })).toMatchObject({
    arrival: 'current', screenReady: true,
  })
  expect(classifyFrameArrival({ ...live, generation: 4, acceptedGeneration: 4 })).toBe('current')
})

test('the editor lattice and the source cache share one receipt for the same facts', () => {
  const facts = { ...live, coverage: 'partial' as const, nativePhase: true }
  const editor = acceptFrameClarity(facts)
  const source = acceptFrameClarity(facts)
  expect(editor).toEqual(source)
  expect(editor.partialSharp).toBe(true)
  expect(editor.screenReady).toBe(false)
  const settled = acceptFrameClarity({ ...facts, coverage: 'full' })
  expect(settled.screenReady).toBe(true)
  expect(settled.partialSharp).toBe(false)
})

test('#59 motion partial-sharp gate is byte-equivalent to currentPlan when default off', () => {
  for (const currentPlan of [true, false])
    for (const planExists of [true, false])
      for (const moving of [true, false])
        expect(motionPartialSharpAllowed({ currentPlan, planExists, moving, enabled: false })).toBe(currentPlan)
})

test('#59 motion partial-sharp replaces the stretched preview early only while moving with a plan', () => {
  // Stale plan currency during an active gesture: a ready sharp region may
  // replace the stretched preview without waiting for the whole viewport plan.
  expect(motionPartialSharpAllowed({ currentPlan: false, planExists: true, moving: true, enabled: true })).toBe(true)
  // A current plan still qualifies with the flag off or on.
  expect(motionPartialSharpAllowed({ currentPlan: true, planExists: true, moving: true, enabled: true })).toBe(true)
  // No plan, nothing to publish early.
  expect(motionPartialSharpAllowed({ currentPlan: false, planExists: false, moving: true, enabled: true })).toBe(false)
})

test('#59 stopped input never takes the early-replacement path (G3 exactness preserved)', () => {
  // Once the camera settles (moving=false) the gate collapses to currentPlan,
  // so the stopped frame is governed by the full-coverage screen-ready receipt.
  for (const currentPlan of [true, false])
    expect(motionPartialSharpAllowed({ currentPlan, planExists: true, moving: false, enabled: true })).toBe(currentPlan)
  // The receipt the early path relies on is partial-sharp, never screen-ready:
  // publishing it during motion can never certify the stopped exact frame.
  const sharpRegion = acceptFrameClarity({ ...live, coverage: 'partial' })
  expect(sharpRegion.partialSharp).toBe(true)
  expect(sharpRegion.screenReady).toBe(false)
  // A region missing native density or phase is not even partial-sharp, so the
  // gate only ever publishes genuinely sharp pixels, never a stretched sample.
  expect(acceptFrameClarity({ ...live, coverage: 'partial', nativeDensity: false }).partialSharp).toBe(false)
  expect(acceptFrameClarity({ ...live, coverage: 'partial', nativePhase: false }).partialSharp).toBe(false)
})
