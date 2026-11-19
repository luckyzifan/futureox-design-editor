import { exactBlendLattice } from './effect-region'
import { intersect, type GpuNode, type GpuPaint, type GpuScene, type PathMesh, type Rect } from './types'

type FocusPath = { region: Rect; bounds: Rect; value: Float32Array; bits: Uint32Array }
export type FocusPrefixWitness = { properties: unknown; coverage: readonly (FocusPath | null)[] }

function contains(outer: Rect, inner: Rect) {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
}

/** Exact full coverage inside an analytic rectangle's integer spans. */
export function focusClipCovers(path: PathMesh, curves: GpuScene['curves'], output: Rect) {
  const area = path.area, bounds = path.rect
  if (!curves || !area || !path.count || area.count !== 7 || !contains(bounds,output) ||
      !exactBlendLattice([bounds,output]) || !Number.isSafeInteger(area.first) || area.first < 0) return false
  const first = area.first * 4
  if (first+28 > curves.length || curves[first] !== 1) return false
  const coversAxis = (at: number, left: number, right: number, start: number, end: number) => {
    const lo=curves[at],hi=curves[at+1]
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo>hi) return false
    const whole=(offset: number)=>[0,1,2,3].every(i=>curves[offset+i]===0)
    return (lo<start || lo===start && curves[at+2]===0 && whole(left)) &&
      (hi>end || hi===end && curves[at+3]===1 && whole(right))
  }
  return coversAxis(first+4,first+12,first+16,output.x-bounds.x,output.x+output.w-bounds.x-1) &&
    coversAxis(first+8,first+20,first+24,output.y-bounds.y,output.y+output.h-bounds.y-1)
}

function focusPath(path: PathMesh, curves: Float32Array, viewport: Rect): FocusPath | null | undefined {
  if (!path.count) return null
  const region = intersect(path.rect, viewport), area = path.area
  if (!region.w || !region.h) return null
  if (!area || !exactBlendLattice([path.rect, viewport]) || !Number.isSafeInteger(area.first) || area.first < 0 ||
      !Number.isSafeInteger(area.count) || area.count < 1 || (area.first + area.count) * 4 > curves.length) return
  const first = area.first * 4, end = first + area.count * 4
  const tag = curves[first]
  if (tag === 2) return null
  if (tag === 1 ? area.count !== 7 : tag !== 0 || curves[first+1] !== 1 ||
      curves[first+2] !== path.rect.w || curves[first+3] !== path.rect.h || area.count < 1+path.rect.h*8) return
  const value = curves.subarray(first,end)
  return {region,bounds:path.rect,value,bits:new Uint32Array(value.buffer,value.byteOffset,value.length)}
}

const sameRect = (a: Rect,b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
const zeroEdge = (words:Float32Array, i:number) => words[i]===0 && words[i+1]===0 && words[i+2]===0 && words[i+3]===0
const sameEdge = (a:Uint32Array,i:number,b:Uint32Array,j:number) =>
  a[i]===b[j] && a[i+1]===b[j+1] && a[i+2]===b[j+2] && a[i+3]===b[j+3]

// The original shader only consumes boundary coefficients on their matching
// cells. Ignore clipped-off endpoints but keep all contributing bits and their
// accumulation order. All addresses below are relative to one bounded program.
function sameAxis(a: FocusPath, b: FocusPath, ai: number, bi: number, edgeA: number, edgeB: number,
  aOrigin: number, bOrigin: number, start: number, end: number) {
  const aw=a.value,bw=b.value,ap=a.bits,bp=b.bits
  const alo=aw[ai]+aOrigin,ahi=aw[ai+1]+aOrigin,blo=bw[bi]+bOrigin,bhi=bw[bi+1]+bOrigin
  if (alo > ahi || blo > bhi || !Number.isInteger(alo) || !Number.isInteger(ahi) ||
      !Number.isInteger(blo) || !Number.isInteger(bhi)) return false
  const ea=ai+edgeA, eb=bi+edgeA, ra=ai+edgeB, rb=bi+edgeB
  const leftSame = alo === blo && ap[ai+2] === bp[bi+2] && sameEdge(ap,ea,bp,eb)
  const rightSame = ahi === bhi && ap[ai+3] === bp[bi+3] && sameEdge(ap,ra,bp,rb)
  if (leftSame && rightSame) return true
  return (leftSame || (alo<start || alo===start && ahi>alo && aw[ai+2]===0 && zeroEdge(aw,ea)) &&
    (blo<start || blo===start && bhi>blo && bw[bi+2]===0 && zeroEdge(bw,eb))) &&
    (rightSame || (ahi>end || ahi===end && ahi>alo && aw[ai+3]===1 && zeroEdge(aw,ra)) &&
    (bhi>end || bhi===end && bhi>blo && bw[bi+3]===1 && zeroEdge(bw,rb)))
}

function sameFocusPath(a: FocusPath | null, b: FocusPath | null): boolean {
  if (!a || !b) return a === b
  if (!sameRect(a.region,b.region) || a.value[0]!==b.value[0]) return false
  const {x,y,w,h}=a.region, right=x+w-1, bottom=y+h-1
  if (a.value[0]===1) return sameAxis(a,b,4,4,8,12,a.bounds.x,b.bounds.x,x,right) &&
    sameAxis(a,b,8,8,12,16,a.bounds.y,b.bounds.y,y,bottom)
  const aw=a.value,bw=b.value,ax=a.bounds.x,bx=b.bounds.x
  const firstA=1+a.bounds.h*8,firstB=1+b.bounds.h*8
  let rowA=4+(y-a.bounds.y)*32,rowB=4+(y-b.bounds.y)*32
  for (let row=0;row<h*8;row++,rowA+=4,rowB+=4) {
    const offsetA=aw[rowA], offsetB=bw[rowB], countA=aw[rowA+1], countB=bw[rowB+1]
    if (!Number.isInteger(countA) || !Number.isInteger(countB) || countA<0 || countB<0 ||
        !Number.isInteger(offsetA) || !Number.isInteger(offsetB) || offsetA<0 || offsetB<0 ||
        countA&&(offsetA<firstA||(offsetA+countA*3)*4>aw.length) ||
        countB&&(offsetB<firstB||(offsetB+countB*3)*4>bw.length)) return false
    let ai=offsetA*4,bi=offsetB*4
    const ae=ai+countA*12,be=bi+countB*12
    for (;;) {
      while(ai<ae&&(aw[ai+1]+ax<x||aw[ai]+ax>right))ai+=12
      while(bi<be&&(bw[bi+1]+bx<x||bw[bi]+bx>right))bi+=12
      if(ai===ae||bi===be){if(ai!==ae||bi!==be)return false;break}
      if(!sameAxis(a,b,ai,bi,4,8,ax,bx,x,right))return false
      ai+=12;bi+=12
    }
  }
  return true
}

export function focusPrefixWitness(scene: GpuScene, scope: GpuNode, ids: readonly string[], viewport: Rect,
  unitColor: (color: string) => boolean): FocusPrefixWitness | undefined {
  const curves = scene.curves
  if (!(curves instanceof Float32Array) || !exactBlendLattice([viewport]) || ids.length < 2 || ids.length > 512) return
  const coverage: (FocusPath | null)[] = [], nodes: unknown[] = []
  const colors = new Map<string, number[] | undefined>()
  let coverageWords = 0
  let imageChars = 0
  const addColor = (color: string) => {
    if (colors.has(color)) return true
    if (!unitColor(color)) return false
    colors.set(color, scene.colors?.[color]?.slice())
    return true
  }
  const addPath = (path: PathMesh) => {
    const program = focusPath(path, curves, viewport)
    if (program === undefined) return false
    coverageWords += program?.value.length ?? 0
    if (coverageWords > 1048576) return false
    coverage.push(program)
    return true
  }
  if (scope.clip && !addPath(scope.fill)) return
  const stack = [...ids].reverse(), seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!, n = scene.nodes[id]
    if (!n) continue
    if (seen.has(id) || seen.size >= 48 || !exactBlendLattice([n.rect]) || n.blend !== 'normal' ||
        n.mask || n.maskId || n.passthrough || n.previewSource || n.previewDynamic || n.captureReplay || n.textureReplay ||
        n.opticalPrefixNext || n.rotatedBackdropBounds || n.analyticRegion || n.gaussianRegion || n.sourceFilterField || n.childrenInputBox || n.postCompositeBox ||
        !Number.isFinite(n.opacity) || n.opacity < 0 || n.opacity > 1) return
    seen.add(id)
    const effects = n.effects.filter(effect => effect.visible)
    if (effects.length && (!n.wideImageGaussian || effects.length !== 1 || effects[0].kind !== 'gaussian-blur')) return
    if (n.wideImageGaussian) {
      const image = n.fills[0]?.image
      if (!image?.startsWith('data:')) return
      imageChars += image.length
      if (imageChars > 8 * 1024 * 1024) return
    }
    const paints = [...n.fills, ...n.strokes.map(stroke=>stroke.paint)].filter(paint=>paint.visible)
    if (paints.some(paint=>!(paint.kind==='solid'||paint.kind==='linear'||paint.kind==='image'&&n.wideImageGaussian) ||
        paint.blend !== 'normal' || !Number.isFinite(paint.opacity) || paint.opacity < 0 || paint.opacity > 1 ||
        !addColor(paint.color) || !paint.stops.every(stop=>addColor(stop.color)))) return
    if ((n.fills.some(paint=>paint.visible) && !n.wideImageGaussian || n.clip || n.strokes.some(s=>s.align!=='center')) && !addPath(n.fill)) return
    for (const stroke of n.strokes) if (!addPath(stroke.path)) return
    // The compiler can attach the surrounding allocation even when this node
    // has no active backdrop effect. No admitted painter reads that box.
    const {rect,fill,fills,strokes,children,backdropBox,...properties} = n
    // Managed linear paints consume the kernel's global sampling field. The
    // origin-relative plane belongs to the un-managed gradient fallback.
    const recordedPaint = (paint: GpuPaint) => {
      const {gradientPlane,...parameters} = paint
      return parameters
    }
    const rendered = children.filter(child=>Object.hasOwn(scene.nodes,child))
    nodes.push({properties,rect:intersect(rect,viewport),children:rendered,
      fills:fills.map(recordedPaint),strokes:strokes.map(({path,paint,...stroke})=>({...stroke,paint:recordedPaint(paint)}))})
    stack.push(...rendered.slice().reverse())
  }
  if (seen.size < 2) return
  return {properties:[viewport, scene.view, scope.id, scope.clip, nodes, scene.colorManagement, scene.canvasBlurApproximation,
    scene.integratedBlur,scene.floatCompositing,scene.displayFilters,scene.displayImageSource,scene.displayMaterialSource,[...colors]],coverage}
}

function exactValue(a: unknown, b: unknown): boolean {
  if (Object.is(a,b)) return true
  if (!a || !b || typeof a!=='object' || typeof b!=='object' || Array.isArray(a)!==Array.isArray(b)) return false
  const keys=Object.keys(a),right=Object.keys(b)
  return keys.length===right.length && keys.every(key=>Object.hasOwn(b,key) &&
    exactValue((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]))
}

export function sameFocusPrefix(a: FocusPrefixWitness, b: FocusPrefixWitness): boolean {
  return a.coverage.length===b.coverage.length && exactValue(a.properties,b.properties) &&
    a.coverage.every((program,i)=>sameFocusPath(program,b.coverage[i]))
}

export function snapshotFocusPrefix(witness: FocusPrefixWitness): FocusPrefixWitness {
  return {properties:witness.properties,coverage:witness.coverage.map(path=>{
    if (!path) return null
    const value=path.value.slice()
    return {...path,value,bits:new Uint32Array(value.buffer)}
  })}
}
