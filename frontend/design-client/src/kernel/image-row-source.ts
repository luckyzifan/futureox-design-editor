import {sourceBitmap} from '../source-bitmap'
import { ImageRowDecoder } from './generated-row-decoder'
import { canRebuildImageDecoder } from './image-decode-recovery'

/** A routing hint only. Native PNG/ICC/EXIF and dimension checks remain the
 * authority; malformed and unsupported sources still reject in the decoder. */
export function pngSourceDimensions(uri:string):[number,number]|undefined {
  const prefix='data:image/png;base64,'
  if(!uri.startsWith(prefix))return
  try {
    const bytes=Uint8Array.from(atob(uri.slice(prefix.length,prefix.length+44)),c=>c.charCodeAt(0))
    if(bytes.length<29||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))return
    const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20)
    return width&&height?[width,height]:undefined
  }catch{return}
}
/** A bounded SOF size hint; the native codec still verifies dimensions,
 * colour, orientation and the complete stream before any texture is used. */
export function sourceBitmapDimensions(uri:string):[number,number]|undefined{
 const ref=sourceBitmap(uri);if(ref)return [ref.width,ref.height]
 if(!uri.startsWith('data:image/jpeg;base64,'))return pngSourceDimensions(uri)
 try{
   const start='data:image/jpeg;base64,'.length
   const bytes=atob(uri.slice(start,start+Math.min(uri.length-start,87380)))
   const word=(i:number)=>(bytes.charCodeAt(i)<<8)|bytes.charCodeAt(i+1)
   if(word(0)!==0xffd8)return
   for(let i=2;i+4<bytes.length;){
     if(bytes.charCodeAt(i++)!==255)return
     while(bytes.charCodeAt(i)===255)i++
     const code=bytes.charCodeAt(i++),size=word(i)
     if(code===0xda||code===0xd9||size<2||i+size>bytes.length)return
     if([0xc0,0xc1,0xc2].includes(code)){
       const width=word(i+5),height=word(i+3)
       return size>=8&&bytes.charCodeAt(i+2)===8&&width&&height?[width,height]:undefined
     }
     i+=size
   }
 }catch{return}
}
export function largePngRowCandidate(uri:string):boolean{
  const dims=pngSourceDimensions(uri)
  return !!dims&&(dims[0]*dims[1]>8_388_608||dims[0]>8192||dims[1]>8192||uri.length>12*1024*1024)
}
export type LinearImageRows = Iterable<{y:number;height:number;pixels:Float32Array}>
export function nativeImageRows(uri:string,settings:string,current:()=>void){
  current()
  let decoder: ImageRowDecoder | undefined
  try{decoder=new ImageRowDecoder(uri,settings)}catch(error){
    if(!canRebuildImageDecoder(error,uri))throw error
    current();decoder=new ImageRowDecoder(uri,settings)
  }
  let started=false
  const dispose=()=>{const owned=decoder;decoder=undefined;owned?.free()}
  let width:number,height:number
  try{width=decoder.width();height=decoder.height()}catch(error){dispose();throw error}
  // Upload consumes a transient source synchronously. A dimension-only caller
  // cannot leave compressed bytes/native state pinned indefinitely, even when
  // it never creates/starts the iterator. The renderer also disposes explicitly
  // on admission failure and before returning an uploaded texture.
  queueMicrotask(()=>{if(!started)dispose()})
  return {width,height,pixels:new Float32Array(0),bytes:undefined as Uint8Array|undefined,dispose,
    linearWindow:(x:number,y:number,w:number,h:number)=>{
      if(started||!decoder)throw Error('PNG row source already consumed or disposed')
      started=true
      try{current();return decoder.window(x,y,w,h)}finally{dispose()}
    },straightSrgb8:()=>{
      if(started||!decoder)throw Error('PNG row source already consumed or disposed')
      started=true
      try{current();return decoder.straight_srgb8()}finally{dispose()}
    },linearRows:function*(){
    if(started||!decoder)throw Error('PNG row source already consumed or disposed')
    started=true
    const owned=decoder
    try{
      current()
      let y=0
      for(;;){current();if(decoder!==owned)throw Error('PNG row source disposed');const pixels=owned.next_rows();if(!pixels.length)break
        const rows=pixels.length/(width*4)
        yield {y,height:rows,pixels};y+=rows
      }
      if(y!==height)throw Error('Incomplete PNG row source')
    }finally{dispose()}
  }}
}
