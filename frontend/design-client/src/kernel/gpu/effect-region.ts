import { intersect, type GpuScene, type Rect } from './types'

/** Integer pixel centres remain exactly representable through both global
 * subtraction and a cropped destination copy. Fractional/large coordinates
 * keep the full-target path: rebasing them can change sampling rounding. */
export function exactBlendLattice(rects: Rect[]): boolean {
  return rects.every(r => Object.values(r).every(v => Number.isInteger(v) && Math.abs(v) <= 1048576))
}

/** Only pixels whose complete filter footprint exists in both captures can
 * reuse the previous result. Keep all four nonoverlapping boundary strips. */
export function backdropOverlap(previous: Rect, next: Rect, support: number) {
  if(!exactBlendLattice([previous,next]) || !Number.isSafeInteger(support) || support<0)return
  const inset=(r:Rect):Rect=>({x:r.x+support,y:r.y+support,w:Math.max(0,r.w-support*2),h:Math.max(0,r.h-support*2)})
  const reuse=intersect(inset(previous),inset(next))
  if(!reuse.w||!reuse.h)return
  const right=next.x+next.w,bottom=next.y+next.h,rx=reuse.x+reuse.w,ry=reuse.y+reuse.h
  const dirty=[{x:next.x,y:next.y,w:next.w,h:reuse.y-next.y},
    {x:next.x,y:ry,w:next.w,h:bottom-ry},
    {x:next.x,y:reuse.y,w:reuse.x-next.x,h:reuse.h},
    {x:rx,y:reuse.y,w:right-rx,h:reuse.h}].filter(r=>r.w>0&&r.h>0)
  return {reuse,dirty:dirty.map(output=>({output,input:intersect(next,
    {x:output.x-support,y:output.y-support,w:output.w+2*support,h:output.h+2*support})}))}
}

export function interactionHalo(scene:GpuScene) {
  const base=scene.output&&!scene.resolve&&!scene.presentation?scene.output:{x:0,y:0,w:scene.width,h:scene.height}
  const extent=scene.extent
  return Math.max(0,base.x-extent.x,base.y-extent.y,
    extent.x+extent.w-base.x-base.w,extent.y+extent.h-base.y-base.h)+2
}

/** Native interactions already shade this visible window plus the compiler's
 * dependency halo. Bound temporary inputs to the same absolute pixel lattice;
 * extra protects filter reads at its edge, never changes raster density. */
export function interactionEffectRegion(scene: GpuScene, source: Rect, extra = 0): Rect {
  if (!scene.nativeInteraction || !scene.interactionRetained || scene.coherentSamples || !scene.interactionWindow ||
    !Object.values(source).every(Number.isSafeInteger)) return source
  const window = scene.interactionWindow
  const halo = interactionHalo(scene)
  const padding = Math.ceil(Math.max(0, extra))
  const clip = intersect(source, {
    x: Math.floor(window.x - halo) - padding, y: Math.floor(window.y - halo) - padding,
    w: Math.ceil(window.w + halo * 2 + 2) + padding * 2,
    h: Math.ceil(window.h + halo * 2 + 2) + padding * 2,
  })
  // Empty/offscreen nodes keep the established no-op handling upstream.
  return clip.w > 0 && clip.h > 0 ? clip : source
}
