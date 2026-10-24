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
