import { cloneValue } from './draft'
import { current, isDraft } from 'immer'
import { uid, type DesignDocument, type DesignNode } from './model'
export type Easing =
  | { kind: 'linear' | 'hold' }
  | { kind: 'named'; name: NamedEasing }
  | { kind: 'cubic'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'spring'; mass: number; stiffness: number; damping: number; velocity: number }
export type NamedEasing = `ease-${'in' | 'out' | 'in-out'}-${'sine' | 'quad' | 'cubic' | 'quart' | 'quint' | 'expo' | 'circ'}`
export type Pose = Pick<
  DesignNode,
  | 'kind'
  | 'transform'
  | 'width'
  | 'height'
  | 'opacity'
  | 'radii'
  | 'smoothing'
  | 'fills'
  | 'strokes'
  | 'effects'
  | 'network'
  | 'vectorGeometry'
  | 'arc'
  | 'cornerRadius'
>
export type Keyframe = { timeMs: number; value: Pose; easing: Easing }
export type AnimationTrack = { nodeId: string; keyframes: Keyframe[]; rotationTurns: number }
export type AnimationClip = {
  id: string
  name: string
  pageId: string
  durationMs: number
  delayMs: number
  repeat: 'once' | 'loop' | 'alternate'
  tracks: AnimationTrack[]
}
export type AnimationSample = { clipId: string; timeMs: number }
export const easeInOut: Easing = { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
export const spring: Easing = { kind: 'spring', mass: 1, stiffness: 170, damping: 18, velocity: 0 }
export function pose(n: DesignNode): Pose {
  // recordKeyframe runs inside editor.change and receives an immer draft;
  // unwrap it first because structuredClone cannot clone draft proxies.
  const source = isDraft(n) ? (current(n) as DesignNode) : n
  const {
    kind,
    transform,
    width,
    height,
    opacity,
    radii,
    smoothing,
    fills,
    strokes,
    effects,
    network,
  } = source
  return cloneValue({
    kind,
    transform,
    width,
    height,
    opacity,
    radii,
    smoothing,
    fills,
    strokes,
    effects,
    ...(network ? { network } : {}),
    ...(source.vectorGeometry?{vectorGeometry:source.vectorGeometry}:{}),
    ...(n.arc ? { arc: n.arc } : {}),
    ...(n.cornerRadius ? { cornerRadius: n.cornerRadius } : {}),
  })
}
function subtree(doc: DesignDocument, roots: string[], descendants = true) {
  const seen = new Set<string>(),
    pending = [...roots]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    const n = doc.nodes[id]
    if (!n) throw new Error('动画图层不存在')
    seen.add(id)
    if (descendants) pending.push(...n.children)
  }
  if (!seen.size || seen.size > 1024) throw new Error('动画最多支持 1024 条轨道；整体移动画板时可关闭“包含子图层轨道”')
  return [...seen]
}
export function createClip(
  doc: DesignDocument,
  pageId: string,
  selection: string[],
  descendants = true,
): AnimationClip {
  return {
    id: uid(),
    name: `动画 ${(doc.animations?.length || 0) + 1}`,
    pageId,
    durationMs: 1000,
    delayMs: 0,
    repeat: 'once',
    tracks: subtree(doc, selection, descendants).map((nodeId) => ({
      nodeId,
      rotationTurns: 0,
      keyframes: [0, 1000].map((timeMs) => ({
        timeMs,
        value: pose(doc.nodes[nodeId]),
        easing: cloneValue(easeInOut),
      })),
    })),
  }
}
export function recordKeyframe(
  doc: DesignDocument,
  clip: AnimationClip,
  selection: string[],
  timeMs: number,
  easing: Easing,
  descendants = true,
) {
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > clip.durationMs)
    throw new Error('关键帧时间超出动画长度')
  for (const nodeId of subtree(doc, selection, descendants)) {
    let track = clip.tracks.find((t) => t.nodeId === nodeId)
    if (!track) {
      track = {
        nodeId,
        rotationTurns: 0,
        keyframes: [{ timeMs: 0, value: pose(doc.nodes[nodeId]), easing: cloneValue(easing) }],
      }
      clip.tracks.push(track)
    }
    const key = { timeMs, value: pose(doc.nodes[nodeId]), easing: cloneValue(easing) },
      at = track.keyframes.findIndex((k) => k.timeMs === timeMs)
    if (at < 0) track.keyframes.push(key)
    else track.keyframes[at] = key
    track.keyframes.sort((a, b) => a.timeMs - b.timeMs)
  }
}
// --- Timeline helpers (pure; shared between the panel UI and tests) ---
/** Snap granularity for keyframe drags and timeline clicks, in milliseconds. */
export const TIMELINE_SNAP_MS = 10
/** Maps a keyframe time to its 0–1 ratio on the timeline lane, clamped. */
export function timelineRatio(timeMs: number, durationMs: number): number {
  if (!Number.isFinite(timeMs) || !(durationMs > 0)) return 0
  return Math.min(Math.max(timeMs, 0), durationMs) / durationMs
}
/** Converts a lane pixel offset into a clamped keyframe time snapped to 10ms. */
export function timelineTimeAt(
  offsetPx: number,
  laneWidthPx: number,
  durationMs: number,
): number {
  if (!(laneWidthPx > 0) || !(durationMs > 0)) return 0
  const raw = (offsetPx / laneWidthPx) * durationMs
  const clamped = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), durationMs)
  return Math.round(clamped / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS
}
/**
 * Moves one keyframe to a new time and keeps the array sorted. The kernel
 * validator requires strictly increasing keyframe times, so a move landing
 * exactly on a neighbor's time is rejected (input returned unchanged); ties
 * therefore stay out of the document and any pre-existing equal times keep
 * their original order (stable sort with an index tie-break).
 */
export function moveKeyframeTime(
  keyframes: Keyframe[],
  index: number,
  timeMs: number,
): Keyframe[] {
  if (index < 0 || index >= keyframes.length) return keyframes
  if (keyframes.some((k, i) => i !== index && k.timeMs === timeMs)) return keyframes
  return keyframes
    .map((k, i) => (i === index ? { ...k, timeMs } : k))
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.timeMs - b.k.timeMs || a.i - b.i)
    .map(({ k }) => k)
}
/**
 * Clamps a drag target between the neighboring keyframes (one snap slot away)
 * so the moved time stays strictly inside its slot and the kernel validation
 * of unique increasing times keeps passing.
 */
export function clampKeyframeTime(
  keyframes: Keyframe[],
  index: number,
  timeMs: number,
): number {
  const previous = keyframes[index - 1]?.timeMs,
    next = keyframes[index + 1]?.timeMs
  let time = timeMs
  if (previous !== undefined && time < previous + TIMELINE_SNAP_MS)
    time = previous + TIMELINE_SNAP_MS
  if (next !== undefined && time > next - TIMELINE_SNAP_MS) time = next - TIMELINE_SNAP_MS
  return time
}
/** Removes one keyframe by index, returning the remaining sorted array. */
export function removeKeyframeAt(keyframes: Keyframe[], index: number): Keyframe[] {
  if (index < 0 || index >= keyframes.length) return keyframes
  return keyframes.filter((_, i) => i !== index)
}
/**
 * Ruler step for the timeline: one mark per second whenever the clip is long
 * enough, subdivided for short clips and grown for long ones so the ruler
 * always shows between 3 and 12 labels.
 */
export function timelineTickStepMs(durationMs: number): number {
  if (!(durationMs > 0)) return 1000
  for (const s of [1000, 2000, 5000, 10000, 15000, 30000, 60000])
    if (durationMs / s >= 3 && durationMs / s <= 12) return s
  for (const s of [500, 250, 100]) if (durationMs / s >= 3) return s
  return 100
}
/** Formats a ruler tick label, in seconds with trailing zeros trimmed. */
export function timelineTickLabel(ms: number, stepMs: number): string {
  if (stepMs >= 1000) return `${ms / 1000}s`
  const digits = stepMs === 250 ? 2 : stepMs === 100 ? 1 : 1
  return `${(ms / 1000).toFixed(digits).replace(/\.?0+$/, '')}s`
}
export function pruneAnimations(doc: DesignDocument) {
  if (!doc.animations) return
  doc.animations = doc.animations.filter((clip) => {
    const page = doc.pages.find((p) => p.id === clip.pageId)
    if (!page) return false
    const allowed = new Set<string>(),
      pending = [...page.children]
    while (pending.length) {
      const id = pending.pop()!
      if (allowed.has(id)) continue
      allowed.add(id)
      pending.push(...(doc.nodes[id]?.children || []))
    }
    clip.tracks = clip.tracks.filter(
      (t) =>
        allowed.has(t.nodeId) &&
        doc.nodes[t.nodeId] &&
        t.keyframes.every((k) => k.value.kind === doc.nodes[t.nodeId].kind),
    )
    return clip.tracks.length > 0
  })
}
// Playback uses elapsed time, never accumulated frame deltas. Hidden tabs pause
// at their current position; rendering coalesces frames independently.
export class PlaybackClock {
  private anchor = 0
  private offset = 0
  private running = false
  private rate = 1
  value(now: number) {
    return this.offset + (this.running ? (now - this.anchor) * this.rate : 0)
  }
  play(now: number) {
    if (!this.running) {
      this.anchor = now
      this.running = true
    }
  }
  pause(now: number) {
    this.offset = this.value(now)
    this.running = false
  }
  seek(time: number, now: number) {
    if (!Number.isFinite(time) || time < 0) throw new Error('Invalid playback time')
    this.offset = time
    this.anchor = now
  }
  speed(rate: number, now: number) {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4) throw new Error('Invalid playback speed')
    this.seek(this.value(now), now)
    this.rate = rate
  }
}
