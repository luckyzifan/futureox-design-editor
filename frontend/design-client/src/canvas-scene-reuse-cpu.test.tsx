// Mounted production Canvas + real Editor/WASM. Only rendering surfaces and host
// APIs are substitutes. CPU work counts are not browser/GPU/FPS measurements.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, defaultLayout, type DesignDocument } from './model'
import type { SurfaceProps } from './kernel/Surface'
import { worldToScreen } from './canvas-camera'

const observed = vi.hoisted(() => ({
  scenes: [] as {document: import('./model').DesignDocument; page: string; entries: import('./geometry').SceneEntry[]}[],
  indexes: [] as import('./geometry').SpatialIndex[], surface: null as import('./kernel/Surface').SurfaceProps|null,
  gridQueries: 0,
}))
vi.mock('./grid-overlay',async original=>{
  const actual=await original<typeof import('./grid-overlay')>()
  return {...actual,gridOverlayRectangles:(...args:Parameters<typeof actual.gridOverlayRectangles>)=>{
    observed.gridQueries++;return actual.gridOverlayRectangles(...args)
  }}
})
vi.mock('./geometry', async original => {
  const actual = await original<typeof import('./geometry')>()
  return {...actual,scene:(document:DesignDocument,page:string)=>{
    const entries=actual.scene(document,page);observed.scenes.push({document,page,entries});return entries
  },SpatialIndex:class extends actual.SpatialIndex {
    constructor(entries:ReturnType<typeof actual.scene>){super(entries);observed.indexes.push(this)}
  }}
})
vi.mock('./kernel/Surface', () => ({KernelSurface(props:SurfaceProps){observed.surface=props;return <div data-testid="surface-boundary"/>}}))
vi.mock('./CanvasEditPreview', () => ({CanvasEditPreview(){return null}}))
const original = await vi.importActual<typeof import('./geometry')>('./geometry')
const baseline=process.env.CANVAS_SCENE_BASELINE==='1'
let dom:any,root:Root,editor:Editor,mount:HTMLDivElement,errors:unknown[][]
let frames:Map<number,FrameRequestCallback>,frameId:number
function reset(){observed.scenes.length=0;observed.indexes.length=0}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
function report(data:Record<string,unknown>){const row={baseline,...data};console.info('CANVAS_SCENE_REUSE_METRIC',JSON.stringify(row));if(process.env.CANVAS_SCENE_METRICS)appendFileSync(process.env.CANVAS_SCENE_METRICS,JSON.stringify(row)+'\n')}
function id(i:number){return `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12,'0')}`}
function fixture(count:number,kind:'sparse'|'dense'|'deep'='sparse',live=false){
  const doc=blank('Canvas scene reuse');doc.id=id(1);doc.pages[0].id=id(2)
  doc.pages.push({...doc.pages[0],id:id(3),name:'Empty',children:[]})
  let parent:string|undefined
  if(kind==='deep')for(let i=0;i<16;i++){
    const group=node('group',i+.125,i-.375,100,100);group.id=id(100+i);group.transform=[1,.01,-.02,1,i+.125,i-.375]
    doc.nodes[group.id]=group;(parent?doc.nodes[parent].children:doc.pages[0].children).push(group.id);parent=group.id
  }
  for(let i=0;i<count;i++){
    const n=node('rectangle',kind==='dense'?i%8:i*31.125,kind==='dense'?i%9:(i%40)*37.375,20.25,25.5);n.id=id(1000+i)
    n.fills.forEach((paint,j)=>paint.id=id(900000+i*10+j))
    if(!live&&i===0)n.blend='linear-burn'
    if(i%101===0)n.locked=true
    doc.nodes[n.id]=n;(parent?doc.nodes[parent].children:doc.pages[0].children).push(n.id)
  }
  return doc
}
beforeEach(()=>{
  dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
  for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLCanvasElement','Element','Node','Event','MouseEvent','WheelEvent','KeyboardEvent','FocusEvent','localStorage'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
  Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('devicePixelRatio',1)
  vi.stubGlobal('CSS',{escape:(value:string)=>value});dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
  frames=new Map();frameId=0;vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{frames.set(++frameId,fn);return frameId});vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
  Object.defineProperties(dom.window.HTMLElement.prototype,{clientWidth:{configurable:true,get:()=>1000},clientHeight:{configurable:true,get:()=>800}})
  vi.spyOn(dom.window.HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:1000,bottom:800,width:1000,height:800,x:0,y:0,toJSON(){}})
  dom.window.HTMLElement.prototype.setPointerCapture=()=>{};dom.window.HTMLElement.prototype.hasPointerCapture=()=>false;dom.window.HTMLElement.prototype.releasePointerCapture=()=>{}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype,'getContext').mockReturnValue(null)
  errors=[];const error=console.error.bind(console);vi.spyOn(console,'error').mockImplementation((...args)=>{errors.push(args);error(...args)})
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  editor=new Editor(blank());mount=document.createElement('div');document.body.append(mount);root=createRoot(mount);reset();observed.surface=null
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();expect(errors).toEqual([])})
async function render(doc:DesignDocument){editor.load(doc);editor.set({view:{x:0,y:0,zoom:1},snap:false,snapPixels:false});await act(async()=>{root.render(<Canvas editor={editor}/>);for(let i=0;i<8;i++)await Promise.resolve()});await present();reset()}
async function present(){const p=observed.surface!;await act(async()=>p.onPresentation?.({...p,document:editor.state.doc,pageId:editor.state.page,epoch:editor.sessionGeneration,pixelRatio:1,managed:false}))}
function verifyBuilt(){
  for(const item of observed.scenes){
    const expected=original.scene(item.document,item.page)
    expect(item.entries).toEqual(expected)
    for(let i=0;i<expected.length;i++)for(let j=0;j<6;j++)expect(Object.is(item.entries[i].matrix[j],expected[i].matrix[j])).toBe(true)
    const index=observed.indexes.find(value=>value.entries===item.entries)
    if(index){const reference=new original.SpatialIndex(expected);for(const rect of [{x:0,y:0,width:500,height:500},{x:-1e25,y:-1e25,width:2e25,height:2e25}])expect(index.query(rect)).toEqual(reference.query(rect))}
  }
}

test.each([[3000,'sparse'],[10000,'sparse'],[3000,'dense'],[10000,'dense'],[3000,'deep'],[10000,'deep']] as const)('%i %s nodes: fixed displayed snapshot survives 50 new preview snapshots without rebuilding its geometry/index',async(count,kind)=>{
  await render(fixture(count,kind));const before=editor.state.doc,beforeHash=digest(before)
  await act(async()=>editor.begin('Snapshot preview'))
  let scenes=0,indexes=0,nodeVisits=0,oldBuilds=0,cells=0,cellReferences=0,largeEntries=0,durationMs=0
  let first:typeof observed.scenes[number]|undefined
  for(let i=1;i<=50;i++){
    const started=performance.now()
    await act(async()=>{expect(editor.preview({[id(1001)]:{transform:[1,0,0,1,i+.125,i-.375]}})).toBe(true)})
    durationMs+=performance.now()-started
    for(const index of observed.indexes){const storage=index as unknown as {cells:Map<string,unknown[]>;large:unknown[]};cells+=storage.cells.size;for(const values of storage.cells.values())cellReferences+=values.length;largeEntries+=storage.large.length}
    scenes+=observed.scenes.length;indexes+=observed.indexes.length;nodeVisits+=observed.scenes.reduce((n,v)=>n+v.entries.length,0)
    oldBuilds+=observed.scenes.filter(v=>v.document===before).length;first??=observed.scenes[0]
    if(i<50)reset() // Instrumentation must not retain the entire preview history.
  }
  expect(oldBuilds).toBe(baseline?50:0)
  expect(scenes).toBe(baseline?100:50);expect(indexes).toBe(baseline?100:50)
  expect(editor.state.version).toBe(1);expect(digest(before)).toBe(beforeHash)
  const finalDocumentHash=digest(editor.state.doc),finalEntries=original.scene(editor.state.doc,editor.state.page)
  // The first/last complete scenes and query order are checked independently;
  // direct store tests cover every numeric field across edits/history/fonts.
  if(first)observed.scenes.push(first);verifyBuilt()
  report({kind:'fixed-displayed-preview',shape:kind,nodes:count,samples:50,scenes,indexes,nodeVisits,cells,cellReferences,largeEntries,durationMs,finalDocumentHash,finalEntriesHash:digest(finalEntries),baselineSnapshotHash:digest(before)})
  reset();await present();expect(observed.scenes).toHaveLength(0);expect(observed.indexes).toHaveLength(0)
  await act(async()=>editor.cancel());expect(editor.state.doc).toBe(before)
},120000)

test('current/refine sharing removes settled duplicate traversal; camera/hover/selection changes perform no scene/index work',async()=>{
  await render(fixture(200,'sparse',true));const before=editor.state.doc
  await act(async()=>editor.update([id(1001)],{width:80.125}))
  expect(observed.scenes).toHaveLength(1);expect(observed.indexes).toHaveLength(1)
  reset();await act(async()=>vi.advanceTimersByTime(80))
  expect(observed.scenes).toHaveLength(baseline?1:0);expect(observed.indexes).toHaveLength(0)
  expect(observed.surface!.overview).toEqual(original.unionBounds(original.scene(editor.state.doc,editor.state.page).filter(e=>e.depth===0).map(e=>e.bounds)))
  reset()
  for(let i=0;i<10;i++)await act(async()=>{editor.set({view:{x:i+.125,y:-i-.375,zoom:1+i/100}});editor.select([id(1001+i)]);editor.hoverLayer(id(1002+i),'layers')})
  expect(observed.scenes).toHaveLength(0);expect(observed.indexes).toHaveLength(0)
  expect(before).not.toBe(editor.state.doc)
})

test('production Canvas preserves history/page/same-ID reopen, ownership and displayed hit semantics',async()=>{
  await render(fixture(80,'deep'));const initial=editor.state.doc,initialHash=digest(initial)
  const checkpoints:Record<string,unknown>[]=[]
  const check=(name:string)=>{verifyBuilt();checkpoints.push({name,document:digest(editor.state.doc),selection:editor.state.selection,page:editor.state.page,entries:digest(original.scene(editor.state.doc,editor.state.page)),overview:observed.surface!.overview});reset()}
  check('initial')
  await act(async()=>editor.update([id(1001)],{transform:[-.5,.25,-.125,1.5,40.125,30.375]}));check('edit')
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(initial);check('undo')
  await act(async()=>editor.redo());check('redo')
  await act(async()=>editor.set({page:id(3),selection:[]}));check('empty-page')
  await act(async()=>editor.set({page:id(2)}));check('first-page')
  const reopened=editor.state.doc,session=editor.sessionGeneration
  await act(async()=>editor.load(reopened));expect(editor.sessionGeneration).toBe(session+1);expect(editor.state.doc.id).toBe(initial.id);check('same-id-reopen')
  const target=original.scene(editor.state.doc,editor.state.page).find(e=>e.id===id(1001))!,point={x:target.bounds.x+1,y:target.bounds.y+1}
  await present();await act(async()=>vi.advanceTimersByTime(151));const spy=vi.spyOn(editor,'selectionHit')
  const screen=worldToScreen(observed.surface!.view,point)
  await act(async()=>{
    const host=mount.querySelector('[data-testid="canvas"]')!;const event=new MouseEvent('pointermove',{bubbles:true,clientX:screen.x,clientY:screen.y});Object.defineProperties(event,{pointerId:{value:7},isPrimary:{value:true}});host.dispatchEvent(event)
  })
  await act(async()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn(performance.now())}})
  expect(spy).toHaveBeenCalled()
  const [hitPoint,,hitIndex,zoom,hitSnapshot]=spy.mock.calls.at(-1)!
  expect(hitSnapshot!.document).toBe(editor.state.doc)
  expect(editor.selectionHit(hitPoint,false,hitIndex,zoom,hitSnapshot)).toBe(editor.selectionHit(hitPoint,false,new original.SpatialIndex(original.scene(hitSnapshot!.document,hitSnapshot!.pageId)),zoom,hitSnapshot))
  expect(digest(initial)).toBe(initialHash);report({kind:'history-page-reopen',checkpoints});spy.mockRestore()
})

test('local shape previews use the refine-only path without publishing draft geometry, and release/undo/redo stay exact',async()=>{
  await render(fixture(8,'sparse'));const before=editor.state.doc
  await act(async()=>editor.set({tool:'rectangle'}));reset()
  const pointer=(type:string,x:number,y:number)=>{
    const target=mount.querySelector('[data-testid="canvas"]')!,event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0})
    Object.defineProperties(event,{pointerId:{value:7},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(event)
  }
  await act(async()=>pointer('pointerdown',100,100))
  await act(async()=>pointer('pointermove',140,130))
  await act(async()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn(performance.now())}})
  expect(editor.state.doc).toBe(before)
  await act(async()=>vi.advanceTimersByTime(80))
  const preview=observed.surface!.document
  expect(Object.keys(preview.nodes)).toHaveLength(Object.keys(before.nodes).length+1)
  expect(observed.surface!.overview).toEqual(original.unionBounds(original.scene(preview,editor.state.page).filter(e=>e.depth===0).map(e=>e.bounds)))
  verifyBuilt()
  await act(async()=>pointer('pointerup',155.125,144.375))
  const final=editor.state.doc,created=final.nodes[editor.state.selection[0]]
  expect(created.width).toBe(55.125);expect(created.height).toBe(44.375);expect(created.transform).toEqual([1,0,0,1,100,100])
  await act(async()=>editor.undo());expect(editor.state.doc).toEqual(before)
  await act(async()=>editor.redo());expect(editor.state.doc).toEqual(final)
  report({kind:'local-shape-preview-release',width:created.width,height:created.height,transform:created.transform})
})

test('selected Grid overlays reuse solved tracks through camera/hover updates and refresh on edits',async()=>{
 const d=fixture(4,'sparse',true),frame=node('frame',0,0,300,200);frame.id=id(50)
 frame.layout={...defaultLayout(),mode:'grid',columns:2,padding:[0,0,0,0]};frame.children=[...d.pages[0].children]
 d.nodes[frame.id]=frame;d.pages[0].children=[frame.id]
 await render(d);observed.gridQueries=0
 await act(async()=>editor.select([frame.id]))
 const first=observed.gridQueries;expect(first).toBeGreaterThan(0)
 const points=Array.from(mount.querySelectorAll('[data-testid="layout-grid-cell"]')).map(e=>e.getAttribute('points'))
 expect(points).toHaveLength(4)
 for(let i=0;i<10;i++)await act(async()=>{editor.set({view:{x:i*11,y:-i,zoom:1+i/20}});editor.hoverLayer(frame.id,'layers')})
 expect(observed.gridQueries).toBe(first)
 expect(Array.from(mount.querySelectorAll('[data-testid="layout-grid-cell"]')).map(e=>e.getAttribute('points'))).toEqual(points)
 await act(async()=>editor.update([frame.id],{width:400}))
 expect(observed.gridQueries).toBe(first+1)
 expect(Array.from(mount.querySelectorAll('[data-testid="layout-grid-cell"]')).map(e=>e.getAttribute('points'))).not.toEqual(points)
})
