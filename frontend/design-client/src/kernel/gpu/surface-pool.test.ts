import {expect,test} from 'vitest'
import {SurfacePool} from './surface-pool'

test('release order, acquire/release, touches and pins match the original full sort and exact byte sum',()=>{
  const pool=new SurfacePool<{id:number;bytes:number}>(),ages=new Map<object,number>()
  let age=0
  const release=(texture:{id:number;bytes:number})=>{
    const key=String(texture.id%13),list=pool.get(key)||[]
    list.push(texture);pool.added(texture);pool.setOwned(key,list)
    ages.set(texture,++age);pool.touched(texture,age)
  }
  const all=Array.from({length:3000},(_,id)=>({id,bytes:4*(id+1)}))
  for(const t of all)release(t)
  for(let i=0;i<300;i++){
    const key=String(i%13),t=pool.get(key)!.pop()!;pool.removed(t)
    if(i%2)release(t)
  }
  const pinned=new Map(all.filter(t=>t.id%17===0).map(t=>[t,1]))
  const control=[...pool.values()].flat().filter(t=>!pinned.has(t)).sort((a,b)=>ages.get(a)!-ages.get(b)!)
  const indexed=pool.capture(pinned)!
  expect(indexed.textures).toEqual(control)
  expect(indexed.bytes).toBe(control.reduce((sum,t)=>sum+t.bytes,0))
  for(const t of all)expect(indexed.has(t)).toBe(control.includes(t))
  const before=[...indexed.textures]
  const late={id:9001,bytes:16};release(late)
  expect(indexed.textures).toEqual(before)
  expect(indexed.textures).not.toContain(late)
})

test('snapshot ownership does not alter pool LIFO, pin counts or resource lifetime',()=>{
  const pool=new SurfacePool<{bytes:number}>(),a={bytes:16},b={bytes:32},list=[a,b]
  pool.added(a);pool.touched(a,1);pool.added(b);pool.touched(b,2);pool.setOwned('same',list)
  const pinned=new Map([[a,3]]),snapshot=pool.capture(pinned)!
  expect(snapshot.textures).toEqual([b]);expect(snapshot.bytes).toBe(32);expect(pinned.get(a)).toBe(3)
  expect(pool.get('same')!.pop()).toBe(b);pool.removed(b)
  expect(pool.capture(new Map())!.textures).toEqual([a])
  pool.removed(a);list.pop();pool.delete('same')
  expect(pool.capture(new Map())!.bytes).toBe(0)
})

test('unknown writes, duplicated ownership and invalid ages revoke the index without deleting Map storage',()=>{
  const a={bytes:16}
  for(const setup of [(p:SurfacePool<typeof a>)=>p.set('external',[a]),
    (p:SurfacePool<typeof a>)=>{p.added(a);p.added(a);p.setOwned('duplicate',[a,a])},
    (p:SurfacePool<typeof a>)=>{p.added(a);p.touched(a,NaN);p.setOwned('age',[a])}]){
    const pool=new SurfacePool<typeof a>();setup(pool)
    expect(pool.capture(new Map())).toBeUndefined();expect([...pool.values()].flat()).toContain(a)
  }
  const constructed=new SurfacePool([['seed',[a]]])
  expect(constructed.capture(new Map())).toBeUndefined();expect(constructed.get('seed')).toEqual([a])
  constructed.clear();expect(constructed.capture(new Map())!.bytes).toBe(0)
})

test('bounded maintenance freezes only the original LRU disposal cohort while counting all survivors',()=>{
  const pool=new SurfacePool<{bytes:number}>(),values=Array.from({length:10000},()=>({bytes:1024}))
  values.forEach((value,i)=>{pool.added(value);pool.touched(value,i+1)})
  pool.setOwned('same',values.slice())
  const pins=new Map([[values[1],2],[values[9999],1]])
  const whole=pool.capture(pins)!,batch=pool.capture(pins,{bytes:48*1024,resources:64})!
  expect(batch.textures).toEqual(whole.textures.slice(0,48))
  expect(batch.bytes).toBe(whole.bytes);expect(batch.count).toBe(9998)
  const saved=batch.textures.slice(),late={bytes:1024};pool.added(late);pool.touched(late,10001)
  expect(batch.textures).toEqual(saved);expect(batch.textures).not.toContain(late)
  expect(pins.get(values[1])).toBe(2)
})
