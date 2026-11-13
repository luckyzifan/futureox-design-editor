import type {Rect} from './types'
// Preserve the Rust-computed bilinear fractions and validity flags. Only the
// integer addresses are remapped into a small Cartesian product of real texels.
export function compactSourceAxes(axes:Float32Array,b:Rect,width:number,height:number){
 const span=Math.max(b.w,b.h);if(!span||axes.length!==span*8)return
 const indices:number[][]=[]
 for(const [axis,count,size] of [[0,b.w,width],[1,b.h,height]]){
  const ix:number[]=[],pairs=new Map<number,number>()
  for(let i=0;i<count;i++){
   const at=4*(axis*span+i),v=axes[at]
   if(axes[at+3]!==-1)return
   if(!axes[at+2]){axes[at]=0;continue}
   if(!Number.isInteger(v)||v< -1||v>=size)return
   let base=pairs.get(v)
   if(base===undefined){base=ix.length;pairs.set(v,base);ix.push(Math.max(0,v),Math.min(size-1,v+1))}
   axes[at]=base
  }
  if(!ix.length)ix.push(0)
  indices.push(ix)
 }
 return {xs:indices[0],ys:indices[1]}
}
export function readSourceGrid(uri:string,xs:number[],ys:number[],lut:Float32Array){
 const width=xs.length,height=ys.length,out=new Float32Array(width*height*4)
 // Bound each local response independently of the source image and view.
 const rows=Math.max(1,Math.floor(524288/width))
 for(let y=0;y<height;y+=rows){
  const band=ys.slice(y,y+rows),payload=new Uint32Array(2+width+band.length)
  payload.set([width,band.length]);payload.set(xs,2);payload.set(band,2+width)
  const xhr=new XMLHttpRequest();xhr.open('POST',uri,false);xhr.responseType='arraybuffer';xhr.send(payload)
  if(xhr.status!==200||!(xhr.response instanceof ArrayBuffer)||xhr.response.byteLength!==width*band.length*4)throw Error('无法读取原图采样区域')
  const raw=new Uint8Array(xhr.response)
  for(let j=0;j<raw.length;j+=4){const dest=y*width*4+j,a=lut[256+raw[j+3]];out[dest]=lut[raw[j]]*a;out[dest+1]=lut[raw[j+1]]*a;out[dest+2]=lut[raw[j+2]]*a;out[dest+3]=a}
 }
 return out
}


/** One dense-pose fetch. Nothing here is kept after the call returns: `residentBytes`
 * and `inFlightBytes` are the peak of the reply being scattered, not a cache. */
export type DenseSourceRead={mode:'pairs'|'span';requests:number;sourceBytes:number;residentBytes:number;inFlightBytes:number}
const emptyRead:DenseSourceRead={mode:'pairs',requests:0,sourceBytes:0,residentBytes:0,inFlightBytes:0}
let lastDenseSourceRead:DenseSourceRead=emptyRead
export function denseSourceReadAccounting():DenseSourceRead{return lastDenseSourceRead}
const SPAN_BYTES=64*1024*1024
type SourceSpan={x:number;y:number;w:number;h:number}
function cellAt(field:Float32Array,index:number,iw:number,ih:number){
 const x=field[index*4],y=field[index*4+1]
 if(x===-2)return
 if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=iw||y>=ih)throw Error('Invalid source image cell')
 return [x,y] as const
}
/** Source rectangle covering every bilinear tap. Null when the footprint is no
 * taller than the output, where the existing pair bands already read each row
 * once. A rotation's output row crosses many source rows, so those bands reread. */
function denseSourceSpan(field:Float32Array,b:Rect,iw:number,ih:number,x0=0,x1=b.w,y0=0,y1=b.h):SourceSpan|null{
 let left=iw,top=ih,right=-1,bottom=-1
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
  const cell=cellAt(field,y*b.w+x,iw,ih);if(!cell)continue
  if(cell[0]<left)left=cell[0]
  if(cell[1]<top)top=cell[1]
  if(cell[0]>right)right=cell[0]
  if(cell[1]>bottom)bottom=cell[1]
 }
 if(right<0)return null
 const span={x:left,y:top,w:Math.min(iw,right+2)-left,h:Math.min(ih,bottom+2)-top}
 return span.h>y1-y0?span:null
}
function postSpan(uri:string,span:SourceSpan){
 const payload=new Uint32Array([span.x,span.y,span.w,span.h])
 const xhr=new XMLHttpRequest();xhr.open('POST',uri+'&span=1',false);xhr.responseType='arraybuffer';xhr.send(payload)
 if(xhr.status!==200||!(xhr.response instanceof ArrayBuffer)||xhr.response.byteLength!==span.w*span.h*4)throw Error('无法读取旋转图片的原始采样区域')
 return new Uint8Array(xhr.response)
}
function noteRead(read:DenseSourceRead,bytes:number){
 read.requests++;read.sourceBytes+=bytes
 read.inFlightBytes=Math.max(read.inFlightBytes,bytes)
 read.residentBytes=Math.max(read.residentBytes,bytes)
}
function scatterSpan(field:Float32Array,b:Rect,span:SourceSpan,raw:Uint8Array,iw:number,ih:number,x0:number,x1:number,y0:number,y1:number,tap:(dest:number,rawAt:number)=>void){
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
  const index=y*b.w+x,cell=cellAt(field,index,iw,ih);if(!cell)continue
  const ox=2*x,oy=2*y;field[index*4]=ox;field[index*4+1]=oy
  for(let dy=0;dy<2;dy++){
   const sy=Math.min(ih-1,cell[1]+dy)
   for(let dx=0;dx<2;dx++){
    const sx=Math.min(iw-1,cell[0]+dx)
    tap((oy+dy)*b.w*2+(ox+dx),((sy-span.y)*span.w+(sx-span.x))*4)
   }
  }
 }
}
/** Output strips whose source rectangles fit the 64 MiB reply. One pixel that
 * cannot is left for the pair reader. */
function spanStrips(field:Float32Array,b:Rect,iw:number,ih:number){
 const whole=denseSourceSpan(field,b,iw,ih)
 if(!whole)return
 if(whole.w*whole.h*4<=SPAN_BYTES)return [{x:0,y:0,w:b.w,h:b.h,span:whole}]
 const strips:{x:number;y:number;w:number;h:number;span:SourceSpan}[]=[]
 let y=0
 while(y<b.h){
  let best=0,lo=1,hi=b.h-y
  while(lo<=hi){
   const mid=lo+((hi-lo)>>1),span=denseSourceSpan(field,b,iw,ih,0,b.w,y,y+mid)
   if(span&&span.w*span.h*4<=SPAN_BYTES){best=mid;lo=mid+1}else hi=mid-1
  }
  if(best>0){
   strips.push({x:0,y,w:b.w,h:best,span:denseSourceSpan(field,b,iw,ih,0,b.w,y,y+best)!});y+=best;continue
  }
  let x=0
  while(x<b.w){
   let width=0;lo=1;hi=b.w-x
   while(lo<=hi){
    const mid=lo+((hi-lo)>>1),span=denseSourceSpan(field,b,iw,ih,x,x+mid,y,y+1)
    if(span&&span.w*span.h*4<=SPAN_BYTES){width=mid;lo=mid+1}else hi=mid-1
   }
   if(!width)return
   strips.push({x,y,w:width,h:1,span:denseSourceSpan(field,b,iw,ih,x,x+width,y,y+1)!});x+=width
  }
  y++
 }
 return strips
}
function readDenseTaps(uri:string,field:Float32Array,b:Rect,iw:number,ih:number,tap:(dest:number,raw:Uint8Array,rawAt:number)=>void){
 const strips=spanStrips(field,b,iw,ih)
 const read:DenseSourceRead={mode:strips?'span':'pairs',requests:0,sourceBytes:0,residentBytes:0,inFlightBytes:0}
 if(strips){
  for(const strip of strips){
   const raw=postSpan(uri,strip.span);noteRead(read,raw.byteLength)
   scatterSpan(field,b,strip.span,raw,iw,ih,strip.x,strip.x+strip.w,strip.y,strip.y+strip.h,(dest,rawAt)=>tap(dest,raw,rawAt))
  }
  lastDenseSourceRead=read;return
 }
 const bandRows=Math.max(1,Math.floor(8192/b.w))
 for(let y=0;y<b.h;y+=bandRows){
  const h=Math.min(bandRows,b.h-y),data=new Uint32Array(2+b.w*h*2);data.set([b.w,h])
  for(let i=0;i<b.w*h;i++){
   const index=y*b.w+i,cell=cellAt(field,index,iw,ih);if(!cell)continue
   data[2+i*2]=cell[0];data[3+i*2]=cell[1]
   field[index*4]=2*(i%b.w);field[index*4+1]=2*(y+Math.floor(i/b.w))
  }
  const xhr=new XMLHttpRequest();xhr.open('POST',uri+'&pairs=1',false);xhr.responseType='arraybuffer';xhr.send(data)
  if(xhr.status!==200||!(xhr.response instanceof ArrayBuffer)||xhr.response.byteLength!==b.w*h*16)throw Error('无法读取旋转图片的原始采样区域')
  const raw=new Uint8Array(xhr.response);noteRead(read,raw.byteLength)
  for(let i=0;i<raw.length;i+=4)tap(y*2*b.w*2+i/4,raw,i)
 }
 lastDenseSourceRead=read
}
// A rotated/sheared image has no separable axes. A rotation reads each source
// row of its footprint once; a short footprint keeps the pair bands. Fractions
// stay in the field. The reply is scattered and dropped inside this call.
export function readDenseSourceGrid(uri:string,field:Float32Array,b:Rect,iw:number,ih:number,lut:Float32Array){
 const out=new Float32Array(b.w*2*b.h*2*4)
 readDenseTaps(uri,field,b,iw,ih,(dest,raw,at)=>{
  const a=lut[256+raw[at+3]],i=dest*4
  out[i]=lut[raw[at]]*a;out[i+1]=lut[raw[at+1]]*a;out[i+2]=lut[raw[at+2]]*a;out[i+3]=a
 })
 return out
}
// Straight RGBA8 of the same 2× tap grid as the linear fetch. Coordinates stay
// in that fetch's layout: xy is the integer 2× cell, zw is the original
// fraction. Hosted WebGPU loads these bytes from an rgba8uint image, decodes
// them with the sRGB table, and filters with the same bsBilinear4. Invalid
// cells remain -2 so every tap is outside the texture and contributes zero.
export function readDenseSourceGridBytes(uri:string,field:Float32Array,b:Rect,iw:number,ih:number){
 const out=new Uint8Array(b.w*2*b.h*2*4)
 readDenseTaps(uri,field,b,iw,ih,(dest,raw,at)=>out.set(raw.subarray(at,at+4),dest*4))
 return out
}
/** Interaction display may upload the straight grid. Exact readback, an
 *  unpresented reference, resolve, presentation and software raster stay on
 *  the float grid. */
export function hostedDenseByteFrame(frame:{present:boolean;readback:boolean;resolve?:boolean;presentation?:boolean;softwareRaster?:boolean}){
 return frame.present&&!frame.readback&&frame.resolve!==true&&frame.presentation!==true&&frame.softwareRaster!==true
}
/** WebGPU requires a 256-byte row stride. Already-aligned images keep their
 *  packed buffer; other widths are copied into a padded staging image. */
export function straightImageUploadRows(bytes:Uint8Array,width:number,height:number){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||bytes.length!==width*height*4)throw Error('Invalid straight sRGB source')
 const bytesPerRow=Math.ceil(width*4/256)*256
 if(bytesPerRow===width*4)return {bytes,bytesPerRow}
 const padded=new Uint8Array(bytesPerRow*height)
 for(let y=0;y<height;y++)padded.set(bytes.subarray(y*width*4,(y+1)*width*4),y*bytesPerRow)
 return {bytes:padded,bytesPerRow}
}
/** Managed paint uniforms for a straight RGBA8 image. u[207] selects rgba8uint
 *  sampling plus the sRGB table inside linearImageTexel. u[206] is the
 *  separate source-detail mix. Paint mode 2 and the image-resolve step both
 *  sample that texture; this helper never enables the byte-space u[187] branch. */
export function noteHostedStraightImage(u:Float32Array,straight:boolean,sourceDetailSampling:boolean,certifiedRange:boolean){
 if((u[16]!==2&&u[16]!==51)||u[28]!==3)return
 u[207]=straight?1:0
 u[206]=sourceDetailSampling&&straight||certifiedRange?1:0
}
/** The float bind group cannot accept rgba8uint. Straight bytes move to the
 *  dedicated uint binding; the float image slot keeps an ordinary texture. */
export function hostedStraightFloatInputs<T>(inputs:readonly T[],straight:T|undefined,blank:T):{inputs:T[],byteImage:T}{
 if(straight===undefined)return {inputs:inputs.slice(),byteImage:blank}
 if(inputs[1]!==straight||inputs.some((texture,index)=>index!==1&&texture===straight))
  throw Error('Straight RGBA byte image must be the hosted paint source')
 const copy=inputs.slice()
 copy[1]=blank
 return {inputs:copy,byteImage:straight}
}
/** Byte-space mix used by `smpBytesIndex`. The hosted straight grid does not
 *  take that branch; tests use this as the unequal negative control. */
export function sampleHostedByteImage(bytes:Uint8Array,width:number,height:number,x:number,y:number):[number,number,number,number]{
 const at=(px:number,py:number)=>{
  const ix=Math.floor(px),iy=Math.floor(py)
  if(ix<0||iy<0||ix>=width||iy>=height)return [0,0,0,0]
  const i=(iy*width+ix)*4
  return [bytes[i],bytes[i+1],bytes[i+2],bytes[i+3]]
 }
 const kx=x-Math.floor(x),ky=y-Math.floor(y),bx=Math.floor(x),by=Math.floor(y)
 const mix=(a:number[],b:number[],t:number)=>a.map((v,i)=>v+(b[i]-v)*t)
 const top=mix(at(bx,by),at(bx+1,by),kx),bottom=mix(at(bx,by+1),at(bx+1,by+1),kx)
 return mix(top,bottom,ky).map(v=>v/255) as [number,number,number,number]
}
