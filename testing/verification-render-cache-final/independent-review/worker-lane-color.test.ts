import { expect, test } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/node_modules/vitest/dist/index.js'
import { readFileSync } from 'node:fs'
import { GpuRenderer } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/kernel/gpu/renderer'
import { VectorEngine, color_encode_png } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/generated/design-kernel/design_kernel'
import { blank, node, paint } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/model'

function pqLanes() {
  const encoded=color_encode_png(1,1,new Float32Array([.5,.25,.125,1]),
    JSON.stringify({documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}),
    JSON.stringify({space:'rec2100-pq',toneMap:'none'}))
  const uri=`data:image/png;base64,${Buffer.from(encoded).toString('base64')}`
  const engines:Record<string,VectorEngine>={A:new VectorEngine(),B:new VectorEngine()}
  for(const [name,referenceWhiteNits] of [['A',100],['B',203]] as const) {
    const doc=blank('Independent PQ lane'),rectangle=node('rectangle',0,0,1,1)
    doc.schemaVersion=3;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits,peakLuminanceNits:1000}
    rectangle.fills=[{...paint('#ffffff'),kind:'image',image:uri}]
    doc.nodes[rectangle.id]=rectangle;doc.pages[0].children=[rectangle.id]
    engines[name].load_document(JSON.stringify(doc))
  }
  const pixels={A:engines.A.image_linear(uri),B:engines.B.image_linear(uri)}
  expect(pixels.A).not.toEqual(pixels.B)
  return {uri,engines,pixels,free:()=>{engines.A.free();engines.B.free()}}
}

// No device is created. The upload boundary records exact managed inputs while
// the production renderer owns image retention and production resume code owns
// the decision to retire that renderer after a higher-priority lane.
for (const [resumeLane, interruptLane] of [['A','B'],['B','A']]) test(`priority-yield resume ${interruptLane} to ${resumeLane} retires wrong-color GPU image residency even when backend/format match`, async () => {
  const fixture=pqLanes(),{uri,engines,pixels}=fixture,uploads:Float32Array[]=[]
  try {
  let lane=interruptLane,disposed=false
  const driver:any={managed:true,scratchBytes:0,uploadLinear:(pixels:Float32Array,width:number,height:number)=>{
    uploads.push(pixels.slice());return {width,height,bytes:pixels.byteLength,resource:{}}
  },destroy() {}}
  const load=()=>({width:1,height:1,pixels:engines[lane].image_linear(uri)})
  const renderer:any=new GpuRenderer(driver,true,true,load)
  const scene:any={floatCompositing:true,roots:['image'],nodes:{image:{id:'image',children:[],matrix:[1,0,0,1,0,0],effects:[],strokes:[],fills:[{kind:'image',image:uri}]}}}
  renderer.scene=scene;await renderer.loadImages(scene);renderer.imageFor(uri,0,false)
  expect(uploads).toHaveLength(1)
  // Rebinding only the loader cannot fix an already-uploaded identical URI.
  lane=resumeLane;await renderer.loadImages(scene);renderer.imageFor(uri,0,false)
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toEqual(pixels[interruptLane as 'A'|'B'])

  const source=readFileSync(process.env.RENDER_WORKER_REVIEW_SOURCE || `${process.env.REVIEW_REPOSITORY || '/workspace/shared/design-latest-20261019T1209'}/frontend/design-client/src/kernel/render-worker.ts`,'utf8')
  const start=source.indexOf("await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0)")
  expect(start).toBeGreaterThan(0)
  const begin=start+"await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0)".length
  const end=source.indexOf('} finally {',begin)
  expect(end).toBeGreaterThan(begin)
  const resume=source.slice(begin,end)
  const run=new Function('retire',`
    let gpu={dispose:retire}, settingsJson=${JSON.stringify(resumeLane)}, colorKey=${JSON.stringify(interruptLane)}, preference='webgpu', requestPreference='webgpu',
      referenceGpu=false, wantsReference=false, solidBatchGpu=true, wantsBatch=true, tiledPreviewMode=false;
    const unavailable=new Map(),invalidateTileCache=()=>{},generation=0,previewGenerations={canvas:0},channel='canvas',
      fillGeneration=0,tileFillGeneration=0,selectLane=()=>{};
    ${resume}
    return {colorKey,gpu};
  `)
  const restored=run(()=>{disposed=true})
  expect(disposed).toBe(true)
  expect(restored.gpu).toBeUndefined()
  expect(restored.colorKey).toBe(resumeLane)
  const replacement:any=new GpuRenderer(driver,true,true,load)
  replacement.scene=scene;await replacement.loadImages(scene);replacement.imageFor(uri,0,false)
  expect(uploads).toHaveLength(2)
  expect(uploads[1]).toEqual(pixels[resumeLane as 'A'|'B'])
  console.log('INDEPENDENT_PQ_UPLOAD',JSON.stringify({resumeLane,interruptLane,A:[...pixels.A],B:[...pixels.B],uploads:uploads.map(p=>[...p])}))
  } finally {fixture.free()}
})

test('repeated canceled lane returns preserve the newer live renderer and stop before new rendering', () => {
  const source=readFileSync(process.env.RENDER_WORKER_REVIEW_SOURCE || `${process.env.REVIEW_REPOSITORY || '/workspace/shared/design-latest-20261019T1209'}/frontend/design-client/src/kernel/render-worker.ts`,'utf8')
  const start=source.indexOf("await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0)")
  const begin=start+"await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0)".length
  const end=source.indexOf('} finally {',begin)
  expect(end).toBeGreaterThan(begin)
  const resume=source.slice(begin,end)
  const run=new Function('settingsJson','initialColor','previewCanceled','fillCanceled',`
    let disposed=false,renders=0,selections=0,colorKey=initialColor,gpu={dispose:()=>{disposed=true}},
      preference='webgpu',requestPreference='webgpu',referenceGpu=false,wantsReference=false,
      solidBatchGpu=true,wantsBatch=true,tiledPreviewMode=false;
    const unavailable=new Map(),invalidateTileCache=()=>{},generation=0,previewGenerations={canvas:previewCanceled?1:0},channel='canvas',
      fillGeneration=0,tileFillGeneration=fillCanceled?1:0,selectLane=()=>{selections++};
    try {
      ${resume}
      renders++;
      return {disposed,renders,selections,colorKey,error:null};
    } catch(error) { return {disposed,renders,selections,colorKey,error:String(error)}; }
  `)
  for (let i=0;i<8;i++) for(const [previewCanceled,fillCanceled] of [[true,false],[false,true]]) {
    const color=i%2?'A':'B',other=i%2?'B':'A',result=run(color,other,previewCanceled,fillCanceled)
    expect(result.disposed).toBe(false);expect(result.renders).toBe(0)
    expect(result.selections).toBe(0)
    expect(result.colorKey).toBe(other);expect(result.error).toContain('PREVIEW_CANCELLED')
    const same=run(color,color,previewCanceled,fillCanceled)
    expect(same.disposed).toBe(false);expect(same.renders).toBe(0);expect(same.error).toContain('PREVIEW_CANCELLED')
    const current=run(color,color,false,false)
    expect(current.disposed).toBe(false);expect(current.renders).toBe(1);expect(current.error).toBeNull()
  }
})
