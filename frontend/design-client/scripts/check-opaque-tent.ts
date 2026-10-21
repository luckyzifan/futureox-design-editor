/** Actual production GPU oracle for omitting a proven-opaque tent alpha pass.
 * Reference removes the certificate; candidate may set it only after this
 * fixture's entire physical alpha upload has been verified as exactly +1. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { prefixRationalUnsupported } from '../src/kernel/gpu/prefix-preflight'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

type Pattern='normal'|'signed-hdr'|'wide-span'|'mixed-span'
type Fixture={name:string;axis:0|1;radius:number;width:number;height:number;outputWidth:number;outputHeight:number;
  offset:number;origin:[number,number];channels:number;clamp:boolean;scissor:boolean;expectShortcut:boolean;
  expectEdgeLoss:boolean;expectRgbDecline:boolean;pattern:Pattern;values:number[];kernel:number[];certified:number[];prefixUnsupported:boolean}
if(process.env.VITE_DESIGN_OPAQUE_TENT==='0')throw Error('Opaque-tent candidate is disabled; fallback cannot count as a tested shortcut')

await runProof('futureox-opaque-tent',[],async proof=>{
  const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
  const fixtures:Fixture[]=[]
  const add=(name:string,axis:0|1,radius:number,pattern:Pattern,options:Partial<Fixture>={},lines=7)=>{
    const large=radius>1000,reach=Math.ceil(radius)+1,length=large?3484:2*reach+67,outputLength=large?1032:67
    const width=axis===0?length:lines,height=axis===1?length:lines,outputWidth=axis===0?outputLength:lines,outputHeight=axis===1?outputLength:lines
    const pixels=new Float32Array(width*height*4)
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const along=axis===0?x:y,cross=axis===0?y:x,p=(y*width+x)*4
      for(let c=0;c<3;c++){
        const fraction=(1+(along*17+cross*29+c*53)%251)/256
        const magnitude=pattern==='wide-span'||pattern==='mixed-span'&&c===1?2**([-32,0,20][(along+c)%3]):pattern==='signed-hdr'?2**((along+cross+c)%21-10):1
        const sign=pattern!=='normal'&&(along+cross+c)%4===0?-1:1
        pixels[p+c]=fraction*magnitude*sign
      }
      pixels[p+3]=1
    }
    const kernel=rational_tent_kernel_rgba(radius),certified=certified_tent_kernel_rgba(radius)
    fixtures.push({name,axis,radius,width,height,outputWidth,outputHeight,offset:reach,origin:[-13,37],channels:15,clamp:false,scissor:false,
      expectShortcut:true,expectEdgeLoss:false,expectRgbDecline:pattern==='wide-span'||pattern==='mixed-span',pattern,
      values:Array.from(new Uint32Array(pixels.buffer)),kernel:Array.from(kernel),certified:Array.from(certified),prefixUnsupported:prefixRationalUnsupported(kernel),...options})
  }
  for(const radius of [32,38.25948715209961,64,1224.3035888671875])for(const axis of [0,1] as const)
    for(const pattern of (radius>1000?['normal'] as const:['normal','signed-hdr'] as const))add(`${pattern}-r${radius}-axis${axis}`,axis,radius,pattern)
  for(const axis of [0,1] as const){
    add(`wide-rgb-decline-axis${axis}`,axis,64,'wide-span')
    add(`mixed-rgb-decline-multiple-bands-axis${axis}`,axis,64,'mixed-span',{},257)
    add(`edge-start-axis${axis}`,axis,32,'normal',{offset:0,expectShortcut:false,expectEdgeLoss:true})
    // High-radius edge windows exercise the original transparent border.
    add(`edge-end-117-axis${axis}`,axis,1224.3035888671875,'normal',{offset:3484-1032,expectShortcut:false,expectEdgeLoss:true})
    add(`alpha-only-axis${axis}`,axis,38.25948715209961,'signed-hdr',{channels:8,expectShortcut:false})
    add(`clamped-axis${axis}`,axis,32,'normal',{clamp:true,expectShortcut:false})
    add(`explicit-scissor-axis${axis}`,axis,64,'normal',{scissor:true,expectShortcut:false})
  }
  for(const f of fixtures){
    if(f.expectShortcut&&f.prefixUnsupported)throw Error(`Fixture ${f.name} does not admit the prefix entry`)
    const raw=new Uint32Array(f.values)
    for(let i=3;i<raw.length;i+=4)if(raw[i]!==0x3f800000)throw Error('Fixture alpha is not bit-exact +1')
  }
  const prepared={cases:fixtures.length,wasmSha256:sha256(wasm),fixtureSha256:sha256(JSON.stringify(fixtures)),
    scope:'RGBA reference versus RGB-only opaque shortcut; actual GPU remains required',
    casesSummary:fixtures.map(({values,kernel,certified,...f})=>({...f,components:values.length,kernelBytes:kernel.length,certifiedBytes:certified.length}))}
  await proof.write('fixtures.json',fixtures)
  if(proof.prepareOnly)return prepared
  const result=await proof.browser(async page=>{
    let progress=0
    await page.exposeFunction('opaqueTentProgress',async(value:unknown)=>proof.write(`progress-${String(++progress).padStart(2,'0')}.json`,value))
    return page.evaluate(async(fixtures)=>{
      const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
      const {parameters}=await import('/src/kernel/gpu/types.ts')
      type Texture=import('/src/kernel/gpu/types.ts').Texture
      const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
      const records:any[]=[];let components=0,different=0,maxTextureAndScratchBytes=0,activeCase:any
      const digest=async(values:Float32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Float32Array(values).buffer)))
        .map(v=>v.toString(16).padStart(2,'0')).join('')
      const scene={nodes:{}} as any
      try{
        for(const f of fixtures){
          let reference:Uint32Array|undefined
          const variants:any[]=[]
          activeCase={name:f.name,axis:f.axis,radius:f.radius,variants}
          for(const candidate of [false,true]){
            await driver.prepareScene(scene);await driver.prepareFilters(true)
            driver.begin(new Float32Array(0))
            if(driver.opaqueTentPasses!==0)throw Error('begin did not reset opaque shortcut count')
            const textures:Texture[]=[];const own=(t:Texture)=>{textures.push(t);return t}
            try{
              const pixels=new Float32Array(new Uint32Array(f.values).buffer),pixelBits=new Uint32Array(pixels.buffer)
              for(let i=3;i<pixelBits.length;i+=4)if(pixelBits[i]!==0x3f800000)throw Error('Cannot certify a nonopaque input')
              const source=own(driver.uploadLinear(pixels,f.width,f.height))
              // This is the only candidate difference. The original RGBA
              // control always explicitly removes any upload-side marker.
              delete source.opaqueAlpha;if(candidate)source.opaqueAlpha=true
              const kernel=own(driver.uploadRgba8(new Uint8Array(f.kernel),f.kernel.length/4,1));kernel.prefixRationalUnsupported=f.prefixUnsupported
              const certified=own(driver.uploadRgba8(new Uint8Array(f.certified),f.certified.length/4,1))
              const target=own(driver.create(f.outputWidth,f.outputHeight))
              const sourceRect={x:f.origin[0],y:f.origin[1],w:f.width,h:f.height}
              const output={x:sourceRect.x+(f.axis===0?f.offset:0),y:sourceRect.y+(f.axis===1?f.offset:0),w:f.outputWidth,h:f.outputHeight}
              const u=parameters(output,sourceRect,{x:0,y:0,w:kernel.width,h:1},{x:0,y:0,w:certified.width,h:1})
              u[16]=22;u.set([f.radius,f.axis,Number(f.clamp),1],36)
              const filter={kind:'tent' as const,radius:f.radius},inputs=[source,kernel,certified]
              driver.prepareFilterPass(target,u,inputs,f.channels,filter,256*1024*1024-driver.stats().textureBytes-driver.scratchBytes)
              const scratchReserved=driver.scratchBytes
              driver.pass(target,u,inputs,f.scissor?{x:0,y:0,w:output.w,h:output.h}:undefined,f.channels,filter)
              const hits=driver.opaqueTentPasses,expectedHits=candidate&&f.expectShortcut?1:0
              if(hits!==expectedHits)throw Error(`${f.name}: expected ${expectedHits} opaque shortcuts, observed ${hits}`)
              if(Boolean(target.opaqueAlpha)!==Boolean(expectedHits))throw Error(`${f.name}: incorrect output opaque certificate`)
              const actual=await driver.readSurface(target),actualBits=new Uint32Array(actual.buffer)
              let alphaMinimum=Infinity,alphaMaximum=-Infinity,nonOneAlpha=0,nonzeroRgb=0
              for(let i=0;i<actual.length;i++){
                if(i%4===3){alphaMinimum=Math.min(alphaMinimum,actual[i]);alphaMaximum=Math.max(alphaMaximum,actual[i]);if(actualBits[i]!==0x3f800000)nonOneAlpha++}
                else if(actualBits[i]&0x7fffffff)nonzeroRgb++
              }
              if(f.expectEdgeLoss&&(!(alphaMinimum<1)||nonOneAlpha===0))throw Error(`${f.name}: border alpha loss was hidden`)
              if(f.expectShortcut&&nonOneAlpha)throw Error(`${f.name}: full-footprint alpha is not exactly +1`)
              if(f.channels===8&&nonzeroRgb)throw Error(`${f.name}: alpha-only path changed cleared RGB channels`)
              let prefixCounters:unknown
              if(raw.prefix?.scratchBytes){
                raw.prefix.encodeCountersReadback(raw.encoder);await driver.checkpoint('checkpoint')
                prefixCounters=await raw.prefix.readCounters()
              }
              if(f.expectRgbDecline&&(!(prefixCounters as any)?.declinedLines||!nonzeroRgb))throw Error(`${f.name}: RGB decline fallback was not exercised`)
              if(f.pattern==='mixed-span'&&!(prefixCounters as any)?.acceptedLines)throw Error(`${f.name}: mixed channel acceptance was not exercised`)
              let differences=0;const examples=[]
              if(candidate){
                if(!reference||reference.length!==actualBits.length)throw Error('Missing original RGBA reference')
                for(let i=0;i<reference.length;i++)if(reference[i]!==actualBits[i]){differences++;if(examples.length<12)examples.push({component:i,reference:reference[i],candidate:actualBits[i]})}
                components+=actualBits.length;different+=differences
              }else reference=actualBits.slice()
              maxTextureAndScratchBytes=Math.max(maxTextureAndScratchBytes,driver.stats().textureBytes+driver.scratchBytes)
              if(maxTextureAndScratchBytes>256*1024*1024)throw Error('Probe exceeded texture/scratch budget')
              const row={candidate,opaqueTentPasses:hits,scratchReserved,draws:driver.drawCalls,prefixCounters,
                components:actualBits.length,differences,examples,alphaMinimum,alphaMaximum,nonOneAlpha,nonzeroRgb,pixelSha256:await digest(actual)}
              variants.push(row)
              await driver.finish(target,output,output.w,output.h,false,undefined,false)
              if(driver.scratchBytes!==0)throw Error(`${f.name}: finish retained scratch`)
              Object.assign(row,{scratchAfterFinish:driver.scratchBytes})
              if(differences)throw Error(`${f.name}: ${differences} raw f32 components differ`)
            }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});throw error}
            finally{for(const texture of textures)driver.destroy(texture)}
          }
          records.push({name:f.name,axis:f.axis,radius:f.radius,pattern:f.pattern,channels:f.channels,clamp:f.clamp,scissor:f.scissor,
            expectShortcut:f.expectShortcut,expectEdgeLoss:f.expectEdgeLoss,expectRgbDecline:f.expectRgbDecline,variants})
          await (globalThis as any).opaqueTentProgress({completed:f.name,records,components,different,maxTextureAndScratchBytes})
        }
        return {status:'passed',adapter:driver.stats().adapter,cases:records.length,components,different,maxTextureAndScratchBytes,records,
          scope:'Actual WebGpuDriver original RGBA versus opaque-alpha shortcut, full raw f32 components including border/partial-channel/clamp/declined RGB cases'}
      }catch(error){return {status:'failed',error:String(error),components,different,maxTextureAndScratchBytes,records,activeCase}}
      finally{driver.dispose()}
    },fixtures)
  })
  await proof.write('gpu-result.json',result)
  if(result.status!=='passed')throw Error(result.error||'Opaque-tent GPU oracle failed')
  return {...prepared,...result}
})
