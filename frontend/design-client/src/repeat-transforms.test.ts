import {afterEach,expect,test} from 'vitest'
import {blank,node,validateDocument} from './model'
import {defaultRepeat,expandRepeats,repeatDerivedId,repeatSourceId,repeatStep,validateRepeat,validateRepeatDocument} from './repeat-transforms'
import {Editor} from './engine'
import {encodeDocumentBinary,decodeDocumentBinary} from './kernel/binfmt'
import {createDesignAutomation} from './automation/core'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture(){const d=blank(),n=node('rectangle',10,10,10,10);d.schemaVersion=15;n.repeat={...defaultRepeat(n),translation:{x:20,y:0}};d.nodes[n.id]=n;d.pages[0].children=[n.id];return {d,n}}
test('ephemeral repeat scene keeps one authored source and IDs stable',()=>{
 const {d,n}=fixture(),before=JSON.stringify(d),out=expandRepeats(d)
 expect(Object.keys(d.nodes)).toHaveLength(1);expect(Object.keys(out.nodes)).toHaveLength(3);expect(JSON.stringify(d)).toBe(before);expect(expandRepeats(d)).toBe(out)
 expect(out.pages[0].children.map(id=>out.nodes[id].transform[4])).toEqual([10,30,50]);for(const id of out.pages[0].children)expect(repeatSourceId(out,id)).toBe(n.id)
 expect(repeatDerivedId('repeat.v1/source:1/source')).toBe('edebb2de-f85c-804d-762e-a7bbec2c7091')
})
test('parent-coordinate pivot and nested repeats follow matrix composition',()=>{
 const {d,n}=fixture();n.repeat={...n.repeat!,count:2,translation:{x:5,y:0},rotation:Math.PI/2,scale:{x:2,y:2}}
 const child=node('rectangle',2,3,4,5);child.repeat={...defaultRepeat(child),count:2};n.children=[child.id];d.nodes[child.id]=child
 const out=expandRepeats(d);expect(Object.keys(out.nodes)).toHaveLength(6);const t=out.nodes[out.pages[0].children[1]].transform;expect(t[4]).toBeCloseTo(15);expect(t[5]).toBeCloseTo(10);expect(repeatStep(n.repeat)[1]).toBeCloseTo(2)
})
test('reject negative, fractional, excessive, singular and nonfinite params and cyclic/bomb trees',()=>{
 const {d,n}=fixture();for(const count of [-1,0,1.5,257,Infinity,NaN])expect(()=>validateRepeat({...n.repeat!,count})).toThrow()
 for(const rotation of [Infinity,NaN])expect(()=>validateRepeat({...n.repeat!,rotation})).toThrow()
 for(const x of [0,-1,Infinity,NaN])expect(()=>validateRepeat({...n.repeat!,scale:{x,y:1}})).toThrow()
 expect(()=>validateRepeat({...n.repeat!,count:256,scale:{x:100,y:100}})).toThrow()
 n.children=[n.id];expect(()=>validateRepeatDocument(d)).toThrow();n.children=[]
 const child=node('rectangle',0,0,1,1);child.repeat={...defaultRepeat(child),count:256};n.repeat!.count=256;n.children=[child.id];d.nodes[child.id]=child;expect(()=>expandRepeats(d)).toThrow()
})
test('real Editor source edit, picking, undo/redo, cancel and removal do not persist copies',()=>{
 const {d,n}=fixture(),e=new Editor(d);editors.push(e)
 expect(e.hit({x:55,y:15},true)).toBe(n.id)
 e.update([n.id],{width:14},'source width');expect(Object.values(expandRepeats(e.state.doc).nodes).every(n=>n.width===14)).toBe(true)
 expect(Object.keys(e.state.doc.nodes)).toHaveLength(1);e.undo();expect(e.state.doc.nodes[n.id].width).toBe(10);e.redo();expect(e.state.doc.nodes[n.id].width).toBe(14)
 e.begin('repeat gesture');e.update([n.id],{repeat:{...n.repeat!,count:5}},'repeat');e.cancel();expect(e.state.doc.nodes[n.id].repeat?.count).toBe(3)
 e.select([n.id]);e.remove();expect(Object.keys(expandRepeats(e.state.doc).nodes)).toHaveLength(0);expect(e.hit({x:55,y:15},true)).toBeNull();e.undo();expect(e.hit({x:55,y:15},true)).toBe(n.id)
})
test('FD binary and JSON reopen retain repeat params without derived nodes',()=>{
 const {d,n}=fixture();expect(validateDocument(d)).toBe(d);const restored=validateDocument(decodeDocumentBinary(encodeDocumentBinary(d)));expect(restored.nodes[n.id].repeat).toEqual(n.repeat);expect(Object.keys(restored.nodes)).toHaveLength(1)
 const e=new Editor(JSON.parse(JSON.stringify(restored)));editors.push(e);expect(e.hit({x:55,y:15},true)).toBe(n.id)
})
test('MCP node.update edits parameters as a guarded one-undo transaction',()=>{
 const {d,n}=fixture(),e=new Editor(d);editors.push(e);const api=createDesignAutomation(e)
 const response=api.execute({method:'node.update',params:{ids:[n.id],patch:{repeat:{...n.repeat!,count:4}}},expectedRevision:e.state.version,documentId:e.state.doc.id,session:e.sessionGeneration})
 expect(response.ok,JSON.stringify(response)).toBe(true);expect(e.state.doc.nodes[n.id].repeat?.count).toBe(4);expect(Object.keys(e.state.doc.nodes)).toHaveLength(1);e.undo();expect(e.state.doc.nodes[n.id].repeat?.count).toBe(3)
})
test('256 appearances remain bounded; benchmark reports actual expansion counts',()=>{
 const {d,n}=fixture();n.repeat!.count=256;const started=performance.now(),out=expandRepeats(d);expect(Object.keys(out.nodes)).toHaveLength(256)
 console.info(JSON.stringify({benchmark:'repeat-expansion',authoredNodes:1,derivedAppearances:256,expandedNodes:Object.keys(out.nodes).length,elapsedMs:performance.now()-started,authoredBytes:new TextEncoder().encode(JSON.stringify(d)).length}))
})

test('SVG/page and selection export extents include derived copies under transformed parents',async()=>{
 const {exportBounds,targetBounds,svgSource,exportPdfVector}=await import('./export')
 const {d,n}=fixture(),parent=node('group',100,50,100,100);parent.children=[n.id];d.nodes[parent.id]=parent;d.pages[0].children=[parent.id]
 const target={kind:'selection' as const,nodeIds:[n.id]},b=targetBounds(d,d.pages[0].id,target)
 expect(b).toEqual({x:110,y:60,width:50,height:10})
 expect(exportBounds(d,d.pages[0].id,0).width).toBeGreaterThanOrEqual(50)
 const svg=svgSource(d,d.pages[0].id,target);expect(svg.box).toEqual(b);expect(svg.source).toContain('width="50"');expect(Object.keys(d.nodes)).toHaveLength(2)
 const pdf=await exportPdfVector(d,d.pages[0].id,target);expect(pdf.width).toBe(50);expect(pdf.height).toBe(10);expect(pdf.blob.size).toBeGreaterThan(100)
})

test('repeat rejection is an atomic Editor edit without a history entry',()=>{
 const {d,n}=fixture(),e=new Editor(d);editors.push(e);const before=e.state.doc
 e.update([n.id],{repeat:{...n.repeat!,count:-1}},'bad repeat');expect(e.state.doc).toBe(before);expect(e.canUndo).toBe(false)
})


test('history-length edit loops do not retain an unbounded derived-scene cache',()=>{
 const {d}=fixture(),first=expandRepeats(d)
 for(let i=0;i<50;i++){const next=structuredClone(d);next.name=`Iteration ${i}`;expect(Object.keys(expandRepeats(next).nodes)).toHaveLength(3)}
 const recomputed=expandRepeats(d);expect(recomputed).not.toBe(first);expect(recomputed).toEqual(first)
})

test('real WASM CPU selection PNG includes appearances, not just original source',async()=>{
 const {VectorEngine}=await import('./generated/design-kernel/design_kernel'),{d,n}=fixture(),actual=new VectorEngine(),reference=new VectorEngine()
 try{
  actual.load_document(JSON.stringify(d));reference.load_document(JSON.stringify(expandRepeats(d)))
  const request={pageId:d.pages[0].id,bounds:{x:0,y:0,width:64,height:32},scale:1}
  expect(actual.render_region_png(JSON.stringify({...request,nodeIds:[n.id]}))).toEqual(reference.render_region_png(JSON.stringify(request)))
 }finally{actual.free();reference.free()}
})

test('real WASM CPU animation samples the source before deriving copies and restores on stop',async()=>{
 const {VectorEngine}=await import('./generated/design-kernel/design_kernel'),{createClip,recordKeyframe}=await import('./animation')
 const {d,n}=fixture(),clip=createClip(d,d.pages[0].id,[n.id]);d.animations=[clip];n.transform[4]=20;recordKeyframe(d,clip,[n.id],1000,{kind:'linear'});n.transform[4]=10
 const actual=new VectorEngine(),reference=new VectorEngine(),options={pageId:d.pages[0].id,width:80,height:32,view:{x:0,y:0,zoom:1},transparent:true}
 try{
  actual.load_document(JSON.stringify(d))
  for(const timeMs of [500,1000,0,500]){
   const expected=structuredClone(d);expected.animations=[];expected.nodes[n.id].transform[4]=10+timeMs/100
   reference.load_document(JSON.stringify(expandRepeats(expected)))
   expect(actual.render_rgba(JSON.stringify({...options,animation:{clipId:clip.id,timeMs}}))).toEqual(reference.render_rgba(JSON.stringify(options)))
  }
  const stopped=structuredClone(d);stopped.animations=[];reference.load_document(JSON.stringify(expandRepeats(stopped)));expect(actual.render_rgba(JSON.stringify(options))).toEqual(reference.render_rgba(JSON.stringify(options)))
 }finally{actual.free();reference.free()}
})


test('native WASM rejects unknown nested repeat point keys consistently with JS',async()=>{
 const {validateKernelDocument}=await import('./kernel/module')
 for(const key of ['translation','pivot','scale'] as const){
  const {d,n}=fixture();Object.assign(n.repeat![key],{ignored:1})
  expect(()=>validateDocument(d)).toThrow();expect(()=>validateKernelDocument(JSON.stringify(d))).toThrow()
 }
})


test('Sketch export explicitly rejects live repeats while native FD stays editable',async()=>{
 const {export_sketch_json}=await import('./generated/design-kernel/design_kernel'),{d,n}=fixture(),before=JSON.stringify(d)
 expect(()=>export_sketch_json(before)).toThrow(/native FD\/JSON/);expect(JSON.stringify(d)).toBe(before)
 expect(validateDocument(decodeDocumentBinary(encodeDocumentBinary(d))).nodes[n.id].repeat).toEqual(n.repeat)
})


test('approximate semantic HTML explicitly reports omitted repeat appearances',async()=>{
 const {exportDesignCode}=await import('./automation/export'),{d,n}=fixture(),out=exportDesignCode(d)
 expect(out.fidelity).toBe('approximate');expect(out.warnings).toContainEqual(expect.objectContaining({code:'REPEAT_TRANSFORMS_NOT_EXPORTED',nodeId:n.id}))
})
