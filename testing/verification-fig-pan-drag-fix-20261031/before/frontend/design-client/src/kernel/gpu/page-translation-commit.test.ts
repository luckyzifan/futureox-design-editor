import {expect,test} from 'vitest'
import {blank,node} from '../../model'
import {documentPatch} from '../../document-patch'
import {pageTranslationCommit} from './page-translation-commit'
import {descriptorPresenter} from '../descriptor-presenter.test-helper'
import type {ResidentFrame} from './resident-presenter'
import {pixelSourceContract} from './page-background'
import {afterEach,vi} from 'vitest'
afterEach(()=>vi.unstubAllGlobals())

function docs(){
 const before=blank(),a=node('frame',0,0,10,10),b=node('frame',20,0,10,10),child=node('rectangle',0,0,5,5)
 a.children=[child.id];before.nodes={[a.id]:a,[b.id]:b,[child.id]:child};before.pages[0].children=[a.id,b.id]
 const next={...before,nodes:{...before.nodes,...Object.fromEntries([a,b].map(n=>[n.id,{...n,transform:[1,0,0,1,n.transform[4]+4,0] as typeof n.transform}]))}}
 return{before,next,a,b,child,page:before.pages[0].id}
}
test('native translation-only acceptance is mandatory and covers every visible root',()=>{
 const f=docs(),patch=documentPatch(f.before,f.next)
 expect(pageTranslationCommit(f.before,f.next,f.page,patch,{full:true,translationOnly:true})).toEqual({x:4,y:0})
 expect(pageTranslationCommit(f.before,f.next,f.page,patch,{full:true})).toBeUndefined()
 const partial={...f.next,nodes:{...f.next.nodes,[f.b.id]:f.b}}
 expect(pageTranslationCommit(f.before,partial,f.page,documentPatch(f.before,partial),{full:true,translationOnly:true})).toBeUndefined()
 const nested={...f.next,nodes:{...f.next.nodes,[f.child.id]:{...f.child,transform:[1,0,0,1,4,0] as typeof f.child.transform}}}
 expect(pageTranslationCommit(f.before,nested,f.page,documentPatch(f.before,nested),{full:true,translationOnly:true})).toBeUndefined()
 expect(pageTranslationCommit(f.before,f.next,f.page,{...patch,fields:{name:'changed'}},{full:true,translationOnly:true})).toBeUndefined()
 expect(pageTranslationCommit(f.before,{...f.next,id:'other'},f.page,patch,{full:true,translationOnly:true})).toBeUndefined()
})
function presented(){
 const f=descriptorPresenter(()=>{}),owner={},next={},contract='page/native/full',proof={owner,contract,view:{x:0,y:0,zoom:1},bounds:[[4,4,8,8]],pixel:[.5/16,.5/16] as [number,number]}
 const source=f.presenter.capture(16,16,proof)
 const frame:ResidentFrame={view:{x:0,y:0,zoom:1},width:16,height:16,dpr:1,interaction:true,allowBackground:true,
  backgroundTranslation:{x:4,y:0},input:{sequence:4,at:1,owner:'page'},items:[{active:true,layer:0,gutter:0,
   tile:{key:'source',serial:1,gpuTile:source.id,x:0,y:0,width:16,height:16,zoom:1},placement:{left:4,top:0,width:16,height:16}}]}
 f.presenter.draw(frame)
 return{...f,owner,next,frame,source,contract}
}
test('only accepted native pixels with private source ownership can adopt the newly validated document owner',()=>{
 const f=presented()
 const result=f.presenter.snapshotPageTranslation(f.owner,f.next,{x:4,y:0},16,16,1,f.contract)
 expect(result?.frame).toBe(f.frame)
 const captured=(f.presenter as any).textures.get(result!.gpuTile)
 expect(captured.background.owner).toBe(f.next)
 expect(captured.background.bounds).toEqual([[8,4,12,8]])
 expect(captured.background.view).toEqual({x:0,y:0,zoom:1})
})
test.each(['owner','contract','offset','size','density','placement','phase','tiny-source-phase','blend','new-frame'] as const)('translated snapshot refuses %s without allocating or acknowledging pixels',reason=>{
 const f=presented()
 let owner=f.owner,offset={x:4,y:0},width=16,scale=1
 if(reason==='owner')owner={}
 if(reason==='offset')offset={x:5,y:0}
 if(reason==='size')width=32
 if(reason==='density')scale=2
 if(reason==='placement')f.presenter.draw({...f.frame,items:[{...f.frame.items[0],placement:{left:5,top:0,width:16,height:16}}]})
 if(reason==='phase')f.presenter.draw({...f.frame,allowEmpty:true,allowBackground:false,backgroundTranslation:{x:.5,y:0},items:[{...f.frame.items[0],placement:{left:.5,top:0,width:16,height:16}}]})
 if(reason==='tiny-source-phase')f.presenter.draw({...f.frame,items:[{...f.frame.items[0],tile:{...f.frame.items[0].tile,phaseX:1e-9},placement:{left:4-1e-9,top:0,width:16,height:16}}]})
 if(reason==='blend')f.presenter.draw({...f.frame,allowEmpty:true,items:[{...f.frame.items[0],blend:true}]})
 if(reason==='new-frame')f.presenter.draw({...f.frame,interaction:false,backgroundTranslation:undefined,items:[{...f.frame.items[0],placement:undefined}]})
 const epoch=f.queue.epoch,bytes=f.presenter.residentBytes
 expect(f.presenter.snapshotPageTranslation(owner,f.next,offset,width,16,scale,reason==='contract'?'foreign-page/math':f.contract)).toBeUndefined()
 expect(f.queue.epoch).toBe(epoch);expect(f.presenter.residentBytes).toBe(bytes)
})

test('pixel contracts retain page, sampling and native policy while ignoring crop and transport',()=>{
 const a={pageId:'one',rasterProfile:'figmaSubpixel',transparent:false,interactiveEffects:false,view:{x:0,y:0,zoom:1},width:512,height:512}
 expect(pixelSourceContract({...a,view:{x:1,y:2,zoom:3},gpuViewport:{x:8,y:8,w:16,h:16},frameResources:{scope:'new'}})).toBe(pixelSourceContract(a))
 for(const patch of [{pageId:'two'},{rasterProfile:'figma'},{transparent:true},{interactiveEffects:true},{gpuPainterSupport:true}])
  expect(pixelSourceContract({...a,...patch})).not.toBe(pixelSourceContract(a))
})

test('interior tiles carry pixel ownership even when they have no background texel',()=>{
 const f=descriptorPresenter(()=>{}),owner={},next={},contract='page/native/full'
 const proof={owner,contract,view:{x:0,y:0,zoom:1},bounds:[[4,4,28,12]],pixel:[.5/16,.5/16] as [number,number]}
 const left=f.presenter.capture(16,16,proof),right=f.presenter.capture(16,16,undefined,{owner,contract})
 const draw=()=>f.presenter.draw({view:{x:0,y:0,zoom:1},width:32,height:16,dpr:1,interaction:true,allowEmpty:true,allowBackground:true,backgroundTranslation:{x:4,y:0},
  items:[left,right].map((tile,index)=>({active:true,layer:0,gutter:0,tile:{key:String(index),serial:1,gpuTile:tile.id,x:16*index,y:0,width:16,height:16,zoom:1},
    placement:{left:4+16*index,top:0,width:16,height:16}}))})
 draw();expect(f.presenter.snapshotPageTranslation(owner,next,{x:4,y:0},32,16,1,contract)).toBeDefined()
 const entry=(f.presenter as any).textures.get(right.id)
 for(const identity of [undefined,{owner:{},contract},{owner,contract:'different-math'}]){
  entry.content=identity;draw()
  expect(f.presenter.snapshotPageTranslation(owner,next,{x:4,y:0},32,16,1,contract)).toBeUndefined()
 }
})
