import {expect,test} from 'vitest'
import {CoordinateRetirementSet} from './coordinate-retirement-set'
test('owned accounting matches filtering with overlapping pins and removals',()=>{
 const set=new CoordinateRetirementSet<{bytes:number}>(),a={bytes:12},b={bytes:20},c={bytes:30},foreign={bytes:100}
 set.addOwned(a).addOwned(b).addOwned(c).addOwned(a)
 const first=new Map([[a,1],[foreign,2]]),second=new Set([a,b])
 expect(set.summary(first,second)).toEqual({count:1,bytes:30})
 set.delete(b);expect(set.summary(first,second)).toEqual({count:1,bytes:30})
 set.delete(c);expect(set.summary(first,second)).toEqual({count:0,bytes:0})
})
test('unknown writes and invalid ownership use the unindexed fallback until clear',()=>{
 const set=new CoordinateRetirementSet<{bytes:number}>(),a={bytes:10}
 set.addOwned(a);set.add(a);expect(set.summary(new Set())).toBeUndefined()
 set.delete(a);set.addOwned({bytes:20});expect(set.summary(new Set())).toBeUndefined()
 set.clear();set.addOwned({bytes:20});expect(set.summary(new Set())).toEqual({count:1,bytes:20})
 set.addOwned({bytes:Infinity});expect(set.summary(new Set())).toBeUndefined()
})
test('summary does not enumerate thousands of stable resources',()=>{
 let reads=0;const set=new CoordinateRetirementSet<{bytes:number}>()
 for(let i=0;i<5000;i++)set.addOwned({get bytes(){reads++;return 16}})
 reads=0
 for(let i=0;i<100;i++)expect(set.summary(new Set())).toEqual({count:5000,bytes:80000})
 expect(reads).toBe(0)
 expect(set.size).toBe(5000)
})
