import { decodeFrameValue } from './frame-wire'
import type { GpuNode } from './types'
import { documentCapacity } from '../../document-capacity'
export type FrameResource = { id:number; kind:number; data:Uint8Array; value:any; size:number; pins:number; cached:boolean; node?:WeakRef<GpuNode> }
export type ResourceLease = { scope:string; entries:ReadonlyMap<number,FrameResource>; generation:number; acknowledgement:Readonly<{scope:string;ranges:readonly (readonly [number,number])[]}>; release():void }
type Snapshot={scope:string;entries:ReadonlyMap<number,FrameResource>;acknowledgement:ResourceLease['acknowledgement'];readers:number;current:boolean}
function readonlyEntries(source:Map<number,FrameResource>):ReadonlyMap<number,FrameResource>{
  const view:ReadonlyMap<number,FrameResource>=Object.freeze({
    get size(){return source.size},get:(id:number)=>source.get(id),has:(id:number)=>source.has(id),
    entries:()=>source.entries(),keys:()=>source.keys(),values:()=>source.values(),[Symbol.iterator]:()=>source[Symbol.iterator](),
    forEach:(callback:(value:FrameResource,key:number,map:ReadonlyMap<number,FrameResource>)=>void,thisArg?:unknown)=>source.forEach((value,key)=>callback.call(thisArg,value,key,view)),
  });return view
}
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i])
/** Uses the pinned host memory policy. Pinned in-flight acknowledgements
 * remain charged after eviction/mutation until their exact reply is consumed. */
export class FrameResources {
  private scope='';private generation=0;private entries=new Map<number,FrameResource>()
  private snapshot?:Snapshot
  private charged=new WeakSet<FrameResource>()
  private leases=new WeakSet<ResourceLease>()
  bytes=0;hits=0
  constructor(readonly limit=documentCapacity().memoryBytes){
    if(!Number.isSafeInteger(limit)||limit<0)throw Error('Invalid trusted frame resource memory allowance')
  }
  capture():ResourceLease {
    let snapshot=this.snapshot
    if(!snapshot){
      const entries=new Map(this.entries),scope=this.scope
      for(const e of entries.values())e.pins++
      const ids=[...entries.keys()].sort((a,b)=>a-b),ranges:[number,number][]=[]
      for(const id of ids){const last=ranges.at(-1);if(last&&last[1]+1===id)last[1]=id;else ranges.push([id,id])}
      snapshot={scope,entries:readonlyEntries(entries),readers:0,current:true,
        acknowledgement:Object.freeze({scope,ranges:Object.freeze(ranges.map(pair=>Object.freeze(pair)))})}
      this.snapshot=snapshot
    }
    const captured=snapshot;captured.readers++
    let released=false
    const lease:ResourceLease={scope:captured.scope,entries:captured.entries,generation:this.generation,acknowledgement:captured.acknowledgement,release:()=>{
      if(released)return;released=true;this.leases.delete(lease)
      captured.readers--;if(!captured.readers&&!captured.current)this.releaseSnapshot(captured)
    }}
    this.leases.add(lease);return lease
  }
  private uncharge(entry:FrameResource){if(this.charged.delete(entry))this.bytes-=entry.size}
  private releaseSnapshot(snapshot:Snapshot){for(const e of snapshot.entries.values())if(--e.pins===0&&!e.cached)this.uncharge(e)}
  private invalidateSnapshot(){const snapshot=this.snapshot;if(!snapshot)return;this.snapshot=undefined;snapshot.current=false;if(!snapshot.readers)this.releaseSnapshot(snapshot)}
  private remove(id:number){const e=this.entries.get(id);if(!e)return;this.invalidateSnapshot();this.entries.delete(id);e.cached=false;if(!e.pins)this.uncharge(e)}
  clear(){this.invalidateSnapshot();for(const id of this.entries.keys())this.remove(id);this.scope='';this.generation++}
  /** Document revision fences revoke old publication, while immutable resource
   * identities remain valid until their producer scope changes. */
  invalidate(){this.generation++}
  commit(scope:string,incoming:Map<number,FrameResource>,lease:ResourceLease){
    if(!scope||!this.leases.has(lease)||lease.generation!==this.generation)return
    if(this.scope!==scope){this.invalidateSnapshot();for(const id of this.entries.keys())this.remove(id);this.scope=scope}
    for(const [id,entry] of incoming){
      const old=this.entries.get(id)
      if(old){if(old!==entry&&(old.kind!==entry.kind||!equal(old.data,entry.data)))throw Error('Frame resource identity changed');continue}
      if(entry.size>this.limit)continue
      const additional=this.charged.has(entry)?0:entry.size
      for(const key of this.entries.keys()){if(this.bytes+additional<=this.limit)break;this.remove(key)}
      if(this.bytes+additional>this.limit)continue
      this.invalidateSnapshot();entry.cached=true;this.entries.set(id,entry)
      if(!this.charged.has(entry)){this.charged.add(entry);this.bytes+=entry.size}
    }
  }
  touch(id:number){const e=this.entries.get(id);if(e){this.entries.delete(id);this.entries.set(id,e);this.hits++}}
}
export function frameResource(id:number,kind:number,data:Uint8Array):FrameResource {
  if(!Number.isSafeInteger(id)||id<=0||![1,2,3].includes(kind))throw Error('Invalid frame resource')
  const owned=data.slice(),value=kind===1?new TextDecoder('utf-8',{fatal:true}).decode(owned):decodeFrameValue(owned)
  const size=kind===1?owned.byteLength+value.length*2+256:owned.byteLength*4+256
  return {id,kind,data:owned,value,size,pins:0,cached:false}
}
export function identicalResource(a:FrameResource,b:FrameResource){return a.kind===b.kind&&equal(a.data,b.data)}
