import {expect,test} from 'vitest'
import {acceptFinishedMaterialScope,deferOverlappingMaterialScope,finishMaterialScopePublication,includesMaterials,materialScope,rememberedMaterialScope,rememberPublishedScope,type MaterialScopePublication} from './source-material-scope'
import type {SourceCanvasItem} from './desktop'
const items=Array.from({length:40},(_,i)=>({key:'p:'+i,pageId:i===4?'other':'p',bytes:i===3?9*1024**2:100,
 placed:{x:i===2?3000:i*10,y:0,width:8,height:8}})) as SourceCanvasItem[]
test('scenes cover subsets and retain only neighbouring roots on the requested page',()=>{
 const v={x:0,y:0,width:100,height:60},prior=items.slice(0,5).map(i=>i.key)
 expect(includesMaterials(prior,['p:1','p:3'])).toBe(true)
 expect(includesMaterials(prior,['p:7'])).toBe(false)
 expect(materialScope(items,[5],prior,v)).toEqual(['p:0','p:1','p:5'])
 expect(materialScope(items,[5],prior)).toEqual(['p:5'])
 expect(materialScope(items,[5],[],v)).toEqual(['p:5'])
})

test('an overlapping dense scope waits, and a covered or disjoint scope does not',()=>{
 const held=['a','b','c','d','e','f']
 expect(deferOverlappingMaterialScope({viewportDriven:true,held,wanted:['a','b','c','d','e','f','g','h']})).toBe(true)
 expect(deferOverlappingMaterialScope({viewportDriven:true,held,wanted:['a','z']})).toBe(true)
 expect(deferOverlappingMaterialScope({viewportDriven:true,held,wanted:['a','b']})).toBe(false)
 expect(deferOverlappingMaterialScope({viewportDriven:true,held,wanted:['x','y','z']})).toBe(false)
 expect(deferOverlappingMaterialScope({viewportDriven:false,held,wanted:['a','z']})).toBe(false)
 expect(deferOverlappingMaterialScope({viewportDriven:true,held:held.slice(0,5),wanted:['a','z']})).toBe(false)
 expect(deferOverlappingMaterialScope({viewportDriven:true,held,wanted:[]})).toBe(false)
})

test('a stale overlapping publish does not replace a presented scope that already covers the return',()=>{
 const finished=['a','b','c','d','e','f']
 const presented=['a','b']
 expect(acceptFinishedMaterialScope({generationCurrent:true,latestKeys:['a'],finishedKeys:finished,presentedKeys:presented})).toBe(true)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:['a','b'],finishedKeys:finished,presentedKeys:presented})).toBe(false)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:['a','z'],finishedKeys:finished,presentedKeys:presented})).toBe(false)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:['c'],finishedKeys:finished,presentedKeys:presented})).toBe(true)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:[],finishedKeys:finished,presentedKeys:presented})).toBe(false)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:['a',undefined],finishedKeys:finished,presentedKeys:presented})).toBe(false)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:['c'],finishedKeys:finished})).toBe(true)
 expect(acceptFinishedMaterialScope({generationCurrent:false,latestKeys:[],finishedKeys:finished})).toBe(false)
})

test('the post-await publication keeps displayed coverage after the host token moves',()=>{
 // Already-presented range A is token T1. A stale AB snapshot returns T2
 // after the latest need is A again. Writing the host token first and then
 // fencing the picture on that token drops the presented keys.
 const input={frameToken:'T2',generationCurrent:false,latestKeys:['a'],finishedKeys:['a','b']}
 const presented={token:'T1',materialKeys:['a']}
 const rejected:MaterialScopePublication={hostToken:'T1',displayedToken:'T1',presented}
 rejected.hostToken=input.frameToken
 const rejectedKeys=rejected.presented&&rejected.presented.token===rejected.hostToken&&!rejected.presented.viewportSubset?rejected.presented.materialKeys:undefined
 expect(acceptFinishedMaterialScope({...input,presentedKeys:rejectedKeys})).toBe(true)
 const state:MaterialScopePublication={hostToken:'T1',displayedToken:'T1',presented}
 expect(finishMaterialScopePublication(state,input)).toBe(false)
 expect(state.hostToken).toBe('T2')
 expect(state.displayedToken).toBe('T1')
})

test('displayed coverage ownership stays fenced after a publication is refused',()=>{
 const state:MaterialScopePublication={hostToken:'T1',displayedToken:'T1',presented:{token:'T1',materialKeys:['a']}}
 expect(finishMaterialScopePublication(state,{frameToken:'T2',generationCurrent:false,latestKeys:['z'],finishedKeys:['a','b']})).toBe(false)
 expect(state.hostToken).toBe('T2')
 expect(state.displayedToken).toBe('T1')
 const foreign:MaterialScopePublication={hostToken:'T0',displayedToken:undefined,presented:{token:'T-old',materialKeys:['a']}}
 expect(finishMaterialScopePublication(foreign,{frameToken:'T2',generationCurrent:false,latestKeys:['a'],finishedKeys:['a','b']})).toBe(true)
 expect(foreign.displayedToken).toBe('T2')
 const subset:MaterialScopePublication={hostToken:'T1',displayedToken:'T1',presented:{token:'T1',materialKeys:['a','b'],viewportSubset:true}}
 expect(finishMaterialScopePublication(subset,{frameToken:'T3',generationCurrent:false,latestKeys:['a'],finishedKeys:['a','b']})).toBe(true)
 expect(subset.displayedToken).toBe('T3')
 const current:MaterialScopePublication={hostToken:'T1',displayedToken:'T1',presented:{token:'T1',materialKeys:['a']}}
 expect(finishMaterialScopePublication(current,{frameToken:'T4',generationCurrent:true,latestKeys:['a'],finishedKeys:['a','b']})).toBe(true)
 expect(current.hostToken).toBe('T4')
 expect(current.displayedToken).toBe('T4')
})

test('a published scope is recalled immediately and a different revision is not',()=>{
 const remembered: {revision:number; keys:readonly string[]}[] = []
 rememberPublishedScope(remembered, 3, ['b','a'])
 rememberPublishedScope(remembered, 3, ['c'])
 expect(rememberedMaterialScope({revision:3, keys:['a','b'], remembered})).toBe(true)
 expect(rememberedMaterialScope({revision:3, keys:['c'], remembered})).toBe(true)
 expect(rememberedMaterialScope({revision:4, keys:['c'], remembered})).toBe(false)
 expect(rememberedMaterialScope({revision:3, keys:[], remembered})).toBe(false)
 rememberPublishedScope(remembered, 4, ['c'])
 expect(remembered.some(entry => entry.revision === 3)).toBe(false)
 expect(rememberedMaterialScope({revision:4, keys:['c'], remembered})).toBe(true)
})

test('requested roots keep their slots before previously prepared neighbours',()=>{
 const nearby=items.map(item=>({...item,pageId:'p',bytes:1024,placed:{x:0,y:0,width:8,height:8}}))
 const wanted=nearby.slice(32).map(item=>item.key)
 const scope=materialScope(nearby,nearby.slice(32).map((_,i)=>i+32),nearby.map(item=>item.key),{x:0,y:0,width:100,height:60})
 expect(scope).toHaveLength(32)
 expect(includesMaterials(scope,wanted)).toBe(true)
})

test('a dense new viewport starts with its zoom anchor and skips redundant provisional scopes',async()=>{
  const {firstVisibleMaterialKeys}=await import('./source-material-scope')
  const v={x:0,y:0,width:800,height:100}
  const data=Array.from({length:12},(_,i)=>({...items[0],key:String(i),bytes:2*1024**2,placed:{x:i*60,y:10,width:42,height:70}}))
  const wanted=data.map((_,i)=>i),keys=firstVisibleMaterialKeys(data,wanted,v,[],{x:18,y:40})
  expect(keys).toEqual(['0','1'])
  expect(firstVisibleMaterialKeys(data,wanted,v,keys,{x:18,y:40})).toBeUndefined()
  expect(firstVisibleMaterialKeys(data,[0,1,2],v,[])).toBeUndefined()
})
