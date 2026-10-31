import type { ConstraintAnchor, DesignDocument, DesignNode } from '../model'

const hasReferences = (node: DesignNode) =>
  !!(node.component || node.componentSet || node.componentKey != null || node.instance ||
    node.instanceOrigin || node.booleanOperation || Object.keys(node.bindings || {}).length ||
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

/** Internal immutable pointer-transaction plan. Topology/dependency admission
 * is done once; each pose still evaluates the exact constraint fixed point.
 * The Editor owns its base and revokes it on content/font/transaction changes. */
export class TranslationPreviewPlan {
  private readonly parents=new Map<string,string>()
  private readonly roots=new Set<string>()
  private readonly ids:readonly string[]
  private valid=true
  constructor(readonly base:DesignDocument,ids:readonly string[]){
    this.ids=[...ids]
    if(base.animations?.length||!ids.length||new Set(ids).size!==ids.length)this.valid=false
    base.pages.forEach(page=>page.children.forEach(id=>this.roots.add(id)))
    for(const node of Object.values(base.nodes)){
      if(node.connector||node.board?.kind==='code-block'&&node.board.language)this.valid=false
      for(const child of node.children){if(!base.nodes[child]||this.parents.has(child))this.valid=false;this.parents.set(child,node.id)}
    }
    for(const id of ids){const seen=new Set<string>();let at:string|undefined=id
      while(at){const n=base.nodes[at];if(seen.has(at)||!n||hasReferences(n)||n.layout&&n.layout.mode!=='none'||n.sizing&&(n.sizing.width!=='fixed'||n.sizing.height!=='fixed')){this.valid=false;break}seen.add(at);at=this.parents.get(at)}
    }
  }
  accepts(patches:Readonly<Record<string,Partial<DesignNode>>>){
    if(!this.valid||Object.keys(patches).length!==this.ids.length)return false
    for(const id of this.ids){const before=this.base.nodes[id],patch=patches[id],m=patch?.transform
      if(!before||!m||Object.keys(patch).some(key=>key!=='transform')||m.length!==6||m.some(v=>!Number.isFinite(v)||Math.abs(v)>1e7)||m.slice(0,4).some((v,i)=>!Object.is(v,before.transform[i])))return false
      let at:string|undefined=id
      while(at){const source=this.base.nodes[at],parentId=this.parents.get(at),parent=parentId?this.base.nodes[parentId]:undefined
        const node=patches[at]?.transform?{...source,transform:patches[at].transform!}:source
        const parentNode=parent&&patches[parent.id]?.transform?{...parent,transform:patches[parent.id].transform!}:parent
        if(!fixedConstraints(node,parentNode,this.roots.has(at)))return false
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
  const parents = new Map<string, string>()
  const pageRoots = new Set(next.pages.flatMap(page => page.children))
  for (const id of ids) {
    const node = next.nodes[id], before = previous.nodes[id]
    if (node.connector || (node.board?.kind === 'code-block' && node.board.language)) return null
    for (const child of node.children) {
      if (!next.nodes[child] || parents.has(child)) return null
      parents.set(child, id)
    }
    if (node === before) continue
    const fields = Object.keys(before)
    if (fields.length !== Object.keys(node).length || fields.some(key =>
      !Object.hasOwn(node, key) ||
      (key !== 'transform' && before[key as keyof DesignNode] !== node[key as keyof DesignNode]))) return null
    if (node.transform.length !== 6 || node.transform.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7) ||
      node.transform.slice(0, 4).some((value, index) => !Object.is(value, before.transform[index]))) return null
    changed.push(id)
  }
  for (const id of changed) {
    const seen = new Set<string>()
    let at: string | undefined = id
    while (at) {
      if (seen.has(at)) return null
      seen.add(at)
      const node: DesignNode | undefined = next.nodes[at]
      const parentId = parents.get(at)
      if (!node || hasReferences(node) || !fixedConstraints(node, parentId ? next.nodes[parentId] : undefined, pageRoots.has(at)) ||
        (node.layout && node.layout.mode !== 'none') ||
        (node.sizing && (node.sizing.width !== 'fixed' || node.sizing.height !== 'fixed'))) return null
      at = parentId
    }
  }
  return changed
}
