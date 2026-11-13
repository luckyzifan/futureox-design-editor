import {expect,test,vi,afterEach} from 'vitest'
import {image_sampling_grid_placed} from '../../generated/design-kernel/design_kernel'
import {GpuRenderer} from './renderer'
import {inverse} from '../../geometry'
import type {Driver,Texture} from './types'
import type {Matrix} from '../../model'

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})

const IMAGE = 512
const VIEW = 256

function uri(){
  return 'design-app://app/source-image/owned-1/'+'ab'.repeat(32)+`-${IMAGE}x${IMAGE}.png?samples=1`
}
function turn(degrees:number):Matrix{
  const radians=degrees*Math.PI/180
  const c=Math.cos(radians),s=Math.sin(radians)
  return [c,s,-s,c,12,8]
}

function fixture(){
  const posts:number[]=[]
  vi.stubGlobal('XMLHttpRequest',class{status=500;responseType='';response=null;open(){}send(){posts.push(1);throw Error('rotated pose re-read source texels')}})
  const fields:Float32Array[]=[]
  const straightUploads:Uint8Array[]=[]
  const make=(w:number,h:number,bytes=w*h*16)=>({width:w,height:h,bytes,resource:{}} as Texture)
  const driver={name:'webgpu',managed:true,linearLight:true,hdr:false,displayMath:false,scratchBytes:0,sourceImageLimit:8192,
    create:vi.fn(make),clear:vi.fn(),destroy:vi.fn(),checkpoint:vi.fn(async()=>{}),
    uploadLinear:vi.fn((_v:Float32Array,w:number,h:number)=>make(w,h)),
    uploadParameters:vi.fn((values:Float32Array,w:number,h:number)=>{fields.push(values.slice());return make(w,h,values.byteLength)}),
    uploadStraightSrgb8:vi.fn((values:Uint8Array,w:number,h:number)=>{straightUploads.push(values.slice());return make(w,h,w*h*4)}),
    pass:vi.fn()}
  const bytes=new Uint8Array(IMAGE*IMAGE*4)
  for(let i=0;i<bytes.length;i+=4){bytes[i]=i&255;bytes[i+3]=255}
  let decodes=0
  const loader=Object.assign(vi.fn(()=>{throw Error('full image decode')}),{straightSrgb8:vi.fn(()=>{decodes++;return {width:IMAGE,height:IMAGE,bytes:bytes.slice()}})})
  const r=new GpuRenderer(driver as unknown as Driver,true,false,loader,false,false,1024) as any
  r.scene={floatCompositing:true,coherentSamples:true,colorManagement:{documentSpace:'srgb'},nodes:{}}
  r.sampleIndex=0
  const rect={x:0,y:0,w:VIEW,h:VIEW}
  const mask={texture:make(VIEW,VIEW),rect},dst={texture:make(VIEW,VIEW),rect}
  r.busy.add(mask.texture);r.busy.add(dst.texture);r.bytes=mask.texture.bytes+dst.texture.bytes
  return {r,driver,fields,straightUploads,decodes:()=>decodes,posts,mask,dst,rect,paint:{
    kind:'image',image:uri(),color:'#ffffff',opacity:1,blend:'normal',visible:true,stops:[],angle:0,fit:'stretch',
  }}
}

function node(matrix:Matrix,paint:ReturnType<typeof fixture>['paint'],rect:{x:number;y:number;w:number;h:number}){
  return {id:'large-rotated-image',rect,size:[VIEW,VIEW],matrix,inverse:inverse(matrix),fills:[paint],children:[],effects:[],strokes:[]}
}

function expectedField(matrix:Matrix,paint:ReturnType<typeof fixture>['paint']){
  return image_sampling_grid_placed(JSON.stringify({x:0,y:0,w:VIEW,h:VIEW}),new Float64Array(matrix),new Float64Array([VIEW,VIEW]),
    new Uint32Array([IMAGE,IMAGE]),JSON.stringify({kind:'image',color:paint.color,fit:paint.fit,transform:paint.transform,tile:paint.tile}),
    0,0,new Int32Array([0,0]))
}

test('a large rotated source image is decoded once and keeps the exact coordinate field',async()=>{
  const f=fixture()
  const angles=[37,-24]
  const uploaded:Float32Array[]=[]
  for(const degrees of angles){
    const matrix=turn(degrees)
    const paint={...f.paint}
    const before=f.fields.length
    await f.r.paintOver(node(matrix,paint,f.rect),paint,f.mask,f.dst,undefined,true)
    const added=f.fields.slice(before).filter(field=>field.length===VIEW*VIEW*4)
    expect(added).toHaveLength(1)
    uploaded.push(added[0])
    const expected=expectedField(matrix,f.paint)
    expect(added[0].length).toBe(expected.length)
    let mismatch=0
    for(let i=0;i<expected.length;i++)if(added[0][i]!==expected[i])mismatch++
    expect(mismatch).toBe(0)
  }
  expect(f.decodes()).toBe(1)
  expect(f.straightUploads).toHaveLength(1)
  expect(f.straightUploads[0].length).toBe(IMAGE*IMAGE*4)
  expect(f.posts).toHaveLength(0)
  expect(f.driver.uploadLinear).not.toHaveBeenCalled()
  let changed=0
  for(let i=0;i<uploaded[0].length;i++)if(uploaded[0][i]!==uploaded[1][i])changed++
  expect(changed).toBeGreaterThan(0)
  const pairsBytesPerPose=VIEW*VIEW*16
  console.log(JSON.stringify({
    case:'large-rotated-source',
    image:IMAGE,viewport:VIEW,poses:angles.length,
    residentImageBytes:f.straightUploads[0].length,
    coordinateFields:uploaded.length,
    coordinateBytes:uploaded[0].byteLength,
    pairsTexelBytesAvoidedPerPose:pairsBytesPerPose,
    sourcePosts:f.posts.length,
    decodes:f.decodes(),
  }))
  expect(pairsBytesPerPose*angles.length).toBeGreaterThan(f.straightUploads[0].length)
})

test('a small rotated crop keeps the single texel request',()=>{
  const f=fixture()
  vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}
    send(body:Uint32Array){this.response=new Uint8Array(body[0]*body[1]*16).buffer}})
  const rect={x:0,y:0,w:64,h:32}
  const matrix=turn(37)
  const paint={...f.paint}
  const grid=f.r.sourceBitmapGrid({...node(matrix,paint,rect),rect},paint)
  expect(grid).toBeTruthy()
  expect(f.decodes()).toBe(0)
  expect(f.driver.uploadStraightSrgb8).not.toHaveBeenCalled()
  expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
})

test('an axis-aligned source crop still uses the separable texel window',()=>{
  const f=fixture()
  vi.stubGlobal('XMLHttpRequest',class{status=200;responseType='';response=new ArrayBuffer(0);open(){}
    send(body:Uint32Array){
      const width=body[0],height=body[1]
      this.response=new Uint8Array(width*height*4).buffer
    }})
  const matrix=[1,0,0,1,0,0] as Matrix
  const grid=f.r.sourceBitmapGrid(node(matrix,f.paint,f.rect),f.paint)
  expect(grid).toBeTruthy()
  expect(f.decodes()).toBe(0)
  expect(f.driver.uploadStraightSrgb8).not.toHaveBeenCalled()
  expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
})
