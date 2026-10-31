import { expect, test, vi } from 'vitest'
import { blank, node } from './model'
import { createClip } from './animation'
import {
  AnimationPlayback,
  LEGACY_DT_CLAMP_SECONDS,
  PLAYBACK_FALLBACK_REASONS,
  PLAYBACK_PLACEHOLDER_FLAGS,
  clipHasMotion,
  createClipBakeSource,
  resolvePlaybackTrack,
  startOrchestratedPlayback,
  type AnimationBakeSource,
} from './animation-orchestrator'

function fixture() {
  const doc = blank(),
    rect = node('rectangle', 10, 20, 100, 80)
  doc.nodes[rect.id] = rect
  doc.pages[0].children = [rect.id]
  const clip = createClip(doc, doc.pages[0].id, [rect.id])
  doc.animations = [clip]
  return { doc, clip, rect, pageId: doc.pages[0].id }
}

// ---------------------------------------------------------------------------
// Gate ladder
// ---------------------------------------------------------------------------

test('gate ladder activates the jit track for a clip with motion when the kernel is ready', () => {
  const { doc, clip, pageId } = fixture()
  const gate = resolvePlaybackTrack(doc, { clipId: clip.id, pageId }, { isKernelReady: () => true })
  expect(gate).toEqual({ implementation: 'jit', outcome: 'activated' })
})

test('gate ladder falls back rung by rung with Figma fallback reasons', () => {
  const { doc, clip, pageId } = fixture()
  // 1. missing_source: unknown clip / wrong page / empty tracks
  expect(
    resolvePlaybackTrack(doc, { clipId: 'nope', pageId }, { isKernelReady: () => true }),
  ).toMatchObject({ implementation: 'legacy', fallbackReason: 'missing_source' })
  expect(
    resolvePlaybackTrack(doc, { clipId: clip.id, pageId: 'other-page' }, { isKernelReady: () => true }),
  ).toMatchObject({ fallbackReason: 'missing_source' })
  const empty = { ...clip, tracks: [] }
  expect(
    resolvePlaybackTrack(
      { ...doc, animations: [empty] } as typeof doc,
      { clipId: clip.id, pageId },
      { isKernelReady: () => true },
    ),
  ).toMatchObject({ fallbackReason: 'missing_source' })
  // 2. jit_disabled: the disable_jit kill switch
  expect(
    resolvePlaybackTrack(doc, { clipId: clip.id, pageId, disableJit: true }, { isKernelReady: () => true }),
  ).toMatchObject({ implementation: 'legacy', fallbackReason: 'jit_disabled' })
  // 3. missing_prototype_lib: kernel bake source unavailable
  expect(
    resolvePlaybackTrack(doc, { clipId: clip.id, pageId }, { isKernelReady: () => false }),
  ).toMatchObject({ fallbackReason: 'missing_prototype_lib' })
  // 4. legacy_required: no motion content and no transition override
  const still = structuredClone(clip)
  for (const track of still.tracks) track.keyframes = [track.keyframes[0]]
  expect(clipHasMotion(still)).toBe(false)
  expect(
    resolvePlaybackTrack(
      { ...doc, animations: [still] } as typeof doc,
      { clipId: still.id, pageId },
      { isKernelReady: () => true },
    ),
  ).toMatchObject({ fallbackReason: 'legacy_required' })
  // ...and the transitionOverridesEnabled override keeps the jit track (uT)
  expect(
    resolvePlaybackTrack(
      { ...doc, animations: [still] } as typeof doc,
      { clipId: still.id, pageId, transitionOverridesEnabled: true },
      { isKernelReady: () => true },
    ),
  ).toEqual({ implementation: 'jit', outcome: 'activated' })
  // 5. materialization_failed: source available but the bake itself fails
  const failing: AnimationBakeSource = { available: () => true, bake: () => null }
  expect(
    resolvePlaybackTrack(doc, { clipId: clip.id, pageId }, { bakeSource: failing }),
  ).toMatchObject({ fallbackReason: 'materialization_failed' })
})

test('placeholder flags and fallback reason enums are recorded, not pretended', () => {
  expect(Object.keys(PLAYBACK_PLACEHOLDER_FLAGS).sort()).toEqual(
    [
      'metronome',
      'eclipse',
      'mix_jit_default_enabled',
      'mix_jit_overlays',
      'mix_jit_min_animate',
      'mix_jit_keyframeless_transitions',
      'has3dTransform',
    ].sort(),
  )
  expect(PLAYBACK_FALLBACK_REASONS).toEqual([
    'jit_disabled',
    'legacy_required',
    'missing_source',
    'missing_prototype_lib',
    'materialization_failed',
  ])
})

// ---------------------------------------------------------------------------
// Bake (kernel consumption contract)
// ---------------------------------------------------------------------------

test('clip bake produces the {timelineDefId, durationUs} activation handle', () => {
  const { doc, clip, pageId, rect } = fixture()
  clip.durationMs = 1200
  const source = createClipBakeSource(() => true)
  expect(source.available()).toBe(true)
  const handle = source.bake(doc, clip.id, pageId)!
  expect(handle.timelineDefId).toBe(clip.id)
  expect(handle.durationUs).toBe(1_200_000)
  expect(handle.nodeIds).toEqual([rect.id])
  expect(handle.jitSourceCloneMode).toBe('clone_free')
  expect(handle.tracks[0].keyframeTimesMs).toEqual([0, 1000])
  // Keyframe times are sorted once per bake, so per-frame sampling never
  // re-sorts.
  clip.tracks[0].keyframes = [
    { timeMs: 900, value: clip.tracks[0].keyframes[0].value, easing: clip.tracks[0].keyframes[0].easing },
    { timeMs: 100, value: clip.tracks[0].keyframes[0].value, easing: clip.tracks[0].keyframes[0].easing },
  ]
  expect(source.bake(doc, clip.id, pageId)!.tracks[0].keyframeTimesMs).toEqual([100, 900])
  // Invalid clips fail the bake (mirrors the kernel renderer's own
  // prepare_frame validation) instead of erroring per frame.
  const dangling = structuredClone(clip)
  dangling.tracks.push({ nodeId: 'gone', rotationTurns: 0, keyframes: [{ timeMs: 0, value: dangling.tracks[0].keyframes[0].value, easing: dangling.tracks[0].keyframes[0].easing }] })
  expect(source.bake({ ...doc, animations: [dangling] } as typeof doc, dangling.id, pageId)).toBeNull()
})

test('session start runs the gate once and assembles playback either way', () => {
  const { doc, clip, pageId } = fixture()
  const started = startOrchestratedPlayback(doc, { clipId: clip.id, pageId }, { isKernelReady: () => true })
  expect(started.gate.implementation).toBe('jit')
  expect(started.bake?.timelineDefId).toBe(clip.id)
  expect(started.playback).toBeInstanceOf(AnimationPlayback)
  expect(started.stats.gateAttempts).toBe(1)
  expect(started.stats.jitActivations).toBe(1)
  const fallback = startOrchestratedPlayback(
    doc,
    { clipId: clip.id, pageId, disableJit: true },
    { isKernelReady: () => true },
  )
  expect(fallback.gate).toMatchObject({ implementation: 'legacy', fallbackReason: 'jit_disabled' })
  expect(fallback.bake).toBeNull()
  // A fallback still plays: the legacy track drives the same machine.
  expect(fallback.playback).toBeInstanceOf(AnimationPlayback)
  expect(fallback.stats.legacyFallbacks).toBe(1)
  expect(fallback.stats.fallbacks.jit_disabled).toBe(1)
})

// ---------------------------------------------------------------------------
// State machine: IDLE -> PLAYING -> {COMMITTED | ABORTED}
// ---------------------------------------------------------------------------

test('wall-clock playback commits when a once clip reaches its end', () => {
  const onEnd = vi.fn()
  const p = new AnimationPlayback({ durationMs: 1000, onEnd })
  expect(p.state).toBe('IDLE')
  expect(p.start(0)).toBe(true)
  expect(p.state).toBe('PLAYING')
  expect(p.tick(400)).toMatchObject({ state: 'PLAYING', progress: 0.4, timeMs: 400, ended: null })
  // A huge wall-clock jump lands directly at the end — the wall path does
  // NOT clamp dt, only the resulting time to [0, duration].
  expect(p.tick(9999)).toMatchObject({ state: 'COMMITTED', progress: 1, timeMs: 1000, ended: 'COMMIT' })
  expect(onEnd).toHaveBeenCalledTimes(1)
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'COMMIT', state: 'COMMITTED', timeMs: 1000 })
  // Terminal ticks are inert.
  expect(p.tick(12000)).toMatchObject({ state: 'COMMITTED', ended: null, emitted: false })
  expect(onEnd).toHaveBeenCalledTimes(1)
  expect(p.commit()).toBe(false)
  expect(p.abort()).toBe(false)
  // The machine re-arms after a terminal state.
  expect(p.start(0)).toBe(true)
  expect(p.state).toBe('PLAYING')
})

test('explicit abort from PLAYING fires the ABORT end exactly once', () => {
  const onEnd = vi.fn()
  const p = new AnimationPlayback({ durationMs: 1000, onEnd })
  p.start(0)
  p.tick(250)
  expect(p.abort()).toBe(true)
  expect(p.state).toBe('ABORTED')
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'ABORT', state: 'ABORTED', timeMs: 250 })
  expect(p.abort()).toBe(false)
  expect(onEnd).toHaveBeenCalledTimes(1)
})

test('explicit commit from mid-flight lands on the end frame', () => {
  const onSample = vi.fn()
  const p = new AnimationPlayback({ durationMs: 1000, onSample })
  p.start(0)
  p.tick(250)
  expect(p.commit()).toBe(true)
  expect(p.state).toBe('COMMITTED')
  const last = onSample.mock.calls.at(-1)![0]
  expect(last.timeMs).toBe(1000)
  expect(last.progress).toBe(1)
})

test('loop and alternate clips never auto-commit', () => {
  for (const repeat of ['loop', 'alternate'] as const) {
    const onEnd = vi.fn()
    const p = new AnimationPlayback({ durationMs: 1000, repeat, onEnd })
    p.start(0)
    // Absolute time passes through unwrapped; the kernel sampler computes
    // the loop/alternate phase from it.
    expect(p.tick(5000)).toMatchObject({ state: 'PLAYING', timeMs: 5000, ended: null })
    expect(onEnd).not.toHaveBeenCalled()
  }
})

test('delay shifts the transition window', () => {
  const p = new AnimationPlayback({ durationMs: 1000, delayMs: 200 })
  p.start(0)
  expect(p.tick(100)).toMatchObject({ progress: 0, timeMs: 100 })
  expect(p.tick(700)).toMatchObject({ progress: 0.5, timeMs: 700 })
  expect(p.tick(1200)).toMatchObject({ state: 'COMMITTED', timeMs: 1200, ended: 'COMMIT' })
})

test('invalid transitions are rejected', () => {
  const p = new AnimationPlayback({ durationMs: 1000 })
  expect(p.beginScrub()).toBe(false) // IDLE
  p.start(0)
  expect(p.start(0)).toBe(false) // already PLAYING
  expect(p.releaseScrub(true)).toBe(false) // not SCRUB
  expect(new AnimationPlayback({ durationMs: 1000 }).abort()).toBe(false) // IDLE
})

// ---------------------------------------------------------------------------
// SCRUB -> SETTLING
// ---------------------------------------------------------------------------

test('release settles with duration |target - progress| x total and commits at 1', () => {
  let nowMs = 0
  const p = new AnimationPlayback({ durationMs: 1000, now: () => nowMs })
  p.start(0)
  p.tick(100)
  expect(p.beginScrub()).toBe(true)
  expect(p.state).toBe('SCRUB')
  expect(p.setScrubProgress(0.25)).toMatchObject({ state: 'SCRUB', progress: 0.25, timeMs: 250 })
  // Scrub ratio clamps to [0,1].
  expect(p.setScrubProgress(7)).toMatchObject({ progress: 1, timeMs: 1000 })
  p.setScrubProgress(0.25)
  expect(p.releaseScrub(true)).toBe(true)
  expect(p.state).toBe('SETTLING')
  // |1 - 0.25| * 1000ms = 750ms of settling.
  expect(p.settleDurationUs).toBe(750_000)
  nowMs = 375
  expect(p.tick(100)).toMatchObject({ state: 'SETTLING', progress: 0.25 + 0.75 * 0.5, ended: null })
  nowMs = 750
  expect(p.tick(100)).toMatchObject({ state: 'COMMITTED', progress: 1, timeMs: 1000, ended: 'COMMIT' })
})

test('release with commit=false reverts to the source end as an abort', () => {
  let nowMs = 0
  const onEnd = vi.fn()
  const p = new AnimationPlayback({ durationMs: 1000, now: () => nowMs, onEnd })
  p.start(0)
  p.tick(400)
  p.beginScrub()
  p.setScrubProgress(0.4)
  expect(p.releaseScrub(false)).toBe(true)
  // |0 - 0.4| * 1000ms = 400ms of settling.
  expect(p.settleDurationUs).toBe(400_000)
  nowMs = 200
  expect(p.tick(0)).toMatchObject({ state: 'SETTLING', progress: 0.4 - 0.4 * 0.5 })
  nowMs = 400
  expect(p.tick(0)).toMatchObject({ state: 'ABORTED', progress: 0, timeMs: 0, ended: 'ABORT' })
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'ABORT', state: 'ABORTED', timeMs: 0 })
})

test('settling a full-distance scrub uses the max(1, ...) minimum duration', () => {
  let nowMs = 0
  const p = new AnimationPlayback({ durationMs: 1000, now: () => nowMs })
  p.start(0)
  p.tick(500)
  // Scrub onto the commit target itself — |1 - 1| = 0, so the settle
  // duration clamps to the 1us minimum and completes on the next frame.
  p.beginScrub()
  p.setScrubProgress(1)
  p.releaseScrub(true)
  expect(p.settleDurationUs).toBe(1)
  nowMs = 1
  expect(p.tick(0)).toMatchObject({ state: 'COMMITTED', ended: 'COMMIT' })
})

test('abort during SCRUB and SETTLING ends immediately', () => {
  const onEnd = vi.fn()
  const a = new AnimationPlayback({ durationMs: 1000, onEnd })
  a.start(0)
  a.beginScrub()
  expect(a.abort()).toBe(true)
  expect(a.state).toBe('ABORTED')
  const b = new AnimationPlayback({ durationMs: 1000, onEnd })
  b.start(0)
  b.beginScrub()
  b.setScrubProgress(0.5)
  b.releaseScrub(true)
  expect(b.abort()).toBe(true)
  expect(b.state).toBe('ABORTED')
  expect(onEnd).toHaveBeenCalledTimes(2)
  expect(onEnd.mock.calls.every((c) => c[0].outcome === 'ABORT')).toBe(true)
})

// ---------------------------------------------------------------------------
// dt clamp (legacy track) vs unclamped wall clock
// ---------------------------------------------------------------------------

test('legacy advance clamps every dt to 1/30s', () => {
  const p = new AnimationPlayback({ durationMs: 1000 })
  p.start(0)
  // A 500ms hitch advances only one clamped step.
  p.advance(0.5)
  expect(p.timeMs).toBeCloseTo(1000 / 30, 5)
  // The exact boundary passes through untouched...
  const before = p.timeMs
  p.advance(LEGACY_DT_CLAMP_SECONDS)
  expect(p.timeMs).toBeCloseTo(before + 1000 / 30, 5)
  // ...anything above clamps back to the same step.
  p.advance(LEGACY_DT_CLAMP_SECONDS + 0.001)
  expect(p.timeMs).toBeCloseTo(before + (2 * 1000) / 30, 5)
  // Negative deltas are ignored (clock skew cannot rewind accumulation).
  const frozen = p.timeMs
  p.advance(-1)
  expect(p.timeMs).toBeCloseTo(frozen, 5)
  // Reaching the end through clamped accumulation still commits.
  for (let i = 0; i < 40; i++) p.advance(1)
  expect(p.state).toBe('COMMITTED')
})

test('wall-clock and external seek are not dt-clamped', () => {
  const p = new AnimationPlayback({ durationMs: 1000 })
  p.start(0)
  p.tick(300)
  expect(p.timeMs).toBe(300)
  // External control pins an arbitrary time directly.
  expect(p.seek(800)).toMatchObject({ progress: 0.8, timeMs: 800 })
  expect(p.isExternallyControlled()).toBe(true)
  // Resuming the wall clock clears the external pin.
  p.tick(900)
  expect(p.isExternallyControlled()).toBe(false)
})

// ---------------------------------------------------------------------------
// Emission coalescing, dirty invalidation, easing seam
// ---------------------------------------------------------------------------

test('samples emit only when the display time changes', () => {
  const onSample = vi.fn()
  const p = new AnimationPlayback({ durationMs: 1000, onSample })
  p.start(0)
  expect(p.tick(500).emitted).toBe(true)
  expect(p.tick(500).emitted).toBe(false)
  expect(p.tick(500).emitted).toBe(false)
  expect(p.tick(600).emitted).toBe(true)
  expect(onSample).toHaveBeenCalledTimes(2)
  // The final COMMIT frame emits the end sample exactly once.
  expect(p.tick(1000).emitted).toBe(true)
  expect(p.tick(1000).emitted).toBe(false)
  expect(onSample).toHaveBeenCalledTimes(3)
})

test('every emitted frame marks the baked node set dirty', () => {
  const onDirtyNodes = vi.fn()
  const p = new AnimationPlayback({
    durationMs: 1000,
    dirtyNodeIds: ['a', 'b', 'c'],
    onDirtyNodes,
  })
  p.start(0)
  p.tick(100)
  p.tick(200)
  p.tick(200) // coalesced: no dirty marks, no callback
  expect(onDirtyNodes).toHaveBeenCalledTimes(2)
  expect(onDirtyNodes.mock.calls.every((c) => c[0].length === 3)).toBe(true)
  expect(p.dirtyTracker.drain().sort()).toEqual(['a', 'b', 'c'])
  expect(p.dirtyTracker.framesMarked).toBe(2)
  expect(p.dirtyTracker.pendingCount).toBe(0)
})

test('easedTransitionProgress passes raw through for external control and applies easingGet otherwise', () => {
  const p = new AnimationPlayback({ durationMs: 1000, easingGet: (t) => t * t })
  p.start(0)
  p.tick(500)
  expect(p.easedTransitionProgress()).toBeCloseTo(0.25, 10)
  p.beginScrub()
  p.setScrubProgress(0.5)
  // SCRUB is external control: raw progress, no easing.
  expect(p.easedTransitionProgress()).toBe(0.5)
  p.releaseScrub(true)
  // SETTLING too.
  expect(p.easedTransitionProgress()).toBeCloseTo(0.5, 10)
  // Without an easing function the raw progress is the contract — the
  // kernel sampler applies the clip easing itself.
  const bare = new AnimationPlayback({ durationMs: 1000 })
  bare.start(0)
  bare.tick(500)
  expect(bare.easedTransitionProgress()).toBe(0.5)
})

test('session stats count emissions, coalescing and dirty nodes', () => {
  const { doc, clip, pageId } = fixture()
  const started = startOrchestratedPlayback(doc, { clipId: clip.id, pageId }, { isKernelReady: () => true })
  const p = started.playback!
  p.start(0)
  p.tick(100)
  p.tick(100)
  p.tick(200)
  expect(started.stats.framesEmitted).toBe(2)
  expect(started.stats.framesCoalesced).toBe(1)
  expect(started.stats.dirtyNodesMarked).toBe(2)
  p.tick(10000)
  expect(started.stats.commitEnds).toBe(1)
})
