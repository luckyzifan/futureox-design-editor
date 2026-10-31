import type { GpuNode, Rect } from './types'
import { intersect } from './types'

export const SOLID_INSTANCE_FLOATS = 20
export const MAX_SOLID_INSTANCES = 20000

export function batchableSolid(n: GpuNode | undefined): n is GpuNode {
  const p=n?.fills[0]
  return !!n && n.opacity===1 && n.blend==='normal' && !n.children.length &&
    !n.effects.length && !n.strokes.length && n.fills.length===1 &&
    !!p?.visible && p.kind==='solid' && p.opacity===1 && p.blend==='normal' &&
    (!!n.fill.analytic || !!n.fill.analyticRect)
}

// Rows: mask rect; analytic first/count/band base/flags; local rectangle edges;
// opaque RGBA; clipped raster quad. Five vec4 rows per instance.
// Preserve input order, including overlapping
// shapes: batching changes submission granularity, not painter order.
export function solidInstances(nodes: GpuNode[], target: Rect): Float32Array {
  if(nodes.length>MAX_SOLID_INSTANCES)throw new Error('GPU solid instance budget exceeded')
  const out:number[]=[]
  for(const n of nodes){
    const path=n.fill,r=path.rect,b=intersect(r,target)
    if(!b.w||!b.h||(!path.analyticRect&&!path.analytic?.count))continue
    const hex=n.fills[0].color
    if(!/^#[0-9a-f]{6}$/i.test(hex))throw new Error('无效颜色')
    // Flag 2 selects exact axis-aligned rectangle coverage. Other bits encode
    // even-odd versus nonzero winding, shared with the single-path shader.
    const flags=(path.rule==='evenodd'?1:0)+(path.analyticRect?2:0)
    const box=path.analyticRect?.map((v,i)=>v-(i%2?r.y:r.x))||[0,0,0,0]
    out.push(r.x,r.y,r.w,r.h,path.analytic?.first||0,path.analytic?.count||0,path.analytic?.bands??-1,flags,...box,
      Number.parseInt(hex.slice(1,3),16)/255,Number.parseInt(hex.slice(3,5),16)/255,Number.parseInt(hex.slice(5,7),16)/255,1,
      b.x,b.y,b.w,b.h)
  }
  return new Float32Array(out)
}
