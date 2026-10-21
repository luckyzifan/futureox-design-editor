/** Actual WebGPU bit oracle for the exact X table. The reference always uses
 * original image paint -> normal over transparent -> four ordered resolves. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine, image_sampling_axes_placed } from '../src/generated/design-kernel/design_kernel.js'
import { certifyExactImageRange, planExactImageXTable } from '../src/kernel/gpu/exact-image-x-table'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

type Window = { name: string; x: number; y: number; w: number; h: number }
type Fixture = { name: string; width: number; height: number; imageWidth: number; imageHeight: number;
  imageBits: number[]; axesBits: number[][]; windows: Window[] }
const scenePath=resolve(process.env.DESIGN_117_SCENE||'/tmp/futureox-fusion-117-scene.json')
const documentPath=resolve(process.env.DESIGN_117_DOCUMENT||'/tmp/futureox-fusion-117-document.json')
if(process.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE!=='1')throw Error('Run with VITE_DESIGN_EXACT_IMAGE_X_TABLE=1; disabled fallback is not a candidate result')
const floats=(bits:number[])=>new Float32Array(new Uint32Array(bits).buffer)
const bits=(values:Float32Array)=>Array.from(new Uint32Array(values.buffer,values.byteOffset,values.length))
function fixture(name:string,pattern:number,fractionKind=0):Fixture {
  const width=73,height=47,imageWidth=19,imageHeight=17,span=Math.max(width,height)
  const pixels=new Float32Array(imageWidth*imageHeight*4),raw=new Uint32Array(pixels.buffer)
  for(let p=0;p<imageWidth*imageHeight;p++)for(let c=0;c<4;c++){
    const at=p*4+c
    if(pattern===2)raw[at]=[1,2,0x80000001,0x007fffff,0x00800001,0x80000000,0][(p*3+c)%7]
    else if(pattern===4&&c<3)raw[at]=[0x7f7fffff,0xff7fffff,0x7f7ffffe,0xff7ffffe,0,0x80000000][(p+c)%6]
    else if(c===3)pixels[at]=pattern===3?0:pattern===5?[4,-3,.125,2][p%4]:[1,.5,0,-.25][p%4]
    else if(pattern===1)pixels[at]=(p+c)%2?-(2**((p*7+c)%25-12)):2**((p*7+c)%25-12)
    else if(pattern===3)pixels[at]=[4,-3,.125][c]
    else pixels[at]=((p*37+c*19)%251)/251
  }
  const axes=Array.from({length:4},(_,sample)=>{
    const a=new Float32Array(span*8)
    for(let x=0;x<width;x++){
      const fractions=fractionKind===1?[-0,0,1,1]:fractionKind===2?[2**-36,1-2**-24,.5,0]:fractionKind===3?[2**-22,2**-23,.5,0]:[0,.125,.5,1-2**-24,1]
      a.set([(x*3+sample)%(imageWidth-1),fractions[(x+sample)%fractions.length],1,-1],x*4)
    }
    for(let y=0;y<height;y++){
      const fractions=fractionKind===1?[1,-0,0,1]:fractionKind===2?[2**-35,.25,1-2**-24,1]:fractionKind===3?[2**-22,2**-21,1-2**-24,1]:[0,.25,.75,1-2**-24,1]
      a.set([(y*5+sample)%(imageHeight-1),fractions[(y+sample)%fractions.length],1,-1],(span+y)*4)
    }
    return a
  })
  return {name,width,height,imageWidth,imageHeight,imageBits:bits(pixels),axesBits:axes.map(bits),
    windows:[{name:'full',x:0,y:0,w:width,h:height},{name:'offset',x:3,y:7,w:31,h:29}]}
}

await runProof('futureox-image-x-table',[scenePath,documentPath],async proof=>{
  const fixtures=[fixture('ordinary',0),fixture('signed-hdr-span24',1),fixture('subnormal',2),fixture('zero-alpha-hdr',3),
    fixture('max-finite',4),fixture('hdr-alpha',5),fixture('corner-zero-one',0,1),fixture('ku36-kv35',0,2),fixture('signed-hdr-ku36-kv35',1,2),fixture('signed-hdr-Y96-boundary',1,3)]
  const sceneBytes=await readFile(scenePath),documentBytes=await readFile(documentPath)
  const scene=JSON.parse(sceneBytes.toString('utf8')),document=JSON.parse(documentBytes.toString('utf8'))
  const nodeId='1AB99304-455A-4A9E-9473-8923A1330FA4',n=scene.nodes[nodeId]
  if(!n||n.children.length||n.fills.length!==1||n.fills[0].kind!=='image'||n.fills[0].image!==document.nodes[nodeId].fills[0].image||n.fills[0].adjust)
    throw Error('Saved real117 source changed; expected the actual unadjusted single image')
  const input={x:-1228,y:-1228,w:3484,h:3484}
  const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
  const engine=new VectorEngine();let realSummary:unknown
  try{
    engine.load_document(documentBytes.toString('utf8'))
    const [imageWidth,imageHeight]=JSON.parse(engine.image_info(n.fills[0].image)),pixels=engine.image_linear(n.fills[0].image)
    const p=n.fills[0],paint=JSON.stringify({kind:'image',color:p.color,fit:p.fit,transform:p.transform,tile:p.tile})
    const axes=Array.from({length:4},(_,sample)=>image_sampling_axes_placed(JSON.stringify(input),new Float64Array(n.matrix),
      new Float64Array(n.size),new Uint32Array([imageWidth,imageHeight]),paint,sample,0,new Int32Array([0,0])))
    const range=certifyExactImageRange(pixels),plan=range&&planExactImageXTable({axes,width:input.w,height:input.h,imageWidth,imageHeight,range})
    if(!plan)throw Error('Real117 native fields unexpectedly reject X-table admission during CPU preparation')
    realSummary={imageWidth,imageHeight,imageSha256:sha256(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)),
      axesSha256:axes.map(a=>sha256(new Uint8Array(a.buffer,a.byteOffset,a.byteLength))),tableBytes:plan.tableBytes,
      rowMin:plan.rowMin,rowCount:plan.rowCount,maxKx:plan.maxKx,maxKy:plan.maxKy}
  }finally{engine.free()}
  const prepared=fixtures.map(f=>{
    const range=certifyExactImageRange(floats(f.imageBits)),plan=range&&planExactImageXTable({...f,axes:f.axesBits.map(floats),range})
    if(!plan)throw Error(`Accepted synthetic fixture ${f.name} was accidentally unsupported`)
    return {name:f.name,width:f.width,height:f.height,windows:f.windows,tableBytes:plan.tableBytes,
      maxKx:plan.maxKx,maxKy:plan.maxKy,range:range}
  })
  await proof.write('fixtures.json',{synthetic:prepared,real:realSummary,sceneSha256:sha256(sceneBytes),documentSha256:sha256(documentBytes),wasmSha256:sha256(wasm)})
  if(proof.prepareOnly)return {scope:'CPU fixture preparation only; actual driver certificate/table/pixel oracle remains unrun',synthetic:prepared,real:realSummary}
  const result=await proof.browser(async page=>{
    let progress=0
    await page.exposeFunction('imageXTableProgress',async(value:unknown)=>proof.write(`progress-${String(++progress).padStart(2,'0')}.json`,value))
    return page.evaluate(async({fixtures,scene,document,nodeId,input,realSummary})=>{
      const {initializeKernelModule}=await import('/src/kernel/module.ts')
      const {VectorEngine,image_sampling_axes_placed}=await import('/src/generated/design-kernel/design_kernel.js')
      const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
      const {planExactImageXTable}=await import('/src/kernel/gpu/exact-image-x-table.ts')
      const {parameters}=await import('/src/kernel/gpu/types.ts')
      type Texture=import('/src/kernel/gpu/types.ts').Texture
      type LocalFixture={name:string;width:number;height:number;imageWidth:number;imageHeight:number;pixels:Float32Array;axes:Float32Array[];windows:{name:string;x:number;y:number;w:number;h:number}[]}
      const toFloats=(raw:number[])=>new Float32Array(new Uint32Array(raw).buffer)
      const digest=async(values:Float32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Float32Array(values).buffer)))
        .map(v=>v.toString(16).padStart(2,'0')).join('')
      await initializeKernelModule()
      const engine=new VectorEngine();engine.load_document(JSON.stringify(document))
      const p=scene.nodes[nodeId].fills[0],realPixels=engine.image_linear(p.image),[iw,ih]=JSON.parse(engine.image_info(p.image))
      const realAxes=Array.from({length:4},(_,sample)=>image_sampling_axes_placed(JSON.stringify(input),new Float64Array(scene.nodes[nodeId].matrix),
        new Float64Array(scene.nodes[nodeId].size),new Uint32Array([iw,ih]),JSON.stringify({kind:'image',color:p.color,fit:p.fit,transform:p.transform,tile:p.tile}),sample,0,new Int32Array([0,0])))
      if(await digest(realPixels)!==(realSummary as any).imageSha256)throw Error('Browser real-image decode differs from native prepared pixels')
      for(let i=0;i<4;i++)if(await digest(realAxes[i])!==(realSummary as any).axesSha256[i])throw Error('Browser real-axis program differs from prepared native metadata')
      const cases:LocalFixture[]=fixtures.map(f=>({...f,pixels:toFloats(f.imageBits),axes:f.axesBits.map(toFloats)}))
      cases.push({name:'actual-117-full-support',width:3484,height:3484,imageWidth:iw,imageHeight:ih,pixels:realPixels,axes:realAxes,
        windows:[{name:'top',x:0,y:0,w:3484,h:58},{name:'middle',x:0,y:1713,w:3484,h:58},{name:'bottom',x:0,y:3426,w:3484,h:58}]})
      const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
      const records:any[]=[],rejections:any[]=[],caseRecords:any[]=[]
      let different=0,components=0,maxBytes=0
      const preparedScene={nodes:{image:{fill:{count:0},fills:[{kind:'image',blend:'normal'}],strokes:[],effects:[],blend:'normal'}}} as any
      const checkpoint=()=>driver.checkpoint('checkpoint')
      const reject=(name:string,work:()=>unknown)=>{const value=work();if(value!==undefined)throw Error(`Unsupported case admitted: ${name}`);rejections.push({name,rejected:true})}
      try{
        for(const f of cases){
          driver.begin(new Float32Array(0));const owned:Texture[]=[]
          const own=(t:Texture)=>{owned.push(t);return t}
          let last:Texture|undefined,lastRect:{x:number;y:number;w:number;h:number}|undefined
          try{
            const image=own(driver.uploadLinear(f.pixels,f.imageWidth,f.imageHeight)),range=driver.imageTableRange(image)
            if(!range)throw Error(`No actual immutable-upload range certificate for ${f.name}`)
            const fields=f.axes.map(a=>own(driver.uploadParameters(a,Math.max(f.width,f.height),2)))
            await driver.prepareScene(preparedScene)
            const plan=planExactImageXTable({axes:f.axes,width:f.width,height:f.height,imageWidth:f.imageWidth,imageHeight:f.imageHeight,range})
            if(!plan)throw Error(`Candidate plan declined accepted fixture ${f.name}`)
            const required=256+plan.tableBytes+plan.x.byteLength+plan.y.byteLength,before=driver.scratchBytes
            const table=await driver.prepareImageTable(image,plan,256*1024*1024-driver.stats().textureBytes-driver.scratchBytes)
            if(!table||table.bytes!==required||driver.scratchBytes-before!==required)throw Error(`Candidate table was not actually created: ${f.name}`)
            caseRecords.push({name:f.name,tableBytes:plan.tableBytes,allocatedBytes:table.bytes,rowMin:plan.rowMin,rowCount:plan.rowCount,
              maxKx:plan.maxKx,maxKy:plan.maxKy,rangeMinimum:range.minimum,rangeMaximum:range.maximum})
            for(const window of f.windows){
              const origin=f.name==='actual-117-full-support'?{x:input.x,y:input.y}:{x:-19,y:23}
              const r={x:origin.x+window.x,y:origin.y+window.y,w:window.w,h:window.h},ir={x:0,y:0,w:f.imageWidth,h:f.imageHeight}
              const mask=own(driver.createBinaryCoverage(window.w,window.h)),white=new Uint8Array(window.w*window.h*4).fill(255)
              raw.device.queue.writeTexture({texture:mask.resource},white,{bytesPerRow:window.w*4},[window.w,window.h])
              const empty=own(driver.create(window.w,window.h));driver.clear(empty)
              const paint=own(driver.create(window.w,window.h)),over=own(driver.create(window.w,window.h))
              const resolved=[own(driver.create(window.w,window.h)),own(driver.create(window.w,window.h))]
              const candidate=own(driver.create(window.w,window.h));let reference=empty
              const referenceDraws=driver.drawCalls
              for(let sample=0;sample<4;sample++){
                const u=parameters(r,r,ir,r);u[16]=2;u[28]=3;u[32]=1;u[241]=1;u.set([origin.x,origin.y],204)
                driver.pass(paint,u,[mask,image,mask,fields[sample]])
                const normal=parameters(r,r,r);normal.set([3,0,1,0],16);driver.pass(over,normal,[paint,empty])
                const resolve=parameters(r,r,r);resolve[16]=48;resolve[17]=sample
                const next=resolved[sample&1];driver.pass(next,resolve,[over,reference]);reference=next
              }
              if(driver.drawCalls-referenceDraws!==12)throw Error('Reference did not encode all original twelve passes')
              const beforeCandidate=driver.drawCalls;driver.resolveImageTable(candidate,table,window.x,window.y)
              if(driver.drawCalls-beforeCandidate!==1)throw Error('Candidate table resolve was not encoded')
              const expected=await driver.readSurface(reference),actual=await driver.readSurface(candidate)
              const a=new Uint32Array(expected.buffer),b=new Uint32Array(actual.buffer),examples=[]
              let differences=0
              for(let i=0;i<a.length;i++)if(a[i]!==b[i]){differences++;if(examples.length<12)examples.push({component:i,expected:a[i],actual:b[i]})}
              components+=a.length;different+=differences
              records.push({name:f.name,window,components:a.length,differences,examples,referenceSha256:await digest(expected),candidateSha256:await digest(actual)})
              maxBytes=Math.max(maxBytes,driver.stats().textureBytes+driver.scratchBytes)
              if(maxBytes>256*1024*1024)throw Error('Probe exceeded 256 MiB texture/scratch budget')
              last=candidate;lastRect=r
              if(differences)throw Error(`Exact table changed ${differences} raw f32 components in ${f.name}/${window.name}`)
            }
            await driver.finish(last!,lastRect!,lastRect!.w,lastRect!.h,false,undefined,false)
            if(driver.scratchBytes!==0)throw Error('finish did not retire table scratch')
          }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});throw error}
          finally{for(const texture of owned)driver.destroy(texture)}
          await (globalThis as any).imageXTableProgress({completed:f.name,caseRecords,records,rejections,components,different,maxBytes})
        }
        // Rejections remain explicit outcomes; no candidate fallback is counted
        // as a successful table case. All certificates come from real uploads.
        driver.begin(new Float32Array(0));const owned:Texture[]=[];const own=(t:Texture)=>{owned.push(t);return t}
        try{
          const f=cases[0],image=own(driver.uploadLinear(f.pixels,f.imageWidth,f.imageHeight)),range=driver.imageTableRange(image)!
          await driver.prepareScene(preparedScene)
          const args={axes:f.axes,width:f.width,height:f.height,imageWidth:f.imageWidth,imageHeight:f.imageHeight,range},baseline=planExactImageXTable(args)!
          const span=Math.max(f.width,f.height)
          for(const [name,at,value] of [
            ['negative-cell',0,-1],['missing-neighbour',0,f.imageWidth-1],['fractional-cell',0,.5],
            ['negative-weight',1,-.125],['weight-over-one',1,1.125],['contain-gap',2,0],['dense-marker',3,0],
            ['invalid-y-marker',(span*4)+3,0],['missing-y-neighbour',span*4,f.imageHeight-1],['ku72-overflow',1,2**-72],
          ] as [string,number,number][]){const axes=f.axes.map(a=>a.slice());axes[0][at]=value;reject(name,()=>planExactImageXTable({...args,axes}))}
          const both=f.axes.map(a=>a.slice());both[0][1]=2**-60;both[0][span*4+1]=2**-41
          reject('combined-signed128-bound',()=>planExactImageXTable({...args,axes:both}))
          reject('forged-range',()=>planExactImageXTable({...args,range:{...range}}))
          reject('range-size-mismatch',()=>planExactImageXTable({...args,imageWidth:f.imageWidth-1}))
          reject('table-byte-limit',()=>planExactImageXTable({...args,maxTableBytes:baseline.tableBytes-1}))
          const wide=f.pixels.slice(),wideBits=new Uint32Array(wide.buffer);wideBits[0]=1;wideBits[4]=0x7f7fffff
          const wideImage=own(driver.uploadLinear(wide,f.imageWidth,f.imageHeight)),wideRange=driver.imageTableRange(wideImage)!
          reject('image-exponent-span',()=>planExactImageXTable({...args,range:wideRange}))
          for(const value of [NaN,Infinity]){
            let rejected=false;try{driver.uploadLinear(new Float32Array([value,0,0,1]),1,1)}catch{rejected=true}
            if(!rejected)throw Error('Nonfinite source upload admitted');rejections.push({name:Number.isNaN(value)?'nan-upload':'infinite-upload',rejected})
          }
          const required=256+baseline.tableBytes+baseline.x.byteLength+baseline.y.byteLength
          if(await driver.prepareImageTable(image,baseline,required-1)!==undefined||driver.scratchBytes!==0)throw Error('Insufficient available bytes allocated a table')
          rejections.push({name:'driver-available-byte-limit',rejected:true})
          const handle=await driver.prepareImageTable(image,baseline,required)
          if(!handle)throw Error('Boundary budget could not create the admitted table')
          const target=own(driver.create(5,7))
          for(const [name,x,y] of [['negative-offset',-1,0],['fractional-offset',.5,0],['x-outside',f.width-4,0],['y-outside',0,f.height-6]] as [string,number,number][]){
            let rejected=false;try{driver.resolveImageTable(target,handle,x,y)}catch{rejected=true}
            if(!rejected)throw Error(`Invalid table window admitted: ${name}`);rejections.push({name,rejected})
          }
          driver.resolveImageTable(target,handle,0,0);await checkpoint()
          driver.clear(image)
          if(driver.imageTableRange(image)!==undefined||await driver.prepareImageTable(image,baseline,required)!==undefined)throw Error('Source write retained table authority')
          let revoked=false;try{driver.resolveImageTable(target,handle,0,0)}catch{revoked=true}
          if(!revoked)throw Error('Revoked source still resolved');rejections.push({name:'source-write-revokes-table',rejected:true})
          await driver.finish(target,{x:0,y:0,w:5,h:7},5,7,false,undefined,false)
          if(driver.scratchBytes!==0)throw Error('Rejection case leaked scratch')
        }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});throw error}
        finally{for(const texture of owned)driver.destroy(texture)}
        return {status:'passed',adapter:driver.stats().adapter,cases:caseRecords.length,windows:records.length,components,different,
          maxBytes,records,caseRecords,rejections,reference:'Original production mode2 -> mode3 over transparent -> mode48 in sample order 0,1,2,3. Mode51 is not used as the oracle.'}
      }catch(error){return {status:'failed',error:String(error),components,different,maxBytes,records,caseRecords,rejections}}
      finally{driver.dispose();engine.free()}
    },{fixtures,scene,document,nodeId,input,realSummary})
  })
  await proof.write('gpu-result.json',result)
  if(result.status!=='passed')throw Error(result.error||'X-table GPU oracle failed')
  return result
})
