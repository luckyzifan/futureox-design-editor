import {expect,test} from 'vitest'
import {sourceTileRetirement,rememberSourceTier,zoomOutRetentionCohort} from './source-tile-retirement'

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

test('nearby high zoom completions keep the wide return cohort within the same two history slots',()=>{
  const wide=new Set(['wide']),near=new Set(['near']),latest=new Set(['latest'])
  const history=new Map([[2.00000004,wide],[64.000001,near]])
  rememberSourceTier(history,64.000004,latest)
  expect([...history.values()]).toEqual([wide,latest]);expect(history.size).toBe(2)
  rememberSourceTier(history,2.00000038,near)
  expect([...history.values()]).toEqual([latest,near]);expect(history.size).toBe(2)
})

test('a 25% return keeps the coarse cohort that a scale>=2 gate drops',()=>{
  const page=new Set(['page']),crop=new Set(['crop'])
  const history=[[2,page],[64,crop]] as const
  expect(zoomOutRetentionCohort(history,0.5)).toBe(page)
  expect(zoomOutRetentionCohort(history,64)).toBe(page)
  expect(zoomOutRetentionCohort(history,2)).toBeUndefined()
  expect(zoomOutRetentionCohort(history,Number.NaN)).toBeUndefined()
  const tiles=[{key:'page',used:1},{key:'crop',used:50},{key:'live',used:9}]
  const dropped=sourceTileRetirement(tiles,[page,crop],false,zoomOutRetentionCohort(history,0.5))
    .filter(tile=>tile.key!=='live').slice(0,1)
  expect(dropped.map(tile=>tile.key)).toEqual(['crop'])
})

test('wide-cohort preference evicts old fine tiles before return pixels without growing capacity',()=>{
 const wide=Array.from({length:25},(_,i)=>({key:'wide'+i,used:i}))
 const fine=Array.from({length:16},(_,i)=>({key:'fine'+i,used:100+i}))
 const active=Array.from({length:3},(_,i)=>({key:'active'+i,used:200+i}))
 const coarse=new Set(wide.map(t=>t.key)),history=[coarse,new Set(fine.map(t=>t.key))]
 const dropped=sourceTileRetirement([...wide,...fine,...active],history,false,coarse)
   .filter(t=>!t.key.startsWith('active')).slice(0,12)
 expect(dropped.every(t=>t.key.startsWith('fine'))).toBe(true)
 expect(wide.length+fine.length+active.length-dropped.length).toBe(32)
})
