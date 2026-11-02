import {expect,test} from 'vitest'
import {ResidentPoseReuse} from './resident-pose-reuse'
import type {Matrix} from '../model'
const input=()=>({scene:{},driver:{},texture:{},window:{x:-3.5,y:4.25,w:100,h:80},transforms:{a:[1,0,0,1,12.125,4.5] as Matrix}})
test('only a successful captured texture can certify a repeated exact pose',()=>{
 const cache=new ResidentPoseReuse(),a=input();expect(cache.matches(a)).toBe(false);cache.record(a)
 expect(cache.matches({...a,transforms:{a:[...a.transforms.a]}})).toBe(true)
 const changes:Parameters<ResidentPoseReuse['matches']>[0][]=[{...a,scene:{}},{...a,driver:{}},{...a,texture:{}},{...a,texture:undefined},
  {...a,window:{...a.window,x:a.window.x+.125}}, {...a,transforms:{a:[1,0,0,1,12.25,4.5] as Matrix}},
  {...a,transforms:{b:a.transforms.a}}, {...a,transforms:{a:a.transforms.a,b:a.transforms.a}}]
 for(const next of changes)expect(cache.matches(next)).toBe(false)
})
test('signed zeros, frozen inputs, malformed windows and replacement captures cannot borrow a receipt',()=>{
 const cache=new ResidentPoseReuse(),a=input();cache.record(a)
 a.transforms.a[4]=99;expect(cache.matches(a)).toBe(false)
 a.transforms.a[4]=12.125;a.transforms.a[1]=-0;expect(cache.matches(a)).toBe(false)
 const b=input();cache.record(b);expect(cache.matches(a)).toBe(false);expect(cache.matches(b)).toBe(true)
 cache.record({...b,window:{...b.window,x:NaN}});expect(cache.matches(b)).toBe(false)
 cache.record({...b,texture:undefined});expect(cache.matches(b)).toBe(false)
})

test('only newer same-owner release work may supersede a preparation; movement cannot starve raster',async()=>{
 const {terminalPoseDisposition,samePoseTransforms}=await import('./resident-pose-reuse')
 const a={slot:3,input:{owner:'owner',sequence:4},transforms:input().transforms}
 const b={...a,input:{owner:'owner',sequence:5},terminal:true}
 expect(terminalPoseDisposition(a,b)).toBe('same')
 expect(terminalPoseDisposition(a,{...b,transforms:{a:[1,0,0,1,17,9]}})).toBe('changed')
 for(const other of [{...b,terminal:false},{...b,slot:4},{...b,input:{owner:'foreign',sequence:5}},{...b,input:{owner:'owner',sequence:3}}])
  expect(terminalPoseDisposition(a,other)).toBe('none')
 expect(samePoseTransforms({a:new Array(6) as Matrix},a.transforms)).toBe(false)
})
