import {expect,test} from 'vitest'
import {sourceTileRetirement} from './source-tile-retirement'

test('lower-density motion keeps a complete 25-tile return view inside the same 32 slots',()=>{
  const group=(prefix:string,count:number,time:number)=>Array.from({length:count},(_,i)=>({key:prefix+i,used:time+i}))
  const last=group('last',25,0),older=group('older',16,100),active=group('moving',3,200)
  const history=[new Set(older.map(t=>t.key)),new Set(last.map(t=>t.key))]
  const cache=[...older,...last,...active],protectedKeys=new Set(active.map(t=>t.key))
  const trim=(prefer:boolean)=>new Set(sourceTileRetirement(cache,history,prefer)
    .filter(t=>!protectedKeys.has(t.key)).slice(0,cache.length-32).map(t=>t.key))
  expect(last.some(t=>trim(false).has(t.key))).toBe(true)
  const dropped=trim(true);expect(cache.length-dropped.size).toBe(32)
  expect(last.every(t=>!dropped.has(t.key))).toBe(true)
  expect([...dropped]).toEqual(older.slice(0,12).map(t=>t.key))
})
