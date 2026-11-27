/** Exact byte spans, never a hash. The cache owns one copy only on insertion. */
export type CompilationWitness=Uint8Array|Readonly<{byteLength:number;parts:readonly Uint8Array[]}>
export type WitnessLookup=CompilationWitness|(()=>CompilationWitness)
export function segmentedWitness(parts:readonly Uint8Array[]):CompilationWitness{
  return Object.freeze({byteLength:parts.reduce((n,p)=>n+p.byteLength,0),parts:Object.freeze([...parts])})
}
/** Exact comparison of part.length bytes at offset inside owner. Short spans
 * and the first 128 bytes compare one by one: a changed witness usually
 * diverges early, and probing before creating word views keeps misses as cheap
 * as the plain byte loop. Beyond that, when both spans share a byte phase
 * modulo 4, the bulk compares as Uint32 words: one equal word is four equal
 * bytes, so this stays exact and never hashes. Mismatched phases (and the
 * <4-byte head/tail) compare byte by byte. */
const probeBytes=128
export function sameByteSpan(owner:Uint8Array,offset:number,part:Uint8Array):boolean{
  const length=part.byteLength
  if(length===0)return true
  if(offset+length>owner.byteLength)return false
  const ownerStart=owner.byteOffset+offset,partStart=part.byteOffset
  const probe=Math.min(probeBytes,length)
  let i=0
  for(;i<probe;i++)if(owner[offset+i]!==part[i])return false
  if(probe<length&&(ownerStart&3)===(partStart&3)){
    const align=(4-((ownerStart+probe)&3))&3
    const head=Math.min(probe+align,length)
    for(;i<head;i++)if(owner[offset+i]!==part[i])return false
    const words=(length-i)>>>2
    if(words>0){
      const a=new Uint32Array(owner.buffer,ownerStart+i,words)
      const b=new Uint32Array(part.buffer,partStart+i,words)
      for(let w=0;w<words;w++)if(a[w]!==b[w])return false
      i+=words<<2
    }
  }
  for(;i<length;i++)if(owner[offset+i]!==part[i])return false
  return true
}
export function sameWitness(owned:Uint8Array,next:CompilationWitness):boolean{
  if(owned.byteLength!==next.byteLength)return false
  if(next instanceof Uint8Array){
    const probe=Math.min(probeBytes,owned.byteLength)
    for(let i=0;i<probe;i++)if(owned[i]!==next[i])return false
    return probe===owned.byteLength||sameByteSpan(owned,0,next)
  }
  let offset=0
  for(const part of next.parts){
    if(!sameByteSpan(owned,offset,part))return false
    offset+=part.byteLength
  }
  return offset===owned.byteLength
}
export function copyWitness(witness:CompilationWitness):Uint8Array{
  if(witness instanceof Uint8Array)return witness.slice()
  const owned=new Uint8Array(witness.byteLength);let offset=0
  for(const part of witness.parts){owned.set(part,offset);offset+=part.length}
  if(offset!==owned.length)throw Error('Invalid compilation witness length')
  return owned
}