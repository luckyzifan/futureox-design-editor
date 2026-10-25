import type { GpuNode, GpuScene } from './types'
import { bindScenePlan, type NativeScenePlan } from './scene-index'
import { decodeFrameValue } from './frame-wire'
import { bindSourceIdentity, bindSourcePrograms } from './source-identity'
import { FrameResources, frameResource, identicalResource, type FrameResource, type ResourceLease } from './frame-resources'
const decoded=new WeakMap<Uint8Array,GpuScene>()
const witnesses=new WeakMap<Uint8Array,Uint8Array>()
function immutable<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)) {
    for(const child of Object.values(value))immutable(child)
    Object.freeze(value)
  }
  return value
}
/** FGSC is the only production packet. Resource references are materialized
 * before acknowledgement, while the precise request lease is still alive. */
export function decodeScenePacket(input:Uint8Array,store?:FrameResources,lease?:ResourceLease):GpuScene {
  const known=decoded.get(input);if(known)return known
  const bytes=input.byteOffset%4||!(input.buffer instanceof ArrayBuffer)?input.slice():input as Uint8Array<ArrayBuffer>
  if(bytes.length<24)throw Error('Truncated GPU scene packet')
  const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  if(header.getUint32(0,true)!==0x43534746||header.getUint32(4,true)!==1)throw Error('Unsupported GPU scene packet')
  const metadataLength=header.getUint32(8,true),nv=header.getUint32(12,true),nc=header.getUint32(16,true),payload=header.getUint32(20,true)
  const start=Math.ceil((24+metadataLength)/4)*4,resourceStart=start+(nv+nc)*4
  if(resourceStart+payload!==bytes.length)throw Error('Invalid GPU scene packet length')
  const metadata=decodeFrameValue(bytes.subarray(24,24+metadataLength))
  const {resourceScope,frameSequence,nodeResources,scenePlan,...fields}=metadata
  if(typeof resourceScope!=='string'||!Number.isSafeInteger(frameSequence)||frameSequence<=0||!Array.isArray(nodeResources)||
      ![7,8].includes(fields.version)||!Array.isArray(fields.roots))throw Error('Invalid frame scene metadata')
  const incoming=new Map<number,FrameResource>(), available=new Map(resourceScope&&lease?.scope===resourceScope?lease.entries:[])
  let cursor=resourceStart
  while(cursor<bytes.length){
    if(bytes.length-cursor<9)throw Error('Truncated frame resource')
    const id=header.getUint32(cursor,true),kind=bytes[cursor+4],length=header.getUint32(cursor+5,true);cursor+=9
    if(length>bytes.length-cursor||incoming.has(id))throw Error('Invalid frame resource length or identity')
    const entry=frameResource(id,kind,bytes.subarray(cursor,cursor+length));cursor+=length
    const prior=available.get(id)
    if(prior&&!identicalResource(prior,entry))throw Error('Frame resource identity changed')
    incoming.set(id,entry);available.set(id,prior||entry)
  }
  const used=new Set<number>()
  const resource=(id:number,kind:number)=>{
    const entry=available.get(id)
    if(!Number.isSafeInteger(id)||!entry||entry.kind!==kind)throw Error('Missing frame resource')
    used.add(id);return entry
  }
  const image=<T extends {image?:string}>(paint:T):T=>{
    if(paint.image==null)return paint
    if(!/^[1-9][0-9]*$/.test(paint.image))throw Error('Invalid frame image reference')
    return {...paint,image:resource(Number(paint.image),1).value as string}
  }
  const nodes:Record<string,GpuNode>={}
  for(const row of nodeResources){
    if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||Object.hasOwn(nodes,row[0]))throw Error('Invalid frame node binding')
    const [id,reference]=row,entry=resource(reference,2),raw=entry.value.node as GpuNode
    if(!raw)throw Error('Missing compiled node')
    if(raw.id!==id||!Array.isArray(raw.fills)||!Array.isArray(raw.strokes))throw Error('Frame node identity changed')
    // Resolve every dependency even on a weak materialization hit: the producer
    // must supply assets absent from this request's acknowledged lease.
    const fills=raw.fills.map(image),strokes=raw.strokes.map(s=>({...s,paint:image(s.paint)})),replay=raw.textureReplay&&{...raw.textureReplay,paint:image(raw.textureReplay.paint)}
    const node=entry.node?.deref()||immutable({...raw,fills,strokes,...(replay?{textureReplay:replay}:{})})
    entry.node=new WeakRef(node)
    bindSourceIdentity(node,resourceScope,entry.value.sourceIdentity)
    Object.defineProperty(nodes,id,{value:node,writable:true,enumerable:true,configurable:true})
  }
  Object.freeze(nodes)
  const scene={...fields,nodes,vertices:new Float32Array(bytes.buffer,bytes.byteOffset+start,nv),
    curves:new Float32Array(bytes.buffer,bytes.byteOffset+start+nv*4,nc)} as GpuScene
  bindSourcePrograms(scene)
  bindScenePlan(scene,resource(scenePlan,3).value as NativeScenePlan)
  // No partial dictionary publication on malformed data or missing dependencies.
  if(store&&lease){store.commit(resourceScope,incoming,lease);for(const id of used)if(lease.scope===resourceScope&&lease.entries.has(id))store.touch(id)}
  decoded.set(input,scene)
  // Exact tile equivalence excludes retransmitted resource bodies, but includes
  // the producer scope and immutable logical IDs that prove their identity.
  const witness=resourceScope?bytes.slice(0,resourceStart):bytes
  if(resourceScope)new DataView(witness.buffer).setUint32(20,0,true)
  witnesses.set(input,witness)
  return scene
}
export function scenePacketWitness(bytes:Uint8Array){return witnesses.get(bytes)||bytes}

/** Coalesced consumers get independent program storage; immutable native node
 * resources may be shared, exactly as their frame leases already permit. */
export function copyScenePacket(input:Uint8Array):Uint8Array {
  const copy=input.slice(),scene=decoded.get(input)
  if(scene){
    const header=new DataView(copy.buffer),start=Math.ceil((24+header.getUint32(8,true))/4)*4
    const vertices=header.getUint32(12,true),curves=header.getUint32(16,true)
    const copied={...scene,vertices:new Float32Array(copy.buffer,start,vertices),curves:new Float32Array(copy.buffer,start+vertices*4,curves)}
    bindSourcePrograms(copied); decoded.set(copy,copied)
    const witness=witnesses.get(input);if(witness)witnesses.set(copy,witness.slice())
  }
  return copy
}
