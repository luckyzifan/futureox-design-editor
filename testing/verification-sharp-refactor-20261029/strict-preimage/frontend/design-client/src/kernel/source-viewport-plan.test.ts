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
