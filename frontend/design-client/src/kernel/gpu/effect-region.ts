import { intersect, type GpuScene, type Rect } from './types'

/** Integer pixel centres remain exactly representable through both global
 * subtraction and a cropped destination copy. Fractional/large coordinates
 * keep the full-target path: rebasing them can change sampling rounding. */
export function exactBlendLattice(rects: Rect[]): boolean {
  return rects.every(r => Object.values(r).every(v => Number.isInteger(v) && Math.abs(v) <= 1048576))
}

/** A rounded glass leaf only consumes optics through its fill mask. Expand
 * that domain in device pixels before resolving the four backdrop planes.
 * The authored depth bounds displacement, and a spectral ray scales it by
 * at most 1.2. Two is a conservative bound including binary32 rounding. */
export function glassBackdropWindow(basis: Rect, mask: Rect, matrix: readonly number[], depth: number,
  refraction: number, filterSupport: number): Rect | undefined {
  if (!exactBlendLattice([basis, mask]) || matrix.length !== 6 || !matrix.every(Number.isFinite) ||
      !(depth >= 1 && depth <= 1000 && refraction >= 0 && refraction <= 1) ||
      !Number.isSafeInteger(filterSupport) || filterSupport < 0 || filterSupport > 512) return
  const output = intersect(basis, mask)
  if (!output.w || !output.h) return
  const reach = depth * refraction * 2
  // Four sample offsets, bilinear neighbours, physical zero-weight reads
  // and the full original separable filter are all inside this window.
  const dx = Math.ceil(reach * (Math.abs(matrix[0]) + Math.abs(matrix[2]))) + filterSupport + 4
  const dy = Math.ceil(reach * (Math.abs(matrix[1]) + Math.abs(matrix[3]))) + filterSupport + 4
  if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) return
  const input = intersect(basis, {x:output.x-dx,y:output.y-dy,w:output.w+2*dx,h:output.h+2*dy})
  return input.w*input.h*2 <= basis.w*basis.h ? input : undefined
}

/** Original normal-over writable footprint and saved bilinear neighbours.
 * Fused paints must touch this same ring: even a transparent source can
 * canonicalize destination zero/NaN neighbours at the sampling boundary. */
export function normalMergeRegion(source:Rect,target:Rect):{region:Rect;before?:Rect}|undefined {
  const affected=intersect({x:source.x-1,y:source.y-1,w:source.w+2,h:source.h+2},target)
  const x=Math.max(0,Math.floor(affected.x-target.x)),y=Math.max(0,Math.floor(affected.y-target.y))
  const w=Math.max(0,Math.min(target.w,Math.ceil(affected.x+affected.w-target.x))-x)
  const h=Math.max(0,Math.min(target.h,Math.ceil(affected.y+affected.h-target.y))-y)
  const region={x,y,w,h}
  if(!w||!h)return {region}
  if(w*h*2>=target.w*target.h)return
  const left=Math.max(0,x-1),top=Math.max(0,y-1)
  return {region,before:{x:target.x+left,y:target.y+top,w:Math.min(target.w,x+w+2)-left,h:Math.min(target.h,y+h+2)-top}}
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

/** The clipped gesture texture is consumed only inside this window. A leaf's
 * own filter may read its whole source; its completed output is in node.rect.
 * A filtered ancestor or backdrop reader can consume an off-window sibling. */
export function localPoseDemand(scene: GpuScene): Rect | undefined {
  const local = scene.nativeInteraction && scene.interactionRetained && scene.interactionLocalFootprint
  const w = local ? scene.interactionContentWindow ?? scene.interactionWindow : scene.repairOutput ? scene.output : undefined
  if (!w ||
      scene.resolve || scene.presentation || scene.softwareRaster || !scene.coherentSamples ||
      !Object.values(w).every(Number.isFinite) || w.w <= 0 || w.h <= 0) return
  for (const n of Object.values(scene.nodes)) {
    if (!exactBlendLattice([n.rect]) || n.captureReplay || n.textureReplay ||
        n.effects.some(e => e.visible && (n.children.length > 0 || !['shadow','inner-shadow','blur','gaussian-blur','color-controls'].includes(e.kind)))) return
  }
  return guardedPixelWindow(w)
}

/** Outward integer rounding and neighbours for a bounded pixel operation. */
export function guardedPixelWindow(w: Rect): Rect {
  const x = Math.floor(w.x)-2, y = Math.floor(w.y)-2
  return { x,y,w:Math.ceil(w.x+w.w)+2-x,h:Math.ceil(w.y+w.h)+2-y }
}
