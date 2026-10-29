import {expect,test} from 'vitest'
import {SourceRenderWork} from './source-render-work'
const tiles=[{key:'a',zoom:1},{key:'b',zoom:1},{key:'c',zoom:1}]
test('cancel revokes delivery but does not release the physical slot',()=>{
 const queue=new SourceRenderWork<typeof tiles[number]>(),work=queue.begin(tiles)
 queue.demand(true,()=>true)
 expect(work.controller.signal.aborted).toBe(true);expect(queue.accepts(work,'a')).toBe(false)
 expect(()=>queue.begin(tiles)).toThrow('owner');queue.release(work)
 expect(queue.begin(tiles).sequence).toBe(2)
})
test('completed old tile does not revoke a useful remaining tile',()=>{
 const queue=new SourceRenderWork<typeof tiles[number]>(),work=queue.begin(tiles)
 queue.delivered(work,'a');queue.demand(false,tile=>tile.key==='b')
 expect(work.controller.signal.aborted).toBe(false);expect(queue.accepts(work,'a')).toBe(false)
 expect(queue.accepts(work,'b')).toBe(true)
})
test('source disposal and late old release cannot overwrite a new owner',()=>{
 const queue=new SourceRenderWork<typeof tiles[number]>(),old=queue.begin(tiles)
 queue.demand(true,()=>true);queue.release(old)
 const next=queue.begin(tiles);queue.release(old)
 expect(queue.current).toBe(next);expect(queue.accepts(old,'a')).toBe(false)
 queue.close();expect(next.controller.signal.aborted).toBe(true);queue.release(next)
 expect(()=>queue.begin(tiles)).toThrow('owner')
})
test('duplicates and expanded batch limits are rejected before dispatch',()=>{
 const queue=new SourceRenderWork<typeof tiles[number]>()
 expect(()=>queue.begin([tiles[0],tiles[0]])).toThrow('Duplicate')
 expect(()=>queue.begin(tiles,3)).toThrow('Invalid')
 expect(queue.begin(tiles).pending.size).toBe(2)
})
