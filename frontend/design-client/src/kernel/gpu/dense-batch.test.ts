import {expect,test} from 'vitest'
import {denseBatch} from './dense-batch'
import type {GpuNode} from './types'

const node=(x:number)=>({rect:{x,y:0,w:8,h:8}} as GpuNode)
test('a sparse batch preserves painter order, handles program zero and stops at a present ordinary painter',()=>{
  const ids=['a','missing','b','ordinary','c'],nodes={a:node(0),b:node(2),ordinary:node(3),c:node(4)}
  const pcs={a:9,b:0,c:12}
  expect(denseBatch(ids,0,nodes,pcs,16,true)).toEqual({starts:[9,0],write:{x:0,y:0,w:10,h:8},last:2})
  expect(denseBatch(ids,0,nodes,pcs,16,false).last).toBe(0)
  expect(denseBatch(ids,0,nodes,{...pcs,b:16},16,true).last).toBe(0)
})
test('a gap cannot create a large sparse rectangle, cross an optical prefix or scan unbounded missing IDs',()=>{
  const ids=['a','gap','b'],pcs={a:0,b:1}
  expect(denseBatch(ids,0,{a:node(0),b:node(1000)},pcs,2,true).starts).toEqual([0])
  expect(denseBatch(ids,0,{a:{...node(0),opticalPrefixNext:'b'},b:node(0)},pcs,2,true).last).toBe(0)
  expect(denseBatch(['a',...Array(96).fill('missing'),'b'],0,{a:node(0),b:node(0)},pcs,2,true).last).toBe(0)
})
