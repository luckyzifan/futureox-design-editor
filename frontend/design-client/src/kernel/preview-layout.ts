import type { DesignDocument, DesignNode } from '../model'
import { applyDocumentPatch, shareDocument } from '../document-patch'
import { kernelLayout, pickingGeometryEpoch } from './picking'

/** One pointer transaction owns this topology. Dimensions still pass through
 * the existing Rust layout/constraint/Boolean resolver, on complete independent
 * root islands. Cross-island dependencies always retain the full route. */
export class PreviewLayout {
  private roots = new Map<string, string>()
  private eligible = true
  private epoch = pickingGeometryEpoch()
  constructor(readonly base: DesignDocument) {
    if (base.animations?.length || base.prototype || base.reviews?.length) this.eligible = false
    for (const n of Object.values(base.nodes)) {
      if (n.component || n.componentSet || n.instance || n.instanceOrigin || n.componentKey != null ||
          n.connector || n.textPath || n.repeat || n.board || Object.keys(n.bindings || {}).length ||
          Object.keys(n.styleRefs || {}).length || Object.keys(n.variableModes || {}).length) this.eligible = false
    }
    if (!this.eligible) return
    const visit = (id: string, root: string) => { this.roots.set(id, root); base.nodes[id].children.forEach(child => visit(child, root)) }
    base.pages.forEach(page => page.children.forEach(root => visit(root, root)))
  }
  prepare(patches: Record<string, Partial<DesignNode>>): DesignDocument | undefined {
    if (!this.eligible || this.epoch !== pickingGeometryEpoch()) return
    const ids = Object.keys(patches)
    if (!ids.length || ids.some(id => !this.roots.has(id) ||
      Object.keys(patches[id]).some(key => !['transform','width','height'].includes(key)))) return
    const roots = new Set(ids.map(id => this.roots.get(id)!)), nodes: DesignDocument['nodes'] = {}
    const include = (id: string) => {
      nodes[id] = patches[id] ? { ...this.base.nodes[id], ...patches[id] } : this.base.nodes[id]
      nodes[id].children.forEach(include)
    }
    roots.forEach(include)
    const subset = { ...this.base, nodes, pages: this.base.pages.map(page => ({ ...page, children: page.children.filter(id => roots.has(id)) })) }
    const resolved = kernelLayout(subset)
    const changed: DesignDocument['nodes'] = {}
    for (const [id,n] of Object.entries(resolved.nodes)) if (n !== this.base.nodes[id]) changed[id] = n
    return shareDocument(this.base, applyDocumentPatch(this.base, { nodes:changed, fields:{} }))
  }
}
