import { expect, test } from 'vitest'
import { blank, node, defaultLayout } from './model'
import { Editor } from './engine'
import { createGraphHistory } from './kernel/graph-history'
import { Graph } from './kernel/graph'
import { gridOverlayRectangles } from './grid-overlay'
import { initialPrototype, prototypeEvent } from './prototype'

function fixture() {
  const d = blank(), a = node('rectangle', 10, 20, 40, 30)
  d.nodes[a.id] = a; d.pages[0].children = [a.id]
  return { d, a }
}
test('Graph document history reports real depths and strictly increasing revisions', () => {
  const { d, a } = fixture(), history = createGraphHistory(d)
  try {
    const after = structuredClone(d); after.nodes[a.id].name = 'edit'
    const first = history.apply(0, after)
    expect(first.undoDepth).toBe(1)
    const undo = history.undo(); expect(undo.undoDepth).toBe(0); expect(undo.redoDepth).toBe(1)
    expect(undo.revision).toBeGreaterThan(first.revision)
    const redo = history.redo(); expect(redo.revision).toBeGreaterThan(undo.revision)
    expect(redo.undoDepth).toBe(1)
  } finally { history.free() }
})
test('document replacement invalidates removed handles without aliasing another node', () => {
  const { d, a } = fixture(), graph = Graph.open(JSON.stringify(d)), handle = graph.handle(a.id)
  const replacement = blank(), b = node('ellipse', 10, 20, 40, 30)
  replacement.nodes[b.id] = b; replacement.pages[0].children = [b.id]
  try { graph.replaceDocument(JSON.stringify(replacement)); expect(() => graph.id(handle)).toThrow(/stale/); expect(graph.id(graph.handle(b.id))).toBe(b.id) }
  finally { graph.free() }
})
test('default autolayout uses the kernel inferred vertical arrangement and measured gap', () => {
  const d = blank(), f = node('frame', 100, 200, 132, 198)
  f.transform=[2,0,0,2,100,200]
  d.nodes[f.id] = f; d.pages[0].children = [f.id]
  for (const y of [16, 74, 132]) { const c = node('rectangle', 16, y, 100, 50); f.children.push(c.id); d.nodes[c.id] = c }
  const order=[...f.children];f.children.reverse()
  const e = new Editor(d); e.select([f.id]); e.autoLayout()
  expect(e.state.doc.nodes[f.id].layout).toMatchObject({ mode:'vertical', gap:8, padding:[16,16,16,16] })
  expect(e.state.doc.nodes[f.id].children).toEqual(order)
  e.dispose()
})
test('layout grid overlay retains nested frame world transforms and bounds', () => {
  const d=blank(), f=node('frame',300,200,180,160), c=node('rectangle',16,16,80,60)
  f.layout={...defaultLayout(),mode:'grid',columns:1}; f.transform=[2,0,0,2,300,200]; f.children=[c.id]
  d.nodes={[f.id]:f,[c.id]:c};d.pages[0].children=[f.id]
  const rects=gridOverlayRectangles(d,f.id)
  expect(rects.length).toBeGreaterThan(0)
  expect(rects[0].x).toBeGreaterThanOrEqual(300);expect(rects[0].y).toBeGreaterThanOrEqual(200)
  for(const r of rects){expect(r.x+r.width).toBeLessThanOrEqual(660);expect(r.y+r.height).toBeLessThanOrEqual(520)}
})
test('prototype navigation calls the real WASM animation plan instead of a require fallback', () => {
  const d=blank(), a=node('frame',0,0,100,100),b=node('frame',200,100,100,100)
  d.nodes={[a.id]:a,[b.id]:b};d.pages[0].children=[a.id,b.id];d.prototype={startNode:a.id,interactions:{[a.id]:[{trigger:'click',actions:[{kind:'navigate',target:b.id,durationMs:100}]}]}}
  const next=prototypeEvent(d,initialPrototype(d),a.id,'click')
  expect(next.transition).toMatchObject({from:a.id,to:b.id,frameDelta:[200,100]})
})

test('production tile planning uses the kernel and preserves fractional device phase exactly', async()=>{
  const {planTiles}=await import('./kernel/tile-cache'),{planTilesAligned}=await import('./kernel/tile-plan-aligned')
  for(const z of [.125,.7071067811865476,1,1.189207115002721,2,4,8])for(const p of [0,.125,.999999999]){
    const bounds={x:-255.99,y:127.999,width:79,height:65},phase={x:p,y:1-p===1?0:1-p}
    expect(planTilesAligned(bounds,z,4096,phase)).toEqual(planTiles(bounds,z,4096,phase))
  }
})
test('Graph history stays bounded and a rejected revision cannot mutate the timeline',()=>{
  const {d,a}=fixture(),h=createGraphHistory(d);let revision=0
  try{for(let i=0;i<140;i++){const next=structuredClone(d);next.nodes[a.id].name=String(i);const r=h.apply(revision, next);revision=r.revision;expect(r.undoDepth).toBe(Math.min(i+1,128))}
    expect(()=>h.apply(0, d)).toThrow(/版本/)
    expect(h.undo().undoDepth).toBe(127)
  }finally{h.free()}
})

test('gradient blur is schema-gated and retained by native validation and history',async()=>{
  const {effect,validateDocument}=await import('./model'),{validate_document_json}=await import('./generated/design-kernel/design_kernel')
  const {d,a}=fixture();a.effects=[{...effect('blur'),radius:2,gradientBlur:{start:[0,0],end:[40,0],startCount:0,endCount:3,smooth:true}}]
  expect(()=>validateDocument(d)).toThrow(/版本 9/)
  d.schemaVersion=9;validateDocument(d);validate_document_json(JSON.stringify(d))
  const graph=Graph.open(JSON.stringify(d));try{expect(JSON.parse(graph.documentJson()).nodes[a.id].effects[0].gradientBlur).toEqual(a.effects[0].gradientBlur)}finally{graph.free()}
  a.effects[0].gradientBlur!.startCount=-1;expect(()=>validateDocument(d)).toThrow();expect(()=>validate_document_json(JSON.stringify(d))).toThrow()
})

test('real Rust shortcut tables route core tools and reject unsupported commands',async()=>{
  const {resolveToolShortcut}=await import('./kernel/shortcuts')
  for(const os of ['mac','windows','linux'] as const){
    expect(resolveToolShortcut('v',os)).toBe('select');expect(resolveToolShortcut('n',os)).toBe('pencil');expect(resolveToolShortcut('k',os)).toBe('scale')
    expect(resolveToolShortcut('e',os)).toBe('eraser');expect(resolveToolShortcut('i',os)).toBe('eyedropper');expect(resolveToolShortcut('c',os)).toBe('comments')
    expect(resolveToolShortcut('?',os)).toBeNull()
  }
})

test('inferred banner children keep their geometry outside the flow and Undo restores the document',()=>{
  const d=blank(),f=node('frame',0,0,300,400)
  d.nodes[f.id]=f;d.pages[0].children=[f.id]
  for(const [y,w] of [[16,100],[74,230],[132,100]]){const c=node('rectangle',16,y,w,50);d.nodes[c.id]=c;f.children.push(c.id)}
  const editor=new Editor(d);editor.select([f.id]);const before=editor.state.doc,banner=f.children[1]
  editor.autoLayout();expect(editor.state.doc.nodes[banner].sizing?.absolute).toBe(true)
  expect(editor.state.doc.nodes[banner].transform).toEqual(before.nodes[banner].transform)
  editor.undo();expect(editor.state.doc).toEqual(before);editor.dispose()
})
