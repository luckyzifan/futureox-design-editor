import {beforeAll,expect,test} from 'vitest'
import {initializeKernelModule} from './module'
import {SourceViewportPlanner} from './source-viewport-plan'
import {tilesCoverBounds} from './tile-cache'
beforeAll(()=>initializeKernelModule())
test('long diagonal travel resumes wide bands with complete, stable world coverage',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true,true)
 const width=855,height=888,zoom=32
 planner.plan({x:0,y:0,zoom},2,width,height,false)
 for(const sign of [-1,1]){
   const far={x:sign*8000,y:-sign*5000,zoom}
   const plan=planner.plan(far,2,width,height,false)
   expect(plan.tiles.length).toBeLessThanOrEqual(9)
   expect(tilesCoverBounds(plan.tiles,{x:-far.x/zoom,y:-far.y/zoom,width:width/zoom,height:height/zoom},2*zoom)).toBe(true)
   expect(planner.plan({...far,x:far.x+24},2,width,height,true).tiles.some(t=>plan.keys.has(t.key))).toBe(true)
 }
})
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

test('a presented fractional lattice survives large pure pans without a new density rung',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true),view={x:.25,y:.375,zoom:.404}
 const base=planner.plan(view,2,800,600,false)
 planner.presented(view,2,800,600)
 for(const [dx,dy] of [[64,0],[512,0],[0,512],[-512,0],[0,-512]]){
  const next={...view,x:view.x+dx,y:view.y+dy}
  // The surface also probes the settled demand on every input. That probe
  // has no authority to replace the last actually presented lattice.
  planner.plan(next,2,800,600,false)
  const moving=planner.plan(next,2,800,600,true)
  expect(moving.raster).toEqual(base.raster)
  expect(moving.exact).toBe(true)
  const shared=moving.tiles.filter(t=>base.tiles.some(u=>u.x===t.x&&u.y===t.y))
  expect(shared.length).toBeGreaterThan(0)
  expect(shared.every(t=>base.keys.has(t.key))).toBe(true)
 }
 const fractional={...view,x:view.x+64.125}
 expect(planner.plan(fractional,2,800,600,true).exact).toBe(false)
 const settled=planner.plan(fractional,2,800,600,false)
 expect(settled.exact).toBe(true);expect(settled.raster.phase).not.toEqual(base.raster.phase)
 planner.presented(fractional,2,800,600)
 expect(planner.plan(fractional,2,800,600,true).raster).toEqual(settled.raster)
 expect(planner.plan({...view,zoom:1.5},2,800,600,true).raster.scale).toBeGreaterThanOrEqual(3)
 expect(planner.plan(view,3,800,600,true).raster.scale).toBeGreaterThanOrEqual(view.zoom*3)
})

test('a retained native lattice does not suppress screen-anchored byte dithering',()=>{
 const planner=new SourceViewportPlanner('figma',false),view={x:.25,y:.375,zoom:1}
 const base=planner.plan(view,1,800,600,false);planner.presented(view,1,800,600)
 const moving=planner.plan({...view,x:1.25},1,800,600,true)
 expect(moving.raster.camera).not.toEqual(base.raster.camera)
 expect(moving.exact).toBe(false)
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

test('low zoom only lowers the moving density while shrinking and recovers on reversal',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true)
 const view=(zoom:number)=>({x:200,y:150,zoom})
 planner.plan(view(.5),2,800,600,false)
 const out=planner.plan(view(.2),2,800,600,true)
 expect(out.raster.scale).toBeLessThan(.4);expect(out.exact).toBe(false)
 expect(planner.plan(view(.2),2,800,600,false).raster.scale).toBe(.4)
 planner.plan(view(.1),2,800,600,true)
 expect(planner.plan(view(.2),2,800,600,true).raster.scale).toBeGreaterThanOrEqual(.4)
 expect(planner.plan(view(.2),2,800,600,false,.1).exact).toBe(false)
})

test('far source coordinates are rebased without changing the world lattice or fractional phase',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true),view={x:-1253000,y:-1693200,zoom:32}
 const plan=planner.plan(view,2,850,888,false)
 expect(plan.exact).toBe(true)
 expect(plan.tiles.every(t=>Math.abs(t.x+plan.raster.camera.x)<200000&&Math.abs(t.y+plan.raster.camera.y)<200000)).toBe(true)
 expect(plan.tiles.some(t=>Math.abs(t.x)>1000000)).toBe(true)
 expect(plan.raster.phase).toEqual({x:0,y:0})
})

test('a continuous zoom retains its current lattice until visible detail advances',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true)
 const view=(zoom:number)=>({x:0,y:0,zoom})
 planner.plan(view(.25),2,800,600,false);planner.presented(view(.25),2,800,600)
 const first=planner.plan(view(.45),2,800,600,true,undefined,true)
 const waiting=planner.plan(view(.56),2,800,600,true,undefined,true)
 expect(waiting.raster.scale).toBe(first.raster.scale)
 expect(planner.presentedDetail(waiting.raster.scale)).toBe(true)
 expect(planner.plan(view(.58),2,800,600,true,undefined,true).raster.scale).toBeGreaterThan(waiting.raster.scale)
 expect(planner.plan(view(.58),2,800,600,false).exact).toBe(true)
})

test('an incomplete native material handoff retries a complete same-density lattice once',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true,true),view={x:-1670.375,y:-3287.125,zoom:32}
 const band=planner.plan(view,2,855,888,false)
 expect(band.exact).toBe(true);expect(band.tiles).toHaveLength(4)
 expect(band.tiles.every(t=>t.width<=962&&t.height<=962)).toBe(true)
 expect(planner.retryNativeCoverage(view,2,855,888)).toBe(true)
 const repair=planner.plan(view,2,855,888,false)
 expect(repair.raster).toEqual(band.raster)
 expect(repair.tiles.every(t=>t.width===514&&t.height===514)).toBe(true)
 expect(planner.retryNativeCoverage(view,2,855,888)).toBe(false)
 const next=planner.plan({...view,x:view.x+64},2,855,888,false)
 expect(next.tiles.some(t=>t.width>514)).toBe(true)
})

test('a high-density material pan reuses its accepted bands through drag, settle and return',()=>{
 const planner=new SourceViewportPlanner('figmaSubpixel',true,true)
 const view={x:-132180.5,y:-632132,zoom:32},dpr=2,width=855,height=888
 const start=planner.plan(view,dpr,width,height,false)
 planner.presented(view,dpr,width,height)
 const next={...view,x:view.x+96},motion=planner.plan(next,dpr,width,height,true),settled=planner.plan(next,dpr,width,height,false)
 expect(motion.exact).toBe(true)
 expect(motion.keys).toEqual(settled.keys)
 expect(start.tiles.every(t=>settled.keys.has(t.key))).toBe(true)
 const incoming=settled.tiles.filter(t=>!start.keys.has(t.key))
 expect(incoming.length).toBeGreaterThan(0)
 expect(incoming.every(t=>t.width<=258)).toBe(true)
 planner.presented(next,dpr,width,height)
 expect(planner.plan(view,dpr,width,height,true).keys).toEqual(start.keys)
 const fractional={...view,x:view.x+.25}
 expect(planner.plan(fractional,dpr,width,height,true).exact).toBe(false)
 expect(planner.plan(fractional,dpr,width,height,false).keys).not.toEqual(start.keys)
})

test('an overview narrows the existing global tiles and restores the full set if physical coverage is declined',()=>{
 const v={x:-1290.7641421142123,y:319.62935841138074,zoom:.20763036280235658}
 const requested=new SourceViewportPlanner('figmaSubpixel',true,true,true)
 const reference=new SourceViewportPlanner('figmaSubpixel',true,true)
 const all=reference.plan(v,2,855,888,false)
 const window={x:0,y:256,width:855,height:288}
 const local=requested.plan(v,2,855,888,false,undefined,false,window)
 expect(local.raster).toEqual(all.raster);expect(local.tiles.length).toBeLessThan(all.tiles.length)
 expect(local.tiles.every(t=>all.tiles.some(original=>original.key===t.key&&original.width===t.width&&original.height===t.height))).toBe(true)
 expect(requested.retryNativeCoverage(v,2,855,888)).toBe(true)
 const retry=requested.plan(v,2,855,888,false,undefined,false,window)
 expect(retry.tiles).toEqual(all.tiles)
})
