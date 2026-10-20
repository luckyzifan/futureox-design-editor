import { test, expect } from 'vitest'
import { CoverageCache } from './coverage-cache'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'
const bytesLimit = 32 * 1024 * 1024, entries = 256
const texture = (bytes = 48 * 1024): Texture => ({ bytes, width: bytes / 16, height: 1, resource: {} as GPUTexture })
const bits = new Uint32Array()
test('two 100-field views stay reusable inside the unchanged byte limit', () => {
 const destroyed: Texture[] = []
 const renderer = new GpuRenderer({ scratchBytes: 0, destroy: (t: Texture) => { destroyed.push(t) } } as unknown as Driver)
 const c: CoverageCache = (renderer as unknown as { materialFields: CoverageCache }).materialFields
 const textures = Array.from({length: 200}, () => texture())
 c.begin(); for(let i=0;i<100;i++)expect(c.put(String(i),bits,textures[i])).toBe(true)
 c.begin(); for(let i=100;i<200;i++)expect(c.put(String(i),bits,textures[i])).toBe(true)
 c.begin(); for(let i=0;i<100;i++)expect(c.get(String(i),bits)).toBe(textures[i])
 c.begin(); for(let i=100;i<200;i++)expect(c.get(String(i),bits)).toBe(textures[i])
 expect(c.bytes).toBe(200*48*1024);expect(c.bytes).toBeLessThan(bytesLimit);expect(destroyed).toHaveLength(0)
 c.clear();expect(destroyed).toHaveLength(200);expect(new Set(destroyed).size).toBe(200);expect(c.bytes).toBe(0)
})
test('entry pressure evicts only old LRU entries, never current-frame fields',()=>{
 const destroyed:Texture[] = [],c=new CoverageCache(bytesLimit,entries,t=>destroyed.push(t))
 const textures=Array.from({length:257},()=>texture())
 c.begin();for(let i=0;i<256;i++)expect(c.put(String(i),bits,textures[i])).toBe(true)
 expect(c.put('overflow',bits,textures[256])).toBe(false);expect(destroyed).toHaveLength(0)
 c.begin();expect(c.get('0',bits)).toBe(textures[0]);expect(c.put('overflow',bits,textures[256])).toBe(true)
 expect(destroyed).toEqual([textures[1]]);expect(c.has(textures[0])).toBe(true)
})
test('256 entries do not enlarge the 32 MiB byte budget or destroy a live alias',()=>{
 const destroyed:Texture[]=[],c=new CoverageCache(bytesLimit,entries,t=>destroyed.push(t)),a=texture(20*1024*1024),b=texture(20*1024*1024)
 c.begin();expect(c.put('a',bits,a)).toBe(true);expect(c.put('b',bits,b)).toBe(false);expect(c.bytes).toBe(a.bytes)
 c.begin();expect(c.get('a',bits)).toBe(a);expect(c.put('alias',bits,a)).toBe(false);expect(c.put('b',bits,b)).toBe(false);expect(destroyed).toHaveLength(0)
 c.begin();expect(c.put('b',bits,b)).toBe(true);expect(destroyed).toEqual([a]);expect(c.bytes).toBe(b.bytes)
})
