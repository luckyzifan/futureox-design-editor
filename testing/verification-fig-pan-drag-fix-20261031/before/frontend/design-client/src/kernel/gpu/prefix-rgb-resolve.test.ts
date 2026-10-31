import { afterEach, expect, test, vi } from 'vitest'
import { TexturePrefix, PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { prefixRgbBandSize, prefixBandSize, PREFIX_BYTES, RESULT_BYTES, METADATA_BYTES, READBACK_BYTES } from './prefix-band'
import shader from './texture-prefix.wgsl?raw'

afterEach(()=>vi.unstubAllEnvs())
function recorder(axis:0|1=0,lines=59,rollEvery=2) {
  const events:any[]=[],uniforms:Float32Array[]=[]
  let epoch=0,created=0
  const makeEncoder=(id:number)=>({
    beginComputePass(descriptor:any){return begin('compute',id,descriptor)},
    beginRenderPass(descriptor:any){return begin('render',id,descriptor)},
  })
  let active=makeEncoder(epoch)
  const begin=(kind:string,id:number,descriptor:any)=>{
    expect(id).toBe(epoch)
    const event:any={kind,id,descriptor};events.push(event)
    return {setPipeline(pipeline:any){event.pipeline=pipeline},setBindGroup(slot:number,group:any){if(slot===0)event.u=group.u},
      dispatchWorkgroups(...args:number[]){event.dispatch=args},setScissorRect(...args:number[]){event.scissor=args},
      draw(...args:number[]){event.draw=args},end(){event.ended=true}}
  }
  const prefix=Object.create(TexturePrefix.prototype) as TexturePrefix
  Object.assign(prefix,{device:{createBindGroup(descriptor:any){return {u:descriptor.entries[0].resource.buffer.u}}},
    uniform(u:Float32Array){if(created&&created%rollEvery===0)active=makeEncoder(++epoch);created++;uniforms.push(u.slice());return {buffer:{u:u.slice()},offset:0,size:1024}},
    sourceLayout:{},scratchGroup:{},scan:'scan',solve:'solve',solveRgb:'solveRgb',resolve:['resolve0','resolve1','resolve2','resolve3'],resolveRgb:'resolveRgb'})
  const texture=(width:number,height:number)=>({width,height,format:'rgba32float',createView:()=>({})}) as unknown as GPUTexture
  const source=texture(axis===0?3484:lines,axis===0?lines:3484),target=texture(axis===0?1032:lines,axis===0?lines:1032)
  const rect={x:-13+(axis===0?1226:0),y:37+(axis===1?1226:0),w:target.width,h:target.height},u=new Float32Array(256)
  u.set([rect.x,rect.y,rect.w,rect.h],0);u.set([-13,37,source.width,source.height],4);u[16]=22;u.set([1224.3035888671875,axis,0,1],36)
  const encode=(channels=7,opaque=true,maxBand=255,boundBits=0)=>prefix.encode(()=>active as unknown as GPUCommandEncoder,target,
    [source,texture(1,1),texture(1,1)],u,1224.3035888671875,'tent',rect,channels,maxBand,opaque,boundBits)
  return {prefix,events,uniforms,encode,base:u,get rollovers(){return epoch}}
}

test('RGB bands bound all three unchanged buffers using the cropped output result stride',()=>{
  expect(PREFIX_BYTES+RESULT_BYTES+METADATA_BYTES+READBACK_BYTES).toBe(PREFIX_SCRATCH_BYTES)
  expect(prefixRgbBandSize(3484,1032)).toBe(29)
  expect(29*1032*16).toBe(478848)
  expect(29*1032*32).toBeGreaterThan(RESULT_BYTES)
  for(const length of [1,2,31,32,255,256,511,512,1108,3484,8192,16384])for(const output of [1,Math.min(length,1032),length]){
    const band=prefixRgbBandSize(length,output)
    expect(band).toBeGreaterThan(0);expect(band*(length+1)*32).toBeLessThanOrEqual(PREFIX_BYTES)
    expect(band*output*16).toBeLessThanOrEqual(RESULT_BYTES);expect(16+band*16).toBeLessThanOrEqual(METADATA_BYTES)
  }
  for(const value of [0,-1,.5,NaN,Infinity,16385]){
    expect(prefixRgbBandSize(value,1)).toBe(0);expect(prefixRgbBandSize(1,value)).toBe(0)
  }
  expect(prefixRgbBandSize(3484,1032,2)).toBe(2)
})

test.each([0,1] as const)('band-major RGB encodes three scan/solve pairs then one resolve, axis %s',axis=>{
  vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE','1')
  const f=recorder(axis);expect(f.encode()).toBe(true)
  expect(f.prefix.lastComputePasses).toBe(18);expect(f.prefix.lastRenderPasses).toBe(3)
  expect(f.rollovers).toBe(4)
  for(let band=0;band<3;band++){
    const slice=f.events.slice(band*7,band*7+7),first=band*29,count=band===2?1:29
    expect(slice.map(e=>e.pipeline)).toEqual(['scan','solveRgb','scan','solveRgb','scan','solveRgb','resolveRgb'])
    expect(slice.map(e=>e.u[196])).toEqual([0,0,1,1,2,2,2])
    for(const e of slice){expect([...e.u.slice(192,196)]).toEqual([3484,first,count,axis]);expect(e.u[201]).toBe(1032);expect(e.ended).toBe(true)}
    const resolve=slice[6]
    expect(resolve.scissor).toEqual(axis===0?[0,first,1032,count]:[first,0,count,1032])
    expect(resolve.descriptor.colorAttachments[0].loadOp).toBe(band===0?'clear':'load')
    expect(resolve.descriptor.colorAttachments[0].clearValue).toEqual([0,0,0,1])
    expect(slice[0].dispatch).toEqual([count]);expect(slice[1].dispatch).toEqual([17,count])
  }
})

test('flag-off, absent opaque proof and ordinary RGBA retain original channel-major path',()=>{
  for(const [flag,channels,opaque] of [['0',7,true],['1',7,false],['1',15,true],['1',8,true]] as const){
    vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE',flag)
    const f=recorder();expect(f.encode(channels,opaque)).toBe(true)
    const count=channels===15?4:channels===8?1:3,bands=Math.ceil(59/prefixBandSize(3484))
    expect(f.prefix.lastRenderPasses).toBe(count*bands);expect(f.prefix.lastComputePasses).toBe(count*bands*2)
    expect(f.events.some(e=>e.pipeline==='solveRgb'||e.pipeline==='resolveRgb')).toBe(false)
  }
})

test('forced tiny bands preserve last-line count and fresh encoders through frequent uniform rollover',()=>{
  vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE','1')
  const f=recorder(0,7,1);expect(f.encode(7,true,2)).toBe(true)
  expect(f.rollovers).toBe(11);expect(f.prefix.lastRenderPasses).toBe(4)
  expect(f.events.filter(e=>e.pipeline==='resolveRgb').map(e=>e.scissor)).toEqual([[0,0,1032,2],[0,2,1032,2],[0,4,1032,2],[0,6,1032,1]])
})

test.each([0,1] as const)('coefficient bounds occupy the same immutable uniform slot in RGBA/RGB, axis %s',axis=>{
  for(const [flag,channels] of [['0',15],['0',7],['1',15],['1',7]] as const){
    vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE',flag)
    for(const tight of ['0','1'])for(const bits of [1,64,69,120]){
      vi.stubEnv('VITE_DESIGN_PREFIX_TIGHT_BOUND',tight)
      const f=recorder(axis,7,1);f.base[199]=93
      expect(f.encode(channels,true,2,bits)).toBe(true)
      expect(f.uniforms.length).toBe((channels===15?4:3)*4)
      expect(f.uniforms.every(u=>u[199]===bits)).toBe(true)
      expect(f.events.every(e=>e.u[199]===bits)).toBe(true)
      expect(f.base[199]).toBe(93)
      expect(f.rollovers).toBe(f.uniforms.length-1)
    }
  }
})

test('unknown or malformed coefficient bounds always overwrite inherited u49.w with zero',()=>{
  vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE','1')
  for(const channels of [7,15])for(const bits of [undefined,0,-0,-1,1.5,120.5,121,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER]){
    const f=recorder();f.base[199]=69
    expect(f.encode(channels,true,255,bits)).toBe(true)
    expect(f.uniforms.every(u=>Object.is(u[199],0))).toBe(true)
    expect(f.base[199]).toBe(69)
  }
})

function body(name:string) {
  const at=shader.indexOf(`fn ${name}(`);if(at<0)throw Error(`Missing production ${name}`)
  const start=shader.indexOf('{',at);let end=start+1,depth=1
  while(depth&&end<shader.length){if(shader[end]==='{')depth++;if(shader[end]==='}')depth--;end++}
  if(depth)throw Error('Unterminated WGSL function')
  return shader.slice(start+1,end-1).replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1').replaceAll('vec2<u32>','vec2').replaceAll('bitcast<f32>','bitsToFloat')
}
const vec2=(x:number,y=x)=>({x:x>>>0,y:y>>>0})
const bitsToFloat=(bits:number)=>new Float32Array(new Uint32Array([bits]).buffer)[0]
const floatToBits=(value:number)=>new Uint32Array(new Float32Array([value]).buffer)[0]
function productionResults() {
  const storage=Array.from({length:8},()=>vec2(0xffffffff)),calls:{channel:number;point:unknown;direction:unknown}[]=[]
  let channel=0
  const store=new Function('prefixResults','u','u32','vec2','select',`return function(index,value){${body('prefixStoreRgbResult')}}`)(
    storage,()=>({x:channel}),Number,vec2,(a:number,b:number,condition:boolean)=>condition?b:a) as (index:number,value:{x:number;y:number})=>void
  const read=new Function('prefixResults','select','bitsToFloat','exactFilterChannel',`return function(index,channel,point,direction){${body('prefixRgbChannel')}}`)(
    storage,(a:number,b:number,condition:boolean)=>condition?b:a,bitsToFloat,(point:unknown,direction:unknown,c:number)=>{calls.push({channel:c,point,direction});return -2.5-c}) as (index:number,channel:number,point:unknown,direction:unknown)=>number
  return {storage,calls,store(index:number,c:number,value:number,valid:boolean){channel=c;store(index,vec2(value,Number(valid)))},read}
}

test('production RGB packing selects exact stored bits or scalar fallback for all eight mixed validity masks',()=>{
  const bits=[0x80000000,1,0x7f7fffff],point=[13.5,-7.5],direction=[0,1]
  for(let mask=0;mask<8;mask++){
    const f=productionResults()
    for(let c=0;c<3;c++)f.store(2,c,bits[c],!!(mask&(1<<c)))
    expect(f.storage[5].y).toBe(mask)
    expect([f.storage[4].x,f.storage[4].y,f.storage[5].x]).toEqual(bits)
    for(let c=0;c<3;c++)expect(floatToBits(f.read(2,c,point,direction))).toBe(mask&(1<<c)?bits[c]:floatToBits(-2.5-c))
    expect(f.calls).toEqual([0,1,2].filter(c=>!(mask&(1<<c))).map(channel=>({channel,point,direction})))
    expect(f.storage[0]).toEqual(vec2(0xffffffff)) // No collision with another output pixel.
  }
})

test('a rejected channel zero resets old-band validity before mixed later channels store results',()=>{
  const f=productionResults()
  for(let c=0;c<3;c++)f.store(0,c,0x3f800000+c,true)
  expect(f.storage[1].y).toBe(7)
  f.store(0,0,0,false);expect(f.storage.slice(0,2)).toEqual([vec2(0),vec2(0)])
  f.store(0,1,0x40000000,true);f.store(0,2,0,false)
  expect(f.storage[1].y).toBe(2)
  expect([0,1,2].map(c=>f.read(0,c,[.5,.5],[1,0]))).toEqual([-2.5,2,-4.5])
})
