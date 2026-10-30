import type {GpuNode,GpuScene,Rect} from './types'
const contains=(a:Rect,b:Rect)=>a.x<=b.x&&a.y<=b.y&&a.x+a.w>=b.x+b.w&&a.y+a.h>=b.y+b.h
/** Removing an isolation surface is exact only when each pixel sees at most
 * one independent child. Do not invoke approximate alpha associativity. */
export function disjointNeutralGroup(scene:GpuScene,n:GpuNode,clip?:{opaqueInterior?:Rect}) {
  if(n.opacity!==1||n.blend!=='normal'||n.passthrough||n.mask||n.maskId||
    n.fills.length||n.strokes.length||n.effects.length||!n.children.length||n.children.length>16||
    clip&&(!clip.opaqueInterior||!contains(clip.opaqueInterior,n.rect)))return false
  const children=n.children.map(id=>scene.nodes[id]).filter(c=>c&&c.opacity>0)
  if(children.some(c=>c.mask||c.passthrough||c.blend!=='normal'||!contains(n.rect,c.rect)||
    c.effects.some(e=>e.visible&&(e.kind==='glass'||e.kind==='background-blur'))))return false
  for(let i=0;i<children.length;i++)for(let j=0;j<i;j++){
    const a=children[i].rect,b=children[j].rect
    if(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h)return false
  }
  return true
}
