/**
 * JIT-style playback orchestration for the animation preview.
 *
 * Ported from the reverse-engineered Figma viewer Smart Animate JS
 * orchestration (`figma-wasm-analysis/evidence/js-mining-2026-10-16/
 * viewer-smart-animate-jit.js`, 2026-10-16 round; see GLUE-JS-MINING.md §3).
 * This module is the *orchestration layer* alignment only — gate ladder,
 * playback state machine, dt clamp, per-frame dirty invalidation and the
 * kernel bake contract. The kernel-level JIT track-group system (clone
 * carriers named `-JitAnimationClone-From/To`, `setupJitAnimationNode`'s
 * track-group construction, JIT-TRACK.md §4) is a recorded follow-up and is
 * deliberately NOT pretended here.
 *
 * Spec anchors (viewer-e4fa8fc59235ee9e.min.js byte offsets in evidence):
 * - gate ladder `u_` @810119 / `uT` @810822, telemetry enums `ur`/`ui` @804124
 * - activation `materializeJitNavigateAnimationNode` @1229156
 *   (wasm returns `{timelineDefId, durationUs}`; `jitSourceCloneMode`
 *   `clone_free|clone_backed`)
 * - playback manager `hq` @1196586 / `computePlaybackTimeUs` @1202663
 *   (SCRUB/SETTLING math, wall-clock clamp)
 * - legacy tracker `me` @1521910 (`advanceToNextFrame` clamps dt to 1/30s)
 * - eased progress @1774571, transition end COMMIT/ABORT @1774836,
 *   per-frame `dirtyNode` @1778258
 */
import type { AnimationClip } from './animation'
import type { DesignDocument } from './model'
import { createAnimationBakeSession, kernelBakeRevision } from './kernel/bake-session'

// ---------------------------------------------------------------------------
// 1. Gate ladder
// ---------------------------------------------------------------------------

/**
 * Figma's fallback-reason culture (telemetry fields `ur`/`ui` @804124):
 * `outcome: completed|aborted|fallback` plus
 * `fallbackReason: jit_disabled|legacy_required|missing_source|
 *  missing_prototype_lib|materialization_failed`.
 * The names are kept verbatim so reports line up rung by rung.
 */
export type PlaybackFallbackReason =
  | 'jit_disabled'
  | 'legacy_required'
  | 'missing_source'
  | 'missing_prototype_lib'
  | 'materialization_failed'

export const PLAYBACK_FALLBACK_REASONS: readonly PlaybackFallbackReason[] = [
  'jit_disabled',
  'legacy_required',
  'missing_source',
  'missing_prototype_lib',
  'materialization_failed',
]

/**
 * Figma JIT gate flags that our runtime cannot yet evaluate honestly. They
 * are recorded as named placeholders so every rung of `u_` stays visible;
 * TODO(kernel): the JIT track-group system is the follow-up that gives these
 * flags real semantics.
 * - `metronome` — animation runtime prerequisite; our live equivalent is
 *   kernel-module readiness, checked through the bake source instead.
 * - `eclipse`, `mix_jit_default_enabled`, `mix_jit_overlays`,
 *   `mix_jit_min_animate`, `mix_jit_keyframeless_transitions` — release-gate
 *   mix semantics that only matter once both tracks exist.
 * - `has3dTransform` — our scene model has no 3D transform content yet.
 * The ladder below consults ONLY the three real bits (disable_jit switch,
 * has-motion-clip detection, transition-overrides override); these constants
 * are documentation, never read as behavior.
 */
export const PLAYBACK_PLACEHOLDER_FLAGS = {
  metronome: true,
  eclipse: false,
  mix_jit_default_enabled: false,
  mix_jit_overlays: false,
  mix_jit_min_animate: false,
  mix_jit_keyframeless_transitions: false,
  has3dTransform: false,
} as const

export type PlaybackGateInput = {
  clipId: string
  pageId: string
  /**
   * `transitionOverridesEnabled` equivalent (`uT` @810822): a per-request
   * override that keeps the JIT track even when the default-on gate would
   * fall back to legacy. Real bit #3.
   */
  transitionOverridesEnabled?: boolean
  /** `disable_jit` equivalent: hard kill switch. Real bit #1. */
  disableJit?: boolean
}

export type PlaybackGateResult = {
  implementation: 'jit' | 'legacy'
  outcome: 'activated' | 'fallback'
  fallbackReason?: PlaybackFallbackReason
}

export type PlaybackGateDeps = {
  /** Kernel module readiness — the `metronome`/`missing_prototype_lib` seam. */
  isKernelReady?: () => boolean
  bakeSource?: AnimationBakeSource
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0)

/** Content probe for the `hasMotionClip` rung: real detection, not a flag. */
export function clipHasMotion(clip: AnimationClip): boolean {
  return clip.tracks.some((t) => t.keyframes.length >= 2)
}

/**
 * The eligibility gate, rung by rung after Figma's `u_` @810119:
 * 1. action resolves a playable clip on this page (`ug` action predicate) —
 *    failure is `missing_source`;
 * 2. `disable_jit` → `jit_disabled`;
 * 3. prototype-lib present (kernel bake source available) — otherwise
 *    `missing_prototype_lib`;
 * 4. content gate: `eclipse || hasMotionClip || has3dTransform` (eclipse and
 *    has3dTransform are placeholders), plus the `transitionOverridesEnabled`
 *    override from `uT` — otherwise `legacy_required`;
 * 5. materialization (bake) — failure is `materialization_failed`.
 * A fallback still plays: the legacy track drives the same state machine,
 * only the per-frame advance source differs.
 */
export function resolvePlaybackTrack(
  doc: DesignDocument,
  input: PlaybackGateInput,
  deps: PlaybackGateDeps = {},
): PlaybackGateResult {
  const clip = doc.animations?.find((c) => c.id === input.clipId)
  if (!clip || clip.pageId !== input.pageId || clip.tracks.length === 0)
    return { implementation: 'legacy', outcome: 'fallback', fallbackReason: 'missing_source' }
  if (input.disableJit)
    return { implementation: 'legacy', outcome: 'fallback', fallbackReason: 'jit_disabled' }
  const bakeSource = deps.bakeSource ?? createKernelClipBakeSource(deps.isKernelReady ?? (() => false))
  if (!bakeSource.available())
    return { implementation: 'legacy', outcome: 'fallback', fallbackReason: 'missing_prototype_lib' }
  const jitEligible =
    PLAYBACK_PLACEHOLDER_FLAGS.eclipse ||
    clipHasMotion(clip) ||
    PLAYBACK_PLACEHOLDER_FLAGS.has3dTransform ||
    !!input.transitionOverridesEnabled
  if (!jitEligible)
    return { implementation: 'legacy', outcome: 'fallback', fallbackReason: 'legacy_required' }
  const handle = bakeSource.bake(doc, input.clipId, input.pageId)
  if (!handle)
    return { implementation: 'legacy', outcome: 'fallback', fallbackReason: 'materialization_failed' }
  return { implementation: 'jit', outcome: 'activated' }
}

// ---------------------------------------------------------------------------
// 2. Kernel bake contract (one bake, many samples)
// ---------------------------------------------------------------------------

/**
 * Activation handle, shaped after the wasm entry's return value in
 * `materializeJitNavigateAnimationNode` @1229156: `{timelineDefId,
 * durationUs}` plus the orchestration data the JS side derives from it.
 */
export type KernelBakeHandle = {
  timelineDefId: string
  durationUs: number
  /** Nodes the animation touches every frame — the dirty-invalidation set. */
  nodeIds: string[]
  /** Track snapshot with keyframe times sorted once per bake. */
  tracks: ReadonlyArray<{ nodeId: string; keyframeTimesMs: readonly number[] }>
  /**
   * `clone_free | clone_backed` @1229156. Ours is always `clone_free`: the
   * render path samples the live document through the kernel render contract
   * and never materializes clone carriers. `clone_backed` is the placeholder
   * for the kernel-level track-group follow-up.
   */
  jitSourceCloneMode: 'clone_free' | 'clone_backed'
}

export type AnimationBakeSource = {
  available(): boolean
  bake(doc: DesignDocument, clipId: string, pageId: string): KernelBakeHandle | null
}

/**
 * The default bake source for clip playback. Baking runs once per playback:
 * it validates the clip against the same rules the kernel renderer's
 * `prepare_frame` enforces (design-kernel/src/renderer.rs: clip exists, page
 * matches) so a bad clip fails at activation with a fallback reason instead
 * of an error per frame, snapshots the sorted keyframe times, and hands the
 * per-frame math a precomputed structure — the orchestration-layer analogue
 * of `PlanTree::sample_document_with_plan` (animation_plan.rs: "one bake per
 * transition, many samples").
 *
 * The kernel's bake track is now wasm-bound as `AnimationBakeSession` (the
 * stateful revision-bearing bake + plan cache + in-flight mutex; prototype
 * frame pairs are consumed by PrototypePlayer through it). This pure-TS
 * source is the fallback half of the seam; `createKernelClipBakeSource`
 * below layers kernel materialization on top of it whenever the session
 * binding is live. Per-frame kernel resampling is additionally skipped
 * upstream by the renderer's `prepare_animation` equality check whenever the
 * emitted sample is coalesced (see AnimationPlayback emission rule).
 */
export function createClipBakeSource(isKernelReady: () => boolean): AnimationBakeSource {
  return {
    available: () => isKernelReady(),
    bake(doc, clipId, pageId) {
      const clip = doc.animations?.find((c) => c.id === clipId)
      if (!clip || clip.pageId !== pageId || clip.tracks.length === 0) return null
      if (!Number.isFinite(clip.durationMs) || clip.durationMs < 0) return null
      const tracks: { nodeId: string; keyframeTimesMs: number[] }[] = []
      for (const track of clip.tracks) {
        const node = doc.nodes[track.nodeId]
        // The kernel sampler indexes keyframes[0]; an empty or dangling track
        // would fail inside the render worker, so bake rejects it up front.
        if (!node || track.keyframes.length === 0) return null
        if (track.keyframes.some((k) => !Number.isFinite(k.timeMs) || k.timeMs < 0)) return null
        tracks.push({
          nodeId: track.nodeId,
          keyframeTimesMs: track.keyframes.map((k) => k.timeMs).sort((a, b) => a - b),
        })
      }
      return {
        timelineDefId: clip.id,
        durationUs: Math.max(0, Math.round(clip.durationMs * 1000)),
        nodeIds: tracks.map((t) => t.nodeId),
        tracks,
        jitSourceCloneMode: 'clone_free',
      }
    },
  }
}

/**
 * Kernel-backed bake source: the reserved seam of `createClipBakeSource`'s
 * contract, slotted into the wasm `AnimationBakeSession`. Same contract
 * shape, same validation (delegated to the pure-TS source); when the kernel
 * session binding is live, the bake additionally materializes through the
 * kernel — one `bake` of the clip's page pair at the document's revision,
 * the `materializeJitNavigateAnimationNode` @1229156 analogue — which
 * registers the pair in the kernel's in-flight mutex and warms the plan
 * cache (the cache entry outlives the immediately released guard). A
 * kernel-side failure (e.g. a `BakeConflict` against another live playback)
 * fails the bake so the gate ladder reports `materialization_failed`; when
 * the binding is unavailable the pure-TS handle stands as the fallback.
 */
export function createKernelClipBakeSource(isKernelReady: () => boolean): AnimationBakeSource {
  const fallback = createClipBakeSource(isKernelReady)
  return {
    available: fallback.available,
    bake(doc, clipId, pageId) {
      const handle = fallback.bake(doc, clipId, pageId)
      if (!handle) return null
      const session = createAnimationBakeSession()
      if (!session) return handle
      try {
        const json = JSON.stringify(doc)
        session.bake(json, json, pageId, pageId, kernelBakeRevision(doc))
      } catch {
        return null
      } finally {
        session.free()
      }
      return handle
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Per-frame dirty invalidation
// ---------------------------------------------------------------------------

/**
 * Accumulator for the per-frame `dirtyNode` contract (@1778258: object
 * animations call `dirtinessTracker.dirtyNode(target)` every frame while in
 * progress). The playback marks its baked node set on every emitted frame;
 * damage consumers (tile/damage scheduling) drain the set when they repaint.
 */
export class AnimationDirtyTracker {
  private pending = new Set<string>()
  private markedTotal = 0
  markFrame(nodeIds: Iterable<string>): void {
    for (const id of nodeIds) this.pending.add(id)
    this.markedTotal += 1
  }
  /** Drains: returns the accumulated ids and clears the pending set. */
  drain(): string[] {
    const out = [...this.pending]
    this.pending.clear()
    return out
  }
  get pendingCount(): number {
    return this.pending.size
  }
  get framesMarked(): number {
    return this.markedTotal
  }
  clear(): void {
    this.pending.clear()
    this.markedTotal = 0
  }
}

// ---------------------------------------------------------------------------
// 4. Playback state machine
// ---------------------------------------------------------------------------

export type PlaybackState = 'IDLE' | 'PLAYING' | 'SCRUB' | 'SETTLING' | 'COMMITTED' | 'ABORTED'
export type PlaybackEndOutcome = 'COMMIT' | 'ABORT'

export type PlaybackSampleEvent = {
  /** Raw (un-eased) display time for the kernel render sample. */
  timeMs: number
  /** Raw transition-window ratio in [0,1]. */
  progress: number
  dirtyNodeIds: string[]
}

export type PlaybackEndEvent = {
  outcome: PlaybackEndOutcome
  state: 'COMMITTED' | 'ABORTED'
  timeMs: number
}

export type PlaybackTick = {
  state: PlaybackState
  progress: number
  timeMs: number
  /** Set on exactly the frame that finalized COMMIT or ABORT. */
  ended: PlaybackEndOutcome | null
  /** Whether this frame emitted a fresh sample (false = coalesced duplicate). */
  emitted: boolean
}

/**
 * Figma's legacy (baked) tracker clamps each frame's dt to 1/30s
 * (`me.advanceToNextFrame` @1521910: `t = Math.min(t, 1/30)`) so a dropped
 * frame cannot lunge the transition. The wall-clock/external path computes
 * absolute elapsed time instead of accumulating deltas, so it stays
 * unclamped (a hitch lands on the correct absolute time, clamped only to
 * [0, duration] the way `computePlaybackTimeUs` @1202663 does).
 */
export const LEGACY_DT_CLAMP_SECONDS = 1 / 30

export type AnimationPlaybackOptions = {
  durationMs: number
  delayMs?: number
  repeat?: AnimationClip['repeat']
  /** Dirty targets, normally the bake handle's `nodeIds`. */
  dirtyNodeIds?: readonly string[]
  /**
   * `easingFunction.get(rawProgress)` equivalent (@1774571). Null by
   * default: clip easing is applied inside the kernel sampler
   * (`sample_validated` runs `a.easing.sample(...)`), and the orchestrator
   * deliberately does not double-apply it. Injected only by consumers that
   * consume eased progress outside the render sample.
   */
  easingGet?: (rawProgress: number) => number
  /** Wall-clock source for SETTLING interpolation (injectable for tests). */
  now?: () => number
  onSample?: (event: PlaybackSampleEvent) => void
  onDirtyNodes?: (nodeIds: string[]) => void
  onEnd?: (event: PlaybackEndEvent) => void
  stats?: PlaybackOrchestrationStats
  debug?: boolean
}

const defaultNow = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

const isActiveState = (s: PlaybackState) => s === 'PLAYING' || s === 'SCRUB' || s === 'SETTLING'

/**
 * Transition-scoped playback machine: `IDLE→PLAYING→{COMMITTED|ABORTED}`
 * with `SCRUB`/`SETTLING` as the external-drag states
 * (`hq` manager @1196586). Two advance sources:
 * - `tick(elapsedMs)` — wall-clock/external path (absolute, unclamped dt);
 * - `advance(dtSeconds)` — legacy path (dt clamped to 1/30s).
 * SCRUB is entered by `beginScrub()`; `releaseScrub(commitOnFinish)` starts
 * SETTLING with `settleDurationUs = max(1, |target - progress| *
 * durationUs)` (`settleCurrentSmartAnimateDrag` @1202663); a finished settle
 * commits to the destination (progress 1) or reverts to the source
 * (progress 0 — the abort side of `getSmartAnimateDragCompletionNode`).
 * Natural end for `repeat: 'once'` is COMMIT, Figma's default end action
 * (`transitionEnded() → COMMIT`, @1774836); `commit()`/`abort()` are the
 * explicit two-state API.
 */
export class AnimationPlayback {
  private stateValue: PlaybackState = 'IDLE'
  private elapsedMs = 0
  private lastEmittedTimeMs: number | null = null
  private lastProgress = 0
  private externalControl = false
  private scrubProgress = 0
  private settle: {
    startProgress: number
    targetProgress: number
    startTimeMs: number
    durationUs: number
    commitOnFinish: boolean
  } | null = null
  private lastSettleDurationUs: number | null = null
  private readonly options: AnimationPlaybackOptions &
    Required<Pick<AnimationPlaybackOptions, 'delayMs' | 'repeat' | 'now'>>
  readonly dirtyTracker = new AnimationDirtyTracker()

  constructor(options: AnimationPlaybackOptions) {
    this.options = {
      ...options,
      delayMs: options.delayMs ?? 0,
      repeat: options.repeat ?? 'once',
      now: options.now ?? defaultNow,
    }
  }

  get state(): PlaybackState {
    return this.stateValue
  }
  get progress(): number {
    return this.lastProgress
  }
  get timeMs(): number {
    return this.lastEmittedTimeMs ?? this.computeTimeMs()
  }
  get settleDurationUs(): number | null {
    return this.lastSettleDurationUs
  }
  isExternallyControlled(): boolean {
    return this.stateValue === 'SCRUB' || this.stateValue === 'SETTLING' || this.externalControl
  }

  /** IDLE/terminal → PLAYING; re-arms the whole lifecycle. */
  start(initialElapsedMs = 0): boolean {
    if (isActiveState(this.stateValue)) return false
    this.elapsedMs = Math.max(0, initialElapsedMs)
    this.lastEmittedTimeMs = null
    this.lastProgress = this.computeProgress(this.computeTimeMs())
    this.externalControl = false
    this.settle = null
    this.lastSettleDurationUs = null
    this.stateValue = 'PLAYING'
    return true
  }

  /**
   * Wall-clock / external-control advance (the JIT track's time source,
   * `computePlaybackTimeUs` @1202663). Takes absolute elapsed time — our
   * callers supply a rate-scaled clock value, which preserves the no-dt
   * property: absolute time cannot accumulate a hitch.
   */
  tick(elapsedMs: number): PlaybackTick {
    if (this.stateValue === 'SETTLING') return this.advanceSettling()
    if (this.stateValue !== 'PLAYING') return this.terminalTick()
    this.externalControl = false
    this.elapsedMs = Math.max(0, elapsedMs)
    return this.frameFromElapsed()
  }

  /** Legacy-track advance: accumulates dt, clamped to 1/30s per frame. */
  advance(dtSeconds: number): PlaybackTick {
    if (this.stateValue === 'SETTLING') return this.advanceSettling()
    if (this.stateValue !== 'PLAYING') return this.terminalTick()
    this.externalControl = false
    const dt = Math.min(Math.max(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0), LEGACY_DT_CLAMP_SECONDS)
    this.elapsedMs += dt * 1000
    return this.frameFromElapsed()
  }

  /** External seek (`seekCurrentAnimation` @1196586): pins the time. */
  seek(timeMs: number): PlaybackTick {
    if (this.stateValue === 'SETTLING') return this.advanceSettling()
    if (this.stateValue !== 'PLAYING') return this.terminalTick()
    this.externalControl = true
    this.elapsedMs = Math.max(0, timeMs)
    return this.frameFromElapsed()
  }

  /** PLAYING → SCRUB (external drag takes over the time source). */
  beginScrub(): boolean {
    if (this.stateValue !== 'PLAYING') return false
    this.scrubProgress = clamp01(this.lastProgress)
    this.externalControl = true
    this.stateValue = 'SCRUB'
    return true
  }

  /** Drag position update; ratio clamps to [0,1] (@1196586). */
  setScrubProgress(ratio: number): PlaybackTick {
    if (this.stateValue !== 'SCRUB') return this.terminalTick()
    this.scrubProgress = clamp01(ratio)
    const timeMs = this.options.delayMs + this.scrubProgress * this.options.durationMs
    return this.emit('SCRUB', this.scrubProgress, timeMs, null)
  }

  /**
   * SCRUB → SETTLING. `commitOnFinish` picks the settle target (1 = commit
   * to destination, 0 = revert to source); the settle duration follows the
   * Figma formula `max(1, |target - progress| * durationUs)`
   * (`settleCurrentSmartAnimateDrag` @1202663).
   */
  releaseScrub(commitOnFinish: boolean): boolean {
    if (this.stateValue !== 'SCRUB') return false
    const current = clamp01(this.scrubProgress)
    const target = commitOnFinish ? 1 : 0
    const durationUs = Math.max(1, Math.round(Math.abs(target - current) * this.options.durationMs * 1000))
    this.settle = {
      startProgress: current,
      targetProgress: target,
      startTimeMs: this.options.now(),
      durationUs,
      commitOnFinish,
    }
    this.lastSettleDurationUs = durationUs
    this.stateValue = 'SETTLING'
    return true
  }

  /**
   * Explicit COMMIT: land on the end frame (`commitStateChange` @1774836).
   * Emits the final sample so consumers see the destination pose.
   */
  commit(): boolean {
    if (!isActiveState(this.stateValue)) return false
    this.settle = null
    this.stateValue = 'COMMITTED'
    const timeMs = this.options.delayMs + this.options.durationMs
    this.emit('COMMITTED', 1, timeMs, 'COMMIT')
    return true
  }

  /**
   * Explicit ABORT (`abortStateChange` @1774836). Emits no final sample —
   * reverting to the source pose is consumer-side policy; sample-based
   * rendering has no document mutation to roll back.
   */
  abort(): boolean {
    if (!isActiveState(this.stateValue)) return false
    this.settle = null
    const timeMs = this.timeMs
    this.stateValue = 'ABORTED'
    if (this.options.stats) this.options.stats.abortEnds += 1
    this.options.onEnd?.({ outcome: 'ABORT', state: 'ABORTED', timeMs })
    this.debugLog('abort at', Math.round(timeMs), 'ms')
    return true
  }

  /**
   * `easedTransitionProgress` @1774571: raw when there is no easing function
   * or playback is externally controlled (SCRUB/SETTLING/pinned seek);
   * otherwise `easingFunction.get(rawProgress)`.
   */
  easedTransitionProgress(): number {
    const raw = this.progress
    if (!this.options.easingGet || this.isExternallyControlled()) return raw
    return this.options.easingGet(raw)
  }

  // -- internals ----------------------------------------------------------

  private computeTimeMs(): number {
    const { delayMs, durationMs, repeat } = this.options
    const total = delayMs + durationMs
    if (repeat === 'once') return clamp(this.elapsedMs, 0, total)
    return Math.max(0, this.elapsedMs)
  }
  private computeProgress(timeMs: number): number {
    const { delayMs, durationMs } = this.options
    if (durationMs <= 0) return this.elapsedMs >= delayMs + durationMs ? 1 : 0
    return clamp01((timeMs - delayMs) / durationMs)
  }

  private frameFromElapsed(): PlaybackTick {
    const { delayMs, durationMs, repeat } = this.options
    const total = delayMs + durationMs
    if (repeat === 'once' && this.elapsedMs >= total) {
      this.stateValue = 'COMMITTED'
      return this.emit('COMMITTED', 1, total, 'COMMIT')
    }
    const timeMs = this.computeTimeMs()
    return this.emit('PLAYING', this.computeProgress(timeMs), timeMs, null)
  }

  private advanceSettling(): PlaybackTick {
    const settle = this.settle
    if (!settle) return this.terminalTick()
    const elapsedUs = (this.options.now() - settle.startTimeMs) * 1000
    const ratio = clamp01(elapsedUs / Math.max(1, settle.durationUs))
    const progress = clamp01(
      settle.startProgress + (settle.targetProgress - settle.startProgress) * ratio,
    )
    const timeMs = this.options.delayMs + progress * this.options.durationMs
    if (elapsedUs >= settle.durationUs) {
      const outcome: PlaybackEndOutcome = settle.commitOnFinish ? 'COMMIT' : 'ABORT'
      this.stateValue = outcome === 'COMMIT' ? 'COMMITTED' : 'ABORTED'
      this.settle = null
      return this.emit(
        outcome === 'COMMIT' ? 'COMMITTED' : 'ABORTED',
        settle.targetProgress,
        timeMs,
        outcome,
      )
    }
    return this.emit('SETTLING', progress, timeMs, null)
  }

  private terminalTick(): PlaybackTick {
    const timeMs = this.lastEmittedTimeMs ?? this.computeTimeMs()
    return {
      state: this.stateValue,
      progress: this.stateValue === 'COMMITTED' ? 1 : this.lastProgress,
      timeMs,
      ended: null,
      emitted: false,
    }
  }

  /**
   * Emission rule: a sample fires only when the display time actually
   * changed. Unchanged samples coalesce, which keeps the kernel renderer's
   * `prepare_animation` equality skip path (renderer.rs: identical
   * `{clipId, timeMs}` requests do no resampling) and avoids React churn
   * while paused or scrubbing onto the same slot.
   */
  private emit(
    state: PlaybackState,
    progress: number,
    timeMs: number,
    ended: PlaybackEndOutcome | null,
  ): PlaybackTick {
    const stats = this.options.stats
    this.lastProgress = progress
    const emitted = this.lastEmittedTimeMs === null || this.lastEmittedTimeMs !== timeMs
    if (emitted) {
      this.lastEmittedTimeMs = timeMs
      const dirty = this.options.dirtyNodeIds ?? []
      if (dirty.length) this.dirtyTracker.markFrame(dirty)
      if (stats) {
        stats.framesEmitted += 1
        stats.dirtyNodesMarked += dirty.length
      }
      this.options.onSample?.({ timeMs, progress, dirtyNodeIds: [...dirty] })
      if (dirty.length) this.options.onDirtyNodes?.([...dirty])
    } else if (stats) {
      stats.framesCoalesced += 1
    }
    if (ended) {
      if (stats) {
        if (ended === 'COMMIT') stats.commitEnds += 1
        else stats.abortEnds += 1
      }
      this.options.onEnd?.({
        outcome: ended,
        state: ended === 'COMMIT' ? 'COMMITTED' : 'ABORTED',
        timeMs,
      })
      this.debugLog('ended', ended, 'at', Math.round(timeMs), 'ms')
    }
    return { state, progress, timeMs, ended, emitted }
  }

  private debugLog(...parts: unknown[]) {
    if (this.options.debug) console.debug('[animation-orchestrator]', ...parts)
  }
}

// ---------------------------------------------------------------------------
// 5. Session façade + stats
// ---------------------------------------------------------------------------

export type PlaybackOrchestrationStats = {
  gateAttempts: number
  jitActivations: number
  legacyFallbacks: number
  fallbacks: Record<PlaybackFallbackReason, number>
  framesEmitted: number
  framesCoalesced: number
  dirtyNodesMarked: number
  commitEnds: number
  abortEnds: number
}

export function createPlaybackOrchestrationStats(): PlaybackOrchestrationStats {
  return {
    gateAttempts: 0,
    jitActivations: 0,
    legacyFallbacks: 0,
    fallbacks: {
      jit_disabled: 0,
      legacy_required: 0,
      missing_source: 0,
      missing_prototype_lib: 0,
      materialization_failed: 0,
    },
    framesEmitted: 0,
    framesCoalesced: 0,
    dirtyNodesMarked: 0,
    commitEnds: 0,
    abortEnds: 0,
  }
}

export type OrchestratedPlaybackStart = {
  gate: PlaybackGateResult
  /** Present when the JIT track activated (the `{timelineDefId, durationUs}` analogue). */
  bake: KernelBakeHandle | null
  /** Always created when the clip resolves — the legacy track plays the same machine. */
  playback: AnimationPlayback | null
  stats: PlaybackOrchestrationStats
}

export type OrchestratedPlaybackDeps = PlaybackGateDeps & {
  now?: () => number
  easingGet?: (rawProgress: number) => number
  debug?: boolean
  onSample?: (event: PlaybackSampleEvent) => void
  onDirtyNodes?: (nodeIds: string[]) => void
  onEnd?: (event: PlaybackEndEvent) => void
  stats?: PlaybackOrchestrationStats
}

/**
 * Activation entry: runs the gate ladder once per playback (never per
 * frame), bakes when the JIT track activates, and assembles the state
 * machine. Fallback telemetry lands in `stats` and, with `debug`, in
 * `console.debug` — the `ur`/`ui` fields (`implementation`, `outcome`,
 * `fallbackReason`) map one to one.
 */
export function startOrchestratedPlayback(
  doc: DesignDocument,
  input: PlaybackGateInput,
  deps: OrchestratedPlaybackDeps = {},
): OrchestratedPlaybackStart {
  const stats = deps.stats ?? createPlaybackOrchestrationStats()
  stats.gateAttempts += 1
  const bakeSource = deps.bakeSource ?? createKernelClipBakeSource(deps.isKernelReady ?? (() => false))
  const gate = resolvePlaybackTrack(doc, input, { ...deps, bakeSource })
  const buildPlayback = (dirtyNodeIds: readonly string[]) => {
    const clip = doc.animations?.find((c) => c.id === input.clipId)
    return clip
      ? new AnimationPlayback({
          durationMs: clip.durationMs,
          delayMs: clip.delayMs,
          repeat: clip.repeat,
          dirtyNodeIds,
          easingGet: deps.easingGet,
          now: deps.now,
          onSample: deps.onSample,
          onDirtyNodes: deps.onDirtyNodes,
          onEnd: deps.onEnd,
          stats,
          debug: deps.debug,
        })
      : null
  }
  let bake: KernelBakeHandle | null = null
  if (gate.outcome === 'activated') {
    bake = bakeSource.bake(doc, input.clipId, input.pageId)
    if (!bake) {
      // The source went unavailable between the availability check and the
      // bake; degrade to legacy rather than play without a handle.
      stats.fallbacks.materialization_failed += 1
      stats.legacyFallbacks += 1
      if (deps.debug)
        console.debug('[animation-orchestrator] jit fallback:', 'materialization_failed')
      const fallbackGate: PlaybackGateResult = {
        implementation: 'legacy',
        outcome: 'fallback',
        fallbackReason: 'materialization_failed',
      }
      const fallbackClip = doc.animations?.find((c) => c.id === input.clipId)
      return {
        gate: fallbackGate,
        bake: null,
        playback: buildPlayback(fallbackClip ? fallbackClip.tracks.map((t) => t.nodeId) : []),
        stats,
      }
    }
    stats.jitActivations += 1
  } else {
    stats.legacyFallbacks += 1
    stats.fallbacks[gate.fallbackReason ?? 'legacy_required'] += 1
    if (deps.debug)
      console.debug(
        '[animation-orchestrator] jit fallback:',
        gate.fallbackReason ?? 'legacy_required',
      )
  }
  const clip = doc.animations?.find((c) => c.id === input.clipId)
  return {
    gate,
    bake,
    playback: buildPlayback(bake ? bake.nodeIds : (clip?.tracks ?? []).map((t) => t.nodeId)),
    stats,
  }
}
