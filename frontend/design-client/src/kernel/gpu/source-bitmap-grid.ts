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


// A rotated/sheared image has no separable axes. Fetch the four native texels
// for each original Rust cell in bounded bands; keep its fractional words.
export function readDenseSourceGrid(uri:string,field:Float32Array,b:Rect,iw:number,ih:number,lut:Float32Array){
 const width=b.w*2,height=b.h*2,out=new Float32Array(width*height*4)
 // The field generator stores -2 for transparent samples and clamps valid
 // source indices to pixel centres before computing their cell and fraction.
 const bandRows=Math.max(1,Math.floor(8192/b.w))
 for(let y=0;y<b.h;y+=bandRows){
  const h=Math.min(bandRows,b.h-y),data=new Uint32Array(2+b.w*h*2);data.set([b.w,h])
  for(let i=0;i<b.w*h;i++){
   const off=(y*b.w+i)*4,x=field[off],v=field[off+1]
   if(x===-2)continue
   if(!Number.isInteger(x)||!Number.isInteger(v)||x<0||v<0||x>=iw||v>=ih)throw Error('Invalid source image cell')
   data[2+i*2]=x;data[3+i*2]=v
   field[off]=2*(i%b.w);field[off+1]=2*(y+Math.floor(i/b.w))
  }
  const xhr=new XMLHttpRequest();xhr.open('POST',uri+'&pairs=1',false);xhr.responseType='arraybuffer';xhr.send(data)
  if(xhr.status!==200||!(xhr.response instanceof ArrayBuffer)||xhr.response.byteLength!==b.w*h*16)throw Error('无法读取旋转图片的原始采样区域')
  const raw=new Uint8Array(xhr.response);for(let i=0;i<raw.length;i+=4){const dest=y*2*width*4+i,a=lut[256+raw[i+3]];out[dest]=lut[raw[i]]*a;out[dest+1]=lut[raw[i+1]]*a;out[dest+2]=lut[raw[i+2]]*a;out[dest+3]=a}
 }
 return out
}

// Straight RGBA8 of the same 2× tap grid as the linear fetch. Coordinates stay
// in that fetch's layout: xy is the integer 2× cell, zw is the original
// fraction. Hosted WebGPU decodes these bytes with the sRGB table inside
// linearImageTexel and filters them with the same bsBilinear4. Invalid cells
// remain -2 so every tap is outside the texture and contributes zero.
export function readDenseSourceGridBytes(uri:string,field:Float32Array,b:Rect,iw:number,ih:number){
 const width=b.w*2,height=b.h*2,out=new Uint8Array(width*height*4)
 const bandRows=Math.max(1,Math.floor(8192/b.w))
 for(let y=0;y<b.h;y+=bandRows){
  const h=Math.min(bandRows,b.h-y),data=new Uint32Array(2+b.w*h*2);data.set([b.w,h])
  for(let i=0;i<b.w*h;i++){
   const off=(y*b.w+i)*4,x=field[off],v=field[off+1]
   if(x===-2)continue
   if(!Number.isInteger(x)||!Number.isInteger(v)||x<0||v<0||x>=iw||v>=ih)throw Error('Invalid source image cell')
   data[2+i*2]=x;data[3+i*2]=v
   field[off]=2*(i%b.w);field[off+1]=2*(y+Math.floor(i/b.w))
  }
  const xhr=new XMLHttpRequest();xhr.open('POST',uri+'&pairs=1',false);xhr.responseType='arraybuffer';xhr.send(data)
  if(xhr.status!==200||!(xhr.response instanceof ArrayBuffer)||xhr.response.byteLength!==b.w*h*16)throw Error('无法读取旋转图片的原始采样区域')
  out.set(new Uint8Array(xhr.response),y*2*width*4)
 }
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
/** Managed paint uniforms for a straight RGBA8 image. u[207] selects the
 *  table decode in linearImageTexel. u[206] is the separate source-detail
 *  mix, and this helper never enables the byte-space u[187] branch. */
export function noteHostedStraightImage(u:Float32Array,straight:boolean,sourceDetailSampling:boolean,certifiedRange:boolean){
 if(u[16]!==2||u[28]!==3)return
 u[207]=straight?1:0
 u[206]=sourceDetailSampling&&straight||certifiedRange?1:0
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
