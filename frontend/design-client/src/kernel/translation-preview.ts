import type { ConstraintAnchor, DesignDocument, DesignNode } from '../model'
import { connectorIntoSubtree, snapshotParents, snapshotTargets } from '../page-edit-scope'

const hasReferences = (node: DesignNode, booleanGeometry = true) =>
  !!(node.component || node.componentSet || node.componentKey != null || node.instance ||
    node.instanceOrigin || (booleanGeometry && node.booleanOperation) || Object.keys(node.bindings || {}).length ||
    Object.keys(node.styleRefs || {}).length || Object.keys(node.variableModes || {}).length)

const anchors: readonly ConstraintAnchor[] = ['start', 'center', 'end', 'stretch', 'scale']
function constrainedAxis(position: number, size: number, old: number, next: number, mode: ConstraintAnchor): readonly [number, number] {
  // Preserve layout.rs::anchor's operation order, including End cancellation
  // and Stretch/Scale's minimum. Equal reference extents alone are insufficient.
  switch (mode) {
    case 'start': return [position, size]
    case 'center': return [position + (next - old) / 2, size]
    case 'end': return [position + next - old, size]
    case 'stretch': return [position, Math.max(size + next - old, 0.01)]
    case 'scale': return [position * (next / old), Math.max(size * (next / old), 0.01)]
  }
}
function fixedConstraints(node: DesignNode, parent: DesignNode | undefined, pageRoot: boolean): boolean {
  const c = node.constraints
  if (!c) return true
  if (!anchors.includes(c.horizontal) || !anchors.includes(c.vertical)) return false
  for (const reference of [c.referenceWidth, c.referenceHeight])
    if (reference != null && (!Number.isFinite(reference) || reference < 0.01 || reference > 1e7)) return false
  // Rust constrains a node's children, not page roots. Do not confuse a known
  // root with an orphan; root reference fields remain untouched by that solver.
  if (!parent) return pageRoot
  if (typeof c.referenceWidth !== 'number' || typeof c.referenceHeight !== 'number' ||
      !Object.is(c.referenceWidth, parent.width) || !Object.is(c.referenceHeight, parent.height)) return false
  const x = node.transform[4], y = node.transform[5]
  if ([x, y, node.width, node.height].some(value => !Number.isFinite(value) || Object.is(value, -0))) return false
  const [nx, width] = constrainedAxis(x, node.width, c.referenceWidth, parent.width, c.horizontal)
  const [ny, height] = constrainedAxis(y, node.height, c.referenceHeight, parent.height, c.vertical)
  return Object.is(nx, x) && Object.is(ny, y) && Object.is(width, node.width) && Object.is(height, node.height)
}

/** The editor's published-snapshot index. Child links, repeat presence and
 * global pose dependencies come from the same traversal as the picking map. */
export class PoseTopology implements ReadonlyMap<string, string> {
  readonly #source: WeakRef<DesignDocument>
  readonly #parents = new Map<string, string>()
  readonly #pages = new Set<string>()
  readonly hasSketchMasks: boolean
  readonly hasRepeats: boolean
  readonly permitsPose: boolean
  constructor(document: DesignDocument) {
    this.#source = new WeakRef(document)
    let repeats = false, sketchMasks = false, valid = true
    for (const page of document.pages) {
      if (document.nodes[page.id] || this.#pages.has(page.id)) valid = false
      this.#pages.add(page.id)
      for (const id of page.children) {
        if (this.#parents.has(id) || !document.nodes[id]) valid = false
        this.#parents.set(id, page.id)
      }
    }
    for (const node of Object.values(document.nodes)) {
      repeats ||= node.repeat !== undefined
      sketchMasks ||= node.mask && (node.maskType === 'shape' || node.maskChain !== undefined)
      // A connector or code block elsewhere does not make every pose depend on
      // it. Endpoint attachment is rejected from the transformed subtree;
      // code highlighting does not read this transform.
      for (const child of node.children) {
        if (this.#parents.has(child) || !document.nodes[child]) valid = false
        this.#parents.set(child, node.id)
      }
    }
    this.hasSketchMasks = sketchMasks
    this.hasRepeats = repeats
    this.permitsPose = valid
    Object.freeze(this)
  }
  get size() { return this.#parents.size }
  get(id: string) { return this.#parents.get(id) }
  has(id: string) { return this.#parents.has(id) }
  keys() { return this.#parents.keys() }
  values() { return this.#parents.values() }
  entries() { return this.#parents.entries() }
  [Symbol.iterator]() { return this.entries() }
  forEach(fn: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown) {
    this.#parents.forEach((value, key) => fn.call(thisArg, value, key, this))
  }
  matches(document: DesignDocument) { return this.#source.deref() === document }
  isRoot(id: string) { const parent = this.get(id); return parent !== undefined && this.#pages.has(parent) }
  nodeParent(id: string) { return this.isRoot(id) ? undefined : this.get(id) }
}

/** Internal immutable pointer-transaction plan. Topology/dependency admission
 * is done once; each pose still evaluates the exact constraint fixed point.
 * The Editor owns its base and revokes it on content/font/transaction changes. */
export class TranslationPreviewPlan {
  private readonly ids:readonly string[]
  private valid=true
  private readonly topology: PoseTopology
  readonly booleanRoots = new Set<string>()
  constructor(readonly base:DesignDocument,ids:readonly string[],topology=new PoseTopology(base),
    purpose:'pixels'|'document-pose'='pixels'){
    this.topology=topology;this.ids=[...ids]
    if(!topology.matches(base)||!topology.permitsPose||base.animations?.length||!ids.length||new Set(ids).size!==ids.length||snapshotTargets(base,ids)||connectorIntoSubtree(base,ids))this.valid=false
    for(const id of ids){const seen=new Set<string>();let at:string|undefined=id
      let booleanRoot:string|undefined
      const documentLeaf=purpose==='document-pose'&&base.nodes[id]?.children.length===0
      while(at){const n=base.nodes[at]
        if(seen.has(at)||!n||hasReferences(n,!documentLeaf||at===id)||n.layout&&n.layout.mode!=='none'||n.sizing&&(n.sizing.width!=='fixed'||n.sizing.height!=='fixed')){this.valid=false;break}
        if(n.booleanOperation)booleanRoot=at
        seen.add(at);at=topology.nodeParent(at)
      }
      if(booleanRoot)this.booleanRoots.add(booleanRoot)
    }
  }
  accepts(patches:Readonly<Record<string,Partial<DesignNode>>>){
    return this.acceptsTransform(patches,false)
  }
  /** Only the native pose lane consumes this proof. A changed linear part
   * still requires fresh native device coverage; it never admits bitmap or
   * translation-only geometry reuse. Constraints use the same exact solver. */
  acceptsAffine(patches:Readonly<Record<string,Partial<DesignNode>>>){
    return this.acceptsTransform(patches,true)
  }
  private acceptsTransform(patches:Readonly<Record<string,Partial<DesignNode>>>,affine:boolean){
    if(!this.valid||Object.keys(patches).length!==this.ids.length)return false
    for(const id of this.ids){const before=this.base.nodes[id],patch=patches[id],m=patch?.transform
      if(!before||!m||Object.keys(patch).some(key=>key!=='transform')||m.length!==6||m.some(v=>!Number.isFinite(v)||Math.abs(v)>1e7)||!affine&&m.slice(0,4).some((v,i)=>!Object.is(v,before.transform[i])))return false
      let at:string|undefined=id
      while(at){const source=this.base.nodes[at],parentId=this.topology.nodeParent(at),parent=parentId?this.base.nodes[parentId]:undefined
        const node=patches[at]?.transform?{...source,transform:patches[at].transform!}:source
        const parentNode=parent&&patches[parent.id]?.transform?{...parent,transform:patches[parent.id].transform!}:parent
        if(!fixedConstraints(node,parentNode,this.topology.isRoot(at)))return false
        at=parentId
      }
    }
    return true
  }
}

/** A placement-only preview over an already resolved immutable document.
 * Returns null whenever layout or another node's derived geometry may depend
 * on the change. Opaque format metadata can remain in the same design system.
 */
export function translationOnlyChanges(previous: DesignDocument, next: DesignDocument): string[] | null {
  const previousFields = Object.keys(previous)
  if (previousFields.length !== Object.keys(next).length || previousFields.some(key =>
    !Object.hasOwn(next, key) ||
    (key !== 'nodes' && previous[key as keyof DesignDocument] !== next[key as keyof DesignDocument]))) return null
  if (next.animations?.length) return null
  const ids = Object.keys(next.nodes)
  if (ids.length !== Object.keys(previous.nodes).length || ids.some(id => !previous.nodes[id])) return null
  const changed: string[] = []
  const parents = snapshotParents(previous)
  const pages = new Set(next.pages.map(page => page.id))
  for (const id of ids) {
    const node = next.nodes[id], before = previous.nodes[id]
    if (node === before) continue
    const fields = Object.keys(before)
    if (fields.length !== Object.keys(node).length || fields.some(key =>
      !Object.hasOwn(node, key) ||
      (key !== 'transform' && before[key as keyof DesignNode] !== node[key as keyof DesignNode]))) return null
    if (node.transform.length !== 6 || node.transform.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7) ||
      node.transform.slice(0, 4).some((value, index) => !Object.is(value, before.transform[index]))) return null
    if (node.children.length !== before.children.length || node.children.some((child, index) => child !== before.children[index])) return null
    changed.push(id)
  }
  if (snapshotTargets(previous, changed) || connectorIntoSubtree(previous, changed)) return null
  for (const id of changed) {
    const seen = new Set<string>()
    let at: string | undefined = id
    while (at && next.nodes[at]) {
      if (seen.has(at)) return null
      seen.add(at)
      const node = next.nodes[at]
      const parentId = parents.get(at)
      const parent = parentId ? next.nodes[parentId] : undefined
      if (!node || node.connector || (node.board?.kind === 'code-block' && node.board.language) ||
        hasReferences(node) || !fixedConstraints(node, parent, !parent && !!parentId && pages.has(parentId)) ||
        (node.layout && node.layout.mode !== 'none') ||
        (node.sizing && (node.sizing.width !== 'fixed' || node.sizing.height !== 'fixed'))) return null
      at = parent ? parentId : undefined
    }
  }
  return changed
}
