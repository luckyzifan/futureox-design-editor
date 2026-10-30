import {expect,test,vi} from 'vitest'
import {segmentedWitness,copyWitness,sameWitness} from './compilation-witness'
import {ExactTileCache} from './exact-tile-cache'

test('segmented proof compares every byte across boundaries and cache insertion snapshots ownership',()=>{
  const a=new Uint8Array([0,128]),b=new Uint8Array([255,1]),proof=segmentedWitness([a,b])
  expect(copyWitness(proof)).toEqual(new Uint8Array([0,128,255,1]))
  expect(sameWitness(new Uint8Array([0,128,255,1]),proof)).toBe(true)
  const cache=new ExactTileCache<string>(4096);cache.set('slot',proof,'pixels',4)
  a[0]=7;expect(cache.get('slot',segmentedWitness([new Uint8Array([0]),new Uint8Array([128,255,1])]))).toBe('pixels')
  expect(cache.get('slot',proof)).toBeUndefined()
})
test('an empty coordinate never materializes an expensive proof and a hit evaluates it once',()=>{
  const cache=new ExactTileCache<string>(4096),read=vi.fn(()=>new Uint8Array([1,2]))
  expect(cache.get('missing',read)).toBeUndefined();expect(read).not.toHaveBeenCalled()
  cache.set('present',new Uint8Array([1,2]),'pixels',4)
  expect(cache.get('present',read)).toBe('pixels');expect(read).toHaveBeenCalledOnce()
})
