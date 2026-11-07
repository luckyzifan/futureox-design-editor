import { afterEach, expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { PoseDiagnostics, createPoseDiagnostics } from './pose-diagnostics'
import { sanitizeFields } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { InteractionRenderer } from './interaction-renderer'
import { PageTranslation } from './page-translation'
import { planInteractionLayers, type InteractionProps } from './interaction-layers'
import {KernelClient} from './client'
import * as geometry from '../geometry'
import { CanvasSceneSnapshots } from '../canvas-scene-snapshots'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'

const worker = vi.hoisted(() => ({ jobs: [] as any[], poses:[] as any[],stops:[] as number[],released:[] as number[],disposed: 0 }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {}
  dispose() { worker.disposed++ }
  moveResidentInteraction(...args:unknown[]){worker.poses.push(args)}
  stopResidentInteraction(id:number){worker.stops.push(id)}
  releasePresented(ids:number[]){worker.released.push(...ids)}
  render(document: unknown, options: any, ...rest:any[]) {
    return new Promise((resolve, reject) => worker.jobs.push({ document, options, reject, progress:rest[5], signal:rest[6],
      resolve: (result={}) => resolve({ bytes: new Uint8Array(options.width * options.height * 4),...result }) }))
  }
} }))

const owners: InteractionRenderer[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); worker.jobs.length = 0; worker.poses.length=worker.stops.length=worker.released.length=0;worker.disposed = 0; vi.unstubAllEnvs() })
test('reparent before the first capture preserves the original erase footprint until the exact page takes over',async()=>{
 const doc=blank(),root=node('frame',0,0,1000,700),a=node('frame',20,30,100,100),b=node('frame',300,150,100,100),child=node('rectangle',10,10,20,20)
 root.children=[a.id,b.id];a.children=[child.id];for(const n of [root,a,b,child])n.blend='normal'
 doc.nodes=Object.fromEntries([root,a,b,child].map(n=>[n.id,n]));doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,gestureKind:'move',epoch:1,control:{current:null},onReady:vi.fn()}
 const view={x:0,y:0,zoom:1},size={width:600,height:500}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 const after={...doc,nodes:{...doc.nodes,[a.id]:{...a,children:[]},[b.id]:{...b,children:[child.id]},[child.id]:{...child,transform:[1,0,0,1,12,16] as typeof child.transform}}}
 owner.prepare({...props,document:after},doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 worker.jobs[0].resolve({gpuTile:701,residentInteraction:true,bytes:new Uint8Array()})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
 worker.jobs[1].resolve({gpuTile:702,residentInteraction:true,bytes:new Uint8Array()})
 await vi.waitFor(()=>expect(owner.tiles[0]?.gpuTile).toBe(702))
 const clip=owner.items(view)![0].clip!
 expect(clip.left).toBeLessThanOrEqual(30);expect(clip.top).toBeLessThanOrEqual(40)
 expect(clip.left+clip.width).toBeGreaterThanOrEqual(332);expect(clip.top+clip.height).toBeGreaterThanOrEqual(186)
 expect(worker.released).toContain(701)
 owner.prepare({...props,document:after,active:false},doc.pages[0].id,view,1,'analytic','webgpu',after,size)
 expect((owner as any).resident?.repairBounds).toBeUndefined()
})
test('an active retained board keeps its complete pixels while a structural move adopts a live owner',async()=>{
 const doc=blank(),a=node('frame',0,0,80,80),b=node('frame',200,0,300,300)
 a.blend=b.blend='normal';doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
 const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
 const view={x:0,y:0,zoom:1},size={width:600,height:400},props:InteractionProps={document:doc,selection:[a.id],active:true,epoch:1,control:{current:null},onReady:vi.fn()}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',doc,size)
 for(let i=0;i<2;i++){await vi.waitFor(()=>expect(worker.jobs.length).toBeGreaterThan(i));worker.jobs[i].resolve({gpuTile:600+i,bytes:new Uint8Array()})}
 await vi.waitFor(()=>expect(owner.ready).toBe(true))
 owner.control.apply(doc,{[a.id]:{transform:[1,0,0,1,10,0]}})
 const held=owner.items(view)!.map(i=>({slot:i.tile.gpuTile,placement:i.placement,blend:i.blend}))
 const after={...doc,pages:[{...doc.pages[0],children:[b.id]}],nodes:{...doc.nodes,[b.id]:{...b,children:[a.id]},[a.id]:{...a,transform:[1,0,0,1,10,0] as typeof a.transform}}}
 owner.prepare({...props,document:after},doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 expect(owner.mode).toBe('retained-layers');expect(owner.control.isActive()).toBe(true)
 expect(owner.items(view)!.map(i=>({slot:i.tile.gpuTile,placement:i.placement,blend:i.blend}))).toEqual(held)
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(3));worker.jobs[2].resolve({gpuTile:602,residentInteraction:true,bytes:new Uint8Array()})
 await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(602))
 expect(owner.mode).toBe('live-kernel')
 expect(owner.control.apply(after,{[a.id]:{transform:[1,0,0,1,12,0]}})).not.toBeNull()
 expect(worker.poses.at(-1)?.[0]).toBe(602)
})
test('reparent capture queues new-basis poses while holding old pixels at their original placement',async()=>{
 const doc=blank(),root=node('frame',0,0,1000,700),a=node('frame',20,30,100,100),b=node('frame',300,150,100,100),child=node('rectangle',10,10,20,20)
 b.transform=[2,0,0,3,300,150];root.children=[a.id,b.id];a.children=[child.id]
 doc.nodes=Object.fromEntries([root,a,b,child].map(n=>[n.id,n]));doc.pages[0].children=[root.id]
 const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady:vi.fn()}
 const view={x:0,y:0,zoom:1},size={width:600,height:500}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 worker.jobs[0].resolve({gpuTile:501,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const after={...doc,nodes:{...doc.nodes,[a.id]:{...a,children:[]},[b.id]:{...b,children:[child.id]},[child.id]:{...child,transform:[1,0,0,1,10,10] as typeof child.transform}}}
 const patches={[child.id]:{transform:[1,0,0,1,14,16] as typeof child.transform}}
 expect(owner.control.apply(after,patches)).toBeNull()
 const oldItems=owner.items(view)!.map(item=>item.placement)
 owner.prepare({...props,document:after},doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 expect(worker.jobs).toHaveLength(2);expect(owner.tiles[0].gpuTile).toBe(501)
 expect(owner.control.apply(after,patches)).toMatchObject({x:8,y:18})
 expect(owner.items(view)!.map(item=>item.placement)).toEqual(oldItems)
 const samples=owner.samples;owner.acceptResidentSample({slot:501,sequence:1,at:performance.now()});expect(owner.samples).toBe(samples)
 expect(worker.poses).toHaveLength(0)
 worker.jobs[1].resolve({gpuTile:502,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(502))
 expect(owner.control.apply(after,patches)).toMatchObject({x:8,y:18})
 expect(worker.poses.at(-1)?.[0]).toBe(502);expect(worker.jobs).toHaveLength(2)
 expect(owner.control.apply(doc,patches)).toBeNull()
})
test('structural move retains capture-owned chrome and asks the worker for its frozen old parent basis',async()=>{
 const doc=blank(),root=node('frame',0,0,1000,700),a=node('frame',20,30,100,100),b=node('frame',300,150,100,100),child=node('rectangle',10,10,20,20)
 b.transform=[2,0,0,3,300,150];root.children=[a.id,b.id];a.children=[child.id]
 doc.nodes=Object.fromEntries([root,a,b,child].map(n=>[n.id,n]));doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,gestureKind:'move',epoch:1,control:{current:null},onReady:vi.fn()}
 const view={x:0,y:0,zoom:1},size={width:600,height:500},commands={pixelGrid:false,transforms:{[child.id]:child.transform},
  selection:{owners:[child.id],handles:true,corners:[{x:30,y:40},{x:50,y:40},{x:50,y:60},{x:30,y:60}]},measurements:[]}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size,{document:doc,pageId:doc.pages[0].id,epoch:1,uiIdentity:'same-ui',commands})
 worker.jobs[0].resolve({gpuTile:503,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const after={...doc,nodes:{...doc.nodes,[a.id]:{...a,children:[]},[b.id]:{...b,children:[child.id]},[child.id]:{...child,transform:[1,0,0,1,12,16] as typeof child.transform}}}
 const newer={...commands,transforms:{[child.id]:after.nodes[child.id].transform},selection:{...commands.selection,corners:commands.selection.corners.map(p=>({x:p.x+300,y:p.y+150}))}}
 owner.prepare({...props,document:after},doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 const held=owner.capturedOverlay(after,doc.pages[0].id,1,newer,'same-ui')!
 expect(held.commands).toEqual(commands);expect(held.overlayPoseSlot).toBe(503);expect(held.cohort?.slots).toEqual([503])
 expect(worker.stops).toContain(503)
 expect(owner.capturedOverlay(after,doc.pages[0].id,1,newer,'changed-ui')?.commands).toBeUndefined()
 expect(owner.capturedOverlay(after,doc.pages[0].id,2,newer,'same-ui')?.commands).toBeUndefined()
 worker.jobs[1].resolve({gpuTile:504,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(504))
 expect(owner.capturedOverlay(after,doc.pages[0].id,1,newer,'same-ui')?.cohort?.slots).not.toEqual([503])
})
test('retiring a committed live preview notifies Canvas once so its interactionPreview flag cannot stay latched',async()=>{
 const doc=blank(),root=node('frame',0,0,200,200),child=node('rectangle',10,10,20,20)
 root.children=[child.id];doc.nodes={[root.id]:root,[child.id]:child};doc.pages[0].children=[root.id]
 const ready=vi.fn(),owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady:ready},view={x:0,y:0,zoom:1},size={width:400,height:300}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 worker.jobs[0].resolve({gpuTile:620,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const after={...doc,nodes:{...doc.nodes,[child.id]:{...child,transform:[1,0,0,1,16,10] as typeof child.transform}}}
 owner.control.apply(doc,{[child.id]:{transform:after.nodes[child.id].transform}});owner.control.end(after)
 const final={...props,document:after,active:false};owner.prepare(final,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size)
 expect(owner.control.isActive()).toBe(true);ready.mockClear()
 owner.prepare(final,doc.pages[0].id,view,1,'analytic','webgpu',after,size)
 expect(owner.control.isActive()).toBe(false);expect(ready).toHaveBeenCalledOnce()
 owner.prepare(final,doc.pages[0].id,view,1,'analytic','webgpu',after,size);expect(ready).toHaveBeenCalledOnce()
})
test('a warm native pose after commit and undo carries its submitted document order above the settled page',async()=>{
 const doc=blank(),root=node('frame',0,0,200,200),child=node('rectangle',10,10,20,20)
 root.children=[child.id];doc.nodes={[root.id]:root,[child.id]:child};doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady:vi.fn()},view={x:0,y:0,zoom:1},size={width:400,height:300}
 const prepare=(document=doc,active=true,settled?:typeof doc)=>owner.prepare({...props,document,active},doc.pages[0].id,view,1,'analytic','webgpu',settled,size)
 prepare();worker.jobs[0].resolve({gpuTile:630,residentInteraction:true,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const transform=[1,0,0,1,16,10] as typeof child.transform,after={...doc,nodes:{...doc.nodes,[child.id]:{...child,transform}}}
 owner.control.apply(doc,{[child.id]:{transform}});owner.acceptResidentSample({slot:630,sequence:owner.moves,at:0})
 owner.control.end(after);prepare(after,false,after);expect(owner.items(view)).toBeNull()
 prepare(doc,false,doc);prepare(doc,true,doc)
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,20,10]}})
 expect(owner.items(view)).toBeNull() // Prior capture is still behind the undo.
 owner.acceptResidentSample({slot:630,sequence:owner.moves,at:0})
 expect(owner.items(view)?.[0].tile.gpuTile).toBe(630)
 // A new authored edit owns a later page floor; an older pending sample must
 // keep its old order even if it arrives after that edit is complete.
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,22,10]}});const late=owner.moves
 prepare(after,false,after)
 owner.acceptResidentSample({slot:630,sequence:late,at:0})
 expect(owner.items(view)).toBeNull()
})
test('a dependency capture completing after release retires even when it has adopted the final document',async()=>{
 const doc=blank(),root=node('frame',0,0,200,200),child=node('rectangle',10,10,20,20)
 root.children=[child.id];doc.nodes={[root.id]:root,[child.id]:child};doc.pages[0].children=[root.id]
 const ready=vi.fn(),owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady:ready},view={x:0,y:0,zoom:1},size={width:400,height:300}
 const prepare=(document=doc,active=true,settled?:typeof doc)=>owner.prepare({...props,document,active},doc.pages[0].id,view,1,'analytic','webgpu',settled,size)
 prepare();worker.jobs[0].resolve({gpuTile:640,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const after={...doc,nodes:{...doc.nodes,[child.id]:{...child,width:21}}}
 prepare(after);owner.control.end(after);prepare(after,false)
 worker.jobs[1].resolve({gpuTile:641,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(641))
 expect(owner.control.isActive()).toBe(true);ready.mockClear()
 prepare(after,false,after);expect(owner.control.isActive()).toBe(false);expect(ready).toHaveBeenCalledOnce()
})
test('a single-node translation capture freezes its own projected chrome before a newer input arrives',async()=>{
 const doc=blank(),root=node('frame',0,0,200,200),child=node('rectangle',10,10,20,20)
 root.children=[child.id];doc.nodes={[root.id]:root,[child.id]:child};doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,gestureKind:'move',epoch:1,control:{current:null},onReady:vi.fn()},view={x:0,y:0,zoom:1},size={width:400,height:300}
 const commands={pixelGrid:false,transforms:{[child.id]:child.transform},selection:{owners:[child.id],handles:true,corners:[{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}]},measurements:[]}
 const overlay={document:doc,pageId:doc.pages[0].id,epoch:1,uiIdentity:'selection',commands}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,size,overlay)
 worker.jobs[0].resolve({gpuTile:650,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,20,10]}})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,40,10]}})
 worker.jobs[1].resolve({gpuTile:651,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(651))
 const captured=owner.capturedOverlay(doc,doc.pages[0].id,1,commands,'selection')!
 expect(captured.commands?.selection?.corners[0]).toEqual({x:20,y:10})
 expect(captured.commands?.transforms?.[child.id]).toEqual([1,0,0,1,20,10])
 expect(captured.cohort?.slots).toEqual([651])
 expect(owner.capturedOverlay(doc,doc.pages[0].id,1,commands,'changed-ui')?.commands).toBeUndefined()
})
test('undo after a dependency edit replaces the live lease instead of reusing an obsolete pending layer marker',async()=>{
 const doc=blank(),root=node('frame',0,0,200,200),child=node('rectangle',10,10,20,20)
 root.children=[child.id];doc.nodes={[root.id]:root,[child.id]:child};doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,gestureKind:'move',epoch:1,control:{current:null},onReady:vi.fn()},view={x:0,y:0,zoom:1},size={width:400,height:300}
 const prepare=(document=doc,active=true,settled?:typeof doc)=>owner.prepare({...props,document,active},doc.pages[0].id,view,1,'analytic','webgpu',settled,size)
 prepare();worker.jobs[0].resolve({gpuTile:660,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const after={...doc,nodes:{...doc.nodes,[child.id]:{...child,width:21}}}
 prepare(after);owner.control.end(after);prepare(after,false)
 worker.jobs[1].resolve({gpuTile:661,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(661))
 prepare(after,false,after);prepare(doc,false,doc)
 expect(owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,18,10]}})).not.toBeNull()
 expect(owner.control.isActive()).toBe(true)
})
test('a new complete retained gesture cancels prior canvas repair, including immediate regrab during handoff',async()=>{
 vi.stubEnv('VITE_DESIGN_RETAINED_INPUT_PRIORITY','1')
 const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 const shared=new KernelClient(),cancel=vi.spyOn(shared,'cancelPreview'),ready=vi.fn(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
 const view={x:0,y:0,zoom:1},props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady:ready}
 owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',doc,{width:100,height:100})
 expect(owner.control.blocksCanvasRefinement?.(doc,[root.id],view)).toBe(false)
 worker.jobs[0].resolve({gpuTile:900,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const cancels=()=>cancel.mock.calls.filter(([channel])=>channel==='canvas').length
 expect(owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,10,0]}})).not.toBeNull()
 expect(cancels()).toBe(1);expect(owner.control.blocksCanvasRefinement?.(doc,[root.id],view)).toBe(true)
 owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,11,0]}});expect(cancels()).toBe(1)
 const committed={...doc,nodes:{...doc.nodes,[root.id]:{...root,transform:[1,0,0,1,11,0] as typeof root.transform}}}
 owner.control.end(committed);expect(owner.control.blocksCanvasRefinement?.(committed,[root.id],view)).toBe(false)
 owner.prepare({...props,document:committed,active:true},doc.pages[0].id,view,1,'analytic','webgpu',doc,{width:100,height:100})
 expect(owner.control.apply(committed,{[root.id]:{transform:[1,0,0,1,12,0]}})).not.toBeNull()
 expect(cancels()).toBe(2);expect(owner.tiles[0].gpuTile).toBe(900);expect(worker.jobs).toHaveLength(1)
 expect(owner.control.blocksCanvasRefinement?.(committed,[root.id],{...view,zoom:2})).toBe(false)
 const edited={...committed,nodes:{...committed.nodes,[root.id]:{...committed.nodes[root.id],opacity:.5}}}
 expect(owner.control.blocksCanvasRefinement?.(edited,[root.id],view)).toBe(false)
})
test('a pending replacement capture owns its new viewport while the old resident remains visible',async()=>{
 const doc=blank(),root=node('frame',0,0,1000,1000);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 const shared=new KernelClient(),ready=vi.fn(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
 const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady:ready}
 const prepare=(x:number)=>owner.prepare(props,doc.pages[0].id,{x,y:0,zoom:1},1,'analytic','webgpu',doc,{width:100,height:100})
 prepare(0);worker.jobs[0].resolve({gpuTile:800,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 prepare(-512);expect(worker.jobs).toHaveLength(2);const notifications=ready.mock.calls.length
 for(let i=0;i<20;i++)prepare(-512)
 expect(worker.jobs).toHaveLength(2);expect(ready).toHaveBeenCalledTimes(notifications)
 expect(worker.jobs[1].signal.aborted).toBe(false)
 worker.jobs[1].resolve({gpuTile:801,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.tiles[0].gpuTile).toBe(801))
})
function fixture(dependent = false, zoom = 1, extent = 100, active = dependent) {
  const doc = blank(), root = node('frame', 0, 0, extent, extent)
  root.blend = 'normal'
  if (dependent) root.effects = [effect('glass')]
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active, epoch: 1, control: { current: null }, onReady: vi.fn() }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const view = { x: 0, y: 0, zoom }
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  return { doc, root, props, owner, view }
}

test('continuous pan leaves optional selection capture idle and a real gesture immediately regains priority',async()=>{
 vi.stubEnv('VITE_DESIGN_NAVIGATION_CAPTURE_PRIORITY','1')
 let now=1000;const clock=vi.spyOn(performance,'now').mockImplementation(()=>now)
 try{
 const doc=blank(),root=node('frame',0,0,1000,1000);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
 const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,navigating:true,control:{current:null},onReady:vi.fn()}
 const prepare=(x:number,p=props)=>owner.prepare(p,doc.pages[0].id,{x,y:0,zoom:1},1,'analytic','webgpu',doc,{width:100,height:100})
 for(let i=0;i<30;i++)prepare(-64*i)
 expect(worker.jobs).toHaveLength(0)
 prepare(-64*29,{...props,navigating:false});expect(worker.jobs).toHaveLength(0)
 now+=101;prepare(-64*29,{...props,navigating:false});expect(worker.jobs).toHaveLength(1)
 worker.jobs[0].resolve({gpuTile:810,bytes:new Uint8Array()});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 for(let i=30;i<60;i++)prepare(-64*i)
 expect(worker.jobs).toHaveLength(1);expect(owner.tiles[0].gpuTile).toBe(810)
 prepare(-64*59,{...props,active:true});expect(worker.jobs).toHaveLength(2)
 expect(worker.jobs[1].signal.aborted).toBe(false)
 }finally{clock.mockRestore()}
})

test('navigation quiet wake uses the latest camera and policy, and disposal retires the wake',()=>{
 vi.stubEnv('VITE_DESIGN_NAVIGATION_CAPTURE_PRIORITY','1')
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']})
 try{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const owner=new InteractionRenderer(vi.fn(),new KernelClient());owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,navigating:true,control:{current:null},onReady(){}}
  owner.prepare(props,doc.pages[0].id,{x:0,y:0,zoom:1},1,'analytic','webgpu',doc,{width:200,height:100})
  vi.advanceTimersByTime(60)
  owner.prepare({...props,navigating:false},doc.pages[0].id,{x:2.25,y:1.5,zoom:2},1,'figmaSubpixel','webgpu',doc,{width:200,height:100})
  vi.advanceTimersByTime(99);expect(worker.jobs).toHaveLength(0)
  vi.advanceTimersByTime(1);expect(worker.jobs).toHaveLength(1)
  expect(worker.jobs[0].options).toMatchObject({view:{zoom:2},rasterProfile:'figmaSubpixel'})
  owner.prepare(props,doc.pages[0].id,{x:200,y:0,zoom:2},1,'figmaSubpixel','webgpu',doc,{width:200,height:100})
  owner.dispose();vi.advanceTimersByTime(1000)
  expect(worker.jobs).toHaveLength(1)
 }finally{vi.useRealTimers()}
})

test('live capture prepares 3,000 page roots without rescanning the scene for every root', () => {
  const doc = blank(), count = 3000
  for (let i = 0; i < count; i++) {
    const root = node('frame', (i % 100) * 40, Math.floor(i / 100) * 40, 30, 30)
    root.blend = 'normal'
    if (!i) root.effects = [{ ...effect('background-blur'), radius: 2 }]
    doc.nodes[root.id] = root; doc.pages[0].children.push(root.id)
  }
  const entries = geometry.scene(doc, doc.pages[0].id)
  let identityReads = 0
  const scene = vi.spyOn(geometry, 'scene').mockReturnValue(entries.map(entry => new Proxy(entry, {
    get(target, key, receiver) {
      if (key === 'id' || key === 'ancestors') identityReads++
      return Reflect.get(target, key, receiver)
    },
  })))
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  try {
    owner.prepare({ document: doc, selection: [doc.pages[0].children[0]], active: true,
      epoch: 1, control: { current: null }, onReady() {} }, doc.pages[0].id,
    { x: 0, y: 0, zoom: 1 }, 1, 'analytic', 'cpu', undefined, { width: 640, height: 480 })
    expect(scene).toHaveBeenCalledOnce()
    expect(worker.jobs).toHaveLength(1)
    expect(worker.jobs[0].options.view.zoom).toBe(1)
    expect(worker.jobs[0].options.interactionWindow).toEqual({ x: 112, y: 112, w: 58, h: 58 })
    // Count actual production data access, not wall-clock time or a helper
    // invocation. The old per-root filter performs almost 18 million reads.
    expect(identityReads).toBeLessThan(count * 20)
  } finally { scene.mockRestore() }
})

test.each([60, 90, 120, 144])('3,000-node %i Hz motion coalesces pending inputs and rejects replaced-selection pixels', async hz => {
  const doc = blank(), count = 3000
  for (let i = 0; i < count; i++) {
    const root = node('frame', i % 100 * 40, Math.floor(i / 100) * 40, 30, 30)
    root.blend = 'normal'
    if (!i) root.effects = [{ ...effect('background-blur'), radius: 2 }]
    doc.nodes[root.id] = root; doc.pages[0].children.push(root.id)
  }
  const shared = new KernelClient(), published: number[] = []
  const owner = new InteractionRenderer(() => published.push(...owner.tiles.flatMap(tile => tile.gpuTile ? [tile.gpuTile] : [])), shared)
  owners.push(owner)
  const initial = doc.pages[0].children[0], replacement = doc.pages[0].children[1]
  let props: InteractionProps = { document: doc, selection: [initial], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: -.25, y: .125, zoom: 1 }, size = { width: 640, height: 480 }
  const prepare = () => owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'cpu', undefined, size)
  const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
  const replaceFrame = Math.floor(hz / 3), completeFrame = Math.floor(hz / 2)
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  try {
  prepare()
  expect(worker.jobs).toHaveLength(1)
  for (let frame = 1; frame <= hz; frame++) {
    elapsed = frame * 1000 / hz
    if (frame === replaceFrame) { props = { ...props, selection: [replacement] }; prepare() }
    if (frame > replaceFrame) {
      expect(owner.control.apply(doc, { [replacement]: { transform: [1, 0, 0, 1, 40 + elapsed / 8, -elapsed / 16] } })).not.toBeNull()
      prepare()
    }
    if (frame === completeFrame) {
      worker.jobs[0].resolve({ gpuTile: 701, bytes: new Uint8Array() }); await microtasks()
      expect(worker.released).toContain(701)
      expect(owner.ready).toBe(false)
      expect(worker.jobs).toHaveLength(2)
    }
    expect(worker.jobs.length).toBeLessThanOrEqual(2)
    expect(published).not.toContain(701)
  }
  worker.jobs[1].resolve({ gpuTile: 702, bytes: new Uint8Array() }); await microtasks()
  expect(worker.jobs).toHaveLength(3)
  const final = worker.jobs[2]
  expect(final.document.nodes[replacement].transform).toEqual([1, 0, 0, 1, 165, -62.5])
  expect(final.options.view.zoom).toBe(1)
  final.resolve({ gpuTile: 703, bytes: new Uint8Array() }); await microtasks()
  expect(owner.tiles[0].gpuTile).toBe(703)
  expect(owner.error).toBe('')
  expect(owner.presentedInput.sequence).toBe(hz - replaceFrame)
  expect(owner.presentedInput.at).toBe(1000)
  expect(worker.jobs).toHaveLength(3)
  expect(published).not.toContain(701)
  expect(published).toContain(703)
  } finally { clock.mockRestore(); shared.dispose() }
})

test('exact tiled captures publish atomically and release partial failed replacements', async () => {
  const {doc,root,owner,view}=fixture(true)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  const capture=worker.jobs[1]
  expect(capture.options.view.zoom).toBe(1)
  for(const [i,tile] of capture.options.tileViewport.entries())capture.progress({...tile,gpuTile:100+i,bytes:new Uint8Array()})
  expect(owner.ready).toBe(false)
  capture.resolve({bytes:new Uint8Array()})
  await vi.waitFor(()=>expect(owner.ready).toBe(true))
  const complete=owner.tiles
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,10,0]}})
  const next=worker.jobs[2]
  expect(next.options.tileViewport.length).toBeGreaterThan(0)
  next.progress({...next.options.tileViewport[0],gpuTile:999,bytes:new Uint8Array()})
  expect(owner.tiles).toBe(complete)
  next.reject(Error('GPU tile failed'))
  await vi.waitFor(()=>expect(worker.released).toContain(999))
  expect(owner.tiles).toBe(complete)
  expect(owner.items(view)?.every(item=>item.gutter===1)).toBe(true)
})
test('HQ dependent captures keep the settled computation camera and full density',()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.effects=[effect('glass')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id];doc.rasterProfile='figma'
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  owner.prepare({document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:-.375,y:.125,zoom:1},2,'figma','webgpu',undefined,{width:100,height:100})
  const request=worker.jobs[0].options
  expect(request.view).toEqual({x:-.75,y:.25,zoom:2})
  expect(request.tileViewport.length).toBeGreaterThan(0)
  expect(request.tileViewport.every((tile:any)=>tile.zoom===2&&tile.gutter===1)).toBe(true)
  expect(request.retainInteractionGraph).toBeUndefined()
  shared.dispose()
})

function finalForegroundCapture(earlierBackdrop = true) {
  const doc = blank(), root = node('frame', 0, 0, 1000, 1000)
  const backdrop = node('rectangle', 0, 0, 800, 800), selected = node('rectangle', 300, 300, 238, 118)
  root.clip = false; root.children = [backdrop.id, selected.id]
  if (earlierBackdrop) backdrop.effects = [{ ...effect('background-blur'), radius: 3 }]
  for (const n of [root, backdrop, selected]) doc.nodes[n.id] = n
  doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  owner.prepare({ document: doc, selection: [selected.id], active: true, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 1 }, 2, 'figma', 'webgpu', undefined, { width: 855, height: 888 })
  return { doc, selected, owner, shared }
}
async function completeForegroundCapture(job: any, firstSlot: number) {
  for (const [index, tile] of job.options.tileViewport.entries())
    job.progress({ ...tile, gpuTile: firstSlot + index, bytes: new Uint8Array() })
  job.resolve({ bytes: new Uint8Array() })
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
test('only proven final foreground uses the short reserve while complete swept captures expand in both directions', async () => {
  const { doc, selected, owner, shared } = finalForegroundCapture()
  try {
    const initial = worker.jobs[0]
    // These are real production request extents with a mocked transport.
    // They establish scheduling/coverage, not GPU pixels or measured latency.
    expect(initial.options.width).toBe(732); expect(initial.options.height).toBe(492)
    expect(initial.options.tileViewport).toHaveLength(2)
    expect(initial.options.view).toEqual({ x: 0, y: 0, zoom: 2 })
    await completeForegroundCapture(initial, 100)
    expect(owner.control.apply(doc, { [selected.id]: { transform: [1, 0, 0, 1, 320, 300] } })).not.toBeNull()
    const nearby = worker.jobs[1]
    expect(nearby.options.tileViewport).toEqual(initial.options.tileViewport)
    await completeForegroundCapture(nearby, 200)
    for (const [index, x] of [500, 100].entries()) {
      const previous = owner.tiles
      expect(owner.control.apply(doc, { [selected.id]: { transform: [1, 0, 0, 1, x, 300] } })).not.toBeNull()
      const expanded = worker.jobs[2 + index], tiles = expanded.options.tileViewport
      const left = Math.min(...tiles.map((t: any) => t.x + t.gutter)) / 2
      const right = Math.max(...tiles.map((t: any) => t.x + t.width - t.gutter)) / 2
      const top = Math.min(...tiles.map((t: any) => t.y + t.gutter)) / 2
      const bottom = Math.max(...tiles.map((t: any) => t.y + t.height - t.gutter)) / 2
      expect(left).toBeLessThanOrEqual(Math.min(300, x) - 16)
      expect(right).toBeGreaterThanOrEqual(Math.max(300, x) + 238 + 16)
      expect(top).toBeLessThanOrEqual(300 - 16)
      expect(bottom).toBeGreaterThanOrEqual(300 + 118 + 16)
      expect(expanded.options.width).toBeGreaterThan(initial.options.width)
      expect(expanded.options.view).toEqual(initial.options.view)
      expect(tiles.every((t: any) => t.zoom === 2 && t.gutter === 1)).toBe(true)
      expect(owner.tiles).toBe(previous)
      await completeForegroundCapture(expanded, 300 + index * 100)
      expect(owner.tiles).not.toBe(previous)
    }
    expect(owner.error).toBe('')
  } finally { shared.dispose() }
})
test('ordinary no-backdrop localization retains its original 256-pixel travel reserve', () => {
  const { shared } = finalForegroundCapture(false)
  try {
    expect(worker.jobs[0].options.width).toBe(1628)
    expect(worker.jobs[0].options.height).toBe(1388)
    expect(worker.jobs[0].options.tileViewport).toHaveLength(12)
  } finally { shared.dispose() }
})

test('a localized desktop capture spends pixels on the selection instead of the unused large travel reserve',()=>{
 const doc=blank(),root=node('frame',0,0,1000,800),selected=node('rectangle',300,220,24,20)
 root.blend='normal';root.children=[selected.id];doc.nodes[root.id]=root;doc.nodes[selected.id]=selected;doc.pages[0].children=[root.id]
 const before=JSON.stringify(doc),props:InteractionProps={document:doc,selection:[selected.id],active:true,epoch:1,control:{current:null},onReady(){}}
 const views=[]
 for(const desktop of [false,true]){
  const owner=new InteractionRenderer(vi.fn(),new KernelClient(),desktop);owners.push(owner)
  owner.prepare(props,doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:800,height:600})
  const job=worker.jobs.at(-1);views.push(job.options)
  expect(job.options.view.zoom).toBe(2)
  const capture=job.options.captureViewport
  expect(capture.x).toBeLessThanOrEqual(300*2-16)
  expect(capture.y).toBeLessThanOrEqual(220*2-16)
  expect(capture.x+capture.w).toBeGreaterThanOrEqual((300+24+72)*2)
  expect(capture.y+capture.h).toBeGreaterThanOrEqual((220+20+48)*2)
 }
 expect(views[1].width*views[1].height).toBeLessThan(views[0].width*views[0].height*.4)
 expect(JSON.stringify(doc)).toBe(before)
})

test('worker pose inputs do not enumerate the document after validation and rebase materializes the latest pose',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';root.effects=[effect('background-blur')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  for(let i=0;i<500;i++){const child=node('rectangle',i%80,i%70,1,1);doc.nodes[child.id]=child;root.children.push(child.id)}
  let enumerations=0
  doc.nodes=new Proxy(doc.nodes,{ownKeys(target){enumerations++;return Reflect.ownKeys(target)}})
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}}
  owner.prepare(props,doc.pages[0].id,{x:0,y:0,zoom:1},1,'analytic','webgpu',undefined,{width:100,height:100})
  expect(worker.jobs[0].options.view).toEqual({x:0,y:0,zoom:1})
  expect(worker.jobs[0].options.captureViewport).toBeDefined()
  worker.jobs[0].resolve({gpuTile:44,residentInteraction:true});await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,1,0]}})
  const validated=enumerations
  for(let i=2;i<=120;i++)owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,i,0]}})
  expect(enumerations).toBe(validated);expect(worker.jobs).toHaveLength(1);expect(worker.poses).toHaveLength(120)
  owner.acceptResidentSample({slot:44,sequence:120,at:0,needsRebase:true})
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(120)
  expect(doc.nodes[root.id].transform[4]).toBe(0)
  worker.jobs[1].resolve({gpuTile:45,residentInteraction:true})
  await vi.waitFor(()=>expect(owner.samples).toBe(2));shared.dispose()
})

test('retained layer movement reuses pixels, keeps commit preview and releases raster GPU slot', async () => {
  const { doc, root, props, owner, view } = fixture()
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(worker.disposed).toBe(1)
  expect(owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 30, 40] } })).toEqual({ x: 30, y: 40 })
  const pixels = owner.items(view)![0].tile
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, 30, 40] as const } } } as typeof doc
  owner.control.end(moved)
  owner.prepare({ ...props, document: moved }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(owner.items(view)![0].tile).toBe(pixels)
  expect(worker.jobs).toHaveLength(1)
  owner.control.end(doc)
  expect(owner.items(view)).toBeNull()
})

test('dependent render publishes an active sample despite newer input and coalesces pending samples', async () => {
  const { doc, root, props, owner, view } = fixture(true)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 10, 0] } })
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 20, 0] } })
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 30, 0] } })
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(3))
  expect(owner.items(view)?.length).toBe(1)
  expect(worker.jobs[2].document.nodes[root.id].transform[4]).toBe(30)
  owner.control.end(doc)
  worker.jobs[2].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(owner.items(view)).toBeNull()
})

test('selection replacement cannot publish a late warm result', async () => {
  const { doc, props, owner, view } = fixture()
  owner.prepare({ ...props, selection: [] }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  vi.mocked(props.onReady).mockClear()
  worker.jobs[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(owner.ready).toBe(false)
  expect(props.onReady).not.toHaveBeenCalled()
})

test('idle editor notifications preserve a deferred dependent controller for the first drag', async () => {
  const { doc, root, owner } = fixture(true, 1, 100, false)
  owner.control.end(doc)
  owner.control.end(doc)
  expect(worker.disposed).toBe(0)
  expect(worker.jobs).toHaveLength(0)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 20, 0] } })
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.samples).toBe(1))
  expect(worker.disposed).toBe(0)
})

test('pointer input during cold warm-up is retained without restarting or revealing an empty layer', async () => {
  const { doc, root, owner, view } = fixture()
  expect(owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 40, 20] } })).toEqual({ x: 40, y: 20 })
  expect(owner.items(view)).toBeNull()
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  const item = owner.items(view)![0]
  expect(item.placement!.left).toBeCloseTo(item.tile.x / item.tile.zoom + 40)
})

test('intermediate GPU budget failures reduce preview density with bounded retries', async () => {
  const { owner } = fixture(false, .2)
  const firstWidth = worker.jobs[0].options.width
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.width).toBeLessThan(firstWidth)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
})

test('reopening the same document id revokes an active interaction from the previous session', async () => {
  const { doc, root, props, owner, view } = fixture()
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 50, 0] } })
  owner.prepare({ ...props, epoch: 2 }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(owner.items(view)).toBeNull()
  expect(owner.control.isActive()).toBe(false)
})

test('dependent captures follow the visible viewport instead of a fixed 512-pixel page thumbnail', async () => {
  const { doc, props, owner } = fixture(true)
  const view = { x: -5000, y: -4000, zoom: 1 }
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 2, 'analytic', 'webgpu', undefined, { width: 800, height: 500 })
  // A running first job coalesces the replacement viewport; finish it so the
  // new request can publish its current capture policy.
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.width).toBeGreaterThan(1600)
  expect(worker.jobs[1].options.interactionWindow.w).toBe(1600)
  expect(worker.jobs[1].options.view.x).toBeLessThan(-9000)
})

test('a negotiated interaction density survives subsequent pointer samples', async () => {
  const {doc,root,owner}=fixture(true, .2)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  const acceptedScale=worker.jobs[1].options.view.zoom
  worker.jobs[1].resolve();await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,5,0]}})
  expect(worker.jobs).toHaveLength(3)
  expect(worker.jobs[2].options.view.zoom).toBe(acceptedScale)
})
test('normal-zoom budget failure never retries at reduced sampling density',async()=>{
  const {owner}=fixture(true)
  expect(worker.jobs[0].options.interactionNative).toBe(true)
  expect(worker.jobs[0].options.view.zoom).toBe(1)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.view.zoom).toBe(1)
  expect(worker.jobs[1].options.tileViewport.every((tile:any)=>tile.zoom===1)).toBe(true)
  worker.jobs[1].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(owner.error).toContain('PREVIEW_BUDGET'))
  expect(worker.jobs).toHaveLength(2)
})

test('shared GPU movement sends poses, retains a stable texture handle, and leaves the shared client alive',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.effects=[effect('background-blur')];root.blend='normal'
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const view={x:0,y:0,zoom:1},props:InteractionProps={document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}}
  owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,{width:100,height:100})
  worker.jobs[0].resolve({gpuTile:44,residentInteraction:true})
  await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,5.25,0]}})
  expect(worker.poses).toHaveLength(1);expect(worker.jobs).toHaveLength(1)
  expect(worker.poses[0][0]).toBe(44)
  expect(worker.poses[0][1][root.id][4]).toBe(5.25)
  owner.acceptResidentSample({slot:44,sequence:1,at:1,total:16,graphMs:5,groupHits:3})
  expect(owner.items(view)![0].tile.gpuTile).toBe(44)
  expect(owner.lastSampleMs).toBe(16);expect(owner.samples).toBe(2)
  const moved={...doc,nodes:{...doc.nodes,[root.id]:{...root,transform:[1,0,0,1,5.25,0] as typeof root.transform}}}
  owner.control.end(moved)
  owner.prepare({...props,document:moved},doc.pages[0].id,view,1,'analytic','webgpu',undefined,{width:100,height:100})
  owner.control.end(moved)
  expect(worker.jobs).toHaveLength(1)
  expect(worker.poses).toHaveLength(2)
  expect(worker.stops).not.toContain(44)
  owner.dispose();expect(worker.disposed).toBe(0);expect(worker.stops).toContain(44)
  shared.dispose()
})

test('zoom refreshes retained layer density without resetting an in-progress drag',async()=>{
  const {doc,root,props,owner}=fixture()
  worker.jobs[0].resolve();await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,30,40]}})
  const zoomed={x:0,y:0,zoom:2},before=owner.items(zoomed)![0].placement
  owner.prepare({...props,active:true},doc.pages[0].id,zoomed,1,'analytic','webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(owner.items(zoomed)![0].tile.zoom).toBe(1)
  worker.jobs[1].resolve()
  await vi.waitFor(()=>expect(owner.items(zoomed)![0].tile.zoom).toBe(2))
  expect(owner.items(zoomed)![0].placement).toEqual(before)
})

test('superseded shared-device layer captures release unpresented textures',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}}
  const view={x:0,y:0,zoom:1}
  owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu')
  owner.prepare({...props,epoch:2},doc.pages[0].id,view,1,'analytic','webgpu')
  worker.jobs[0].resolve({gpuTile:77})
  await vi.waitFor(()=>expect(worker.released).toContain(77))
  expect(owner.ready).toBe(false)
  owner.dispose();shared.dispose()
})

test('nested motion retains native Retina density and sends live GPU poses without rebuilding the scene', async () => {
  const doc = blank(), root = node('frame', 0, 0, 1600, 1200), child = node('rectangle', 600, 500, 200, 40)
  root.blend = 'normal'; root.children = [child.id]; doc.nodes[root.id] = root; doc.nodes[child.id] = child
  doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  owner.prepare(props, doc.pages[0].id, { x: 100, y: 100, zoom: .6 }, 2, 'analytic', 'webgpu', undefined, { width: 2560, height: 1440 })
  const job = worker.jobs[0]
  expect(job.options.view.zoom).toBe(1.2)
  expect(job.options.width * job.options.height).toBeLessThan(4_194_304)
  expect(job.options.interactionWindow.w).toBeLessThan(600)
  job.resolve({ gpuTile: 101, residentInteraction: true })
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  for (let i = 1; i <= 60; i++) owner.control.apply(doc, { [child.id]: { transform: [1, 0, 0, 1, 600 + i, 500] } })
  expect(worker.poses).toHaveLength(60)
  expect(worker.jobs).toHaveLength(1)
})

test('nested pointer feedback uses world displacement through a rotated scaled parent', () => {
  const doc = blank(), root = node('frame', 200, 200, 200, 200), child = node('rectangle', 30, 40, 20, 20)
  root.transform = [0, 2, -2, 0, 200, 200]; root.children = [child.id]; root.blend = 'normal'
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare({ document: doc, selection: [child.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 1 }, 1, 'analytic', 'webgpu')
  expect(owner.control.apply(doc, { [child.id]: { transform: [1, 0, 0, 1, 35, 43] } })).toEqual({ x: -6, y: 10 })
})

test('nested background-blur motion captures the fixed board at Retina density instead of the entire wide viewport',async()=>{
  const doc=blank(),root=node('frame',0,0,1440,1030),child=node('rectangle',600,500,200,40)
  root.clip=true;root.blend='multiply';root.effects=[{...effect('background-blur'),radius:8}];root.children=[child.id]
  doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  owner.prepare({document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:800,y:400,zoom:.6},2,'analytic','webgpu',undefined,{width:2560,height:1440})
  const first=worker.jobs[0];expect(first.options.view.zoom).toBe(1.2);expect(first.options.interactionWindowFixed).toBe(true)
  expect(first.options.width*first.options.height).toBeLessThanOrEqual(4_194_304)
  first.resolve({gpuTile:101,residentInteraction:true});await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,900,500]}})
  expect(worker.poses).toHaveLength(1);expect(worker.jobs).toHaveLength(1)
})

test.each([1, 2])('native retained layers refresh 31x to 32x without a density gap at DPR %i', async dpr => {
  const doc = blank(), root = node('frame', .125, -.25, 2, 2)
  root.blend = 'normal'
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 31 }, dpr, 'analytic', 'webgpu')
  expect(worker.jobs[0].options.view.zoom).toBe(31 * dpr)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1.125, .75] } })
  const view = { x: 0, y: 0, zoom: 32 }
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, dpr, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(32 * dpr)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.items(view)![0].tile.zoom).toBe(32 * dpr))
  expect(owner.control.isActive()).toBe(true)
})

test('in-flight 31x warm-up cannot pin a 32x drag to stale density', async () => {
  const doc = blank(), root = node('frame', 0, 0, 2, 2)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 31 }, 2, 'analytic', 'webgpu')
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 2, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  worker.jobs[1].resolve(); await vi.waitFor(() => expect(owner.tiles[0].zoom).toBe(64))
})


test('native retained layers keep integer pixel motion fast and reraster fractional coverage without a blank', async () => {
  const { doc, root, owner, view, props } = fixture(false, 32, 10)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const previous = owner.items(view)![0]
  expect(worker.jobs).toHaveLength(1)
  expect(owner.mode).toBe('retained-layers')
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.interactionNative).toBe(true)
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(.1)
  expect(owner.items(view)![0].tile).toBe(previous.tile)
  expect(owner.items(view)![0].placement).toEqual(previous.placement)
  expect(owner.items(view)![0].blend).toBe(true)
  // An authored React refresh cannot overwrite the newer imperative pose.
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  expect(worker.jobs).toHaveLength(2)
  expect(owner.items(view)![0].tile).not.toBe(previous.tile)
  expect(owner.items(view)![0].blend).toBe(false)
  expect(owner.presentedInput.sequence).toBe(2)
})

test('desktop independent layers follow fractional input and publish chrome only with their GPU frame',async()=>{
 const doc=blank(),root=node('frame',0,0,100,80);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 const onPosePresented=vi.fn(),props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady:vi.fn(),onPosePresented}
 const view={x:.25,y:.375,zoom:1.25},shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared,true);owners.push(owner)
 owner.prepare(props,doc.pages[0].id,view,2,'figmaSubpixel','webgpu',doc,{width:800,height:600})
 expect(worker.jobs).toHaveLength(1)
 const patch={ [root.id]:{transform:[1,0,0,1,.3,.7] as [number,number,number,number,number,number]} }
 owner.control.apply(doc,patch)
 expect(worker.jobs).toHaveLength(1) // finish the useful warm capture
 expect(onPosePresented).not.toHaveBeenCalled()
 worker.jobs[0].resolve({gpuTile:71});await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const first=owner.items(view)![0],base=(first.tile.x-(first.tile.phaseX||0))*view.zoom/first.tile.zoom+view.x
 expect(first.placement!.left-base).toBeCloseTo(.3*view.zoom)
 expect(owner.control.feedbackPending?.()).toBe(true)
 const sequence=owner.control.inputSequence!()
 owner.acceptPresentedInput(sequence,performance.now(),true,true,[999])
 expect(onPosePresented).not.toHaveBeenCalled()
 owner.acceptPresentedInput(sequence,performance.now(),true,true,[71])
 expect(onPosePresented).toHaveBeenCalledOnce()
 expect(onPosePresented.mock.calls[0][0].offset).toMatchObject({x:.3,y:.7})
 for(let i=1;i<=20;i++)owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,.3+i/7,.7+i/11]}})
 expect(worker.jobs).toHaveLength(1);expect(owner.mode).toBe('retained-layers')
 const moved={...doc,nodes:{...doc.nodes,[root.id]:{...root,transform:[1,0,0,1,.3+20/7,.7+20/11] as typeof root.transform}}}
 owner.control.end(moved)
 expect(worker.jobs).toHaveLength(1);expect(owner.items(view)).not.toBeNull()
 owner.prepare({...props,document:moved},doc.pages[0].id,view,2,'figmaSubpixel','webgpu',moved,{width:800,height:600})
 expect(owner.items(view)).toBeNull() // native page has taken over
})

test('fractional retained promotion coalesces newer poses and commits the last native sample', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  for (const x of [.1, .2, .3]) owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, x, 0] } })
  expect(worker.jobs).toHaveLength(2)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(3))
  expect(worker.jobs[2].document.nodes[root.id].transform[4]).toBe(.3)
  expect(worker.jobs[2].options.view.zoom).toBe(32)
  worker.jobs[2].resolve(); await vi.waitFor(() => expect(owner.samples).toBe(2))
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .3, 0] as const } } } as typeof doc
  owner.control.end(moved)
  expect(owner.items(view)).not.toBeNull()
  expect(owner.presentedInput.sequence).toBe(3)
})

test('coalesced pointer poses do not enumerate the complete node dictionary before the running capture finishes',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.effects=[effect('glass')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  let enumerations=0
  doc.nodes=new Proxy(doc.nodes,{ownKeys(target){enumerations++;return Reflect.ownKeys(target)}})
  const owner=new InteractionRenderer(vi.fn());owners.push(owner)
  owner.prepare({document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:0,y:0,zoom:1},1,'analytic','webgpu')
  expect(worker.jobs).toHaveLength(1);enumerations=0
  for(let i=1;i<=60;i++)owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,i/8,0]}})
  expect(worker.jobs).toHaveLength(1)
  expect(enumerations).toBe(0)
  worker.jobs[0].resolve()
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(7.5)
  worker.jobs[1].resolve();await vi.waitFor(()=>expect(owner.presentedInput.sequence).toBe(60))
})

test('fractional input cancels unusable initial retained capture and starts the exact pose immediately', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.interactionNative).toBe(true)
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(.1)
  expect(owner.ready).toBe(false)
  expect(owner.presentedInput.sequence).toBe(0)
  worker.jobs[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(worker.jobs).toHaveLength(2)
  expect(owner.ready).toBe(false)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.mode).toBe('live-kernel')
  expect(owner.items(view)).not.toBeNull()
  expect(owner.presentedInput.sequence).toBe(1)
})

test('late initial shared capture cannot replace the current pose and retires only its own handle', async () => {
  const doc=blank(),root=node('frame',0,0,10,10);root.blend='normal'
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  owner.prepare({document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:0,y:0,zoom:32},1,'analytic','webgpu')
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,.1,0]}})
  expect(worker.jobs[0].signal.aborted).toBe(true)
  expect(worker.jobs[1].signal.aborted).toBe(false)
  worker.jobs[1].resolve({gpuTile:802,bytes:new Uint8Array()})
  await vi.waitFor(()=>expect(owner.ready).toBe(true))
  worker.jobs[0].resolve({gpuTile:801,bytes:new Uint8Array()})
  await vi.waitFor(()=>expect(worker.released).toContain(801))
  expect(owner.tiles[0].gpuTile).toBe(802)
  expect(worker.released).not.toContain(802)
  expect(owner.presentedInput.sequence).toBe(1)
  shared.dispose()
})

test('failed retained warm-up admits a changed native density once without a same-request retry loop', async () => {
  const { doc, props, owner, view } = fixture(false, 31, 10)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(owner.error).toContain('PREVIEW_BUDGET'))
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  const higher = { ...view, zoom: 32 }
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.error).toBe('')
})

test('retained captures preserve the world pixel lattice for fractional authored bounds', async () => {
  const doc = blank(), root = node('frame', .1, .2, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 1, 'analytic', 'webgpu')
  expect(Number.isInteger(worker.jobs[0].options.view.x)).toBe(true)
  expect(Number.isInteger(worker.jobs[0].options.view.y)).toBe(true)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.tiles.every(tile => Number.isInteger(tile.x) && Number.isInteger(tile.y))).toBe(true)
})


test('failed fractional replacement retains the complete pose and a newer input recovers', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  const retained = owner.items(view)![0].tile
  worker.jobs[1].reject(Error('temporary render failure'))
  await vi.waitFor(() => expect(owner.error).toContain('temporary render failure'))
  expect(owner.items(view)![0].tile).toBe(retained)
  expect(owner.mode).toBe('retained-layers')
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .2, 0] } })
  worker.jobs[2].resolve(); await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  expect(owner.error).toBe('')
})

test('disposing a fractional native replacement releases its late shared GPU handle', async () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 1, 'analytic', 'webgpu')
  worker.jobs[0].resolve({ gpuTile: 70 }); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  owner.dispose()
  worker.jobs[1].resolve({ gpuTile: 71 })
  await vi.waitFor(() => expect(worker.released).toContain(71))
  expect(owner.ready).toBe(false)
  shared.dispose()
})


test('a failed old-density warm-up consumes the newer queued density exactly once', async () => {
  const { doc, props, owner, view } = fixture(false, 31, 10)
  const higher = { ...view, zoom: 32 }
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  worker.jobs[1].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(owner.error).toContain('PREVIEW_BUDGET'))
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
})


test('retained and native live samples preserve fractional device camera phase at 32x', async () => {
  const doc = blank(), root = node('frame', 0, 0, 2, 2)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const view = { x: .125, y: -.125, zoom: 32 }, dpr = 2
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, view, dpr, 'analytic', 'webgpu', undefined, { width: 100, height: 100 })
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.tiles[0].phaseX).toBe(.25); expect(owner.tiles[0].phaseY).toBe(.75)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  worker.jobs[1].resolve(); await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  const tile = owner.tiles[0]
  expect(tile.phaseX).toBe(.25); expect(tile.phaseY).toBe(.75)
  const placement = owner.items(view)![0].placement!
  expect(Number.isInteger(placement.left * dpr)).toBe(true)
  expect(Number.isInteger(placement.top * dpr)).toBe(true)
})

test.each([.1,.3953125])('native-density retained pixels keep camera phase even at low zoom %s',async zoom=>{
 const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn());owners.push(owner)
 const view={x:.125,y:-.125,zoom},dpr=2
 owner.prepare({document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}},doc.pages[0].id,view,dpr,'analytic','webgpu',undefined,{width:640,height:480})
 worker.jobs[0].resolve();await vi.waitFor(()=>expect(owner.ready).toBe(true))
 const tile=owner.tiles[0];expect(tile.zoom).toBe(zoom*dpr);expect(tile.phaseX).toBe(.25);expect(tile.phaseY).toBe(.75)
 owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,8/zoom,0]}})
 const placement=owner.items(view)![0].placement!
 expect(Number.isInteger(placement.left*dpr)).toBe(true);expect(Number.isInteger(placement.top*dpr)).toBe(true)
})

test('low-zoom nested text keeps the actual camera phase and bounds native preparation to the local capture',()=>{
 const doc=blank(),root=node('frame',10600,1600,1200,900),selected=node('text',584,558,83,20)
 root.blend='normal';root.clip=true;root.children=[selected.id];selected.effects=[];selected.strokes=[]
 doc.nodes[root.id]=root;doc.nodes[selected.id]=selected;doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient(),true);owners.push(owner)
 const view={x:-942.011,y:163.504,zoom:.122},dpr=2
 owner.prepare({document:doc,selection:[selected.id],active:true,epoch:1,control:{current:null},onReady(){}},doc.pages[0].id,
   view,dpr,'figmaSubpixel','webgpu',undefined,{width:855,height:856})
 const options=worker.jobs.at(-1).options
 expect(options.interactionNative).toBe(true)
 expect(options.captureViewport).toEqual({x:0,y:0,w:options.width,h:options.height})
 expect(options.view.zoom).toBe(view.zoom*dpr)
 expect(options.view.x-Math.floor(options.view.x)).toBeCloseTo(view.x*dpr-Math.floor(view.x*dpr),10)
 const r=(owner as any).resident,b=r.rootBounds.get(selected.id)
 // Capture window includes the existing 16 world-unit dependency margin and
 // uses the very same translated camera as the compiled source geometry.
 expect(options.interactionWindow.x).toBeCloseTo((b.x-16)*options.view.zoom+options.view.x,10)
})


test('page translation hands fractional native motion to the GPU renderer without losing its last complete pose', async () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 32 }, size = { width: 100, height: 100 }
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const page = new PageTranslation(vi.fn(), (document, patches, displayed) => {
    owner.prepare({ ...props, document: displayed }, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
    return owner.control.apply(document, patches)
  })
  const tile = { key: 'page', serial: 1, gpuTile: 70, bytes: new Uint8Array(), x: 0, y: 0, width: 512, height: 512, zoom: 32 }
  const items = [{ tile, active: true, layer: 0 }]
  page.prepare(props, doc.pages[0].id, doc, items, doc, true); page.bind()
  props.control.current!.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const accepted = page.items(view)![0].placement!.left
  expect(props.control.current!.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })).toEqual({ x: .1, y: 0 })
  expect(props.control.current).toBe(owner.control)
  expect(owner.ready).toBe(false)
  expect(page.items(view)![0].placement!.left).toBe(accepted)
  expect(worker.jobs[0].document.nodes[root.id].transform[4]).toBe(1 / 32)
  expect(page.prepare(props, doc.pages[0].id, doc, items, doc, true)).toBe(false)
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
  expect(worker.jobs).toHaveLength(2)
  worker.jobs[0].resolve({ gpuTile: 71 })
  await vi.waitFor(() => expect(worker.released).toContain(71))
  expect(owner.ready).toBe(false)
  expect(page.items(view)![0].placement!.left).toBe(accepted)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(.1)
  expect(worker.jobs[1].options.interactionNative).toBe(true)
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
  worker.jobs[1].resolve({ gpuTile: 72, residentInteraction: true })
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.mode).toBe('live-kernel')
  expect(worker.jobs).toHaveLength(2)
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .1, 0] as typeof root.transform } } }
  owner.control.end(moved)
  expect(page.prepare({ ...props, document: moved, active: false }, doc.pages[0].id, moved, items, moved, true)).toBe(true)
  expect(page.handingOff).toBe(false)
  shared.dispose()
})


test('replaced shared capture retires its own requests without cancelling another owner or same-generation motion', async () => {
  const shared = new KernelClient(), doc = blank(), a = node('frame', 0, 0, 100, 100), b = node('frame', 140, 0, 100, 100)
  a.blend = b.blend = 'normal'; doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  const one = new InteractionRenderer(vi.fn(), shared), two = new InteractionRenderer(vi.fn(), shared); owners.push(one, two)
  const props: InteractionProps = { document: doc, selection: [a.id], active: false, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: .25, y: .125, zoom: .6 }, size = { width: 600, height: 500 }
  one.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  two.prepare({ ...props, control: { current: null } }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  const old = worker.jobs[0], independent = worker.jobs[1]
  expect(old.signal?.aborted).toBe(false); expect(independent.signal?.aborted).toBe(false)
  one.prepare({ ...props, selection: [b.id] }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  expect(old.signal.aborted).toBe(true); expect(independent.signal.aborted).toBe(false)
  const latest = worker.jobs[2]
  expect(latest.signal.aborted).toBe(false)
  one.prepare({ ...props, selection: [b.id] }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  expect(worker.jobs).toHaveLength(3); expect(latest.signal.aborted).toBe(false)
  one.dispose(); expect(latest.signal.aborted).toBe(true); expect(independent.signal.aborted).toBe(false)
})

function pendingRetainedFixture(active = true, diagnostic?:PoseDiagnostics) {
  vi.stubEnv('VITE_DESIGN_RESIDENT_PENDING_POSE', '1')
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.clip = false; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared, false, diagnostic); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active, epoch: 1,
    control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 1 }, size = { width: 240, height: 180 }
  const prepare = (next = props, camera = view) =>
    owner.prepare(next, doc.pages[0].id, camera, 2, 'figmaSubpixel', 'webgpu', undefined, size)
  prepare()
  const transform = (dx: number) => [1, 0, 0, 1, 40 + dx, 40] as typeof child.transform
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { doc, root, child, owner, shared, props, view, prepare, transform, flush }
}

test('a live rotation prioritizes input only while the exact current page still owns its viewport',()=>{
 const f=pendingRetainedFixture(),cancel=vi.spyOn(f.shared,'cancelPreview')
 f.owner.prepare(f.props,f.doc.pages[0].id,f.view,2,'figmaSubpixel','webgpu',f.doc,{width:240,height:180})
 expect(f.owner.control.apply(f.doc,{[f.child.id]:{transform:[0,1,-1,0,60,40]}})).not.toBeNull()
 expect(cancel).toHaveBeenCalledWith('canvas')
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],f.view)).toBe(true)
 expect(f.owner.control.blocksCanvasRefinement?.({...f.doc},[f.child.id],f.view)).toBe(false)
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],{...f.view,zoom:2})).toBe(false)
 f.owner.prepare({...f.props,epoch:2},f.doc.pages[0].id,f.view,2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],f.view)).toBe(false)
})

test('returning to an old camera cannot freeze a coarse background behind the next local gesture',()=>{
 const f=pendingRetainedFixture(),cancel=vi.spyOn(f.shared,'cancelPreview')
 const prepare=(view=f.view,settled:typeof f.doc|undefined=undefined,active=false)=>
  f.owner.prepare({...f.props,active},f.doc.pages[0].id,view,2,'figmaSubpixel','webgpu',settled,{width:240,height:180})
 prepare(f.view,f.doc)
 prepare({...f.view,zoom:32})
 prepare(f.view)
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:[0,1,-1,0,60,40]}})
 expect(cancel.mock.calls.filter(([channel])=>channel==='canvas')).toHaveLength(0)
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],f.view)).toBe(false)
 // Once the *current* background completes, input can own the queue and
 // retain that proof across the deliberate suspension of the exact plan.
 prepare(f.view,f.doc,true)
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:[0,1,-1,0,62,40]}})
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],f.view)).toBe(true)
 prepare(f.view,undefined,true)
 expect(f.owner.control.blocksCanvasRefinement?.(f.doc,[f.child.id],f.view)).toBe(true)
 f.shared.dispose()
})

test('first retained capture transfers its latest queued pure translation to the same worker slot without a second capture', async () => {
  const f = pendingRetainedFixture(), original = JSON.stringify(f.doc), first = worker.jobs[0]
  expect(first.options.retainInteractionGraph).toBe(true)
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(4) } })
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  expect(worker.jobs).toHaveLength(1)
  first.resolve({ gpuTile: 801, residentInteraction: true }); await f.flush()
  expect(worker.jobs).toHaveLength(1)
  expect(worker.poses).toHaveLength(1)
  expect(worker.poses[0][0]).toBe(801)
  expect(worker.poses[0][1][f.child.id]).toEqual(f.transform(12))
  expect(worker.poses[0][2].sequence).toBe(2)
  // Sending is not a presentation acknowledgement. The captured original is
  // displayed until the actual resident sample reports the latest sequence.
  expect(f.owner.presentedInput.sequence).toBe(0)
  f.owner.acceptResidentSample({ slot: 801, ...worker.poses[0][2], nativePose: true })
  expect(f.owner.presentedInput.sequence).toBe(2)
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(16) } })
  expect(worker.poses).toHaveLength(2)
  expect(worker.jobs).toHaveLength(1)
  expect(JSON.stringify(f.doc)).toBe(original)
})

test('a first capture without worker residency keeps the original whole-scene pending path', async () => {
  const f = pendingRetainedFixture()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  worker.jobs[0].resolve({ gpuTile: 802, residentInteraction: false }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].transform).toEqual(f.transform(12))
})

test('camera changes during the first retained capture require a new capture instead of an old-lattice pose', async () => {
  const f = pendingRetainedFixture(), first = worker.jobs[0]
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  f.prepare(f.props, { x: 11.25, y: -.125, zoom: 1.25 })
  first.resolve({ gpuTile: 803, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(2.5)
})

test('a queued style change cannot enter the first retained capture as a transform-only pose', async () => {
  const f = pendingRetainedFixture()
  const styled = { ...f.doc, nodes: { ...f.doc.nodes, [f.child.id]: { ...f.child, opacity: .25 } } }
  f.prepare({ ...f.props, document: styled })
  worker.jobs[0].resolve({ gpuTile: 804, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].opacity).toBe(.25)
})

test('queued translation is checked against the completed capture document rather than only the original plan', async () => {
  const f = pendingRetainedFixture(false)
  expect(worker.jobs).toHaveLength(0)
  const styled = { ...f.doc, nodes: { ...f.doc.nodes, [f.child.id]: { ...f.child, opacity: .25 } } }
  f.prepare({ ...f.props, document: styled, active: true })
  expect(worker.jobs[0].document).toBe(styled)
  // This pending pose is compatible with the initial plan, but not with the
  // actual styled document currently being captured into slot 805.
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  worker.jobs[0].resolve({ gpuTile: 805, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].opacity).toBe(f.child.opacity)
})

test('session replacement while the first capture is pending releases its late slot without sending a pose', async () => {
  const f = pendingRetainedFixture(), first = worker.jobs[0]
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  f.prepare({ ...f.props, epoch: 2 })
  expect(first.signal.aborted).toBe(true)
  first.resolve({ gpuTile: 806, residentInteraction: true }); await f.flush()
  expect(worker.released).toContain(806)
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(f.owner.tiles.some(tile => tile.gpuTile === 806)).toBe(false)
})

test('a transferred pending pose outside the worker capture guard still rebuilds the latest real transform', async () => {
  const f = pendingRetainedFixture()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(60) } })
  worker.jobs[0].resolve({ gpuTile: 807, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(1)
  expect(worker.jobs).toHaveLength(1)
  f.owner.acceptResidentSample({ slot: 807, ...worker.poses[0][2], needsRebase: true })
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].transform).toEqual(f.transform(60))
  expect(f.doc.nodes[f.child.id].transform).toEqual(f.transform(0))
})


test('independent capture replanning borrows Canvas geometry across navigation and revokes stale publications', () => {
  const doc=blank(),a=node('frame',0,0,240,180),b=node('frame',400,0,240,180)
  for(const root of [a,b]){root.blend='normal';doc.nodes[root.id]=root}
  doc.pages[0].children=[a.id,b.id]
  const pageId=doc.pages[0].id,epoch=1,store=new CanvasSceneSnapshots()
  store.begin({},epoch,pageId,true);const snapshot=store.currentScene(doc,pageId)
  const props:InteractionProps={document:doc,selection:[b.id],active:false,epoch,
    control:{current:null},onReady(){},scene:store.borrowCurrentScene(doc,pageId,epoch)}
  const owner=new InteractionRenderer(vi.fn());owners.push(owner)
  const cameras=[{x:0,y:0,zoom:.25},{x:-400,y:-200,zoom:2},{x:300,y:100,zoom:1}]
  const expected=cameras.map(view=>{
    const pad=128/view.zoom,viewport={x:-view.x/view.zoom-pad,y:-view.y/view.zoom-pad,
      width:640/view.zoom+pad*2,height:480/view.zoom+pad*2}
    return planInteractionLayers(doc,pageId,props.selection,viewport)
  })
  const before=JSON.stringify(snapshot.entries),lookup=vi.spyOn(geometry,'scene')
  try{
    for(const [i,view] of cameras.entries()){
      owner.prepare(undefined,pageId,view,1,'analytic','cpu')
      owner.prepare(props,pageId,view,1,'analytic','cpu',doc,{width:640,height:480})
      expect((owner as any).resident.plan).toEqual(expected[i])
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot.entries)).toBe(before)
    store.begin({},epoch+1,pageId,true)
    owner.prepare(undefined,pageId,cameras[0],1,'analytic','cpu')
    owner.prepare({...props,epoch:epoch+1},pageId,cameras[0],1,'analytic','cpu',doc,{width:640,height:480})
    expect(lookup).toHaveBeenCalledOnce()
    expect((owner as any).resident.plan).toEqual(expected[0])
  }finally{lookup.mockRestore()}
})

test('navigation restoration borrows the published Canvas scene while recomputing camera-dependent scope', () => {
  vi.stubEnv('VITE_DESIGN_LOCAL_BACKDROP', '1')
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.clip = true; root.effects = [effect('background-blur')]; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const pageId = doc.pages[0].id, epoch = 1, store = new CanvasSceneSnapshots()
  store.begin({}, epoch, pageId, true)
  const snapshot = store.currentScene(doc, pageId), borrowed = store.borrowCurrentScene(doc, pageId, epoch)!
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: false, epoch,
    control: { current: null }, onReady: vi.fn(), scene: borrowed }
  const before = JSON.stringify(snapshot.entries), lookup = vi.spyOn(geometry, 'scene')
  try {
    for (const [zoom, dpr] of [[.25, 1], [32, 2], [1, 2], [32, 1]] as const) {
      const view = { x: zoom * 3.25, y: -zoom * 2.5, zoom }
      owner.prepare(undefined, pageId, view, dpr, 'analytic', 'cpu')
      owner.prepare(props, pageId, view, dpr, 'analytic', 'cpu', doc, { width: 640, height: 480 })
      const expected = buildInteractionDependencyScope(doc, pageId, snapshot.entries, props.selection,
        { zoom, dpr, allowFixedBackdrop: true })
      const actual = (owner as any).resident
      for (const field of ['rootBounds', 'parentLinear', 'localizedBounds', 'fixedBounds', 'dependencyPadding', 'finalForeground'] as const)
        expect(actual[field]).toEqual(expected[field])
      expect(props.control.current).toBe(owner.control)
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot.entries)).toBe(before)
    expect(props.onReady).toHaveBeenCalledTimes(8)
    expect(worker.jobs).toHaveLength(0)
  } finally { lookup.mockRestore() }
})

test('missing or stale Canvas borrow falls back to fresh geometry, including standalone mutable inputs', () => {
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const pageId = doc.pages[0].id, epoch = 1, store = new CanvasSceneSnapshots()
  store.begin({}, epoch, pageId, true); store.currentScene(doc, pageId)
  const borrowed = store.borrowCurrentScene(doc, pageId, epoch)!
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: false, epoch,
    control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 1 }, lookup = vi.spyOn(geometry, 'scene')
  try {
    owner.prepare(props, pageId, view, 1, 'analytic', 'cpu', doc, { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(1)
    owner.prepare(undefined, pageId, view, 1, 'analytic', 'cpu')
    // Ordinary standalone callers supply no immutable publication capability.
    child.width = 100
    owner.prepare(props, pageId, view, 1, 'analytic', 'cpu', doc, { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect((owner as any).resident.rootBounds.get(child.id).width).toBe(100)
    owner.prepare(undefined, pageId, view, 1, 'analytic', 'cpu')
    const changed = { ...doc, nodes: { ...doc.nodes, [child.id]: { ...child, width: 120 } } }
    owner.prepare({ ...props, document: changed, scene: borrowed }, pageId, view, 1, 'analytic', 'cpu', changed,
      { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(3)
    expect((owner as any).resident.rootBounds.get(child.id).width).toBe(120)
  } finally { lookup.mockRestore() }
})

test('live SVG feedback follows actual accepted presenter input, never the submitted or compiled pose', async () => {
  const f = pendingRetainedFixture(), feedback = vi.fn()
  f.props.onPosePresented = feedback
  worker.jobs[0].resolve({ gpuTile: 901, residentInteraction: true }); await f.flush()
  const submitted = f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  expect(submitted).toEqual({ x: 12, y: 0 })
  expect(f.owner.control.feedbackPending?.()).toBe(true)
  expect(feedback).not.toHaveBeenCalled()
  f.owner.acceptResidentSample({ slot: 901, ...worker.poses[0][2], nativePose: true })
  expect(feedback).not.toHaveBeenCalled()
  f.owner.acceptPresentedInput(worker.poses[0][2].sequence)
  expect(feedback).toHaveBeenCalledOnce()
  expect(feedback.mock.calls[0][0]).toMatchObject({ sequence: 1, offset: { x: 12, y: 0 }, epoch: 1, document: f.doc })
  f.owner.acceptPresentedInput(1); expect(feedback).toHaveBeenCalledOnce()
})

test('failed live preview stops claiming the gesture but does not mutate its authored document', async () => {
  const f = pendingRetainedFixture(), original = JSON.stringify(f.doc)
  worker.jobs[0].resolve({ gpuTile: 902, residentInteraction: false }); await f.flush()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  worker.jobs[1].reject(Error('Sampling coordinate field exceeds 64 MiB')); await f.flush()
  expect(f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(16) } })).toBeNull()
  expect(f.owner.control.covers(f.doc, [f.child.id], f.view)).toBe(false)
  expect(JSON.stringify(f.doc)).toBe(original)
})

test('ended or replaced gesture cannot publish delayed DOM feedback', async () => {
  const f = pendingRetainedFixture(), feedback = vi.fn(); f.props.onPosePresented = feedback
  worker.jobs[0].resolve({ gpuTile: 903, residentInteraction: true }); await f.flush()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(8) } })
  f.owner.acceptPresentedInput(999); expect(feedback).not.toHaveBeenCalled()
  f.owner.control.end(f.doc)
  f.owner.acceptPresentedInput(1); expect(feedback).not.toHaveBeenCalled()
  f.owner.dispose(); f.owner.acceptPresentedInput(1); expect(feedback).not.toHaveBeenCalled()
})


test('same-epoch document replacement cannot relabel an older accepted pose', async () => {
  const f = pendingRetainedFixture(), feedback = vi.fn(); f.props.onPosePresented = feedback
  worker.jobs[0].resolve({ gpuTile: 904, residentInteraction: true }); await f.flush()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(8) } })
  const replacement = { ...f.doc, nodes: { ...f.doc.nodes,
    [f.child.id]: { ...f.child, name: 'replacement' } } }
  f.prepare({ ...f.props, document: replacement })
  f.owner.acceptPresentedInput(1)
  expect(feedback).not.toHaveBeenCalled()
  // Returning to the old immutable snapshot must not revive its retired ACK.
  f.prepare(f.props); f.owner.acceptPresentedInput(1)
  expect(feedback).not.toHaveBeenCalled()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  f.owner.acceptResidentSample({slot:904,sequence:2,at:0})
  f.owner.acceptPresentedInput(2)
  expect(feedback).toHaveBeenCalledOnce()
  expect(feedback.mock.calls[0][0]).toMatchObject({ sequence: 2, document: f.doc, offset: { x: 12, y: 0 } })
})


test('actual renderer pose callbacks report owner/no-frame/sample/accepted/end and late ACK without content', async()=>{
 let now=0; const rows:Record<string,number>[]=[]
 const diagnostic=new PoseDiagnostics(row=>rows.push(sanitizeFields(row)),()=>now)
 const f=pendingRetainedFixture(true,diagnostic), feedback=vi.fn();f.props.onPosePresented=feedback
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
 expect(rows.some(r=>r.poseStage===1&&r.poseReady===0&&r.posePendingCount===1)).toBe(true)
 f.owner.acceptPresentedInput(1,0,true,false)
 f.owner.acceptPresentedInput(1,0,false,true)
 expect(feedback).not.toHaveBeenCalled()
 worker.jobs[0].resolve({gpuTile:940,residentInteraction:true});await f.flush()
 f.owner.acceptResidentSample({slot:940,sequence:1,at:0})
 expect(rows.some(r=>r.poseStage===2&&r.poseSequence===1)).toBe(true)
 f.owner.acceptPresentedInput(1,0,true,true)
 expect(feedback).toHaveBeenCalledOnce()
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}})
 now=1200;f.owner.control.end(f.doc)
 expect(rows.some(r=>r.poseStage===5&&r.posePendingCount===1&&r.poseOldestAgeMs===1200)).toBe(true)
 f.owner.acceptPresentedInput(2,0,true,true)
 expect(rows.some(r=>r.poseStage===4&&r.poseReason===6)).toBe(true)
 expect(rows.some(r=>r.poseStage===4&&r.poseReason===4)).toBe(true)
 expect(rows.some(r=>r.poseStage===4&&r.poseReason===1)).toBe(true)
 expect(JSON.stringify(rows)).not.toContain(f.child.id)
})

test('actual renderer diagnostic output stays bounded through 10000 pointer submissions and preserves end totals',()=>{
 const rows:Record<string,number>[]=[];let now=0
 const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(row),()=>now))
 for(let i=1;i<=10000;i++){now=i*8;f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(i)}})}
 f.owner.control.end(f.doc)
 expect(rows.length).toBeLessThanOrEqual(35)
 const end=rows.filter(r=>r.poseStage===5).pop()!
 expect(end.poseSubmittedCount).toBe(10000)
 expect(end.posePendingCount).toBe(180)
 expect(end.poseEvictedCount).toBe(9820)
 expect(end.posePendingCapped).toBe(1)
 expect(end.poseOldestAgeMs).toBe(79992)
 f.owner.acceptPresentedInput(10000)
 expect(rows.some(r=>r.poseStage===4&&r.poseReason===6)).toBe(true)
})

test('actual renderer reports failed-preview fallback entry without rejecting the authored edit',async()=>{
 const rows:Record<string,number>[]=[];const f=pendingRetainedFixture(true,new PoseDiagnostics(r=>rows.push(r)))
 worker.jobs[0].resolve({gpuTile:941,residentInteraction:true});await f.flush()
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
 // Non-translation scene changes force the actual live capture path to fail.
 f.owner.acceptResidentSample({slot:941,sequence:1,at:0,needsRebase:true})
 worker.jobs.at(-1).reject(new Error('sample budget failed'));await f.flush()
 expect(f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}})).toBeNull()
 expect(rows.some(r=>r.poseStage===7&&r.poseReason===5)).toBe(true)
 expect(f.doc.nodes[f.child.id].transform).toEqual(f.transform(0))
})


test('actual renderer reports document retirement, stale sequence, missing sequence and slot mismatch distinctly',async()=>{
 const rows:Record<string,number>[]=[];const f=pendingRetainedFixture(true,new PoseDiagnostics(r=>rows.push(r)))
 worker.jobs[0].resolve({gpuTile:942,residentInteraction:true});await f.flush()
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
 f.owner.acceptResidentSample({slot:942,sequence:1,at:0})
 f.owner.acceptPresentedInput(1);f.owner.acceptPresentedInput(1);f.owner.acceptPresentedInput(999)
 f.owner.acceptResidentSample({slot:999,sequence:2,at:0})
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}})
 f.prepare({...f.props,document:{...f.doc,nodes:{...f.doc.nodes}}})
 f.owner.acceptPresentedInput(2)
 for(const reason of [2,3,7,9])expect(rows.some(r=>r.poseStage===4&&r.poseReason===reason)).toBe(true)
})


test.each([true,false])('desktop detail=%s emits the terminal gesture summary before late ACK aggregation',async detail=>{
 vi.useFakeTimers();vi.stubGlobal('window',{coreDesktop:{renderDiagnostics:true,renderDiagnosticsDetail:detail}})
 const output=vi.spyOn(console,'log').mockImplementation(()=>{})
 let diagnosticTime=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>diagnosticTime)
 try{
  const f=pendingRetainedFixture(true,createPoseDiagnostics(777))
  f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
  f.owner.acceptPresentedInput(1,0,false,true)
  for(let i=0;i<12;i++){diagnosticTime+=260;f.owner.acceptPresentedInput(1,0,false,true)}
  f.owner.control.end(f.doc)
  f.owner.acceptPresentedInput(1,0,true,true)
  vi.advanceTimersByTime(1100)
  const records=output.mock.calls.flatMap(args=>{const value=JSON.parse(String(args[0]).replace('[render-diag] ',''));return value.batch||[value]})
  expect(records.some(r=>r.event==='pose-lifecycle'&&r.interactionOwner===777&&r.poseStage===1&&r.poseSubmittedCount===1)).toBe(true)
  expect(records.some(r=>r.poseStage===4&&r.poseReason===1)).toBe(true)
  expect(records.some(r=>r.poseStage===5&&r.posePendingCount===1)).toBe(true)
  expect(JSON.stringify(records)).not.toContain(f.child.id)
 }finally{clock.mockRestore();output.mockRestore();vi.unstubAllGlobals();vi.useRealTimers()}
})

test('throwing diagnostic output never changes apply, accepted feedback or end semantics',async()=>{
 const f=pendingRetainedFixture(true,new PoseDiagnostics(()=>{throw Error('sink')})),feedback=vi.fn();f.props.onPosePresented=feedback
 worker.jobs[0].resolve({gpuTile:943,residentInteraction:true});await f.flush()
 expect(f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})).toEqual({x:8,y:0})
 f.owner.acceptResidentSample({slot:943,sequence:1,at:0})
 f.owner.acceptPresentedInput(1)
 expect(feedback).toHaveBeenCalledOnce()
 expect(()=>f.owner.control.end(f.doc)).not.toThrow()
})


test.each(['dispose','epoch','selection'] as const)('renderer %s retires pending feedback with one final summary and no duplicate late-ACK end',kind=>{
 const rows:Record<string,number>[]=[];const f=pendingRetainedFixture(true,new PoseDiagnostics(r=>rows.push(r)))
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
 if(kind==='dispose')f.owner.dispose()
 else if(kind==='epoch')f.prepare({...f.props,epoch:2})
 else f.prepare({...f.props,selection:[f.root.id]})
 expect(rows.filter(r=>r.poseStage===5)).toHaveLength(1)
 expect(rows.find(r=>r.poseStage===5)?.posePendingCount).toBe(1)
 f.owner.acceptPresentedInput(1)
 expect(rows.filter(r=>r.poseStage===5)).toHaveLength(1)
})

test('rotation coalesces local native captures, presents only rendered affine feedback, and hands off before React props catch up', async () => {
  const f = pendingRetainedFixture(), feedback = vi.fn(); f.props.onPosePresented = feedback
  worker.jobs[0].resolve({ gpuTile: 980, residentInteraction: true }); await f.flush()
  const first = [0, 1, -1, 0, 60, 40] as typeof f.child.transform
  const latest = [.6, .8, -.8, .6, 62, 42] as typeof f.child.transform
  expect(f.owner.control.apply(f.doc, { [f.child.id]: { transform: first } })?.matrix).toBeDefined()
  expect(worker.stops).toContain(980)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options).toMatchObject({ interactionNative: true, interactionAffine: true, interactionWindowFixed: true })
  expect(worker.jobs[1].options.interactionWindow.w).toBeLessThan(480)
  expect(worker.jobs[1].options.interactionWindow.h).toBeLessThan(360)
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: latest } })
  f.owner.acceptPresentedInput(2)
  expect(feedback).not.toHaveBeenCalled()
  worker.jobs[1].resolve({ gpuTile: 981, residentInteraction: true }); await f.flush()
  expect(worker.jobs).toHaveLength(2)
  expect(worker.poses.at(-1)[1][f.child.id]).toEqual(latest)
  expect(f.owner.presentedInput.sequence).toBe(1)
  f.owner.acceptPresentedInput(1)
  expect(feedback.mock.calls[0][0].offset.matrix).toBeDefined()
  f.owner.acceptResidentSample({ slot: 981, sequence: 2, at: 0 })
  f.owner.acceptPresentedInput(2)
  expect(feedback).toHaveBeenCalledTimes(2)
  const final = { ...f.doc, nodes: { ...f.doc.nodes, [f.child.id]: { ...f.child, transform: latest } } }
  f.owner.control.end(final)
  expect(f.owner.control.feedbackPending!()).toBe(false)
  f.prepare(f.props) // Stale props before the commit notification.
  f.prepare({ ...f.props, active: false, document: final })
  f.owner.control.end(final)
  expect(worker.jobs).toHaveLength(2)
  expect(f.owner.items(f.view)).not.toBeNull()
})

test('inactive root selection leaves incomplete zoom coverage to canvas while preserving a callable interaction lease', async () => {
  const f = pendingRetainedFixture(false)
  f.prepare({ ...f.props, selection: [f.root.id] })
  expect(worker.jobs).toHaveLength(0)
  for (const zoom of [.2, 2, .3, 1]) f.prepare({ ...f.props, selection: [f.root.id] }, { ...f.view, zoom })
  expect(worker.jobs).toHaveLength(0)
  expect(f.owner.control.apply(f.doc, { [f.root.id]: { transform: [1, 0, 0, 1, 12, 8] } })).not.toBeNull()
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve({ gpuTile: 982 }); await f.flush()
  expect(f.owner.ready).toBe(true)
})

test.each(['during','after'])('guarded native rotation rechecks a later backdrop %s capture before forwarding a worker pose',async timing=>{
 vi.stubEnv('VITE_DESIGN_GUARDED_ROTATION_CAPTURE','1')
 const doc=blank(),root=node('frame',0,0,1200,900),child=node('rectangle',40,40,30,20),reader=node('rectangle',400,300,80,80)
 root.blend=reader.blend=child.blend='normal';reader.effects=[{...effect('background-blur'),radius:4}]
 root.children=[child.id,reader.id];doc.nodes=Object.fromEntries([root,child,reader].map(n=>[n.id,n]));doc.pages[0].children=[root.id]
 const client=new KernelClient(),owner=new InteractionRenderer(vi.fn(),client);owners.push(owner)
 const props:InteractionProps={document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady(){}}
 owner.prepare(props,doc.pages[0].id,{x:0,y:0,zoom:1},1,'analytic','webgpu',undefined,{width:640,height:480})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(1))
 worker.jobs[0].resolve({gpuTile:1095,residentInteraction:true,bytes:new Uint8Array()})
 await vi.waitFor(()=>expect(owner.ready).toBe(true))
 owner.control.apply(doc,{[child.id]:{transform:[0,1,-1,0,70,40]}})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
 const local=worker.jobs[1].options.width*worker.jobs[1].options.height
 expect(local).toBeLessThan(640*480)
 if(timing==='after'){
  worker.jobs[1].resolve({gpuTile:1096,residentInteraction:true,bytes:new Uint8Array()})
  await vi.waitFor(()=>expect(owner.tiles[0]?.gpuTile).toBe(1096))
  const count=worker.poses.length
  owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,80,40]}})
  expect(worker.poses).toHaveLength(count+1)
  expect(worker.jobs).toHaveLength(2)
 }
 const forwarded=worker.poses.length
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,450,330]}})
 if(timing==='during')worker.jobs[1].resolve({gpuTile:1096,residentInteraction:true,bytes:new Uint8Array()})
 else expect(worker.stops).toContain(1096)
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(3))
 expect(worker.poses).toHaveLength(forwarded)
 expect(worker.jobs[2].options.width*worker.jobs[2].options.height).toBeGreaterThan(local)
 expect(worker.jobs[2].options.width*worker.jobs[2].options.height).toBeGreaterThanOrEqual(640*480)
 // A quick reversal must not wait for this obsolete global backdrop capture.
 const held=owner.tiles
 owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,80,40]}})
 expect(worker.jobs[2].signal.aborted).toBe(true)
 expect(owner.tiles).toBe(held)
 worker.jobs[2].resolve({gpuTile:1097,residentInteraction:true,bytes:new Uint8Array()})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(4))
 expect(worker.released).toContain(1097)
 expect(worker.released).not.toContain(1096)
 expect(worker.jobs[3].options.width*worker.jobs[3].options.height).toBeLessThan(640*480)
 expect(owner.error).toBe('')
 client.dispose()
})

function idleRootWarmFixture(layered = false, edge = 100) {
  const doc = blank(), root = node('frame', 0, 0, edge, edge)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  if (layered) {
    const before = node('frame', 20, 20, 100, 100), after = node('frame', 40, 40, 100, 100)
    for (const sibling of [before, after]) { sibling.blend = 'normal'; doc.nodes[sibling.id] = sibling }
    doc.pages[0].children = [before.id, root.id, after.id]
  }
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [root.id], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 1 }, size = { width: 320, height: 240 }
  const prepare = (nextView = view, settled: typeof doc | undefined = doc, nextProps = props) =>
    owner.prepare(nextProps, doc.pages[0].id, nextView, 1, 'analytic', 'webgpu', settled, size)
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  prepare()
  expect(worker.jobs).toHaveLength(1)
  expect(worker.jobs[0].options.interactionBranch).toBe(1)
  return { doc, root, shared, owner, props, view, prepare, flush }
}

test.each([1,.25])('rotation after zooming from 32x to %s requests the current density while retaining old pixels',async zoom=>{
 const f=idleRootWarmFixture(false,24)
 worker.jobs[0].resolve({gpuTile:1090,bytes:new Uint8Array()});await f.flush()
 f.prepare({...f.view,zoom:32})
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
 worker.jobs[1].resolve({gpuTile:1091,bytes:new Uint8Array()});await f.flush()
 const held=f.owner.tiles
 f.owner.prepare(f.props,f.doc.pages[0].id,{...f.view,zoom},1,'analytic','webgpu',undefined,{width:320,height:240})
 expect(f.owner.tiles).toBe(held)
 const angle=.2,c=Math.cos(angle),s=Math.sin(angle)
 expect(f.owner.control.apply(f.doc,{[f.root.id]:{transform:[c,s,-s,c,10,12]}})).not.toBeNull()
 await vi.waitFor(()=>expect(worker.jobs).toHaveLength(3))
 expect(worker.jobs[2].options.view.zoom).toBe(zoom)
 expect(worker.jobs[2].options.width*worker.jobs[2].options.height).toBeLessThanOrEqual(8_000_000)
 expect(worker.released).not.toContain(1091)
})


test.each(['camera', 'canvas-repair'] as const)('idle root warm yields its private capture to %s without a replacement warming loop', async reason => {
  const f = idleRootWarmFixture(), old = worker.jobs[0]
  try {
    const view = reason === 'camera' ? { ...f.view, zoom: .75 } : f.view
    // Undefined settledDocument is supplied by the real surface while its
    // current exact plan is incomplete, even if the authored camera is unchanged.
    f.owner.prepare(f.props, f.doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(old.signal.aborted).toBe(true)
    expect(worker.jobs).toHaveLength(1)
    old.resolve({ gpuTile: 990, bytes: new Uint8Array() }); await f.flush()
    expect(worker.released).toContain(990)
    expect(f.owner.ready).toBe(false); expect(f.owner.error).toBe('')
    f.owner.prepare(f.props, f.doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(worker.jobs).toHaveLength(1)
    expect(f.owner.control.apply(f.doc, { [f.root.id]: { transform: [1, 0, 0, 1, 12, 8] } })).not.toBeNull()
    expect(worker.jobs).toHaveLength(2)
    expect(worker.jobs[1].signal.aborted).toBe(false)
    expect(worker.jobs[1].options.view.zoom).toBe(view.zoom)
  } finally { f.shared.dispose() }
})

test.each([false, true])('idle root warm cancellation preserves real pointer input before/after React active=%s', async active => {
  const f = idleRootWarmFixture(), old = worker.jobs[0]
  try {
    expect(f.owner.control.apply(f.doc, { [f.root.id]: { transform: [1, 0, 0, 1, 12, 8] } })).not.toBeNull()
    f.owner.prepare({ ...f.props, active }, f.doc.pages[0].id, f.view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(old.signal.aborted).toBe(false)
    old.resolve({ gpuTile: 991, bytes: new Uint8Array() }); await f.flush()
    expect(f.owner.ready).toBe(true)
    expect(f.owner.items(f.view)).not.toBeNull()
    expect(worker.released).not.toContain(991)
  } finally { f.shared.dispose() }
})

test('idle root warm yields after the exact final edit snapshot and a late old completion cannot clear a newer gesture', async () => {
  const f = idleRootWarmFixture(), old = worker.jobs[0]
  try {
    const transform = [1, 0, 0, 1, 12, 8] as typeof f.root.transform
    f.owner.control.apply(f.doc, { [f.root.id]: { transform } })
    const committed = { ...f.doc, nodes: { ...f.doc.nodes, [f.root.id]: { ...f.root, transform } } }
    f.owner.control.end(committed)
    const props = { ...f.props, document: committed, active: false }
    f.owner.prepare(props, committed.pages[0].id, f.view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(old.signal.aborted).toBe(true)
    expect(worker.jobs).toHaveLength(1)
    expect(f.owner.control.apply(committed, { [f.root.id]: { transform: [1, 0, 0, 1, 24, 16] } })).not.toBeNull()
    expect(worker.jobs).toHaveLength(2)
    const latest = worker.jobs[1]
    old.resolve({ gpuTile: 992, bytes: new Uint8Array() }); await f.flush()
    expect(worker.released).toContain(992)
    expect(latest.signal.aborted).toBe(false)
    latest.resolve({ gpuTile: 993, bytes: new Uint8Array() }); await f.flush()
    expect(f.owner.ready).toBe(true)
    expect(f.owner.tiles.map(tile => tile.gpuTile)).toEqual([993])
    expect(f.owner.error).toBe('')
  } finally { f.shared.dispose() }
})

test('idle root warm cancellation preserves a complete resident while a higher-density replacement is revoked', async () => {
  const f = idleRootWarmFixture()
  try {
    worker.jobs[0].resolve({ gpuTile: 994, bytes: new Uint8Array() }); await f.flush()
    const previous = f.owner.tiles
    const view = { ...f.view, zoom: 2 }
    f.prepare(view)
    expect(worker.jobs).toHaveLength(2)
    const replacing = worker.jobs[1]
    f.owner.prepare(f.props, f.doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(replacing.signal.aborted).toBe(true)
    expect(f.owner.tiles).toBe(previous)
    replacing.resolve({ gpuTile: 995, bytes: new Uint8Array() }); await f.flush()
    expect(worker.released).toContain(995)
    expect(worker.released).not.toContain(994)
    expect(f.owner.tiles).toBe(previous)
    expect(worker.jobs).toHaveLength(2)
    f.owner.prepare(f.props, f.doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(worker.jobs).toHaveLength(2)
    expect(f.owner.tiles).toBe(previous)
    // Once the exact canvas is complete, optional native-density replacement
    // may resume. Its scale has not been reduced by the cancellation policy.
    f.prepare(view)
    expect(worker.jobs).toHaveLength(3)
    expect(worker.jobs[2].options.view.zoom).toBe(2)
  } finally { f.shared.dispose() }
})

test('idle root warm cancellation retires staged layers and prevents later layers from being requested', async () => {
  const f = idleRootWarmFixture(true)
  try {
    expect(planInteractionLayers(f.doc, f.doc.pages[0].id, [f.root.id])!.layers).toHaveLength(3)
    worker.jobs[0].resolve({ gpuTile: 996, bytes: new Uint8Array() }); await f.flush()
    expect(worker.jobs).toHaveLength(2)
    const inFlight = worker.jobs[1]
    f.owner.prepare(f.props, f.doc.pages[0].id, { ...f.view, zoom: 2 }, 1, 'analytic', 'webgpu', undefined, { width: 320, height: 240 })
    expect(inFlight.signal.aborted).toBe(true)
    inFlight.resolve({ gpuTile: 997, bytes: new Uint8Array() }); await f.flush()
    expect(worker.jobs).toHaveLength(2)
    expect(worker.released.filter(id => id === 996)).toHaveLength(1)
    expect(worker.released.filter(id => id === 997)).toHaveLength(1)
    expect(f.owner.ready).toBe(false)
    expect(f.owner.control.apply(f.doc, { [f.root.id]: { transform: [1, 0, 0, 1, 12, 8] } })).not.toBeNull()
    expect(worker.jobs).toHaveLength(3)
    expect(worker.jobs[2].signal.aborted).toBe(false)
    expect(worker.jobs[2].options.interactionBranch).not.toBe(1)
  } finally { f.shared.dispose() }
})

test.each(['page','profile','backend'] as const)('stale committed-document props cannot retain handoff after %s ownership changes',async changed=>{
 const f=pendingRetainedFixture();worker.jobs[0].resolve({gpuTile:983,residentInteraction:true});await f.flush()
 const next={...f.doc,nodes:{...f.doc.nodes,[f.child.id]:{...f.child,transform:f.transform(12)}}}
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}});f.owner.control.end(next)
 expect(worker.stops).not.toContain(983)
 f.owner.prepare(f.props,changed==='page'?'replacement-page':f.doc.pages[0].id,f.view,2,
   changed==='profile'?'analytic':'figmaSubpixel',changed==='backend'?'cpu':'webgpu',undefined,{width:240,height:180})
 expect(worker.stops).toContain(983)
})

test('an in-flight translation-localized warm capture cannot ACK or clip the first affine input',async()=>{
 const f=pendingRetainedFixture(),feedback=vi.fn();f.props.onPosePresented=feedback
 const transform=[0,1,-1,0,60,40] as typeof f.child.transform
 f.owner.control.apply(f.doc,{[f.child.id]:{transform}})
 expect(worker.jobs).toHaveLength(1)
 worker.jobs[0].resolve({gpuTile:984,residentInteraction:true});await f.flush()
 expect(f.owner.presentedInput.sequence).toBe(0)
 f.owner.acceptPresentedInput(1);expect(feedback).not.toHaveBeenCalled()
 expect(worker.poses.at(-1)[1][f.child.id]).toEqual(transform)
 // The worker explicitly declines the old translation-localized lease.
 f.owner.acceptResidentSample({slot:984,sequence:1,at:0,needsRebase:true})
 expect(worker.jobs).toHaveLength(2)
 expect(worker.jobs[1].options).toMatchObject({interactionAffine:true,interactionNative:true})
 expect(worker.jobs[1].options.interactionWindow.w).toBeLessThan(480)
 expect(worker.jobs[1].options.interactionWindow.h).toBeLessThan(360)
 worker.jobs[1].resolve({gpuTile:985,residentInteraction:true});await f.flush()
 expect(f.owner.presentedInput.sequence).toBe(1)
 f.owner.acceptPresentedInput(1);expect(feedback).toHaveBeenCalledOnce()
 expect(worker.jobs).toHaveLength(2)
})


test('diagnostic action token survives a newer input and late presented callback',async()=>{
 const rows:Record<string,number>[]=[];let now=0
 const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(sanitizeFields(row)),()=>now))
 const first={actionOwner:101,actionId:1,actionSession:2,actionStartRevision:3,actionCode:13}
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}},first)
 worker.jobs[0].resolve({gpuTile:940,residentInteraction:true});await f.flush()
 now=500;f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}},{...first,actionId:2})
 now=1000;f.owner.acceptPresentedInput(1,0,false,true)
 const ack=rows.find(row=>row.poseStage===3&&row.poseSequence===1)
 expect(ack).toMatchObject({actionOwner:101,actionId:1,poseActionKnown:1})
 expect(rows.find(row=>row.poseStage===1&&row.poseSequence===2)).toMatchObject({actionId:2})
})

test('unsupported apply associates only its own diagnostic token without claiming a pose',()=>{
 const rows:Record<string,number>[]=[]
 const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(sanitizeFields(row))))
 const result=f.owner.control.apply(f.doc,{unknown:{transform:f.transform(8)}},{actionOwner:102,actionId:7,actionSession:2,actionStartRevision:3,actionCode:13})
 expect(result).toBeNull()
 expect(rows.find(row=>row.poseStage===7)).toMatchObject({poseSequence:0,poseReason:13,actionOwner:102,actionId:7,poseActionKnown:1})
 expect(rows.some(row=>row.poseStage===3||row.poseStage===8)).toBe(false)
})


test('production pose terminal preserves action labels and omitted sampling count',()=>{
 vi.useFakeTimers();vi.stubGlobal('window',{coreDesktop:{renderDiagnostics:true,renderDiagnosticsDetail:true}})
 const output=vi.spyOn(console,'log').mockImplementation(()=>{})
 const clock=vi.spyOn(performance,'now').mockImplementation(()=>0)
 try{
  const f=pendingRetainedFixture(true,createPoseDiagnostics(778))
  const token={actionOwner:1001,actionId:17,actionSession:2,actionStartRevision:3,actionCode:13}
  for(let i=0;i<10;i++)f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(i+8)}},token)
  f.owner.control.end(f.doc);vi.advanceTimersByTime(1100)
  const records=output.mock.calls.flatMap(args=>{const value=JSON.parse(String(args[0]).replace('[render-diag] ',''));return value.batch||[value]})
  expect(records.find(row=>row.poseStage===5)).toMatchObject({interactionOwner:778,actionOwner:1001,actionId:17,poseActionKnown:1,poseSuppressedCount:9,poseSubmittedCount:10})
  expect(JSON.stringify(records)).not.toContain(f.child.id)
 }finally{clock.mockRestore();output.mockRestore();vi.unstubAllGlobals();vi.useRealTimers()}
})

test('end worker sequence inherits only the matching final applied gesture token, including late ACK after a new action',async()=>{
 let now=0;const rows:Record<string,number>[]=[]
 const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(row),()=>now))
 const a={actionOwner:201,actionId:1,actionSession:1,actionStartRevision:0,actionCode:10}
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}},a)
 worker.jobs[0].resolve({gpuTile:940,residentInteraction:true});await f.flush()
 const final={...f.doc,nodes:{...f.doc.nodes,[f.child.id]:{...f.child,transform:f.transform(8)}}}
 f.owner.control.end(final)
 const closing=worker.poses.at(-1)[2].sequence
 expect(closing).toBe(2)
 now=500;f.owner.control.apply(final,{[f.child.id]:{transform:f.transform(12)}},{...a,actionId:2})
 now=1000;f.owner.acceptPresentedInput(closing,0,false,true)
 expect(rows.find(row=>row.poseStage===3&&row.poseSequence===closing)).toMatchObject({actionOwner:201,actionId:1,poseActionKnown:1})
})

test('end whose final transforms differ from accepted apply does not manufacture gesture provenance',async()=>{
 const rows:Record<string,number>[]=[];const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(row)))
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}},{actionOwner:202,actionId:1,actionSession:1,actionStartRevision:0,actionCode:10})
 worker.jobs[0].resolve({gpuTile:941,residentInteraction:true});await f.flush()
 const changed={...f.doc,nodes:{...f.doc.nodes,[f.child.id]:{...f.child,transform:f.transform(16)}}}
 f.owner.control.end(changed);const closing=worker.poses.at(-1)[2].sequence
 expect(closing).toBe(2)
 f.owner.acceptPresentedInput(closing,0,false,true)
 expect(rows.find(row=>row.poseStage===3&&row.poseSequence===closing)).toMatchObject({poseActionKnown:0})
 const before=worker.poses.length;f.owner.control.end(changed);expect(worker.poses.length).toBe(before)
})

test('epoch reset cannot let a later gesture closing ACK borrow the retired action',async()=>{
 let now=0;const rows:Record<string,number>[]=[];const f=pendingRetainedFixture(true,new PoseDiagnostics(row=>rows.push(row),()=>now))
 const a={actionOwner:203,actionId:1,actionSession:1,actionStartRevision:0,actionCode:10}
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}},a)
 worker.jobs[0].resolve({gpuTile:943,residentInteraction:true});await f.flush()
 f.prepare({...f.props,epoch:2})
 // A new accepted input supplies its own explicit identity after the reset.
 now=500;f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}},{...a,actionId:2,actionSession:2})
 const current=worker.jobs.at(-1);current.resolve({gpuTile:942,residentInteraction:true});await f.flush()
 const final={...f.doc,nodes:{...f.doc.nodes,[f.child.id]:{...f.child,transform:f.transform(12)}}}
 f.owner.control.end(final);const closing=worker.poses.at(-1)?.[2]?.sequence
 expect(closing).toBeGreaterThan(1)
 now=1000;f.owner.acceptPresentedInput(closing,0,false,true)
 const ack=rows.find(row=>row.poseStage===3&&row.poseSequence===closing)
 expect(ack).not.toHaveProperty('actionId',1)
 expect(ack).toMatchObject({poseActionKnown:1,actionId:2,actionSession:2})
})


// Failure-cause diagnostic contract. Transport is controlled; this is not GPU evidence.
async function failedCauseFixture(enabled=true,sink?:(row:Record<string,number>)=>void,now=()=>0) {
 const rows:Record<string,number>[]=[]
 const f=pendingRetainedFixture(true,new PoseDiagnostics(sink||((row)=>rows.push(sanitizeFields(row))),now,enabled))
 f.props.onPreviewFailed=vi.fn()
 worker.jobs[0].resolve({gpuTile:970,residentInteraction:true});await f.flush()
 const token={actionOwner:301,actionId:1,actionSession:1,actionStartRevision:0,actionCode:13}
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}},token)
 f.owner.acceptResidentSample({slot:970,sequence:1,at:0,needsRebase:true})
 return {...f,rows,token,failed:worker.jobs.at(-1),authored:JSON.stringify(f.doc)}
}
test('failed cause keeps original A while current recovery retires newer B',async()=>{
 const f=await failedCauseFixture()
 f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}},{...f.token,actionId:2})
 f.failed.reject(Error('fixed controlled failure'));await f.flush()
 const row=f.rows.find(r=>r.poseStage===7&&r.poseReason===5)
 expect(row).toMatchObject({failedCauseKnown:1,failedCauseSequence:1,failedCauseActionId:1,observedCurrentSequence:2,actionId:2,causeRequestKnown:0,failedCausePhase:2})
 expect(f.props.onPreviewFailed).toHaveBeenCalledOnce();expect(f.props.onPreviewFailed).toHaveBeenCalledWith(expect.objectContaining({sequence:2}))
 expect(JSON.stringify(f.doc)).toBe(f.authored)
})
test('ordered capture failure has the same cause and current sequence without inventing a request id',async()=>{
 const f=await failedCauseFixture();f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.rows.find(r=>r.poseStage===7&&r.poseReason===5)).toMatchObject({failedCauseSequence:1,observedCurrentSequence:1,causeRequestKnown:0})
})
test('intentional cancellation keeps existing cancellation behavior and does not emit recovery cause',async()=>{
 const f=await failedCauseFixture();f.failed.reject(Error('PREVIEW_CANCELLED'));await f.flush()
 expect(f.props.onPreviewFailed).not.toHaveBeenCalled()
 expect(f.rows.some(r=>r.failedCauseKnown!==undefined)).toBe(false)
})
test('late failure after epoch reset cannot recover or label the new epoch as failed cause',async()=>{
 const f=await failedCauseFixture();f.prepare({...f.props,epoch:2})
 f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.props.onPreviewFailed).not.toHaveBeenCalled()
 expect(f.rows.some(r=>r.failedCauseKnown!==undefined)).toBe(false)
})
test('captured cause survives subsequent diagnostic-map eviction without borrowing latest action',async()=>{
 const f=await failedCauseFixture()
 for(let i=2;i<=185;i++)f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(i+8)}},{...f.token,actionId:i})
 // Existing forced end row preserves the cause even if ordinary fallback is sampled out.
 f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.rows.find(r=>r.poseStage===5&&r.poseReason===5)).toMatchObject({failedCauseSequence:1,failedCauseActionId:1,observedCurrentSequence:185})
 expect(f.props.onPreviewFailed).toHaveBeenCalledOnce()
})
test('diagnostics disabled does not change recovery sequence or authored data',async()=>{
 const f=await failedCauseFixture(false);f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.props.onPreviewFailed).toHaveBeenCalledWith(expect.objectContaining({sequence:1}));expect(f.rows).toHaveLength(0);expect(JSON.stringify(f.doc)).toBe(f.authored)
})
test('throwing diagnostic sink cannot suppress existing failure recovery',async()=>{
 const f=await failedCauseFixture(true,()=>{throw Error('sink')});f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.props.onPreviewFailed).toHaveBeenCalledOnce();expect(JSON.stringify(f.doc)).toBe(f.authored)
})


test('failure cause survives the actual 32 emitted row cap through existing forced terminal',async()=>{
 let now=0;const f=await failedCauseFixture(true,undefined,()=>now)
 for(let i=2;i<=42;i++){now+=300;f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(i+8)}},{...f.token,actionId:i})}
 const gesture=f.rows.find(r=>r.poseStage===1)!.poseGesture
 const before=f.rows.filter(r=>r.poseGesture===gesture)
 expect(before).toHaveLength(32)
 f.failed.reject(Error('fixed controlled failure'));await f.flush()
 expect(f.rows.some(r=>r.poseStage===7&&r.poseReason===5)).toBe(false)
 const terminal=f.rows.find(r=>r.poseStage===5&&r.poseReason===5)
 expect(terminal).toMatchObject({failedCauseSequence:1,failedCauseActionId:1,observedCurrentSequence:42,causeRequestKnown:0})
 expect(terminal!.poseSuppressedCount).toBeGreaterThan(0)
 expect(f.props.onPreviewFailed).toHaveBeenCalledOnce()
})

test('successful capture followed by notification throw is phase4, not a GPU failure phase',async()=>{
 const f=await failedCauseFixture()
 f.props.onReady=vi.fn().mockImplementationOnce(()=>{throw Error('controlled notification failure')})
 f.failed.resolve({gpuTile:971,residentInteraction:true});await f.flush()
 expect(f.rows.find(r=>r.poseStage===5&&r.poseReason===5)).toMatchObject({failedCauseSequence:1,failedCausePhase:4,causeRequestKnown:0})
 expect(f.props.onPreviewFailed).toHaveBeenCalledOnce()
 expect(JSON.stringify(f.doc)).toBe(f.authored)
})

test('delayed recovery microtask keeps caught cause and does not borrow a rejected later action',async()=>{
 const f=await failedCauseFixture(),tasks:(()=>void)[]=[]
 const queued=vi.spyOn(globalThis,'queueMicrotask').mockImplementation(task=>tasks.push(task))
 try{
  f.failed.reject(Error('fixed controlled failure'));await f.flush()
  expect(tasks).toHaveLength(1);expect(f.props.onPreviewFailed).not.toHaveBeenCalled()
  // catch has already set error: existing control rejects this new input.
  expect(f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(12)}},{...f.token,actionId:2})).toBeNull()
  tasks.shift()!();await f.flush()
  expect(f.rows.find(r=>r.poseStage===5&&r.poseReason===5)).toMatchObject({failedCauseSequence:1,failedCauseActionId:1,observedCurrentSequence:1,failedCausePhase:2})
  expect(f.props.onPreviewFailed).toHaveBeenCalledOnce()
 }finally{queued.mockRestore()}
})

test('desktop captures keep the settled native camera and its exact fractional source lattice',()=>{
 vi.stubEnv('VITE_DESIGN_CANONICAL_CAPTURE','1')
 const doc=blank(),root=node('frame',0,0,1200,900),selected=node('rectangle',300,220,24,20)
 root.blend='normal';root.children=[selected.id];doc.nodes[root.id]=root;doc.nodes[selected.id]=selected;doc.pages[0].children=[root.id]
 const owner=new InteractionRenderer(vi.fn(),new KernelClient(),true);owners.push(owner)
 const view={x:-111.125,y:16.375,zoom:1.25},dpr=2
 owner.prepare({document:doc,selection:[selected.id],active:true,epoch:1,control:{current:null},onReady(){}},doc.pages[0].id,view,dpr,'figmaSubpixel','webgpu',undefined,{width:800,height:600})
 const options=worker.jobs.at(-1).options
 expect(options.view).toEqual({x:view.x*dpr,y:view.y*dpr,zoom:view.zoom*dpr})
 expect(options.captureViewport).toMatchObject({w:options.width,h:options.height})
 expect(Number.isInteger(options.captureViewport.x)).toBe(true);expect(Number.isInteger(options.captureViewport.y)).toBe(true)
 const w=options.interactionWindow,c=options.captureViewport
 expect(w.x).toBeGreaterThanOrEqual(c.x);expect(w.y).toBeGreaterThanOrEqual(c.y)
 expect(w.x+w.w).toBeLessThanOrEqual(c.x+c.w);expect(w.y+w.h).toBeLessThanOrEqual(c.y+c.h)
})


test('only an owner-valid capture-boundary rebase retains the old crop for bounded growth',async()=>{
 for(const expandCapture of [false,true]){
  const f=pendingRetainedFixture(true)
  worker.jobs.at(-1).resolve({gpuTile:995,residentInteraction:true});await f.flush()
  const resident=(f.owner as any).resident,crop={x:-30,y:-20,width:200,height:150}
  resident.captureBounds=crop
  f.owner.control.apply(f.doc,{[f.child.id]:{transform:f.transform(8)}})
  const render=vi.spyOn(f.owner as any,'renderLive').mockImplementation(()=>{})
  f.owner.acceptResidentSample({slot:995,sequence:1,at:0,needsRebase:true,expandCapture})
  expect(resident.captureBounds).toBe(expandCapture?crop:undefined)
  expect(render).toHaveBeenCalledOnce();render.mockRestore()
 }
})
