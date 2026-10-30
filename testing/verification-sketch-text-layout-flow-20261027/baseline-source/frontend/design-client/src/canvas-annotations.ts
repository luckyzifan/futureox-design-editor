import { uid, type Bounds, type Point } from './model'

/**
 * Session-local canvas annotations: comment pins and slice regions.
 * These are tool overlays owned by the local editor session — they are not
 * part of the design document, never persist into .forma/IndexedDB, and do
 * not sync. A collaboration-grade comment service can adopt this surface
 * later without changing the canvas interaction contract.
 */
export type CanvasComment = { id: string; page: string; x: number; y: number; text: string; createdAt: number }
export type CanvasSlice = { id: string; page: string; name: string; bounds: Bounds }

export type CanvasAnnotations = { comments: CanvasComment[]; slices: CanvasSlice[] }

const MAX_COMMENTS = 200
const MAX_SLICES = 64
const EMPTY: CanvasAnnotations = { comments: [], slices: [] }
const stores = new Map<string, CanvasAnnotations>()
const listeners = new Set<() => void>()

function publish() {
  for (const fn of listeners) fn()
}

/** useSyncExternalStore contract: the snapshot is referentially stable until
 * a mutation publishes the next immutable value. */
export function subscribeAnnotations(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function annotationsFor(documentId: string): CanvasAnnotations {
  return stores.get(documentId) ?? EMPTY
}

export function addComment(documentId: string, page: string, point: Point): CanvasComment {
  const entry = annotationsFor(documentId)
  if (entry.comments.length >= MAX_COMMENTS) throw new Error(`评论最多支持 ${MAX_COMMENTS} 条`)
  const comment: CanvasComment = { id: uid(), page, x: point.x, y: point.y, text: '', createdAt: Date.now() }
  stores.set(documentId, { ...entry, comments: [...entry.comments, comment] })
  publish()
  return comment
}

export function updateComment(documentId: string, id: string, text: string) {
  const entry = annotationsFor(documentId)
  if (!entry.comments.some((c) => c.id === id)) return
  stores.set(documentId, {
    ...entry,
    comments: entry.comments.map((c) => (c.id === id ? { ...c, text } : c)),
  })
  publish()
}

export function removeComment(documentId: string, id: string) {
  const entry = annotationsFor(documentId)
  stores.set(documentId, { ...entry, comments: entry.comments.filter((c) => c.id !== id) })
  publish()
}

export function addSlice(documentId: string, page: string, bounds: Bounds): CanvasSlice {
  const entry = annotationsFor(documentId)
  if (entry.slices.length >= MAX_SLICES) throw new Error(`切片最多支持 ${MAX_SLICES} 个`)
  const slice: CanvasSlice = {
    id: uid(),
    page,
    name: `切片 ${entry.slices.length + 1}`,
    bounds: { ...bounds },
  }
  stores.set(documentId, { ...entry, slices: [...entry.slices, slice] })
  publish()
  return slice
}

export function removeSlice(documentId: string, id: string) {
  const entry = annotationsFor(documentId)
  stores.set(documentId, { ...entry, slices: entry.slices.filter((s) => s.id !== id) })
  publish()
}
