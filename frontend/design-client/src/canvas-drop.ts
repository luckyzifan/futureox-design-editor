import { allParents, apply, bounds, boxPoints, inverse, multiply, worldMatrix, type ParentMap } from './geometry'
import { kernelFillWorld } from './kernel/picking'
import { interactivePath } from './selection-hierarchy'
import type { DesignDocument, Point } from './model'

export type CanvasDropIndex = { document: string; page: string; parents: ParentMap; frames: { id:string; ancestors:string[] }[] }
/** A gesture fixes hierarchy eligibility. Geometry and visibility remain live:
 * moving layout children can resize their stationary parent frame. */
export function createCanvasDropIndex(doc: DesignDocument, page: string, parents: ParentMap = allParents(doc)): CanvasDropIndex {
  const frames: CanvasDropIndex['frames'] = []
  const seen = new Set<string>(), ancestors: string[] = []
  const visit = (id: string) => {
    const node = doc.nodes[id]
    if (!node || seen.has(id)) return
    seen.add(id)
    // Store paths for drop targets. Ordinary descendants can use the same
    // traversal stack, even in documents with many nested instance layers.
    if (node.kind === 'frame' || node.kind === 'section') frames.push({ id, ancestors: [...ancestors] })
    if (!node.children.length) return
    ancestors.push(id)
    for (const child of node.children) visit(child)
    ancestors.pop()
  }
  for (const id of doc.pages.find(p => p.id === page)?.children ?? []) visit(id)
  return {document:doc.id,page,parents,frames:frames.reverse()}
}
/** Frame-local geometry handles rotation. The optional gesture index avoids a
 * full scene walk on every pointermove; it never caches camera-space pixels. */
export function canvasDropFrame(doc: DesignDocument, page: string, roots: readonly string[], point: Point, force = false, index?: CanvasDropIndex,
  { pruneClippedRoots = false, allowOversize = false }: { pruneClippedRoots?: boolean; allowOversize?: boolean } = {}): string | undefined {
  const indexed=index?.document===doc.id&&index.page===page?index:createCanvasDropIndex(doc,page)
  const moving=new Set(roots),parents=indexed.parents
  let lastRoot: string | undefined, outsideRoot = false
  for(const entry of indexed.frames) {
    if (pruneClippedRoots) {
      // The painter-ordered index keeps each page root's entries consecutive.
      // Its own clip rejects every nested drop target outside it.
      const rootId = entry.ancestors[0] ?? entry.id
      if (rootId !== lastRoot) {
        lastRoot = rootId
        const root = doc.nodes[rootId]
        outsideRoot = moving.has(rootId) || !!root?.clip && !kernelFillWorld(root, point, worldMatrix(doc, rootId, parents), 1)
      }
      if (outsideRoot) continue
    }
    const n=doc.nodes[entry.id]
    if(!n || moving.has(n.id) || entry.ancestors.some(id=>moving.has(id)))continue
    const path=interactivePath(doc,page,n.id,false,parents)
    if(!path.length || path.some(id=>doc.nodes[id].instance || doc.nodes[id].instanceOrigin))continue
    const world=worldMatrix(doc,n.id,parents),inv=inverse(world),local=apply(inv,point)
    if(local.x<0||local.y<0||local.x>n.width||local.y>n.height)continue
    if(!kernelFillWorld(n,point,world,1))continue
    if(entry.ancestors.some(id=>doc.nodes[id].clip&&!kernelFillWorld(doc.nodes[id],point,worldMatrix(doc,id,parents),1)))continue
    if(!force&&!allowOversize&&roots.some(id=>{
      const child=doc.nodes[id],matrix=multiply(inv,worldMatrix(doc,id,parents))
      const size=bounds(boxPoints({x:0,y:0,width:child.width,height:child.height}).map(p=>apply(matrix,p)))
      return size.width>n.width+1e-9||size.height>n.height+1e-9
    }))continue
    return n.id
  }
}
export function containingFrame(doc: DesignDocument,id:string,parents:ParentMap=allParents(doc)):string|undefined {
  for(let at=parents.get(id);at&&doc.nodes[at];at=parents.get(at))if(['frame','section'].includes(doc.nodes[at].kind))return at
}
/** A canvas move edits a member of a group/boolean in that container. Crossing
 * an enclosing frame must not silently extract it and append it above siblings.
 * Explicit forced placement and dragging a whole container still use frame drops. */
export function canvasMoveKeepsContainer(doc:DesignDocument,id:string,force:boolean,parents:ParentMap):boolean {
  const parent=doc.nodes[parents.get(id)!]
  return !force && !!parent && parent.kind!=='frame' && parent.kind!=='section'
}
export function insideParentFrame(doc: DesignDocument,id:string,point:Point,parents:ParentMap=allParents(doc)):boolean {
  const frame=containingFrame(doc,id,parents)
  return !!frame&&kernelFillWorld(doc.nodes[frame],point,worldMatrix(doc,frame,parents),1)
}
