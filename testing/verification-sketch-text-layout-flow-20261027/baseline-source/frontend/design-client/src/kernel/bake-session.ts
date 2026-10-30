/**
 * Kernel Smart-Animate bake-session bridge (E1 wiring): hands prototype
 * playback the stateful `AnimationBakeSession` wasm binding (one bake per
 * transition, many samples) instead of the stateless per-frame
 * `animation_plan_sample_json` rebuild.
 */
import { AnimationBakeSession } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from './module'
import type { DesignDocument } from '../model'

export type KernelAnimationBakeSession = AnimationBakeSession

/**
 * Revision source for the bake cache's version triple. The prototype player
 * deliberately owns an immutable document snapshot (PrototypePlayer.tsx:
 * "Preview deliberately owns an immutable design version") and no edit-layer
 * revision reaches it, so the revision is derived from document *identity*:
 * a monotonic counter assigned once per document object. Edits produce a new
 * document object (the store saves through immer), hence a fresh revision
 * that invalidates stale cached plans; an unchanged snapshot keeps its
 * revision, so replays of the same pair hit the cache.
 */
let nextBakeRevision = 1
const bakeRevisions = new WeakMap<object, number>()

export function kernelBakeRevision(document: DesignDocument): number {
  let revision = bakeRevisions.get(document)
  if (revision === undefined) {
    revision = nextBakeRevision
    nextBakeRevision += 1
    bakeRevisions.set(document, revision)
  }
  return revision
}

/**
 * Construct a kernel bake session when the module is initialized and the
 * binding exists; `null` otherwise (callers keep the stateless fallback).
 * Sessions share one kernel-global bake context, so the plan cache and the
 * in-flight mutex serve traffic across sessions.
 */
export function createAnimationBakeSession(): KernelAnimationBakeSession | null {
  if (!kernelModuleReady() || typeof AnimationBakeSession !== 'function') return null
  try {
    return new AnimationBakeSession()
  } catch {
    return null
  }
}
