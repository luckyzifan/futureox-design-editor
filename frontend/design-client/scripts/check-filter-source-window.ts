/** Independent cropped-texture scalar oracle for private logical windows.
 * This proves addressing/equivalence only, not a renderer or cache speedup. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { prefixRationalUnsupported } from '../src/kernel/gpu/prefix-preflight'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

type Fixture={name:string;axis:0|1;radius:number;width:number;height:number;physicalWidth:number;physicalHeight:number;
  physicalX:number;physicalY:number;outputWidth:number;outputHeight:number;offset:number;clamp:boolean;channels:number;
  opaque:boolean;forceScalar:boolean;expectPrefix:boolean;expectMixed:boolean;expectRollover:boolean;values:number[];kernel:number[];certified:number[]}
if(process.env.VITE_DESIGN_FILTER_SOURCE_WINDOW!=='1')throw Error('Set VITE_DESIGN_FILTER_SOURCE_WINDOW=1')
if(process.env.VITE_DESIGN_OPAQUE_TENT==='0'||process.env.VITE_DESIGN_PREFIX_RGB_RESOLVE==='0')throw Error('Keep opaque/RGB paths enabled for the window oracle')
await runProof('futureox-filter-source-window',[],async proof=>{
  const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
  const fixtures:Fixture[]=[]
  const add=(name:string,axis:0|1,radius:number,pattern:'normal'|'mixed'|'subnormal'|'nonfinite',options:Partial<Fixture>={},lines=7)=>{
    const length=radius>1000?3484:1108,reach=Math.ceil(radius)+1
    const width=axis===0?length:lines,height=axis===1?length:lines,outputLength=radius>1000?1032:64
    const pixels=new Float32Array(width*height*4),words=new Uint32Array(pixels.buffer)
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<4;c++){
      const along=axis===0?x:y,cross=axis===0?y:x,at=(y*width+x)*4+c
      if(c===3){pixels[at]=1;continue}
      if(pattern==='subnormal'){words[at]=[0,0x80000000,1,3,0x80000001,0x80000003,0x007fffff,0x00800001][(along+cross+c)%8];continue}
      pixels[at]=(1+(along*17+cross*29+c*53)%251)/256*(pattern==='mixed'&&c===1?2**([-32,0,20][along%3]):1)*((along+c)%4===0?-1:1)
      if(pattern==='nonfinite'&&along===reach+17&&c===1)words[at]=0x7fc12345
    }
    const kernel=rational_tent_kernel_rgba(radius),certified=certified_tent_kernel_rgba(radius)
    if(prefixRationalUnsupported(kernel))throw Error(`Fixture ${name} has an unsupported native prefix denominator`)
    fixtures.push({name,axis,radius,width,height,physicalWidth:width+31,physicalHeight:axis===1&&radius>1000?6556:height+37,
      physicalX:11,physicalY:axis===1&&radius>1000?2048:17,outputWidth:axis===0?outputLength:lines,
      outputHeight:axis===1?outputLength:lines,offset:reach,clamp:false,channels:15,opaque:true,forceScalar:false,
      expectPrefix:true,expectMixed:pattern==='mixed'||pattern==='nonfinite',expectRollover:radius>1000,
      values:Array.from(words),kernel:Array.from(kernel),certified:Array.from(certified),...options})
  }
  for(const axis of [0,1] as const){
    add(`117-support-axis${axis}`,axis,1224.3035888671875,'normal')
    add(`mixed-channel-fallback-axis${axis}`,axis,64,'mixed')
    add(`signed-subnormal-axis${axis}`,axis,38.25948715209961,'subnormal')
    add(`logical-zero-edge-axis${axis}`,axis,32,'normal',{offset:0,opaque:false})
    add(`logical-clamp-edge-axis${axis}`,axis,32,'normal',{offset:0,clamp:true,opaque:false,expectPrefix:false})
    add(`forced-scalar-axis${axis}`,axis,38.25948715209961,'normal',{forceScalar:true,expectPrefix:false,opaque:false})
    add(`alpha-only-axis${axis}`,axis,38.25948715209961,'normal',{channels:8,expectPrefix:false,opaque:false})
    add(`nonfinite-logical-axis${axis}`,axis,64,'nonfinite',{opaque:false})
    add(`mixed-multiple-bands-axis${axis}`,axis,64,'mixed',{expectRollover:true},189)
  }
  const prepared={cases:fixtures.length,wasmSha256:sha256(wasm),fixtureSha256:sha256(JSON.stringify(fixtures)),
    reference:'Original mode22 direct scalar on an independent tightly cropped texture; no prefix in reference.',
    candidate:'Actual WebGpuDriver.passFilterWindow on a larger physical texture with NaN outside the logical crop.',
    checks:'raw f32 bits; logical-only prefix acceptance/decline counters; opaque/RGB; scalar fallback/clamp/alpha-only; 2-uniform arena rollover; false/no-op invalid requests; finish scratch retirement.'}
  await proof.write('fixtures.json',{...prepared,fixtures})
  if(proof.prepareOnly)return prepared
  const result=await proof.browser(async page=>{
    let progress=0
    await page.exposeFunction('filterWindowProgress',async(value:unknown)=>proof.write(`progress-${++progress}.json`,value))
    return page.evaluate(async(fixtures)=>{
      const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
      const {parameters}=await import('/src/kernel/gpu/types.ts')
      type Texture=import('/src/kernel/gpu/types.ts').Texture
      const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
      const records:any[]=[];let components=0,different=0,peakBytes=0,active:any
      const digest=async(data:Uint32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data.slice().buffer))).map(v=>v.toString(16).padStart(2,'0')).join('')
      const scene={nodes:{}} as any
      try{
        if(raw.timingQueries)throw Error('Disable timestamp queries for this correctness oracle')
        // Physical GPU uniform buffer stays unchanged. The real driver's arena
        // rolls after two groups, exercising captured windows across submits.
        raw.uniformData=new Float32Array(256*2)
        for(const f of fixtures){
          let reference:Uint32Array|undefined
          const variants:any[]=[];active={name:f.name,variants}
          for(const candidate of [false,true]){
            await driver.prepareScene(scene);await driver.prepareFilters(true);driver.begin(new Float32Array(0))
            const textures:Texture[]=[];const own=(texture:Texture)=>{textures.push(texture);return texture}
            try{
              const physicalWidth=candidate?f.physicalWidth:f.width,physicalHeight=candidate?f.physicalHeight:f.height
              const source=own(driver.create(physicalWidth,physicalHeight)),words=new Uint32Array(physicalWidth*physicalHeight*4)
              if(candidate)for(let i=0;i<words.length;i+=4)words.set([0x7fc12345,0xff800000,0x7f7fffff,0x3f800000],i)
              for(let y=0;y<f.height;y++)words.set(new Uint32Array(f.values.slice(y*f.width*4,(y+1)*f.width*4)),
                ((y+(candidate?f.physicalY:0))*physicalWidth+(candidate?f.physicalX:0))*4)
              raw.device.queue.writeTexture({texture:source.resource},words,{bytesPerRow:physicalWidth*16},[physicalWidth,physicalHeight])
              if(candidate&&f.opaque){for(let i=3;i<words.length;i+=4)if(words[i]!==0x3f800000)throw Error('Invalid physical opaque-alpha fixture');source.opaqueAlpha=true}
              const kernel=own(driver.uploadRgba8(new Uint8Array(f.kernel),f.kernel.length/4,1))
              const certified=own(driver.uploadRgba8(new Uint8Array(f.certified),f.certified.length/4,1))
              const target=own(driver.create(f.outputWidth,f.outputHeight)),logical={x:-13,y:37,w:f.width,h:f.height}
              const output={x:logical.x+(f.axis===0?f.offset:0),y:logical.y+(f.axis===1?f.offset:0),w:f.outputWidth,h:f.outputHeight}
              const u=parameters(output,logical,{x:0,y:0,w:kernel.width,h:1},{x:0,y:0,w:certified.width,h:1})
              u[16]=22;u.set([f.radius,f.axis,Number(f.clamp),1],36)
              const inputs=[source,kernel,certified],window={x:f.physicalX,y:f.physicalY,w:f.width,h:f.height},filter={kind:'tent' as const,radius:f.radius}
              const submitted=driver.commandSubmissions
              if(candidate){
                const available=f.forceScalar?0:256*1024*1024-driver.stats().textureBytes-driver.scratchBytes
                if(!driver.passFilterWindow(target,u,inputs,window,f.channels,filter,available))throw Error('Valid source window was rejected')
              }else driver.pass(target,u,inputs,undefined,f.channels) // No prefix filter contract: independent scalar reducer.
              const rollovers=driver.commandSubmissions-submitted
              if(candidate&&f.expectRollover&&rollovers===0)throw Error('Uniform rollover fixture failed to roll')
              // Metadata mutations after encode must not alter queued bindings.
              if(candidate){window.x=0;window.y=0;u.fill(123,0,8);inputs.length=0}
              const actual=new Uint32Array((await driver.readSurface(target)).buffer),examples=[]
              let differences=0
              if(candidate){
                if(!reference||reference.length!==actual.length)throw Error('Missing scalar reference')
                for(let i=0;i<actual.length;i++)if(actual[i]!==reference[i]){differences++;if(examples.length<12)examples.push({component:i,reference:reference[i],candidate:actual[i]})}
                components+=actual.length;different+=differences
              }else reference=actual.slice()
              let counters:any
              if(raw.prefix?.scratchBytes){raw.prefix.encodeCountersReadback(raw.encoder);await driver.checkpoint('checkpoint');counters=await raw.prefix.readCounters()}
              if(candidate&&f.expectPrefix){
                if(!counters||counters.acceptedLines===0)throw Error('Physical NaN border leaked into logical prefix admission or prefix never ran')
                if(f.expectMixed&&counters.declinedLines===0)throw Error('Mixed scalar fallback was not exercised')
                if(!f.expectMixed&&counters.declinedLines!==0)throw Error('Logical-only finite lines unexpectedly declined')
              }
              if(candidate&&!f.expectPrefix&&driver.scratchBytes!==0)throw Error('Expected scalar-only case reserved prefix scratch')
              const expectedOpaque=candidate&&f.opaque&&f.expectPrefix&&!f.clamp&&f.channels===15?1:0
              if(driver.opaqueTentPasses!==expectedOpaque)throw Error('Opaque shortcut count differs from full logical support proof')
              const row={candidate,components:actual.length,differences,examples,sha256:await digest(actual),counters,
                rollovers,opaqueTentPasses:driver.opaqueTentPasses,scratchBytes:driver.scratchBytes}
              variants.push(row)
              peakBytes=Math.max(peakBytes,driver.stats().textureBytes+driver.scratchBytes)
              if(peakBytes>256*1024*1024)throw Error('Proof exceeded 256MiB texture/scratch budget')
              if(differences)throw Error(`${f.name}: raw output differs from original scalar crop`)
              if(candidate){
                const restore=parameters(output,logical);restore[16]=22;restore.set([f.radius,f.axis,Number(f.clamp),1],36)
                const validWindow={x:f.physicalX,y:f.physicalY,w:f.width,h:f.height},validInputs=[source,kernel,certified]
                let invalid=0
                for(const bad of [{...validWindow,x:-1},{...validWindow,y:.5},{...validWindow,w:0},{...validWindow,x:f.physicalWidth}, {...validWindow,h:NaN}]){
                  const draws=driver.drawCalls,scratch=driver.scratchBytes
                  if(driver.passFilterWindow(target,restore,validInputs,bad,f.channels,filter,0))throw Error('Invalid window accepted')
                  if(driver.drawCalls!==draws||driver.scratchBytes!==scratch)throw Error('Rejected window changed GPU state')
                  invalid++
                }
                const saved=target.resource;target.resource=source.resource
                try{if(driver.passFilterWindow(target,restore,validInputs,validWindow,f.channels,filter,0))throw Error('Physical resource alias accepted')}finally{target.resource=saved}
                const after=new Uint32Array((await driver.readSurface(target)).buffer)
                if(after.some((value,index)=>value!==actual[index]))throw Error('Rejected window changed target pixels')
                Object.assign(row,{rejectedNoOps:invalid+1})
              }
              await driver.finish(target,output,output.w,output.h,false,undefined,false)
              if(driver.scratchBytes!==0)throw Error('Finish did not release window prefix scratch')
            }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});throw error}
            finally{for(const texture of textures)driver.destroy(texture)}
          }
          records.push(active);await (globalThis as any).filterWindowProgress({completed:f.name,records,components,different,peakBytes})
        }
        return {status:'passed',adapter:driver.stats().adapter,cases:records.length,components,different,peakBytes,records,
          scope:'Actual independent cropped scalar versus opt-in logical windows, including original rational fallback. No renderer, ring reuse, budget change or latency claim.'}
      }catch(error){return {status:'failed',error:String(error),active,records,components,different,peakBytes}}
      finally{driver.dispose()}
    },fixtures)
  })
  await proof.write('gpu-result.json',result)
  if(result.status!=='passed')throw Error(result.error||'Logical source-window GPU oracle failed')
  return {...prepared,...result}
})
