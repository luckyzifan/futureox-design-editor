import {expect,test} from 'vitest'
import {sourceOverviewWindow} from './source-overview-window'
import {visibleMaterialWindow} from '../source-material-scope'
import type {SourceCanvasItem} from '../desktop'

test('a clipped multi-material atlas retains integer device phase and amortizes small pans',()=>{
 const boxes=[{x:80,y:120,width:200,height:60},{x:310,y:120,width:150,height:80}]
 const v={x:.25,y:.5,zoom:1},w=sourceOverviewWindow(boxes,v,960,800,2)!
 expect(w.x).toBeLessThanOrEqual(48);expect(w.y).toBeLessThanOrEqual(88)
 expect(w.x+w.width).toBeGreaterThan(492);expect(w.y+w.height).toBeGreaterThan(232)
 expect(sourceOverviewWindow(boxes,{...v,x:v.x+12,y:v.y-9},960,800,2,w)).toBe(w)
 expect(sourceOverviewWindow(boxes,v,960,800,1.25)).toBeUndefined()
 expect(sourceOverviewWindow([{x:0,y:0,width:960,height:800}],v,960,800,2)).toBeUndefined()
})

test('only visible consumer bounds participate in a multi-material preview',()=>{
 const items=[{x:80,y:120,width:200,height:60},{x:310,y:120,width:150,height:80},{x:3000,y:2000,width:900,height:500}]
   .map(placed=>({placed})) as SourceCanvasItem[]
 const viewport={x:100,y:0,width:800,height:600}
 expect(visibleMaterialWindow(items,[0,1,2],viewport)).toEqual({x:100,y:88,width:392,height:144})
 expect(visibleMaterialWindow(items,[2],viewport)).toBeUndefined()
})
