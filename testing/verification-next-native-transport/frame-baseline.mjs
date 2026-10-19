// Keep stdout chunks until the complete FPR1 response is validated. Only the
// small header/metadata ranges may need joining; binary bytes go directly into
// an exactly sized, transferable allocation, never a pooled Node Buffer slab.
function copyRange(parts,start,target){
 let position=0,written=0
 for(const part of parts){
  const begin=Math.max(0,start-position),end=Math.min(part.length,start+target.length-position)
  if(begin<end){target.set(part.subarray(begin,end),written);written+=end-begin}
  if(written===target.length)return
  position+=part.length
 }
 if(written!==target.length)throw Error('Unexpected native preparation frame')
}
function readRange(parts,start,length){
 let position=0
 for(const part of parts){
  if(start>=position&&start+length<=position+part.length)return part.subarray(start-position,start-position+length)
  position+=part.length
 }
 const bytes=Buffer.allocUnsafe(length)
 copyRange(parts,start,bytes)
 return bytes
}
export class NativePreparationFrame {
 constructor(){this.parts=[];this.received=0;this.expected=undefined}
 append(part){
  this.received+=part.length
  if(this.received>130*1024*1024)throw Error('Native preparation frame exceeds limit')
  this.parts.push(part)
  if(!this.expected&&this.received>=12){
   const header=readRange(this.parts,0,12)
   if(header.toString('ascii',0,4)!=='FPR1')throw Error('Invalid native preparation protocol')
   const metadata=header.readUInt32LE(4),binary=header.readUInt32LE(8)
   if(metadata>2*1024*1024||binary>128*1024*1024)throw Error('Native preparation payload exceeds limit')
   this.expected={metadata,binary,total:12+metadata+binary}
  }
  if(!this.expected||this.received<this.expected.total)return false
  if(this.received!==this.expected.total)throw Error('Unexpected native preparation frame')
  return true
 }
 decode(id){
  if(!this.expected||this.received!==this.expected.total)throw Error('Unexpected native preparation frame')
  const reply=JSON.parse(readRange(this.parts,12,this.expected.metadata).toString('utf8'))
  if(reply.id!==id)throw Error('Native preparation sequence mismatch')
  const transfers=[]
  if(reply.encoding){
   if(reply.encoding!=='f32'&&reply.encoding!=='u8')throw Error('Unknown native preparation encoding')
   if(reply.encoding==='f32'&&this.expected.binary%4)throw Error('Misaligned native float payload')
   const bytes=new Uint8Array(this.expected.binary)
   copyRange(this.parts,12+this.expected.metadata,bytes)
   // Supported Electron targets are little endian; the wire remains LE.
   reply.value=reply.encoding==='f32'?new Float32Array(bytes.buffer):bytes
   transfers.push(bytes.buffer)
  }
  delete reply.encoding
  return {reply,transfers}
 }
}
