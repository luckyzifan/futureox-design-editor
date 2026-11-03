import {expect,test} from 'vitest'
import type {OpeningView} from './source-opening-preview'
import {visibleMaterialDetail} from './source-opening-preview'

const items=Array.from({length:36},(_,i)=>{
  const rect={x:(i%6)*120,y:Math.floor(i/6)*120,width:100,height:80}
  return {key:'preview-'+i,id:'r'+i,name:'Material '+i,kind:'artboard',pageId:i<18?'A':'B',pageName:'Page',source:rect,placed:rect,bytes:9000}
})
const source:OpeningView={owner:{documentId:'a',sessionEpoch:1},bounds:{x:0,y:0,width:700,height:680},pages:[['A','A',18],['B','B',18]],items,
  images:new Map(items.map((_,i)=>[i,'rendered'])),finished:true,cacheHit:false,rendered:36}
test('a fit overview schedules no exact scene; a close view prepares only visible roots of its page',()=>{
  expect(visibleMaterialDetail(source,{x:20,y:10,zoom:0.8},800,600,2)).toEqual([])
  expect(visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'A',0)).toEqual([0])
  const selected=visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'A')
  expect(selected).toContain(0);expect(selected.length).toBeLessThan(18)
  expect(visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'B')).toEqual([])
})
test('an unavailable thumbnail can be repaired without preparing the other materials',()=>{
  const images=new Map(source.images);images.delete(3)
  expect(visibleMaterialDetail({...source,images},{x:20,y:10,zoom:0.8},800,600,2)).toEqual([3])
})
