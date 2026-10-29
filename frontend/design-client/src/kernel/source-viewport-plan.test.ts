import {beforeAll,expect,test} from 'vitest'
import {initializeKernelModule} from './module'
import {SourceViewportPlanner} from './source-viewport-plan'
beforeAll(()=>initializeKernelModule())
test('unchanged demand reuses addressing while DPR, phase and scale changes get independent plans',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true),view={x:.25,y:.375,zoom:1.25}
 const settled=planner.plan(view,2,800,600,false)
 expect(settled.exact).toBe(true)
 expect(planner.plan({...view},2,800,600,false)).toBe(settled)
 const moving=planner.plan(view,2,800,600,true)
 expect(moving).not.toBe(settled)
 expect(planner.plan(view,2,800,600,false)).toBe(settled)
 expect(planner.plan(view,2,800,600,true)).toBe(moving)
 const resized=planner.plan(view,2,801,600,false)
 expect(resized).not.toBe(settled);expect(resized.exact).toBe(true)
 const high=planner.plan(view,3,800,600,false)
 expect(high.raster.scale).toBe(3.75);expect(high.exact).toBe(true)
 expect(high.tiles[0].key).not.toBe(settled.tiles[0].key)
})
test('source planners share no mutable demand ownership',()=>{
 const a=new SourceViewportPlanner('figmaSubpixel',true),b=new SourceViewportPlanner('figmaSubpixel',true)
 const view={x:0,y:0,zoom:4},first=a.plan(view,2,800,600,false),second=b.plan(view,2,800,600,false)
 expect(first).not.toBe(second);expect(first.tiles).toEqual(second.tiles)
 view.x=100
 expect(a.plan(view,2,800,600,false)).not.toBe(first)
 expect(b.plan({x:0,y:0,zoom:4},2,800,600,false)).toBe(second)
})

test('2% through 25600% retain native DPR without a 128x tile rejection',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true)
 for(const zoom of [.02,32,64,128,256])for(const dpr of [1,2,3,4]){
  const view={x:420.25-10432*zoom,y:300.375-6112*zoom,zoom}
  const plan=planner.plan(view,dpr,800,600,false)
  expect(plan.raster.scale).toBe(zoom*dpr);expect(plan.exact).toBe(true)
  expect(plan.tiles.length).toBeGreaterThan(0)
  expect(plan.tiles.every(t=>Number.isFinite(t.zoom)&&t.zoom>=.001&&t.zoom<=4096&&t.width<=514&&t.height<=514)).toBe(true)
 }
})

test('idle source demand warms adjacent columns within its separate byte/count allowance',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true),p=planner.plan({x:0,y:0,zoom:1},1,800,600,false)
 expect(p.prefetch.length).toBeGreaterThan(0);expect(p.prefetch.length).toBeLessThanOrEqual(8)
 expect(p.prefetch.reduce((n,t)=>n+t.width*t.height*4,0)).toBeLessThanOrEqual(8*514*514*4)
 expect(p.prefetch.every(t=>t.prefetch&&!p.keys.has(t.key))).toBe(true)
 expect(p.prefetch.some(t=>t.x<0)).toBe(true);expect(p.prefetch.some(t=>t.x>=1023)).toBe(true)
 const next=planner.plan({x:-512,y:0,zoom:1},1,800,600,false)
 const before=new Set([...p.tiles,...p.prefetch].map(t=>t.key))
 expect(next.tiles.every(t=>before.has(t.key))).toBe(true)
 expect(next.prefetch.every(t=>t.x>=1535)).toBe(true)
 const reverse=planner.plan({x:0,y:0,zoom:1},1,800,600,true)
 expect(reverse.prefetch.every(t=>t.x<0)).toBe(true)
})

test('fractional unmanaged cameras reuse only equivalent complete dither periods',()=>{
 const planner=new SourceViewportPlanner('figma',false)
 const a=planner.plan({x:.25,y:.375,zoom:1},1,800,600,false)
 const b=planner.plan({x:512.25,y:.375,zoom:1},1,800,600,false)
 const shared=a.tiles.filter(t=>b.tiles.some(u=>u.x===t.x&&u.y===t.y))
 expect(shared.length).toBeGreaterThan(0)
 for(const tile of shared)expect(b.tiles.find(t=>t.x===tile.x&&t.y===tile.y)?.key).toBe(tile.key)
 expect(b.raster.camera.x).toBe(512.25) // rendering precision is not quantized
 const different=planner.plan({x:1.25,y:.375,zoom:1},1,800,600,false)
 expect(different.tiles.some(t=>a.keys.has(t.key))).toBe(false)
})

test('actual WASM byte-gradient pixels repeat at 512 device pixels while one-pixel dither shifts remain distinct',async()=>{
 const {VectorEngine}=await import('../generated/design-kernel/design_kernel')
 const {blank,node,paint}=await import('../model')
 const doc=blank('Camera period oracle'),n=node('rectangle',-1024,-64,4096,128)
 const gradient=paint('#000000','linear');gradient.stops=[{offset:0,color:'#323232'},{offset:1,color:'#b2b2b2'}];n.fills=[gradient]
 doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
 const engine=new VectorEngine()
 try {
  engine.load_document(JSON.stringify(doc))
  const render=(x:number)=>engine.render_rgba(JSON.stringify({pageId:doc.pages[0].id,width:1536,height:24,view:{x,y:.375,zoom:1},transparent:true,grid:false,rasterProfile:'figmaSoftware'}))
  const a=render(.25),period=render(512.25),different=render(1.25)
  let differences=0
  for(let y=0;y<24;y++)for(let x=16;x<512;x++)for(let c=0;c<4;c++){
   const i=(y*1536+x)*4+c
   expect(period[(y*1536+x+512)*4+c]).toBe(a[i])
   if(different[(y*1536+x+1)*4+c]!==a[i])differences++
  }
  expect(differences).toBeGreaterThan(0)
 } finally {engine.free()}
})
