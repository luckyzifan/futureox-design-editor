import { expect, test } from 'vitest'
import { PageResidencyCache } from './page-residency-cache'
import { estimatedTileResidencyBytes as estimate } from './page-memory-policy'
test('union-estimated pressure remains satisfied after eviction of a shared inactive handle',()=>{
  const make=(gpuTile:number)=>({gpuTile,width:5,height:4,bytes:new Uint8Array()}) // 80 bytes per handle
  const active=make(1), shared=make(1), unique=make(2)
  const cache=new PageResidencyCache(192,8,()=>{},estimate)
  cache.store('shared',[shared],80); cache.store('unique',[unique],80)
  const totalBudget=128
  // Recompute the union after each actual victim is removed.
  cache.trim(cache.limit, inactive => estimate([active,...inactive]) > totalBudget)
  expect(estimate([active,...cache.values()])).toBeLessThanOrEqual(totalBudget)
})
