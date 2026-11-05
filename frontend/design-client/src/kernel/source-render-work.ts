/** One client raster request owner, independent of React/presentation state.
 * Cancellation revokes delivery immediately; only the settled request releases
 * this slot. The Worker/native queue retains its separate physical fence.
 * Accepted texture lifetime stays with the presenter.
 */
export type SourceWork<T extends {key:string}> = Readonly<{
  sequence:number
  pending:Map<string,T>
  controller:AbortController
}>
export class SourceRenderWork<T extends {key:string}> {
  constructor(private readonly limit=2){}
  private sequence=0
  private active?:SourceWork<T>
  private closed=false
  get current(){return this.active}
  begin(tiles:readonly T[],limit=2):SourceWork<T> {
    if(this.closed||this.active)throw Error('Source raster owner is not available')
    if(!Number.isSafeInteger(limit)||limit<1||limit>this.limit||limit>8||!tiles.length)throw Error('Invalid source work batch')
    const selected=tiles.slice(0,limit)
    const pending=new Map(selected.map(tile=>[tile.key,tile]))
    if(pending.size!==selected.length)throw Error('Duplicate source work tile')
    return this.active={sequence:++this.sequence,pending,controller:new AbortController()}
  }
  accepts(work:SourceWork<T>,key:string){
    return !this.closed&&this.active===work&&!work.controller.signal.aborted&&work.pending.has(key)
  }
  delivered(work:SourceWork<T>,key:string){
    if(!this.accepts(work,key))throw Error('Source tile delivery lost ownership')
    work.pending.delete(key)
  }
  demand(complete:boolean,needed:(tile:T)=>boolean){
    const work=this.active
    // The first pending tile owns rasterization; later tiles are bounded CPU
    // speculation. Do not repeatedly kill useful visible work merely because
    // its one-ahead neighbour fell offscreen. Recheck after each delivery.
    const first=work?.pending.values().next().value
    if(work&&(complete||first&&!needed(first)))work.controller.abort()
  }
  release(work:SourceWork<T>){if(this.active===work)this.active=undefined}
  close(){this.closed=true;this.active?.controller.abort()}
}
