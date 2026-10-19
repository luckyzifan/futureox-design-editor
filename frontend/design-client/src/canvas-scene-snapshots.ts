import type { Bounds, DesignDocument } from './model'
import { scene, SpatialIndex, unionBounds, type SceneEntry } from './geometry'
import { pickingGeometryEpoch } from './kernel/picking'

type SnapshotKey = {
  document: DesignDocument
  nodes: DesignDocument['nodes']
  pages: DesignDocument['pages']
  fonts: DesignDocument['fonts']
  pageId: string
  geometryEpoch: object
}

function key(document: DesignDocument, pageId: string): SnapshotKey {
  return { document, nodes: document.nodes, pages: document.pages, fonts: document.fonts,
    pageId, geometryEpoch: pickingGeometryEpoch() }
}

function matches(a: SnapshotKey, b: SnapshotKey) {
  return a.document === b.document && a.nodes === b.nodes && a.pages === b.pages &&
    a.fonts === b.fonts && a.pageId === b.pageId && a.geometryEpoch === b.geometryEpoch
}

function rootOverview(entries: readonly SceneEntry[]): Bounds {
  // Keep the original root order and floating-point evaluation unchanged.
  return unionBounds(entries.filter(entry => entry.depth === 0).map(entry => entry.bounds))
}

class CanvasSceneSnapshot {
  private spatialIndex?: SpatialIndex
  private rootBounds?: Bounds
  private readonly sceneEntries: SceneEntry[]
  constructor(readonly key: SnapshotKey) {
    this.sceneEntries = scene(key.document, key.pageId)
  }
  get entries(): readonly SceneEntry[] { return this.sceneEntries }
  get index() { return this.spatialIndex ??= new SpatialIndex(this.sceneEntries) }
  get overview() { return this.rootBounds ??= rootOverview(this.entries) }
}

/** Canvas-only reuse of published Editor snapshots, never mutable edit drafts.
 * Editor publishes copy-on-write documents; previews, history and imports replace
 * the document rather than mutate it. The identity guards also catch replacement
 * of its top-level containers. They do not make arbitrary mutable inputs safe.
 *
 * Retention is exactly two active scene slots, current and displayed, matching
 * Canvas's existing scene/index owners. No WeakMap, undo-history cache or extra
 * refine scene is retained. A standalone refine overview keeps only its key and
 * four-number Bounds; its temporary scene is released after the calculation.
 * Consumers only read entries and indexes (query returns a new array).
 */
export class CanvasSceneSnapshots {
  private owner?: object
  private session?: number
  private pageId?: string
  private ready?: boolean
  private current?: CanvasSceneSnapshot
  private displayed?: CanvasSceneSnapshot
  private refine?: { key: SnapshotKey; overview: Bounds }

  begin(owner: object, session: number, pageId: string, ready: boolean) {
    if (owner !== this.owner || session !== this.session || pageId !== this.pageId || ready !== this.ready) {
      this.current = this.displayed = undefined
      this.refine = undefined
      this.owner = owner; this.session = session; this.pageId = pageId; this.ready = ready
    }
  }

  private find(next: SnapshotKey) {
    return this.current && matches(this.current.key, next) ? this.current
      : this.displayed && matches(this.displayed.key, next) ? this.displayed : undefined
  }

  currentScene(document: DesignDocument, pageId: string) {
    const next = key(document, pageId)
    // Publish only a completely built scene. A throwing build leaves no partial
    // scene or index available to another owner.
    return this.current = this.find(next) ?? new CanvasSceneSnapshot(next)
  }

  displayedScene(document: DesignDocument | undefined, pageId: string | undefined) {
    if (!document || pageId === undefined) { this.displayed = undefined; return null }
    const next = key(document, pageId)
    return this.displayed = this.find(next) ?? new CanvasSceneSnapshot(next)
  }

  refineOverview(document: DesignDocument, pageId: string) {
    const next = key(document, pageId)
    if (this.refine && matches(this.refine.key, next)) return this.refine.overview
    const active = this.find(next)
    const overview = active ? active.overview : rootOverview(scene(document, pageId))
    this.refine = { key: next, overview }
    return overview
  }
}
