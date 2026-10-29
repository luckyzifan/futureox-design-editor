/** Exact aggregate for immutable, privately allocated parameter textures.
 * Unknown insertion revokes the index and retains the ordinary enumeration.
 * This is accounting only: it cannot release a texture or certify completion. */
export class CoordinateRetirementSet<T extends {bytes:number}> extends Set<T> {
  private owned=new Map<T,number>()
  private total=0
  private trusted=true
  constructor(entries?:Iterable<T>){super();if(entries)for(const value of entries)this.add(value)}
  override add(value:T):this {this.trusted=false;this.owned.clear();this.total=0;return super.add(value)}
  addOwned(value:T):this {
    if(super.has(value))return this
    if(!this.trusted)return super.add(value)
    const bytes=value.bytes
    if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(this.total+bytes))return this.add(value)
    this.owned.set(value,bytes);this.total+=bytes;return super.add(value)
  }
  override delete(value:T):boolean {
    if(this.trusted&&super.has(value)){this.total-=this.owned.get(value)!;this.owned.delete(value)}
    return super.delete(value)
  }
  override clear(){super.clear();this.owned.clear();this.total=0;this.trusted=true}
  summary(first:ReadonlyMap<T,number>|ReadonlySet<T>,second?:ReadonlySet<T>){
    if(!this.trusted)return
    let count=this.size,bytes=this.total
    for(const texture of first.keys()){const charge=this.owned.get(texture);if(charge!==undefined){count--;bytes-=charge}}
    if(second)for(const texture of second){if(first.has(texture))continue;const charge=this.owned.get(texture);if(charge!==undefined){count--;bytes-=charge}}
    return {count,bytes}
  }
}
