/** Real production pipelines and RGBA32F stores, including gradual underflow. */
import { WebGpuDriver } from './webgpu'
import { parameters, rect, type GpuNode, type GpuScene, type Texture } from './types'
import { initializePicking } from '../picking'
import { effect } from '../../model'
import { rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'

export async function checkSurfaceLifetime() {
  await initializePicking()
  const driver = await WebGpuDriver.create(true, false, false)
  const r = rect(-13, 29, 64, 2), checks: {name: string; words: number; failures: number}[] = []
  const node: GpuNode = {id:'probe',rect:r,size:[r.w,r.h],matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],
    fill:{rect:r,first:0,count:0,rule:'nonzero'},fills:[],strokes:[],effects:[effect('shadow')],children:[],opacity:1,blend:'normal',clip:false,mask:false}
  const scene: GpuScene = {version:7,width:r.w,height:r.h,extent:r,background:'#000000',transparent:true,
    grid:false,view:{x:0,y:0,zoom:1},vertices:[],roots:['probe'],nodes:{probe:node},floatCompositing:true,coherentSamples:true,integratedBlur:true}
  const compare = (name: string, a: Uint32Array, b: Uint32Array) => {
    if(a.length!==b.length)throw Error('Incomplete surface readback')
    checks.push({name,words:a.length,failures:a.reduce((n,v,i)=>n+Number(v!==b[i]),0)})
  }
  const read = async (texture: Texture) => {
    const result=await driver.finish(texture,r,r.w,r.h,true,undefined,false,r)
    if(!result.linear)throw Error('Missing raw f32 readback')
    return new Uint32Array(result.linear.buffer,result.linear.byteOffset,result.linear.length).slice()
  }
  const pass = (mode: number, inputs: Texture[], index=0, scalar=false, radius=0, axis=0) => {
    const target=scalar?driver.createScalarCoverage(r.w,r.h):driver.create(r.w,r.h)
    const u=parameters(r,r,r,r);u[16]=mode;u[17]=index;u[18]=1
    if(mode===22)u.set([radius,axis,0,1],36)
    driver.pass(target,u,inputs,undefined,mode===22?8:15)
    return target
  }
  try {
    await driver.prepareScene(scene);await driver.prepareFilters(false)
    const boundaries=[0,0x80000000,1,2,3,4,0x7fffff,0x800000,0x800001,0x80800001,
      0x3f000000,0xbf000000,0x3f800000,0xbf800000,0x7f7fffff,0xff7fffff]
    let seed=0x51853
    const planes=[0,1,2,3].map(sample=>{
      const bits=new Uint32Array(r.w*r.h*4)
      for(let i=0;i<bits.length;i++){
        seed=(Math.imul(seed,1664525)+1013904223)>>>0
        bits[i]=i<boundaries.length*4?boundaries[(Math.floor(i/4)+sample*3)%boundaries.length]:((seed&0x807fffff)|(((seed>>>23)%254)<<23))>>>0
      }
      return driver.uploadLinear(new Float32Array(bits.buffer),r.w,r.h)
    })
    driver.begin(new Float32Array())
    const reference=await read(pass(23,planes))
    driver.begin(new Float32Array())
    const scalarMean=await read(pass(49,planes,0,true))
    compare('R32F mean preserves alpha bits',reference.filter((_,i)=>i%4===3),scalarMean.filter((_,i)=>i%4===3))
    driver.begin(new Float32Array())
    let accumulated: Texture | undefined
    for(let i=0;i<4;i++)accumulated=pass(48,accumulated?[planes[i],accumulated]:[planes[i]],i)
    compare('streamed mean preserves f32 stores, cancellation and subnormals',reference,await read(accumulated!))
    const physicalZero=driver.uploadLinear(new Float32Array(r.w*r.h*4),r.w,r.h)
    const virtualZero=driver.uploadLinear(new Float32Array(4),1,1);virtualZero.transparentZero=true
    for(const slot of [0,1,2,3]){
      driver.begin(new Float32Array());const physical=[...planes];physical[slot]=physicalZero
      const expected=await read(pass(23,physical))
      driver.begin(new Float32Array());const virtual=[...planes];virtual[slot]=virtualZero
      compare(`virtual zero slot ${slot} retains the resolve rectangle`,expected,await read(pass(23,virtual)))
    }
    const color=new Float32Array([0.125,0.25,0.5,0.75]),field=new Float32Array(r.w*r.h*4)
    for(let i=0;i<field.length;i+=4)field.set(color,i)
    const physicalColor=driver.uploadLinear(field,r.w,r.h),uniformColor=driver.uploadLinear(color,1,1)
    uniformColor.uniformColor=true
    for(const slot of [0,1,2,3]){
      driver.begin(new Float32Array());const physical=[...planes];physical[slot]=physicalColor
      const expected=await read(pass(23,physical))
      driver.begin(new Float32Array());const virtual=[...planes];virtual[slot]=uniformColor
      compare(`uniform color slot ${slot} retains logical bounds`,expected,await read(pass(23,virtual)))
    }
    // Values span the normal/subnormal boundary without HDR overflow; compare
    // both filter axes to the existing four-channel physical representation.
    const alphaBits=new Uint32Array(r.w*r.h*4)
    for(let i=0;i<alphaBits.length;i++)alphaBits[i]=[1,3,0x7fffff,0x800001,0x3e800000,0x3f000000][Math.floor(i/4)%6]
    const alpha=driver.uploadLinear(new Float32Array(alphaBits.buffer),r.w,r.h)
    for(const inner of [false,true])for(const offset of [0,0.25]){
      const shadow=(mode: number)=>{
        const target=driver.create(r.w,r.h),u=parameters(r,r,r)
        u[16]=mode;u.set([0,0.25,0.5,0.75],28);u[32]=0.65;u.set([0,offset,-offset,inner?1:0],36)
        driver.pass(target,u,[alpha,alpha]);return target
      }
      driver.begin(new Float32Array())
      const separate=shadow(6)
      const expected=await read(pass(3,inner?[separate,alpha]:[alpha,separate]))
      driver.begin(new Float32Array())
      compare(`fused ${inner?'inner':'outer'} shadow offset ${offset}`,expected,await read(shadow(50)))
    }
    for(const radius of [0.5,2,3.375,15.625]){
      const packet=rational_tent_kernel_rgba(radius),certificate=certified_tent_kernel_rgba(radius)
      const kernel=driver.uploadRgba8(packet,packet.length/4,1),proof=driver.uploadRgba8(certificate,certificate.length/4,1)
      driver.begin(new Float32Array())
      const expected=await read(pass(22,[pass(22,[alpha,kernel,proof],0,false,radius),kernel,proof],0,false,radius,1))
      driver.begin(new Float32Array())
      const actual=await read(pass(22,[pass(22,[alpha,kernel,proof],0,true,radius),kernel,proof],0,true,radius,1))
      compare(`R32F alpha separable filter radius ${radius}`,new Uint32Array(expected.filter((_,i)=>i%4===3)),new Uint32Array(actual.filter((_,i)=>i%4===3)))
    }
    return {checks,failures:checks.reduce((n,c)=>n+c.failures,0)}
  } finally { driver.dispose() }
}
