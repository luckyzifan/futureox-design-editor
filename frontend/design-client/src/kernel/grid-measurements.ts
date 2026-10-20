/** Commit/submission observations only, not a screenshot or pixel alignment proof. */
const sinks = new WeakMap<object, Set<(fields:Record<string,number>)=>void>>()
export function bindCanvasGrid(owner:object, sink:(fields:Record<string,number>)=>void) {
  let group=sinks.get(owner);if(!group)sinks.set(owner,group=new Set());group.add(sink)
  return ()=>{group.delete(sink);if(!group.size)sinks.delete(owner)}
}
export function recordCanvasGrid(owner:object, fields:Record<string,number>) {
  for(const sink of sinks.get(owner)||[])try{sink(fields)}catch{}
}
/** Device phase agreement checks do not imply physical pixel correctness. */
export function gridPhaseAgreement(a:number,b:number,dpr:number) {
  if(![a,b,dpr].every(Number.isFinite)||dpr<=0)return false
  const difference=(a-b)*dpr
  return Math.abs(difference-Math.round(difference))<1e-6
}
/** At most one observation per known grid kind per second, no per-frame output. */
export class GridMeasurements {
  private pending=new Map<number,Record<string,number>>()
  private timer:ReturnType<typeof setTimeout>|undefined
  constructor(private sink:(event:string,fields:Record<string,number>)=>void) {}
  record(fields:Record<string,number>) {
    if(!Number.isInteger(fields.gridKind)||fields.gridKind<1||fields.gridKind>5)return
    const row:Record<string,number>={gridKind:fields.gridKind}
    const ranges:Record<string,number>={gridVisible:1,gridSpacingClass:3,gridPhaseMatch:1,gridAlignmentMatch:1,gridRedrawReason:3,gridStale:1,gridCount:1e9,dpr:64}
    for(const [key,max] of Object.entries(ranges))if(Number.isFinite(fields[key])&&fields[key]>=0&&fields[key]<=max)row[key]=fields[key]
    this.pending.set(fields.gridKind,row)
    if(this.timer===undefined)this.timer=setTimeout(()=>this.flush(),1000)
  }
  flush() { if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;for(const row of this.pending.values())try{this.sink('grid-state',row)}catch{};this.pending.clear() }
  close() { if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.pending.clear() }
}
