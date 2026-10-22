// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { activateDocumentFonts, kernelTextLayout } from './kernel/picking'
import { Editor } from './engine'
import { blank, node, defaultLayout, defaultTextStyle, type DesignDocument } from './model'
import { allParents, worldMatrix } from './geometry'
import { parentBounds } from './canvas-view'
import { selectionMetric } from './selection-properties'
import { applyPasteOverPlan, planPasteOverSelection } from './paste-over-selection'
import { dispatchEditorCommand } from './editor-commands'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { canvasMenuItems } from './canvas-menu-model'
import { createClip } from './animation'
import { emptySystem } from './design-system'
import { stampKeys } from './components'
import { shortcutPreference } from './shortcut-preference'
const editors: Editor[] = []
function editor(doc: DesignDocument) { const e = new Editor(doc); editors.push(e); return e }
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.unstubAllGlobals(); shortcutPreference.set('figma-like') })
function fixture() {
  const d = blank(), parent = node('frame', 100, 200, 400, 300), a = node('rectangle', 20.25, 30.75, 30, 40), b = node('rectangle', 120.5, 60.25, 50, 60), outside = node('rectangle', 800, 20, 20, 20)
  parent.children = [a.id, b.id]; d.pages[0].children = [parent.id, outside.id]
  for (const n of [parent,a,b,outside]) d.nodes[n.id] = n
  const e = editor(d); e.select([a.id]); return { e, parent, a, b, outside }
}
function source() {
  const d = blank(), a = node('rectangle', 7.125, 15.375, 25, 35), b = node('ellipse', 60.25, 17.375, 12, 18)
  d.nodes[a.id] = a; d.nodes[b.id] = b; d.pages[0].children = [a.id,b.id]
  const e = editor(d); e.select([a.id,b.id]); return { e,a,b,packet:e.exportClipboard()! }
}
function clipboard(packet: string) { vi.stubGlobal('navigator', { clipboard: { readText: async () => 'FORMA-NODES-V1\n' + packet } }) }
const normal = (d: DesignDocument) => ({ ...d, animations: d.animations || [] })
test('Figma single target retains original, matches Inspector parent-local x/y, preserves world linear basis, one undo/redo and untouched identity', async () => {
  const f = fixture(), s = source()
  f.e.update([f.parent.id], { transform: [1.5,.7,-.3,2,100,200] }); f.e.update([f.a.id], { transform:[.8,.6,-.6,.8,20.25,30.75] })
  const before=f.e.state.doc, target=before.nodes[f.a.id], untouched=before.nodes[f.outside.id], history=f.e.canUndo
  clipboard(s.packet); await dispatchEditorCommand(f.e, 'paste-over-selection', { shortcutProfile:'figma-like' })
  expect(f.e.state.selection).toHaveLength(2); const [first,second]=f.e.state.selection, after=f.e.state.doc
  expect(after.nodes[f.a.id]).toBe(target); expect(after.nodes[f.outside.id]).toBe(untouched)
  expect(allParents(after).get(first)).toBe(f.parent.id); expect(after.nodes[f.parent.id].children).toEqual([f.a.id,first,second,f.b.id])
  const boxes=f.e.state.selection.map(id=>parentBounds(after.nodes[id]))
  expect(Math.min(...boxes.map(b=>b.x))).toBeCloseTo(parentBounds(target).x,10)
  expect(Math.min(...boxes.map(b=>b.y))).toBeCloseTo(parentBounds(target).y,10)
  worldMatrix(after,first).slice(0,4).forEach((v,i)=>expect(v).toBeCloseTo(s.e.state.doc.nodes[s.a.id].transform[i],10))
  // A single pasted root matches the actual Inspector metric, including parent scale.
  const single=JSON.parse(s.packet);single.roots=[s.a.id];clipboard(JSON.stringify(single));f.e.select([f.a.id]);await dispatchEditorCommand(f.e,'paste-over-selection')
  const n=f.e.state.doc.nodes[f.e.state.selection[0]]
  for(const axis of ['x','y'] as const)expect(selectionMetric(n,axis,f.e.state.doc)).toBeCloseTo(selectionMetric(target,axis,before),10)
  f.e.undo();expect(f.e.state.doc).toEqual(after);f.e.undo();expect(f.e.state.doc).toEqual(before);expect(f.e.canUndo).toBe(history)
  f.e.redo();expect(f.e.state.doc).toEqual(after);expect(editor(JSON.parse(JSON.stringify(after))).state.doc).toEqual(after)
})
test('Sketch per-target creates independent sibling graphs and a single undo, retaining both original targets', async () => {
  const f=fixture(),s=source();f.e.select([f.a.id,f.outside.id]);const before=f.e.state.doc;clipboard(s.packet)
  await dispatchEditorCommand(f.e,'paste-over-selection',{shortcutProfile:'sketch-like'})
  expect(f.e.state.selection).toHaveLength(4);expect(new Set(f.e.state.selection).size).toBe(4)
  const [a,b,c,d]=f.e.state.selection, after=f.e.state.doc
  expect(after.nodes[f.parent.id].children).toEqual([f.a.id,a,b,f.b.id]);expect(after.pages[0].children).toEqual([f.parent.id,f.outside.id,c,d])
  expect(after.nodes[f.a.id]).toBe(before.nodes[f.a.id]);expect(after.nodes[f.outside.id]).toBe(before.nodes[f.outside.id])
  f.e.undo();expect(f.e.state.doc).toEqual(before);expect(f.e.canUndo).toBe(false);f.e.redo();expect(f.e.state.doc).toEqual(after)
})
test('clipboard closed graph preserves variable aliases, prototype references and source text, across independent targets', async () => {
  const f=fixture(),s=source(),d=structuredClone(s.e.state.doc);d.schemaVersion=4
  d.designSystem=emptySystem();d.designSystem.collections.theme={name:'Theme',modes:['default'],defaultMode:'default'}
  d.designSystem.variables.amount={name:'Amount',collection:'theme',kind:'number',values:{default:.5}}
  d.nodes[s.a.id].bindings={opacity:'amount'}
  d.prototype={interactions:{[s.a.id]:[{trigger:'click',actions:[{kind:'navigate',target:s.b.id},{kind:'set-variable',target:'amount',value:1}]}]}}
  s.e.load(d);s.e.select([s.a.id,s.b.id]);const packet=s.e.exportClipboard()!,sourceBefore=s.e.state.doc;clipboard(packet);f.e.select([f.a.id,f.b.id]);const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection',{shortcutProfile:'sketch-like'})
  expect(f.e.state.selection).toHaveLength(4)
  for (const pair of [f.e.state.selection.slice(0,2),f.e.state.selection.slice(2,4)]) {
    const [a,b]=pair, actions=f.e.state.doc.prototype!.interactions[a][0].actions
    expect(actions[0].target).toBe(b);expect(actions[1].target).toBe(f.e.state.doc.nodes[a].bindings!.opacity)
    expect(f.e.state.doc.designSystem!.variables[actions[1].target!].values.default).toBe(.5)
  }
  expect(s.e.state.doc).toBe(sourceBefore);f.e.undo();expect(normal(f.e.state.doc)).toEqual(normal(before))
})
test('animated roots receive static placement wrappers without rewriting keyframes, remap clip/page IDs and reopen', async () => {
  const f=fixture(),s=source(),d=structuredClone(s.e.state.doc);d.animations=[createClip(d,d.pages[0].id,[s.a.id])]
  s.e.load(d);s.e.select([s.a.id]);const packet=s.e.exportClipboard()!,frames=s.e.state.doc.animations![0].tracks[0].keyframes
  clipboard(packet);const before=f.e.state.doc;await dispatchEditorCommand(f.e,'paste-over-selection')
  const after=f.e.state.doc,root=after.nodes[f.e.state.selection[0]],clip=after.animations![0]
  expect(root.kind).toBe('group');expect(root.children).toEqual([clip.tracks[0].nodeId]);expect(clip.tracks[0].keyframes).toEqual(frames)
  expect(clip.pageId).toBe(after.pages[0].id);expect(clip.id).not.toBe(d.animations![0].id)
  expect(editor(JSON.parse(JSON.stringify(after))).state.doc.animations).toEqual(after.animations)
  f.e.undo();expect(normal(f.e.state.doc)).toEqual(normal(before));f.e.redo();expect(f.e.state.doc).toEqual(after)
})
test('plain master creates an instance with valid imported definition and independent undo',async()=>{
  const f=fixture(),d=blank(),master=node('frame',10,20,80,60),child=node('rectangle',5,6,10,12)
  master.component={variants:{},properties:{}};master.children=[child.id];d.nodes[master.id]=master;d.nodes[child.id]=child;d.pages[0].children=[master.id];stampKeys(d,master.id)
  const s=editor(d);s.select([master.id]);clipboard(s.exportClipboard()!);const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection');const n=f.e.state.doc.nodes[f.e.state.selection[0]]
  expect(n.instance).toBeDefined();expect(f.e.state.doc.nodes[n.instance!.componentId].component).toBeDefined();expect(n.children).toHaveLength(1)
  f.e.undo();expect(f.e.state.doc).toEqual(before)
})
test.each(['figma-multiple','locked','hidden','invalid','empty','instance-parent'] as const)('invalid %s target fails atomically, retaining history/selection/document',async kind=>{
  const f=fixture(),s=source()
  if(kind==='locked'||kind==='hidden')f.e.update([f.parent.id],kind==='locked'?{locked:true}:{visible:false})
  if(kind==='instance-parent') { const d=structuredClone(f.e.state.doc);d.nodes[f.parent.id].instanceOrigin={owner:f.parent.id,source:f.a.id} as never; expect(()=>planPasteOverSelection(d,d.pages[0].id,[f.a.id],s.packet,'sketch-like')).toThrow();return }
  f.e.select(kind==='figma-multiple'?[f.a.id,f.b.id]:kind==='invalid'?['missing']:kind==='empty'?[]:[f.a.id]);const before=f.e.state.doc,selection=[...f.e.state.selection],undo=f.e.canUndo
  clipboard(s.packet);await dispatchEditorCommand(f.e,'paste-over-selection')
  expect(f.e.state.doc).toBe(before);expect(f.e.state.selection).toEqual(selection);expect(f.e.canUndo).toBe(undo);expect(f.e.state.message).toMatch(/目标|锁定|隐藏|单选/)
})
test('one target failing semantic preflight prevents every target write, including dependency imports',async()=>{
  const f=fixture(),s=source(),d=structuredClone(s.e.state.doc);d.schemaVersion=4;d.prototype={startNode:s.a.id,interactions:{}};s.e.load(d);s.e.select([s.a.id]);clipboard(s.e.exportClipboard()!);f.e.select([f.a.id,f.b.id]);const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection',{shortcutProfile:'sketch-like'})
  expect(f.e.state.doc).toBe(before);expect(f.e.canUndo).toBe(false);expect(f.e.state.selection).toEqual([f.a.id,f.b.id]);expect(f.e.state.message).toContain('起点')
})
test('auto-layout insertion uses absolute sizing and preserves original target geometry',async()=>{
  const f=fixture(),s=source();f.e.update([f.parent.id],{layout:{...defaultLayout(),mode:'horizontal'}});const before=f.e.state.doc;clipboard(s.packet)
  await dispatchEditorCommand(f.e,'paste-over-selection');expect(f.e.state.selection).toHaveLength(2)
  for(const id of f.e.state.selection)expect(f.e.state.doc.nodes[id].sizing).toMatchObject({absolute:true,width:'fixed',height:'fixed'})
  expect(f.e.state.doc.nodes[f.a.id].transform).toEqual(before.nodes[f.a.id].transform);expect(f.e.state.doc.nodes[f.b.id].transform).toEqual(before.nodes[f.b.id].transform)
})
test('64-target and expansion budgets reject before any graph changes',()=>{
  const f=fixture(),s=source(),d=structuredClone(f.e.state.doc),ids:string[]=[]
  for(let i=0;i<65;i++){const n=node('rectangle',i*5,0,1,1);d.nodes[n.id]=n;d.pages[0].children.push(n.id);ids.push(n.id)}
  expect(()=>planPasteOverSelection(d,d.pages[0].id,ids,s.packet,'sketch-like')).toThrow('64')
  expect(()=>planPasteOverSelection(d,d.pages[0].id,ids.slice(0,64),' '.repeat(524289),'sketch-like')).toThrow('32 MiB')
  // Existing admitted content does not consume a separate 20k business quota.
  for(let i=0;i<20001;i++){const n=node('rectangle',0,0,1,1);d.nodes[n.id]=n;d.pages[0].children.push(n.id)}
  const planned=planPasteOverSelection(d,d.pages[0].id,[ids[0]],s.packet,'sketch-like')
  expect(Object.keys(planned.document.nodes)).toHaveLength(Object.keys(d.nodes).length+2)
  expect(Object.keys(d.nodes)).not.toHaveLength(Object.keys(planned.document.nodes).length)
})
test.each(['document','selection','page','session','interaction','busy'] as const)('async clipboard %s change refuses stale application',async kind=>{
  const f=fixture(),s=source();let resolve!:(value:string)=>void
  vi.stubGlobal('navigator',{clipboard:{readText:()=>new Promise<string>(r=>resolve=r)}})
  const pending=dispatchEditorCommand(f.e,'paste-over-selection')
  if(kind==='document')f.e.update([f.b.id],{name:'new revision'})
  if(kind==='selection')f.e.select([f.b.id])
  if(kind==='page')f.e.set({page:'different-page'})
  if(kind==='session')f.e.load(f.e.state.doc)
  if(kind==='interaction')f.e.begin('user gesture')
  if(kind==='busy')f.e.set({busy:true})
  const before=f.e.state.doc,selection=[...f.e.state.selection],undo=f.e.canUndo
  resolve('FORMA-NODES-V1\n'+s.packet);await pending
  expect(f.e.state.doc).toBe(before);expect(f.e.state.selection).toEqual(selection);expect(f.e.canUndo).toBe(undo);expect(f.e.state.message).toContain('变化')
  if(kind==='interaction'){expect(f.e.interactionActive).toBe(true);f.e.cancel()}
})
test('active user transaction is neither committed nor cancelled and does not read clipboard',async()=>{
  const f=fixture(),read=vi.fn();vi.stubGlobal('navigator',{clipboard:{readText:read}});f.e.begin('gesture');f.e.update([f.a.id],{width:60});const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection');expect(read).not.toHaveBeenCalled();expect(f.e.state.doc).toBe(before);expect(f.e.interactionActive).toBe(true);f.e.cancel();expect(f.e.state.doc.nodes[f.a.id].width).toBe(30)
})
test('both profiles route Shift Mod V to paste-over; paste-in-place remains a distinct menu operation',async()=>{
  const f=fixture(),s=source();clipboard(s.packet)
  const event={key:'v',code:'KeyV',ctrlKey:true,metaKey:false,altKey:false,shiftKey:true,repeat:false,isComposing:false,defaultPrevented:false,target:null,preventDefault:vi.fn()}
  await dispatchEditorShortcut(f.e,event,{profile:'figma-like',platform:'windows'})
  expect(f.e.state.doc.nodes[f.a.id]).toBeDefined();expect(allParents(f.e.state.doc).get(f.e.state.selection[0])).toBe(f.parent.id)
  const menu=canvasMenuItems(f.e,{profile:'sketch-like',platform:'mac'});expect(menu.find(i=>i.command==='paste-over-selection')?.shortcut).toBe('⌘ ⇧ V');expect(menu.find(i=>i.command==='paste-in-place')?.shortcut).toBeUndefined()
  f.e.undo();f.e.importClipboard(s.packet);vi.stubGlobal('navigator',{});await dispatchEditorCommand(f.e,'paste-in-place')
  expect(allParents(f.e.state.doc).get(f.e.state.selection[0])).toBe(f.e.state.page)
})

test('failed foreign-font preflight restores destination WASM font environment before the next text measurement',()=>{
  const bytes=readFileSync(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url)).toString('base64')
  const f=fixture(),d=structuredClone(f.e.state.doc);d.fonts={destination:{family:'Destination',data:bytes}}
  const text=node('text',0,0,100,30);text.text='字体117';text.textStyle={...defaultTextStyle(),fontId:'destination'};d.nodes[text.id]=text;d.pages[0].children.push(text.id);f.e.load(d)
  const s=source(),foreign=structuredClone(s.e.state.doc);foreign.fonts={foreign:{family:'Foreign',data:bytes}};foreign.schemaVersion=4
  foreign.prototype={interactions:{[s.a.id]:[{trigger:'click',actions:[{kind:'navigate',target:s.b.id}]}]}}
  const packet=JSON.stringify({format:'forma-nodes',version:1,document:foreign,roots:[s.a.id]})
  activateDocumentFonts(f.e.state.doc);const before=kernelTextLayout(f.e.state.doc.nodes[text.id])
  expect(before.glyphs.length).toBeGreaterThan(0)
  expect(before.glyphs.every(g=>(g as unknown as {fontId:string}).fontId==='destination')).toBe(true)
  expect(()=>planPasteOverSelection(f.e.state.doc,f.e.state.page,[f.a.id],packet,'figma-like')).toThrow('选区外目标')
  const after=kernelTextLayout(f.e.state.doc.nodes[text.id]);expect(after).toEqual(before)
})

test('appending animation never mutates existing destination clip/history snapshots during Editor normalization',async()=>{
  const f=fixture(),s=source(),destination=structuredClone(f.e.state.doc),sourceDoc=structuredClone(s.e.state.doc)
  destination.animations=[createClip(destination,destination.pages[0].id,[f.b.id])];f.e.load(destination);f.e.select([f.a.id])
  sourceDoc.animations=[createClip(sourceDoc,sourceDoc.pages[0].id,[s.a.id])];s.e.load(sourceDoc);s.e.select([s.a.id]);clipboard(s.e.exportClipboard()!)
  const before=f.e.state.doc,snapshot=structuredClone(before),clip=before.animations![0],tracks=clip.tracks,unaffected=before.nodes[f.outside.id]
  await dispatchEditorCommand(f.e,'paste-over-selection')
  expect(f.e.state.doc.animations).toHaveLength(2);expect(before).toEqual(snapshot);expect(clip.tracks).toBe(tracks);expect(f.e.state.doc.nodes[f.outside.id]).toBe(unaffected)
  const after=f.e.state.doc;f.e.undo();expect(f.e.state.doc).toEqual(snapshot);f.e.redo();expect(f.e.state.doc).toEqual(after);expect(before).toEqual(snapshot)
})

test('root-level masks fail before changing existing siblings; grouped masks retain their internal boundary',async()=>{
  const f=fixture(),s=source();s.e.update([s.a.id],{mask:true});s.e.select([s.a.id,s.b.id]);clipboard(s.e.exportClipboard()!);const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection');expect(f.e.state.doc).toBe(before);expect(f.e.state.message).toContain('编组')
  s.e.group();clipboard(s.e.exportClipboard()!);await dispatchEditorCommand(f.e,'paste-over-selection')
  const root=f.e.state.doc.nodes[f.e.state.selection[0]];expect(root.kind).toBe('group');expect(root.children.some(id=>f.e.state.doc.nodes[id].mask)).toBe(true)
  expect(f.e.state.doc.nodes[f.b.id]).toBe(before.nodes[f.b.id]);expect(f.e.hit({x:245,y:275},true)).toBe(f.b.id)
})
test('post-layout validation failure leaves all destination graph/resource/animation snapshots and history unchanged',()=>{
  const f=fixture(),s=source(),d=structuredClone(f.e.state.doc);d.animations=[createClip(d,d.pages[0].id,[f.b.id])];f.e.load(d);f.e.select([f.a.id])
  const before=f.e.state.doc,snapshot=structuredClone(before),tracks=before.animations![0].tracks
  const plan=planPasteOverSelection(before,f.e.state.page,[f.a.id],s.packet,'figma-like');plan.document.nodes[plan.selection[0]].width=-10
  const result=f.e.change('invalid candidate',draft=>applyPasteOverPlan(draft,before,plan.document),plan.selection)
  expect(result.status).toBe('rejected');expect(f.e.state.doc).toBe(before);expect(before).toEqual(snapshot);expect(before.animations![0].tracks).toBe(tracks);expect(f.e.canUndo).toBe(false)
})
test('real DOM input owns shifted paste; native menu uses text paste, modal/IME/extra modifiers cannot mutate canvas',async()=>{
  const f=fixture(),s=source(),dom=new JSDOM('<!doctype html><input/><div id="canvas" tabindex="0"></div>',{url:'https://design.invalid'})
  vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('navigator',dom.window.navigator)
  const performTextCommand=vi.fn(async()=>({status:'ok'}));dom.window.coreDesktop={version:1,performTextCommand}
  const input=dom.window.document.querySelector('input'),canvas=dom.window.document.querySelector('#canvas'),before=f.e.state.doc
  try {
    input.focus();await dispatchEditorCommand(f.e,'paste-over-selection');expect(performTextCommand).toHaveBeenCalledWith('paste');expect(f.e.state.doc).toBe(before)
    const listener=(event:KeyboardEvent)=>{void dispatchEditorShortcut(f.e,event,{profile:'sketch-like',platform:'windows',desktop:true})};dom.window.addEventListener('keydown',listener)
    for(const target of [input,canvas]) { target.focus();const event=new dom.window.KeyboardEvent('keydown',{key:'v',ctrlKey:true,shiftKey:true,isComposing:target===canvas,bubbles:true,cancelable:true});target.dispatchEvent(event);expect(event.defaultPrevented).toBe(false) }
    canvas.focus();for(const extra of [{altKey:true},{metaKey:true}]){const event=new dom.window.KeyboardEvent('keydown',{key:'v',ctrlKey:true,shiftKey:true,...extra,bubbles:true,cancelable:true});canvas.dispatchEvent(event);expect(event.defaultPrevented).toBe(false)}
    const modal=dom.window.document.createElement('div');modal.setAttribute('aria-modal','true');dom.window.document.body.append(modal);await dispatchEditorCommand(f.e,'paste-over-selection');expect(f.e.state.doc).toBe(before)
    dom.window.removeEventListener('keydown',listener)
  } finally {dom.window.close()}
})
test('copied embedded fonts remain active after successful paste, Undo and Redo',async()=>{
  const bytes=readFileSync(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url)).toString('base64'),f=fixture(),d=blank(),text=node('text',10,20,100,30)
  text.text='字体117';text.textStyle={...defaultTextStyle(),fontId:'foreign'};d.fonts={foreign:{family:'Foreign',data:bytes}};d.nodes[text.id]=text;d.pages[0].children=[text.id]
  const s=editor(d);s.select([text.id]);clipboard(s.exportClipboard()!);const before=f.e.state.doc
  await dispatchEditorCommand(f.e,'paste-over-selection');const id=f.e.state.selection[0],after=f.e.state.doc,layout=kernelTextLayout(after.nodes[id]);expect(layout.glyphs.length).toBeGreaterThan(0)
  expect(layout.glyphs.every(g=>(g as unknown as {fontId:string}).fontId===after.nodes[id].textStyle!.fontId)).toBe(true)
  f.e.undo();expect(f.e.state.doc).toEqual(before);f.e.redo();expect(f.e.state.doc).toEqual(after);expect(kernelTextLayout(f.e.state.doc.nodes[id])).toEqual(layout)
})
