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
