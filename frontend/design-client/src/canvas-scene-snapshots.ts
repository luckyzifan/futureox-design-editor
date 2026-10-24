import type { Bounds, DesignDocument } from './model'
import { scene, SpatialIndex, unionBounds, type SceneEntry } from './geometry'
import { pickingGeometryEpoch } from './kernel/picking'
import { documentPatch } from './document-patch'

type SnapshotKey = {
  document: DesignDocument
  nodes: DesignDocument['nodes']
  pages: DesignDocument['pages']
  fonts: DesignDocument['fonts']
  pageId: string
  geometryEpoch: object
}

/** A borrow of Canvas's existing published-snapshot slots, not another cache.
 * Reading never builds geometry or retains an evicted scene. Only Canvas's
 * immutable Editor publication path may issue this capability. */
export type CanvasSceneBorrow = {
  entriesFor(document: DesignDocument, pageId: string, epoch: number): readonly SceneEntry[] | undefined
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
  private readonly rootForId = new Map<string,string>()
  private readonly islands = new Map<string,SceneEntry[]>()
  constructor(readonly key: SnapshotKey, previous?: CanvasSceneSnapshot) {
    const incremental = previous && previous.key.pageId===key.pageId && previous.key.pages===key.pages &&
      previous.key.fonts===key.fonts && previous.key.geometryEpoch===key.geometryEpoch
        ? this.changedRoots(previous) : undefined
    if (incremental && previous) {
      const rebuilt = scene(key.document,key.pageId,incremental), islands = new Map<string,SceneEntry[]>()
      for(const entry of rebuilt){const root=entry.ancestors[0]||entry.id;const list=islands.get(root)||[];list.push(entry);islands.set(root,list)}
      this.sceneEntries = key.document.pages.find(p=>p.id===key.pageId)!.children.flatMap(root =>
        incremental.has(root) ? islands.get(root)||[] : previous.islands.get(root)||[])
      if(previous.spatialIndex)this.spatialIndex=new SpatialIndex(this.sceneEntries,previous.spatialIndex)
    } else this.sceneEntries = scene(key.document, key.pageId)
    for(const entry of this.sceneEntries){const root=entry.ancestors[0]||entry.id;this.rootForId.set(entry.id,root);const list=this.islands.get(root)||[];list.push(entry);this.islands.set(root,list)}
  }
  private changedRoots(previous:CanvasSceneSnapshot):Set<string>|undefined {
    const before=previous.key.document, after=this.key.document
    if(before.id!==after.id)return
    const patch=documentPatch(before,after)
    if(Object.keys(patch.fields).some(key=>!['name','schemaVersion'].includes(key)))return
    const roots=new Set<string>()
    for(const id of Object.keys(patch.nodes)){
      const a=before.nodes[id],b=after.nodes[id],root=previous.rootForId.get(id)
      if(!a||!b||!root||a.children.length!==b.children.length||a.children.some((child,i)=>child!==b.children[i]))return
      roots.add(root)
    }
    return roots
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
  private borrowScope: object = {}
  private current?: CanvasSceneSnapshot
  private displayed?: CanvasSceneSnapshot
  private refine?: { key: SnapshotKey; overview: Bounds }

  begin(owner: object, session: number, pageId: string, ready: boolean) {
    if (owner !== this.owner || session !== this.session || pageId !== this.pageId || ready !== this.ready) {
      this.borrowScope = {}
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
    return this.current = this.find(next) ?? new CanvasSceneSnapshot(next,this.current)
  }

  /** Borrow only a scene already built for this published current document.
   * Keep the key and scope token, never the snapshot/entries: a later read
   * succeeds only while the same scene is still in one of the original slots.
   * Session/page/readiness ABA and font installation revoke old borrows. */
  borrowCurrentScene(document: DesignDocument, pageId: string, epoch: number): CanvasSceneBorrow | undefined {
    if (!this.ready || this.session !== epoch || this.pageId !== pageId) return
    const expected = key(document, pageId)
    if (!this.current || !matches(this.current.key, expected)) return
    const scope = this.borrowScope
    return { entriesFor: (nextDocument, nextPageId, nextEpoch) => {
      if (this.borrowScope !== scope || !this.ready || this.session !== epoch || nextEpoch !== epoch ||
          this.pageId !== pageId || nextPageId !== pageId || !matches(expected, key(nextDocument, nextPageId))) return
      return this.find(expected)?.entries
    } }
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
