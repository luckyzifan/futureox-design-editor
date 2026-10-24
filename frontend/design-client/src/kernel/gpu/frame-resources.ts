import { decodeFrameValue } from './frame-wire'
import type { GpuNode } from './types'
export type FrameResource = { id:number; kind:number; data:Uint8Array; value:any; size:number; pins:number; cached:boolean; node?:WeakRef<GpuNode> }
export type ResourceLease = { scope:string; entries:ReadonlyMap<number,FrameResource>; generation:number; acknowledgement:{scope:string;ranges:[number,number][]}; release():void }
const LIMIT=32*1024*1024
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i])
/** Replaces the 32 MiB compiled-packet cache. Pinned in-flight acknowledgements
 * remain charged after eviction/mutation until their exact reply is consumed. */
export class FrameResources {
  private scope='';private generation=0;private entries=new Map<number,FrameResource>()
  bytes=0;hits=0
  capture():ResourceLease {
    const entries=new Map(this.entries), scope=this.scope,generation=this.generation
    for(const e of entries.values())e.pins++
    const ids=[...entries.keys()].sort((a,b)=>a-b), ranges:[number,number][]=[]
    for(const id of ids){const last=ranges.at(-1);if(last&&last[1]+1===id)last[1]=id;else ranges.push([id,id])}
    let released=false
    return {scope,entries,generation,acknowledgement:{scope,ranges},release:()=>{
      if(released)return;released=true
      for(const e of entries.values())if(--e.pins===0&&!e.cached)this.bytes-=e.size
    }}
  }
  private remove(id:number){const e=this.entries.get(id);if(!e)return;this.entries.delete(id);e.cached=false;if(!e.pins)this.bytes-=e.size}
  clear(){for(const id of this.entries.keys())this.remove(id);this.scope='';this.generation++}
  /** Document revision fences revoke old publication, while immutable resource
   * identities remain valid until their producer scope changes. */
  invalidate(){this.generation++}
  commit(scope:string,incoming:Map<number,FrameResource>,lease:ResourceLease){
    if(!scope||lease.generation!==this.generation)return
    if(this.scope!==scope){for(const id of this.entries.keys())this.remove(id);this.scope=scope}
    for(const [id,entry] of incoming){
      const old=this.entries.get(id)
      if(old){if(old.kind!==entry.kind||!equal(old.data,entry.data))throw Error('Frame resource identity changed');continue}
      if(entry.size>LIMIT)continue
      for(const key of this.entries.keys()){if(this.bytes+entry.size<=LIMIT)break;this.remove(key)}
      if(this.bytes+entry.size>LIMIT)continue
      entry.cached=true;this.entries.set(id,entry);this.bytes+=entry.size
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
