// Actual Editor + real WASM on a fresh blank document. jsdom is not native pointer/GPU acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, defaultLayout, uid } from './model'
import { useUtilityTools } from './utility-tools'
import { CanvasScrollbars } from './CanvasScrollbars'
import { CanvasGuides } from './CanvasGuides'
import { CanvasLayoutHandles } from './CanvasLayoutHandles'
import { canvasActions, CanvasAction, ActionOutcome } from './canvas-action-diagnostics'
import { interfacePreference } from './interface-preference'
let editor:Editor,root:Root,host:HTMLDivElement,dom:any,utility:ReturnType<typeof useUtilityTools>,target:string|null
const view={x:0,y:0,zoom:1},size={width:800,height:600}
function Harness(){utility=useUtilityTools(editor,editor.state.tool,()=>target,1);return <svg>{utility.overlay}</svg>}
const event=(x=40,y=40)=>({pointerId:1,button:0,isPrimary:true,clientX:x,clientY:y,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false} as React.PointerEvent)
function fire(el:Element,type:string,x=40,y=40){const e=new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0});Object.defineProperty(e,'pointerId',{value:1});el.dispatchEvent(e)}
const outcomes=(code:number)=>canvasActions(editor).snapshot().rows.filter(r=>r.actionCode===code&&r.actionPhase===2)
beforeEach(()=>{dom=new JSDOM('<!doctype html><body></body>',{url:'https://design.invalid'});for(const n of ['window','document','navigator','HTMLElement','Node','Element','Event','KeyboardEvent'])vi.stubGlobal(n,n==='window'?dom.window:dom.window[n]);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);dom.window.coreDesktop={renderDiagnostics:true,renderDiagnosticsDetail:true};vi.spyOn(console,'log').mockImplementation(()=>{});dom.window.Element.prototype.setPointerCapture=()=>{};dom.window.Element.prototype.hasPointerCapture=()=>false;dom.window.Element.prototype.releasePointerCapture=()=>{};host=document.createElement('div');document.body.append(host);root=createRoot(host);editor=new Editor(blank('fresh'));target=null})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();interfacePreference.reset();dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function renderUtility(tool:any){editor.set({tool});await act(async()=>root.render(<Harness/>))}
async function gesture(){await act(async()=>{utility.start(event(),{x:40,y:40},1);utility.end(event(),{x:40,y:40})})}
test('fresh canvas cuts an open stroke and subtracts a filled shape, each with one undo',async()=>{expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0);const line=node('line',10,10,100,100);line.fills=[];editor.change('fixture',d=>{d.nodes[line.id]=line;d.pages[0].children.push(line.id)});target=line.id;await renderUtility('eraser');await gesture();expect(editor.state.doc.nodes[line.id].kind).toBe('vector');expect(editor.state.doc.nodes[line.id].network!.edges.length).toBeGreaterThan(1);expect(outcomes(CanvasAction.eraser).at(-1)?.actionOutcome).toBe(ActionOutcome.committed);editor.undo();expect(editor.state.doc.nodes[line.id].kind).toBe('line');const shape=node('rectangle');shape.fills=[paint('#ff0000')];editor.change('fixture',d=>{d.nodes[shape.id]=shape;d.pages[0].children.push(shape.id)});target=shape.id;await renderUtility('eraser');await gesture();expect(editor.state.doc.nodes[shape.id].kind).toBe('vector');expect(editor.state.doc.nodes[shape.id].fills[0].color).toBe('#ff0000');expect(outcomes(CanvasAction.eraser).at(-1)?.actionOutcome).toBe(ActionOutcome.committed);editor.undo();expect(editor.state.doc.nodes[shape.id].kind).toBe('rectangle')})
test('board creation commits and a cancelled second creation leaves no nodes',async()=>{await renderUtility('shape-whiteboard-square');await gesture();expect(Object.keys(editor.state.doc.nodes).length).toBeGreaterThan(0);expect(outcomes(CanvasAction.boardCreate).at(-1)?.actionOutcome).toBe(ActionOutcome.committed);const count=Object.keys(editor.state.doc.nodes).length;await renderUtility('shape-whiteboard-square');await act(async()=>{utility.start(event(),{x:40,y:40},1);utility.cancel()});expect(Object.keys(editor.state.doc.nodes)).toHaveLength(count);expect(outcomes(CanvasAction.boardCreate).at(-1)?.actionOutcome).toBe(ActionOutcome.cancelled)})
test('measure observes without manufacturing a document commit',async()=>{await renderUtility('measure');const version=editor.state.version;await act(async()=>{utility.start(event(),{x:40,y:40},1);utility.end(event(90,80),{x:90,y:80})});expect(editor.state.version).toBe(version);expect(outcomes(CanvasAction.measure).at(-1)?.actionOutcome).toBe(ActionOutcome.observed)})
test('scrollbar keyboard and thumb change view but never document revision',async()=>{await act(async()=>root.render(<CanvasScrollbars editor={editor} entries={[]} view={view} size={size}/>));const el=host.querySelector('[role=scrollbar]')!;await act(async()=>el.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));expect(editor.state.view.x).not.toBe(0);expect(editor.state.version).toBe(0);expect(outcomes(CanvasAction.scrollbar).at(-1)?.actionOutcome).toBe(ActionOutcome.observed);const thumb=el.querySelector('.canvas-scrollbar-thumb')!;await act(async()=>{fire(thumb,'pointerdown');fire(el,'pointermove',90);fire(el,'pointerup',90)});expect(outcomes(CanvasAction.scrollbar).at(-1)?.motionObserved).toBe(1)})
test('ruler guide drag rounds position, then undo restores blank canvas',async()=>{editor.set({rulers:true});await act(async()=>root.render(<CanvasGuides editor={editor} view={view} size={size} intercept={()=>false}/>));const layer=host.querySelector('.canvas-guide-layer')!;vi.spyOn(layer,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:800,bottom:600,width:800,height:600,x:0,y:0,toJSON(){}});await act(async()=>{fire(host.querySelector('[data-testid=horizontal-ruler]')!,'pointerdown',40,5);fire(layer,'pointermove',40,80.4);fire(layer,'pointerup',40,80.4)});expect(editor.state.doc.pages[0].guides?.[0].position).toBe(80);expect(outcomes(CanvasAction.guide).at(-1)?.actionOutcome).toBe(ActionOutcome.committed);editor.undo();expect(editor.state.doc.pages[0].guides?.length||0).toBe(0)})
test('layout padding gesture resolves snap and commits actual layout change',async()=>{const frame=node('frame',0,0,300,200);frame.layout={...defaultLayout(),mode:'horizontal'};editor.change('fixture',d=>{d.nodes[frame.id]=frame;d.pages[0].children.push(frame.id)});editor.select([frame.id]);await act(async()=>root.render(<CanvasLayoutHandles editor={editor} view={view} size={size} visible/>));const handle=host.querySelector('[data-testid^=layout-handle-]')!,layer=host.querySelector('.canvas-layout-handles')!;expect(handle).not.toBeNull();const version=editor.state.version;await act(async()=>{fire(handle,'pointerdown',40,40);fire(layer,'pointermove',60,60);fire(layer,'pointerup',60,60)});expect(editor.state.version).toBeGreaterThan(version);expect(outcomes(CanvasAction.layoutHandle).at(-1)?.actionOutcome).toBe(ActionOutcome.committed)})

test('eraser cannot remove locked targets',async()=>{const line=node('line');line.fills=[];line.locked=true;editor.change('fixture',d=>{d.nodes[line.id]=line;d.pages[0].children.push(line.id)});target=line.id;await renderUtility('eraser');const version=editor.state.version;await gesture();expect(editor.state.version).toBe(version);expect(editor.state.doc.nodes[line.id]).toBeDefined();expect(outcomes(CanvasAction.eraser).at(-1)?.actionOutcome).toBe(ActionOutcome.blocked)})
test('lasso selection and bend use real authored scene state, not handler returns',async()=>{const line=node('line',20,20,80,80);line.fills=[];editor.change('fixture',d=>{d.nodes[line.id]=line;d.pages[0].children.push(line.id)});await renderUtility('vector-lasso');await act(async()=>{utility.start(event(0,0),{x:0,y:0},1);for(const [x,y] of [[200,0],[200,200],[0,200],[0,0]])utility.move(event(x,y),{x,y});utility.end(event(0,0),{x:0,y:0})});expect(editor.state.selection).toContain(line.id);expect(outcomes(CanvasAction.lasso).at(-1)?.selectionChanged).toBe(1);target=line.id;await renderUtility('bend');const version=editor.state.version;await act(async()=>{utility.start(event(60,60),{x:60,y:60},1);utility.end(event(80,40),{x:80,y:40})});expect(editor.state.version).toBeGreaterThan(version);expect(outcomes(CanvasAction.bend).at(-1)?.actionOutcome).toBe(ActionOutcome.committed)})
test('smart selection gap handle snaps, commits and undo restores transforms',async()=>{const {CanvasSmartSelection}=await import('./CanvasSmartSelection');const nodes=[node('rectangle',20,20,40,40),node('rectangle',100,20,40,40),node('rectangle',180,20,40,40)];editor.change('fixture',d=>{for(const n of nodes){d.nodes[n.id]=n;d.pages[0].children.push(n.id)}});editor.select(nodes.map(n=>n.id));const before=editor.state.doc;await act(async()=>root.render(<CanvasSmartSelection editor={editor} view={view} size={size} visible/>));const layer=host.querySelector('.canvas-smart-selection')!,handle=host.querySelector('[data-testid=smart-gap-x]')!;expect(handle).not.toBeNull();await act(async()=>{fire(handle,'pointerdown',80,40);fire(layer,'pointermove',95.4,40);fire(layer,'pointerup',95.4,40)});expect(editor.state.doc.nodes[nodes[1].id].transform[4]-editor.state.doc.nodes[nodes[0].id].transform[4]).toBe(95);expect(outcomes(CanvasAction.smartSelection).at(-1)?.actionOutcome).toBe(ActionOutcome.committed);editor.undo();expect(editor.state.doc).toBe(before)})

test('Sketch spacing controls hide when a selection fits inside a handle and return on zoom', async () => {
  const { CanvasSmartSelection } = await import('./CanvasSmartSelection')
  interfacePreference.set({ uiMode: 'sketch' })
  const shapes = [20, 60, 100].map(x => node('rectangle', x, 20, 20, 20))
  editor.change('row fixture', doc => {
    for (const shape of shapes) {
      doc.nodes[shape.id] = shape
      doc.pages[0].children.push(shape.id)
    }
  })
  editor.select(shapes.map(shape => shape.id))
  const render = (zoom: number) => act(async () =>
    root.render(<CanvasSmartSelection editor={editor} view={{ ...view, zoom }} size={size} visible />))
  const handles = () => host.querySelectorAll('[data-testid="smart-reorder"],[data-testid="smart-gap-x"]')
  await render(0.02)
  expect(handles()).toHaveLength(0)
  await render(1)
  expect(handles()).toHaveLength(5)
  expect(editor.state.selection).toEqual(shapes.map(shape => shape.id))
})

test('ruler context menu removes the editable guides of one axis in one undo',async()=>{
 interfacePreference.set({uiMode:'sketch'})
 editor.set({rulers:true})
 const frame=node('frame',50,60,120,90), locked=node('frame',210,60,120,90)
 locked.locked=true; locked.guides=[{id:uid(),axis:'y',position:40}]
 editor.change('fixture',d=>{d.nodes[frame.id]=frame;d.nodes[locked.id]=locked;d.pages[0].children.push(frame.id,locked.id)
  d.pages[0].guides=[{id:uid(),axis:'y',position:80},{id:uid(),axis:'y',position:200},{id:uid(),axis:'x',position:120}]
  d.nodes[frame.id].guides=[{id:uid(),axis:'y',position:100},{id:uid(),axis:'x',position:60}]})
 await act(async()=>root.render(<CanvasGuides editor={editor} view={view} size={size} intercept={()=>false}/>))
 const layer=host.querySelector('.canvas-guide-layer')!
 vi.spyOn(layer,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:800,bottom:600,width:800,height:600,x:0,y:0,toJSON(){}})
 await act(async()=>host.querySelector('[data-testid=horizontal-ruler]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:10,button:2})))
 const menu=document.querySelector('.guide-ruler-menu')!
 expect(menu.getAttribute('role')).toBe('menu')
 const item=menu.querySelector('button')!
 expect(item.textContent).toContain('移除全部横向参考线（3）')
 await act(async()=>item.click())
 expect(editor.state.doc.pages[0].guides?.map(g=>g.axis)).toEqual(['x'])
 expect(editor.state.doc.nodes[frame.id].guides?.map(g=>g.axis)).toEqual(['x'])
 expect(editor.state.doc.nodes[locked.id].guides).toEqual(locked.guides)
 expect(editor.canUndo).toBe(true)
 expect(outcomes(CanvasAction.guide).at(-1)?.actionOutcome).toBe(ActionOutcome.committed)
 editor.undo()
 expect(editor.state.doc.pages[0].guides?.length).toBe(3);expect(editor.state.doc.nodes[frame.id].guides?.length).toBe(2)
})
test('ruler menu stays inert without guides of that axis and Escape closes it',async()=>{
 interfacePreference.set({uiMode:'sketch'})
 editor.set({rulers:true})
 editor.change('fixture',d=>{d.pages[0].guides=[{id:uid(),axis:'y',position:80}]})
 await act(async()=>root.render(<CanvasGuides editor={editor} view={view} size={size} intercept={()=>false}/>))
 const layer=host.querySelector('.canvas-guide-layer')!
 vi.spyOn(layer,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:800,bottom:600,width:800,height:600,x:0,y:0,toJSON(){}})
 const version=editor.state.version
 await act(async()=>host.querySelector('[data-testid=vertical-ruler]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:120,button:2})))
 const menu=document.querySelector('.guide-ruler-menu')!
 expect(menu.querySelector('button')!.disabled).toBe(true)
 await act(async()=>menu.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(document.querySelector('.guide-ruler-menu')).toBeNull()
 expect(editor.state.version).toBe(version);expect(editor.state.doc.pages[0].guides?.length).toBe(1)
})
