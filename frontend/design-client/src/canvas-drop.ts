import { allParents, apply, bounds, boxPoints, inverse, multiply, worldMatrix } from './geometry'
import { kernelFillWorld } from './kernel/picking'
import { interactivePath } from './selection-hierarchy'
import type { DesignDocument, Point } from './model'

export type CanvasDropIndex = { document: string; page: string; parents: Map<string,string>; frames: { id:string; ancestors:string[] }[] }
/** A gesture fixes hierarchy eligibility. Geometry and visibility remain live:
 * moving layout children can resize their stationary parent frame. */
export function createCanvasDropIndex(doc: DesignDocument, page: string): CanvasDropIndex {
  const parents=allParents(doc),frames:CanvasDropIndex['frames']=[],seen=new Set<string>()
  const visit=(id:string,ancestors:string[])=>{
    const n=doc.nodes[id];if(!n||seen.has(id))return;seen.add(id)
    if(['frame','section'].includes(n.kind))frames.push({id,ancestors})
    n.children.forEach(child=>visit(child,[...ancestors,id]))
  }
  doc.pages.find(p=>p.id===page)?.children.forEach(id=>visit(id,[]))
  return {document:doc.id,page,parents,frames:frames.reverse()}
}
/** Frame-local geometry handles rotation. The optional gesture index avoids a
 * full scene walk on every pointermove; it never caches camera-space pixels. */
export function canvasDropFrame(doc: DesignDocument, page: string, roots: readonly string[], point: Point, force = false, index?: CanvasDropIndex): string | undefined {
  const indexed=index?.document===doc.id&&index.page===page?index:createCanvasDropIndex(doc,page)
  const moving=new Set(roots),parents=indexed.parents
  for(const entry of indexed.frames) {
    const n=doc.nodes[entry.id]
    if(!n || moving.has(n.id) || entry.ancestors.some(id=>moving.has(id)))continue
    const path=interactivePath(doc,page,n.id,false,parents)
    if(!path.length || path.some(id=>doc.nodes[id].instance || doc.nodes[id].instanceOrigin))continue
    const world=worldMatrix(doc,n.id,parents),inv=inverse(world),local=apply(inv,point)
    if(local.x<0||local.y<0||local.x>n.width||local.y>n.height)continue
    if(!kernelFillWorld(n,point,world,1))continue
    if(entry.ancestors.some(id=>doc.nodes[id].clip&&!kernelFillWorld(doc.nodes[id],point,worldMatrix(doc,id,parents),1)))continue
    if(!force&&roots.some(id=>{
      const child=doc.nodes[id],matrix=multiply(inv,worldMatrix(doc,id,parents))
      const size=bounds(boxPoints({x:0,y:0,width:child.width,height:child.height}).map(p=>apply(matrix,p)))
      return size.width>n.width+1e-9||size.height>n.height+1e-9
    }))continue
    return n.id
  }
}
export function containingFrame(doc: DesignDocument,id:string,parents=allParents(doc)):string|undefined {
  for(let at=parents.get(id);at&&doc.nodes[at];at=parents.get(at))if(['frame','section'].includes(doc.nodes[at].kind))return at
}
export function insideParentFrame(doc: DesignDocument,id:string,point:Point,parents=allParents(doc)):boolean {
  const frame=containingFrame(doc,id,parents)
  return !!frame&&kernelFillWorld(doc.nodes[frame],point,worldMatrix(doc,frame,parents),1)
}
