/** Exact byte spans, never a hash. The cache owns one copy only on insertion. */
export type CompilationWitness=Uint8Array|Readonly<{byteLength:number;parts:readonly Uint8Array[]}>
export type WitnessLookup=CompilationWitness|(()=>CompilationWitness)
export function segmentedWitness(parts:readonly Uint8Array[]):CompilationWitness{
  return Object.freeze({byteLength:parts.reduce((n,p)=>n+p.byteLength,0),parts:Object.freeze([...parts])})
}
export function sameWitness(owned:Uint8Array,next:CompilationWitness):boolean{
  if(owned.byteLength!==next.byteLength)return false
  if(next instanceof Uint8Array){for(let i=0;i<owned.length;i++)if(owned[i]!==next[i])return false;return true}
  let offset=0
  for(const part of next.parts){for(let i=0;i<part.length;i++)if(owned[offset+i]!==part[i])return false;offset+=part.length}
  return offset===owned.length
}
export function copyWitness(witness:CompilationWitness):Uint8Array{
  if(witness instanceof Uint8Array)return witness.slice()
  const owned=new Uint8Array(witness.byteLength);let offset=0
  for(const part of witness.parts){owned.set(part,offset);offset+=part.length}
  if(offset!==owned.length)throw Error('Invalid compilation witness length')
  return owned
}
