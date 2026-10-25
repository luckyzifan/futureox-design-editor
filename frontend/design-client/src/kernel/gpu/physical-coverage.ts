import { tilesCoverBounds } from '../tile-cache'
type PhysicalRect = { x:number;y:number;width:number;height:number;blend?:boolean }
/** Complete overwrite coverage of actual available, clipped draw rectangles.
 * This is not an Alpha test: a fully covered authored-transparent page is valid. */
export function physicalPixelCoverage(rows: readonly PhysicalRect[], width: number, height: number) {
  return tilesCoverBounds(rows.filter(r => !r.blend).map((r, i) => ({ ...r, key: String(i), zoom: 1, gutter: 0 })),
    { x: 0, y: 0, width, height })
}
/** Integer scissor ownership, not a sparse screen sample. A one-pixel gap
 * must keep native coverage false even if none of the diagnostic probes hit it. */
export function physicalCoverage(rows: readonly { x:number;y:number;width:number;height:number;native:boolean;blend?:boolean }[],width:number,height:number) {
  const items=rows.filter(r=>!r.blend).map((r,i)=>({...r,key:String(i),zoom:1,gutter:0}))
  const bounds={x:0,y:0,width,height}
  return {pixelCoverageComplete:tilesCoverBounds(items,bounds),nativeCoverageComplete:tilesCoverBounds(items.filter(r=>r.native),bounds)}
}

/** Exact uncovered physical rectangles. Adjacent strips can stay separate:
 * this is a conservative admission proof, never a sampled quality estimate. */
export function physicalCoverageGaps(rows:readonly PhysicalRect[],width:number,height:number):PhysicalRect[]{
  const rects=rows.filter(r=>!r.blend&&r.width>0&&r.height>0)
  const xs=[...new Set([0,width,...rects.flatMap(r=>[Math.max(0,Math.min(width,r.x)),Math.max(0,Math.min(width,r.x+r.width))])])].sort((a,b)=>a-b)
  const gaps:PhysicalRect[]=[]
  for(let i=1;i<xs.length;i++){
    const left=xs[i-1],right=xs[i];if(right<=left)continue
    const ys=rects.filter(r=>r.x<=left&&r.x+r.width>=right).map(r=>[Math.max(0,r.y),Math.min(height,r.y+r.height)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])
    let y=0
    for(const [a,b] of ys){if(a>y)gaps.push({x:left,y,width:right-left,height:a-y});y=Math.max(y,b)}
    if(y<height)gaps.push({x:left,y,width:right-left,height:height-y})
  }
  return gaps
}
