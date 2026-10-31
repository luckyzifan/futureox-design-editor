import { ImageRowDecoder } from './generated-row-decoder'

/** A routing hint only. Native PNG/ICC/EXIF and dimension checks remain the
 * authority; malformed and unsupported sources still reject in the decoder. */
export function largePngRowCandidate(uri: string): boolean {
  const prefix='data:image/png;base64,'
  if(!uri.startsWith(prefix))return false
  try {
    const bytes=Uint8Array.from(atob(uri.slice(prefix.length,prefix.length+44)),c=>c.charCodeAt(0))
    if(bytes.length<29||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))return false
    const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20)
    // These are routing thresholds for the legacy full-surface decoder, not
    // source admission. Larger sources take the row path at native resolution.
    return width*height>8_388_608||width>8192||height>8192||uri.length>12*1024*1024
  }catch{return false}
}
export type LinearImageRows = Iterable<{y:number;height:number;pixels:Float32Array}>
export function nativeImageRows(uri:string,settings:string,current:()=>void){
  current()
  let decoder: ImageRowDecoder | undefined = new ImageRowDecoder(uri,settings)
  let started=false
  const dispose=()=>{const owned=decoder;decoder=undefined;owned?.free()}
  let width:number,height:number
  try{width=decoder.width();height=decoder.height()}catch(error){dispose();throw error}
  // Upload consumes a transient source synchronously. A dimension-only caller
  // cannot leave compressed bytes/native state pinned indefinitely, even when
  // it never creates/starts the iterator. The renderer also disposes explicitly
  // on admission failure and before returning an uploaded texture.
  queueMicrotask(()=>{if(!started)dispose()})
  return {width,height,pixels:new Float32Array(0),bytes:undefined as Uint8Array|undefined,dispose,linearRows:function*(){
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
