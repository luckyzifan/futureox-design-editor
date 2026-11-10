import type { DesignDocument, DesignNode } from '../model'
import { produceDocumentDraft, shareDocument } from '../document-patch'
import { connectorIntoSubtree } from '../page-edit-scope'
import { kernelLayout, pickingGeometryEpoch } from './picking'

/** One pointer transaction owns this topology. Dimensions still pass through
 * the existing Rust layout/constraint/Boolean resolver, on complete independent
 * root islands. Cross-island dependencies always retain the full route. */
export class PreviewLayout {
  private roots = new Map<string, string>()
  private eligible = true
  private epoch = pickingGeometryEpoch()
  private subset?: {key:string;document:DesignDocument}
  private blockedRoots = new Set<string>()
  constructor(readonly base: DesignDocument) {
    if (base.animations?.length || base.prototype || base.reviews?.length) this.eligible = false
    const bad = new Set<string>()
    for (const n of Object.values(base.nodes)) {
      if (n.component || n.componentSet || n.instance || n.instanceOrigin || n.componentKey != null ||
          n.connector || n.textPath || n.repeat || n.board || n.booleanOperation ||
          Object.keys(n.bindings || {}).length || Object.keys(n.styleRefs || {}).length ||
          Object.keys(n.variableModes || {}).length) bad.add(n.id)
    }
    if (!this.eligible) return
    const visit = (id: string, root: string) => {
      this.roots.set(id, root)
      if (bad.has(id)) this.blockedRoots.add(root)
      base.nodes[id]?.children.forEach(child => visit(child, root))
    }
    base.pages.forEach(page => page.children.forEach(root => visit(root, root)))
  }
  prepare(patches: Record<string, Partial<DesignNode>>): DesignDocument | undefined {
    if (!this.eligible || this.epoch !== pickingGeometryEpoch()) return
    const ids = Object.keys(patches)
    if (!ids.length || ids.some(id => !this.roots.has(id) || this.blockedRoots.has(this.roots.get(id)!) ||
      Object.keys(patches[id]).some(key => !['transform','width','height'].includes(key)))) return
    // The island dropped from this subset does not include a wire that lives
    // outside it and names a descendant. That wire has to take the full route.
    if (connectorIntoSubtree(this.base, ids)) return
    const roots = new Set(ids.map(id => this.roots.get(id)!)), nodes: DesignDocument['nodes'] = {}
    const key=JSON.stringify([...roots].sort())
    const include = (id: string) => {
      nodes[id] = patches[id] ? { ...this.base.nodes[id], ...patches[id] } : this.base.nodes[id]
      nodes[id].children.forEach(include)
    }
    roots.forEach(include)
    const pages = this.base.pages.map(page => {
      const children = page.children.filter(id => roots.has(id))
      return children.length === page.children.length ? page : { ...page, children }
    })
    const subset = { ...this.base, nodes,
      pages: pages.every((page,index) => page === this.base.pages[index]) ? this.base.pages : pages,
      // A partial island must not enter the resident component resolver.
      designSystem: undefined, prototype: undefined, animations: undefined }
    if(this.subset?.key!==key)this.subset={key,document:{...subset,nodes:Object.fromEntries(Object.keys(nodes).map(id=>[id,this.base.nodes[id]]))}}
    // Keep the established exact rigid-translation proof before the scoped
    // resolver. Otherwise an unrelated Boolean in the same root forces a
    // full native resolve for each move despite unchanged geometry/layout.
    // Resizes, constraints that are not fixed points, and affine changes keep
    // their original full authoritative resolution.
    // Affine/size changes still run authoritative layout. They may diff the
    // complete known resident component snapshot instead of serializing and
    // resolving this whole island again at pointer-up. The resolver's private
    // receipt, full diff and stale-receipt fallback remain authoritative.
    const resolved = kernelLayout(subset,this.subset.document,true)
    const changed: DesignDocument['nodes'] = {}
    for (const [id,n] of Object.entries(resolved.nodes)) if (n !== this.base.nodes[id]) changed[id] = n
    // These are already resolved authored records, not native transport
    // patches. Transport normalization drops explicit null optionals and
    // turns a pure pose into a content edit. Preserve the complete shape and
    // establish the usual producer witness for only these changed records.
    return shareDocument(this.base, produceDocumentDraft(this.base, draft => {
      for (const [id, n] of Object.entries(changed)) draft.nodes[id] = n
    }))
  }
}
