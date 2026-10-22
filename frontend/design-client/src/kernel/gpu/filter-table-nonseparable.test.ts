import {readFileSync} from 'node:fs'
import {expect,test,vi,afterEach} from 'vitest'
import { image_sampling_grid_placed } from '../../generated/design-kernel/design_kernel'
import {setGpuDiagnosticSink,sanitizeFields,createRenderDiagnostics,sanitizeBatch,sanitizeRecord,recordGpuDiagnostic} from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(()=>setGpuDiagnosticSink(undefined))
import {certifyExactImageRange} from './exact-image-x-table'
import {GpuRenderer} from './renderer'
import {inverse} from '../../geometry'
import type {Driver,Texture} from './types'
function fixture(width=2049,height=2048) {
 const make=(w:number,h:number)=>({width:w,height:h,bytes:w*h*16,resource:{}} as Texture)
 const fields:{width:number;height:number;bytes:number;head:number[];words:Uint32Array}[]=[],passes:any[]=[]
 const driver={name:'webgpu',managed:true,linearLight:true,scratchBytes:0,create:vi.fn(make),clear:vi.fn(),destroy:vi.fn(),
  uploadLinear:vi.fn((_values:Float32Array,w:number,h:number)=>make(w,h)),
  uploadParameters:vi.fn((values:Float32Array,w:number,h:number)=>{fields.push({width:w,height:h,bytes:values.byteLength,words:new Uint32Array(values.buffer,values.byteOffset,values.length).slice(),head:Array.from(new Uint32Array(values.buffer,values.byteOffset,Math.min(values.length,32)))});return make(w,h)}),
  pass:vi.fn((target:Texture,u:Float32Array,inputs:Texture[],region:any,_channels?:number,_filter?:unknown,clearOutside?:boolean)=>{passes.push({target,u:u.slice(),inputs:[...inputs],region,clearOutside})}),checkpoint:vi.fn(async()=>{})}
 const loader=vi.fn(()=>({width:8,height:8,pixels:new Float32Array(8*8*4).fill(.5)}))
 const r=new GpuRenderer(driver as unknown as Driver,true,false,loader as any,false,false,1024) as any
 r.scene={floatCompositing:true,coherentSamples:true,nodes:{}};r.sampleIndex=0
 const rect={x:-137,y:-59,w:width,h:height},matrix=[Math.cos(Math.PI/12),Math.sin(Math.PI/12),-Math.sin(Math.PI/12),Math.cos(Math.PI/12),0,0]
 const p={kind:'image',image:'data:image/png;base64,AA==',color:'#ffffff',opacity:1,blend:'normal',visible:true,stops:[],angle:0,fit:'stretch'}
 const n={id:'controlled-rotated-image',rect,size:[736,414],matrix,inverse:inverse(matrix as any),fills:[p],children:[],effects:[],strokes:[]}
 const mask={texture:make(width,height),rect},dst={texture:make(width,height),rect};r.busy.add(mask.texture);r.busy.add(dst.texture);r.bytes=mask.texture.bytes+dst.texture.bytes
 return {r,n,p,mask,dst,driver,fields,passes}
}

test('optional interpolation table declines nonseparable oversized support without constructing a dense field',async()=>{
 const f=fixture(),input=f.n.rect,header=1+input.h*4,curves=new Float32Array((header+input.h*12)*4)
 curves.set([3,1,input.w,input.h]);for(let row=0;row<input.h*4;row++){curves.set([header+row*3,1,0,0],4+row*4);curves.set([0,input.w,0,0],(header+row*3)*4)}
 Object.assign(f.n,{fill:{rect:input,count:3,sampleCount:4,area:{first:0,count:curves.length/4}}});f.r.scene.curves=curves
 Object.assign(f.driver,{prepareImageTable:vi.fn(),resolveImageTable:vi.fn(),imageTableRange:()=>({opaqueAlpha:true,nonnegativeRgb:true,maximum:[1,1,1,1]}),imageTableAxes:()=>undefined})
 f.r.filterImageFields={rect:input,fields:new Map(),pinned:new Set()}
 f.r.sampleIndex=2
 await expect(f.r.prepareFilterImageTable(f.n,input)).resolves.toBeUndefined()
 expect(f.r.sampleIndex).toBe(2);expect(f.driver.uploadParameters).not.toHaveBeenCalled();expect((f.driver as any).prepareImageTable).not.toHaveBeenCalled()
})

test('declined table retains exact bounded filter-source sampling for all four phases and support rows',async()=>{
 const f=fixture(),input=f.n.rect
 Object.assign(f.n,{fill:{count:1},blend:'normal',opacity:1});Object.assign(f.driver,{maskRegion:vi.fn()})
 f.r.filterImageFields={rect:input,fields:new Map(),pinned:new Set()}
 for(let sample=0;sample<4;sample++)for(const y of [input.y,input.y+64,input.y+input.h-64]){
   const region={x:input.x,y,w:input.w,h:64},before=f.fields.length
   const result=f.r.filterSource(f.n,region,sample)
   expect(result.rect).toEqual(region);expect(f.fields.length).toBeGreaterThan(before)
   const field=f.fields[before],expected=image_sampling_grid_placed(JSON.stringify(region),new Float64Array(f.n.matrix),new Float64Array(f.n.size),new Uint32Array([8,8]),JSON.stringify({kind:'image',color:f.p.color,fit:f.p.fit}),sample,0,new Int32Array([0,0]))
   expect(field.bytes).toBe(region.w*region.h*16);expect(Buffer.from(field.words.buffer).equals(Buffer.from(expected.buffer,expected.byteOffset,expected.byteLength))).toBe(true)
   f.r.release(result)
 }
 expect((f.driver as any).maskRegion).toHaveBeenCalledTimes(12)
})
test('field failure diagnostics preserve thrown primitive and emit only bounded scalar metadata',()=>{
 const f=fixture(),events:any[]=[];setGpuDiagnosticSink((event:any,fields:any)=>events.push({event,fields:sanitizeFields(fields)}))
 const image=f.r.imageFor(f.p.image,0,false)
 let failure:unknown;try{f.r.imageGrid(f.n,f.p,image,0,[0,0],undefined,6)}catch(e){failure=e}
 expect(failure).toBe('Sampling coordinate field exceeds 64 MiB')
 expect(events.filter(e=>e.event==='filter')).toEqual([{event:'filter',fields:{imageFieldCallsite:6,imageFieldStage:4,imageFieldOutcome:2,imageFieldAxes:2,imageFieldSample:0,imageFieldLevel:0,imageFieldWidth:2049,imageFieldHeight:2048,imageFieldSourceWidth:2049,imageFieldSourceHeight:2048,imageFieldDenseBytes:2049*2048*16}}])
 setGpuDiagnosticSink(()=>{throw Error('telemetry down')})
 expect(()=>f.r.imageGrid(f.n,{...f.p},image,0,[0,0],undefined,6)).toThrow('Sampling coordinate field exceeds 64 MiB')
})

test('field diagnostic sanitizer rejects unknown content, out-of-range values and nonfinite values',()=>{
 expect(sanitizeFields({imageFieldCallsite:99,imageFieldStage:NaN,imageFieldOutcome:-1,imageFieldWidth:'2049',imageFieldDenseBytes:Infinity,document:'secret',image:'data:secret',imageFieldAxes:2})).toEqual({imageFieldAxes:2})
})

test('actual compact axes remain eligible for the table and all original phases are restored',async()=>{
 const f=fixture(32,16),input=f.n.rect,programs=new Map<Texture,Float32Array>()
 input.x=8;input.y=4;f.n.size=[64,32]
 f.n.matrix=[1,0,0,1,0,0];f.n.inverse=inverse(f.n.matrix as any)
 const header=1+input.h*4,curves=new Float32Array((header+input.h*12)*4)
 curves.set([3,1,input.w,input.h]);for(let row=0;row<input.h*4;row++){curves.set([header+row*3,1,0,0],4+row*4);curves.set([0,input.w,0,0],(header+row*3)*4)}
 Object.assign(f.n,{fill:{rect:input,count:3,sampleCount:4,area:{first:0,count:curves.length/4}}});f.r.scene.curves=curves
 const upload=f.driver.uploadParameters.getMockImplementation()!
 f.driver.uploadParameters.mockImplementation((values,w,h)=>{const t=upload(values,w,h);programs.set(t,values.slice());return t})
 const pixels=new Float32Array(8*8*4).fill(.5);for(let i=3;i<pixels.length;i+=4)pixels[i]=1
 const range=certifyExactImageRange(pixels)
 const table={bytes:256};Object.assign(f.driver,{prepareImageTable:vi.fn(async()=>table),resolveImageTable:vi.fn(),imageTableRange:()=>range,imageTableAxes:(t:Texture)=>programs.get(t)})
 f.r.sampleIndex=3
 await expect(f.r.prepareFilterImageTable(f.n,input)).resolves.toBe(table)
 expect(f.r.sampleIndex).toBe(3);expect(f.r.pendingImageTableSources.size).toBe(0)
 expect((f.driver as any).prepareImageTable).toHaveBeenCalledOnce()
 expect(f.fields.every(field=>field.height===2)).toBe(true)
})

for(const detail of [false,true])test(`primitive failure crosses actual worker sink and terminal serialization with detail=${detail}`,()=>{
 const worker=readFileSync(new URL('../render-worker.ts',import.meta.url),'utf8')
 const install=worker.match(/setGpuDiagnosticSink\(\(event,fields\)=>terminalDiagnostics\.record\(event,\{requestId:diagnosticRequestId,\.\.\.fields as object\}\)\)/)?.[0]
 expect(install).toBeDefined()
 const wire:any[]=[],terminal:any[]=[]
 const diagnostics=createRenderDiagnostics({enabled:true,detail,session:42,source:'worker',sink:row=>wire.push({renderDiagnostic:row}),batchSink:rows=>wire.push({renderDiagnostics:rows})})
 // Execute the exact production binding, removing only the TypeScript cast.
 new Function('setGpuDiagnosticSink','terminalDiagnostics','diagnosticRequestId',install!.replace(' as object',''))(setGpuDiagnosticSink,diagnostics,151)
 // Overflow the ordinary eight-record fast path, then overwrite the filter aggregate.
 for(let i=0;i<12;i++)recordGpuDiagnostic('filter',{imageFieldCallsite:1})
 const f=fixture(),image=f.r.imageFor(f.p.image,0,false)
 expect(()=>f.r.imageGrid(f.n,f.p,image,0,[0,0],undefined,6)).toThrow('Sampling coordinate field exceeds 64 MiB')
 for(let i=0;i<12;i++)recordGpuDiagnostic('filter',{imageFieldCallsite:2})
 diagnostics.flush();diagnostics.close()
 // Host terminal uses these actual sanitizers after JSON transport.
 for(const message of wire){const transported=JSON.parse(JSON.stringify(message));if(transported.renderDiagnostics)terminal.push(...sanitizeBatch(transported.renderDiagnostics));else{const row=sanitizeRecord(transported.renderDiagnostic);if(row)terminal.push(row)}}
 const origin=terminal.find(row=>row.event==='failure-origin')
 expect(origin).toMatchObject({requestId:151,session:42,source:'worker',failureOriginCode:6,failureBuildKind:2,failureCode:85,failureThrownKind:2,failureBoundaryStage:12,imageFieldCallsite:6,imageFieldStage:4,imageFieldAxes:2,imageFieldWidth:2049,imageFieldHeight:2048,imageFieldDenseBytes:67141632})
 expect(JSON.stringify(terminal)).not.toMatch(/data:image|controlled-rotated-image|Sampling coordinate field/)
 expect(f.r.activeImageFieldFailure).toBeUndefined()
 const later:any[]=[];setGpuDiagnosticSink((event,fields)=>later.push({event,fields}))
 f.r.failureOrigin('unrelated next error',6,1)
 expect(later[0].fields.imageFieldCallsite).toBeUndefined()
})
