import { expect, test } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/node_modules/vitest/dist/index.js'
import { DecodedImageCache } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/kernel/decoded-image-cache'
import { SceneImageHydration, managedSceneImageLoader } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/kernel/scene-image-hydration'
import { CanvasSceneSnapshots } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/canvas-scene-snapshots'
import { Editor } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/engine'
import { blank, node } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/model'
import { scene, SpatialIndex } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/geometry'
import { activateDocumentFonts, pickingGeometryEpoch } from '/workspace/shared/design-latest-20261019T1209/frontend/design-client/src/kernel/picking'

function compiled(count: number) {
  return { roots: Array.from({length:count},(_,i)=>String(i)), nodes: Object.fromEntries(Array.from({length:count},(_,i)=>[String(i), {
    id:String(i), children:[], matrix:[1,0,0,1,0,0], effects:[], strokes:[],
    fills:[{kind:'image',image:`data:image/png;base64,review-${i}`}]
  }])) } as any
}
const decoder = () => ({ image_info:()=> '[1,1]', image_info_at_level:()=> '[1,1]',
  image_rgba8:()=>new Uint8Array([11,12,13,255]), image_rgba8_at_level:()=>new Uint8Array([21,22,23,255]),
  image_linear:()=>new Float32Array([.1,.2,.3,1]), image_linear_at_level:()=>new Float32Array([.2,.3,.4,1]) })
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve} }

test('wrong-format records still debit optional returned-payload work and retain full-quality fallback', async () => {
  const cache=new DecodedImageCache(4096), kernel=decoder(), context={kernel,scope:'review',settings:'null'}
  let reads=0
  const persistence={key:async(uri:string)=>uri, read:async()=>{ reads++;return {width:4,height:4,data:new Float32Array(64)} },write() {}}
  const hydration=new SceneImageHydration(cache,context,persistence,()=>true,()=>true,{entries:1024,keyBytes:4096,readBytes:256})
  await hydration.hydrate(compiled(8))
  // Correct dimensions but wrong byte/linear format must not reset the read-work ledger.
  expect(reads).toBe(1)
  expect(cache.size).toBe(0)
  expect(managedSceneImageLoader(cache,()=>context,persistence)('data:image/png;base64,review-0',true).bytes).toEqual(new Uint8Array([11,12,13,255]))
})

test('queued canceled hydration neither starts another read nor touches a replacement owner cache', async () => {
  const cache=new DecodedImageCache(4096), gate=deferred<any>(), kernel=decoder()
  let owns=true,reads=0
  const persistence={key:async(uri:string)=>uri,read:async()=>{reads++;return gate.promise},write() {}}
  const hydration=new SceneImageHydration(cache,{kernel,scope:'old',settings:'null'},persistence,()=>owns)
  const first=hydration.hydrate(compiled(2)),second=hydration.hydrate(compiled(2))
  const settled=Promise.allSettled([first,second])
  for(let i=0;i<8;i++) await Promise.resolve()
  expect(reads).toBe(1)
  owns=false;cache.begin('new');const retained={width:1,height:1,data:new Uint8Array([1,2,3,255])};cache.set('new','new',retained)
  gate.resolve({width:1,height:1,data:new Uint8Array([4,5,6,255])})
  const results=await settled
  expect(results.map(r=>r.status)).toEqual(['rejected','rejected'])
  for(const result of results) expect(String((result as PromiseRejectedResult).reason)).toContain('PREVIEW_CANCELLED')
  expect(reads).toBe(1);expect(cache.get('new','new')).toBe(retained);expect(cache.size).toBe(1)
})

test('deferred persistence writes keep captured pixels/settings without changing later lane residency', async () => {
  const cache=new DecodedImageCache(4096), gate=deferred<string|undefined>(),writes:any[]=[],keys:any[]=[]
  let context={kernel:decoder(),scope:'A',settings:'A-settings'}
  const persistence={key:async(uri:string,variant:string,settings:string)=>{keys.push([uri,variant,settings]);return gate.promise},read:async()=>undefined,write:(key:string,image:any)=>writes.push({key,image})}
  const load=managedSceneImageLoader(cache,()=>context,persistence), borrowed=load('data:image/png;base64,A',true).bytes
  context={kernel:decoder(),scope:'B',settings:'B-settings'};cache.begin('B')
  const resident={width:1,height:1,data:new Uint8Array([41,42,43,255])};cache.set('B','owned',resident)
  gate.resolve('persistent-A');for(let i=0;i<8;i++)await Promise.resolve()
  expect(keys).toEqual([['data:image/png;base64,A','byte','A-settings']])
  expect(writes).toHaveLength(1);expect(writes[0].image.data).toBe(borrowed)
  expect(cache.get('B','owned')).toBe(resident);expect(cache.size).toBe(1)
})

test('independent editor sequences preserve ordered real geometry across every publication and query-result mutation', () => {
  const doc=blank('Independent scene review'),root=node('group',-5.125,3.75,1,1)
  const children=Array.from({length:25},(_,i)=>node(i%2?'rectangle':'ellipse',i*7.25,-i*2.5,4.125+i,8.75))
  root.children=children.map(n=>n.id);doc.pages[0].children=[root.id];doc.nodes=Object.fromEntries([root,...children].map(n=>[n.id,n]))
  const editor=new Editor(doc),store=new CanvasSceneSnapshots(),page=editor.state.page
  const assertSame=()=>{
    store.begin(editor,editor.sessionGeneration,page,true)
    const cached=store.currentScene(editor.state.doc,page),fresh=scene(editor.state.doc,page),reference=new SpatialIndex(fresh)
    expect(cached.entries).toEqual(fresh)
    const queries=[{x:-100,y:-100,width:1000,height:1000},{x:12.25,y:-4.5,width:1,height:1},{x:-1e30,y:-1e30,width:2e30,height:2e30}]
    const before=JSON.stringify(cached.entries)
    for(const q of queries) { expect(cached.index.query(q)).toEqual(reference.query(q));cached.index.query(q).splice(0,1000); }
    expect(JSON.stringify(cached.entries)).toBe(before)
    return cached
  }
  try {
    let previous=assertSame()
    for(let i=0;i<30;i++) {
      editor.set({view:{x:i,y:-i,zoom:1+i/100},hover:null});expect(assertSame()).toBe(previous)
      const n=children[i%children.length];editor.update([n.id],{transform:[1+i/32,.125,-.25,1,-i*3.5,i*2.25]})
      previous=assertSame();const old=store.displayedScene(editor.state.doc,page)
      editor.begin('Independent preview');editor.preview({[n.id]:{width:29+i,height:18+i}});assertSame()
      expect(store.displayedScene(old!.key.document,page)).toBe(old)
      editor.cancel();previous=assertSame();editor.undo();assertSame();editor.redo();previous=assertSame()
    }
    const beforeEpoch=pickingGeometryEpoch();activateDocumentFonts({...editor.state.doc,fonts:{}})
    expect(pickingGeometryEpoch()).not.toBe(beforeEpoch);expect(assertSame()).not.toBe(previous)
  } finally {editor.dispose()}
})
