/** Index only privately recorded pool ownership. Unknown Map writes retain
 * the ordinary enumeration/sort path; the index grants no completion credit. */
export class SurfacePool<T extends {bytes:number}> extends Map<string,T[]> {
  private ordered=new Map<T,{age:number;bytes:number}>()
  private total=0
  private trusted=true
  private clock=0
  private untouched=0
  constructor(entries?:Iterable<readonly [string,T[]]>){super();if(entries)for(const [key,list]of entries)this.set(key,list)}
  private invalidate(){this.trusted=false;this.ordered.clear();this.total=0}
  override set(key:string,list:T[]){this.invalidate();return super.set(key,list)}
  setOwned(key:string,list:T[]){return super.set(key,list)}
  added(texture:T){
    if(!this.trusted)return
    if(this.ordered.has(texture)||!Number.isSafeInteger(texture.bytes)||texture.bytes<0||!Number.isSafeInteger(this.total+texture.bytes)){this.invalidate();return}
    this.ordered.set(texture,{age:0,bytes:texture.bytes});this.total+=texture.bytes;this.untouched++
  }
  removed(texture:T){
    const entry=this.ordered.get(texture)
    if(entry){this.total-=entry.bytes;if(entry.age===0)this.untouched--;this.ordered.delete(texture)}
    else if(this.trusted)this.invalidate()
  }
  touched(texture:T,age:number){
    if(!this.trusted||!this.ordered.has(texture))return
    if(!Number.isSafeInteger(age)||age<=this.clock){this.invalidate();return}
    const entry=this.ordered.get(texture)!
    // All actual touches use the renderer's increasing generation. Never
    // certify a synthetic/nonmonotonic order as the original oldest-first LRU.
    if(entry.age===0)this.untouched--
    this.clock=age
    this.ordered.delete(texture);this.ordered.set(texture,{age,bytes:entry.bytes})
  }
  override delete(key:string){
    // Native removal first detaches individual entries. An external deletion
    // of still-indexed storage revokes the optimization rather than its charge.
    if(super.get(key)?.some(texture=>this.ordered.has(texture)))this.invalidate()
    return super.delete(key)
  }
  override clear(){super.clear();this.ordered.clear();this.total=0;this.clock=0;this.untouched=0;this.trusted=true}
  /** Aggregate only. No disposal cohort is allocated for a decision that will
   * retain every resource. Unknown ownership preserves capture's fallback. */
  summary(pinned:ReadonlyMap<T,number>){
    if(!this.trusted)return
    if(this.untouched){this.invalidate();return}
    let bytes=this.total,count=this.ordered.size
    for(const texture of pinned.keys()){const entry=this.ordered.get(texture);if(entry){bytes-=entry.bytes;count--;}}
    return {bytes,count}
  }
  capture(pinned:ReadonlyMap<T,number>,limit?:{bytes:number;resources:number}){
    if(!this.trusted)return undefined
    if(this.untouched){this.invalidate();return undefined}
    if(limit&&(!Number.isSafeInteger(limit.bytes)||limit.bytes<=0||!Number.isSafeInteger(limit.resources)||limit.resources<=0))return undefined
    const textures:T[]=[];let selectedBytes=0
    for(const [texture,entry]of this.ordered){
      if(pinned.has(texture))continue
      textures.push(texture);selectedBytes+=entry.bytes
      if(limit&&(textures.length>=limit.resources||selectedBytes>=limit.bytes))break
    }
    let bytes=this.total,count=this.ordered.size
    for(const texture of pinned.keys()){const entry=this.ordered.get(texture);if(entry){bytes-=entry.bytes;count--;}}
    // Freeze only the bounded disposal cohort when there is no pressure.
    // Aggregate accounting includes every survivor and no completion is minted.
    return {textures,bytes,count,has:(texture:T)=>this.ordered.has(texture)&&!pinned.has(texture)}
  }
}
