import type {PathMesh} from './types'
type Program=NonNullable<PathMesh['area']>
type Entry={offset:number;length:number}
export type ProgramPlan={offsets:Map<number,number>;words:Uint32Array<ArrayBuffer>;upload?:{offset:number;data:Uint32Array<ArrayBuffer>};hits:number;hitBytes:number}

/** Exact append-only device arena. Stable offsets survive packet repacking and
 * camera revisits. Hashes select buckets; every reused IEEE word is checked.
 * Reset at a bounded arena/entry limit, never lower sampling quality. */
export class ResidentPrograms {
  private words=new Uint32Array(0)
  private length=0
  private entries=new Map<string,Entry[]>()
  private count=0
  constructor(private readonly maxWords=16*1024*1024,private readonly maxEntries=8192){}
  get bytes(){return this.words.byteLength}
  reset(){this.entries.clear();this.count=0;this.length=0;this.words=new Uint32Array(0)}
  private lookup(values:Float32Array,paths:Program[]) {
    const source=new Uint32Array(values.buffer,values.byteOffset,values.length)
    const unique=new Map<number,Program>()
    for(const p of paths){
      if(!p.fingerprint||p.fingerprint.length!==2||!p.fingerprint.every(Number.isSafeInteger)||
        !Number.isSafeInteger(p.first)||!Number.isSafeInteger(p.count)||p.first<0||p.count<=0||
        (p.first+p.count)*4>source.length)return undefined
      const old=unique.get(p.first)
      if(old&&(old.count!==p.count||old.fingerprint?.[0]!==p.fingerprint[0]||old.fingerprint?.[1]!==p.fingerprint[1]))return undefined
      unique.set(p.first,p)
    }
    const requests=[...unique.values()]
    const total=requests.reduce((sum,p)=>sum+p.count*4,0)
    if(total>this.maxWords||requests.length>this.maxEntries)return undefined
    const key=(p:Program)=>`${p.fingerprint![0]}:${p.fingerprint![1]}:${p.count}`
    const equal=(entry:Entry,p:Program)=>{
      const start=p.first*4
      for(let i=0;i<entry.length;i++)if(this.words[entry.offset+i]!==source[start+i])return false
      return true
    }
    const matches=requests.map(p=>this.entries.get(key(p))?.find(entry=>equal(entry,p)))
    return {source,requests,total,key,equal,matches}
  }
  /** Read-only exact hit proof. No arena reset, append, capacity growth or
   * upload is possible; hashes remain bucket selectors, never equality. */
  exactPlan(values:Float32Array,paths:Program[]):ProgramPlan|undefined {
    const found=this.lookup(values,paths)
    if(!found||found.matches.some(entry=>!entry))return undefined
    const offsets=new Map<number,number>()
    let hitBytes=0
    for(let i=0;i<found.requests.length;i++){
      const entry=found.matches[i]!
      offsets.set(found.requests[i].first,entry.offset/4);hitBytes+=entry.length*4
    }
    return {offsets,words:this.words.subarray(0,this.length),hits:found.requests.length,hitBytes}
  }
  plan(values:Float32Array,paths:Program[]):ProgramPlan|undefined {
    const found=this.lookup(values,paths)
    if(!found)return undefined
    const {source,requests,total,key,equal}=found
    let {matches}=found
    let newWords=requests.reduce((sum,p,i)=>sum+(matches[i]?0:p.count*4),0)
    const newEntries=matches.filter(e=>!e).length
    if(this.length+newWords>this.maxWords||this.count+newEntries>this.maxEntries){
      const capacity=Math.min(this.maxWords,Math.max(4096,2**Math.ceil(Math.log2(Math.max(1,total*2)))))
      this.entries.clear();this.count=0;this.length=0
      this.words=new Uint32Array(capacity);matches=requests.map(()=>undefined);newWords=total
    } else if(this.length+newWords>this.words.length){
      const capacity=Math.min(this.maxWords,Math.max(4096,2**Math.ceil(Math.log2(Math.max(total*2,this.length+newWords)))))
      const grown=new Uint32Array(capacity);grown.set(this.words.subarray(0,this.length));this.words=grown
    }
    const first=this.length,offsets=new Map<number,number>()
    let hits=0,hitBytes=0
    for(let i=0;i<requests.length;i++){
      const p=requests[i],fingerprint=key(p)
      // A new frame may contain duplicate bytes at different packet offsets.
      let entry=matches[i]||this.entries.get(fingerprint)?.find(e=>equal(e,p))
      if(entry){hits++;hitBytes+=entry.length*4}
      else{
        entry={offset:this.length,length:p.count*4}
        this.words.set(source.subarray(p.first*4,(p.first+p.count)*4),this.length);this.length+=entry.length
        const bucket=this.entries.get(fingerprint)||[];bucket.push(entry);this.entries.set(fingerprint,bucket);this.count++
      }
      offsets.set(p.first,entry.offset/4)
    }
    return {offsets,words:this.words.subarray(0,this.length),hits,hitBytes,
      upload:this.length>first?{offset:first*4,data:this.words.subarray(first,this.length)}:undefined}
  }
}
