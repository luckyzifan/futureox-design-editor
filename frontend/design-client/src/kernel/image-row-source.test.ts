import {afterEach,expect,test,vi} from 'vitest'
const native=vi.hoisted(()=>({freed:0,reads:0,created:0,failures:0}))
vi.mock('./generated-row-decoder',()=>({ImageRowDecoder:class{
 row=0
 constructor(){native.created++;if(native.failures>0){native.failures--;throw 'Invalid image data'}} width(){return 2}height(){return 3}free(){native.freed++}
 next_rows(){native.reads++;return new Float32Array(this.row++<3?8:0)}
}}))
import {nativeImageRows,largePngRowCandidate}from './image-row-source'
import {managedSceneImageLoader}from './scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope}from './decoded-image-cache'
afterEach(async()=>{await Promise.resolve();native.freed=0;native.reads=0;native.created=0;native.failures=0})
test('canonical row input can retry one transient construction failure but never a malformed source or partial upload',()=>{
 native.failures=1
 const source=nativeImageRows('data:image/png;base64,AAAA','settings',()=>{})
 expect([...source.linearRows()]).toHaveLength(3);expect(native.created).toBe(2);expect(native.freed).toBe(1)
 native.failures=1;expect(()=>nativeImageRows('data:image/png;base64,invalid?','settings',()=>{})).toThrow('Invalid image data');expect(native.created).toBe(3)
 native.failures=2;expect(()=>nativeImageRows('data:image/png;base64,AAAA','settings',()=>{})).toThrow('Invalid image data');expect(native.created).toBe(5)
})
test('row recovery rechecks cancellation before constructing its second decoder',()=>{
 native.failures=1;let checks=0
 expect(()=>nativeImageRows('data:image/png;base64,AAAA','settings',()=>{if(++checks===2)throw Error('PREVIEW_CANCELLED')})).toThrow('PREVIEW_CANCELLED')
 expect(native.created).toBe(1);expect(native.freed).toBe(0)
})
test('dimension-only sources expire at the end of the synchronous upload turn',async()=>{
 const source=nativeImageRows('uri','settings',()=>{})
 expect([source.width,source.height]).toEqual([2,3]);expect(native.freed).toBe(0);expect(native.created).toBe(1);expect(native.reads).toBe(0)
 await Promise.resolve();expect(native.freed).toBe(1)
 expect(()=>source.linearRows().next()).toThrow("disposed")
})
test('abandoned upload frees the live row decoder',()=>{
 const source=nativeImageRows('uri','settings',()=>{}),iterator=source.linearRows()
 expect(iterator.next().value?.y).toBe(0);iterator.return()
 expect(native.freed).toBe(1);expect(native.created).toBe(1)
})
test('complete upload consumes one decoder and frees exactly once',()=>{
 const source=nativeImageRows('uri','settings',()=>{}),rows=[...source.linearRows()]
 expect(rows.map(row=>[row.y,row.height])).toEqual([[0,1],[1,1],[2,1]])
 expect(native.created).toBe(1);expect(native.freed).toBe(1);expect(native.reads).toBe(4)
 source.dispose();expect(native.freed).toBe(1)
 expect(()=>[...source.linearRows()]).toThrow('consumed')
})
test('disposing a paused iterator prevents another native read',()=>{
 const source=nativeImageRows('uri','settings',()=>{}),iterator=source.linearRows()
 iterator.next();source.dispose()
 expect(()=>iterator.next()).toThrow('disposed');expect(native.reads).toBe(1);expect(native.freed).toBe(1)
})
test('scope cancellation interrupts rows and frees its native decoder',()=>{
 let current=true;const source=nativeImageRows('uri','settings',()=>{if(!current)throw Error('PREVIEW_CANCELLED')})
 const iterator=source.linearRows();iterator.next();current=false
 expect(()=>iterator.next()).toThrow('PREVIEW_CANCELLED');expect(native.freed).toBe(1);expect(native.created).toBe(1)
})
test('non-PNG and malformed hints retain the normal decoder',()=>{
 expect(largePngRowCandidate('data:image/jpeg;base64,aaaa')).toBe(false)
 expect(largePngRowCandidate('data:image/png;base64,?')).toBe(false)
})
test('large dimensions and encoded payloads route to streaming without an admission ceiling',()=>{
 const header=(width:number,height:number)=>{const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);return 'data:image/png;base64,'+btoa(String.fromCharCode(...bytes))}
 expect(largePngRowCandidate(header(17,8193))).toBe(true)
 expect(largePngRowCandidate(header(4097,4096))).toBe(true)
 expect(largePngRowCandidate(header(2,3)+'A'.repeat(12*1024*1024))).toBe(true)
 expect(largePngRowCandidate(header(2,3))).toBe(false)
})
test.each(['budget','other','byte','mip'])('native cache %s uses only its eligible row fallback',kind=>{
 const owner=createDecodedImageOwner(),settings='{}',failure=kind==='other'?Error('Invalid ICC profile'):Error('Decoded image budget exceeded: 3840x2160 source pixels cannot fit without loss; automatic downsampling is disabled')
 const info=vi.fn(()=>{throw failure}),kernel:any={image_info:info,image_info_at_level:info}
 const load=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:decodedImageScope(owner,settings),settings,current:()=>true}),{key:async()=>undefined,read:async()=>undefined,write(){throw Error('Unexpected cache write')}})
 const run=()=>load('data:image/png;base64,fixture',kind==='byte',kind==='mip'?1:0)
 if(kind==='budget'){const source=run();expect(source.width).toBe(2);expect(source.pixels.length).toBe(0);source.dispose?.();expect(native.freed).toBe(1);expect(native.created).toBe(1)}
 else{expect(run).toThrow(failure);expect(native.freed).toBe(0)}
})

test('admission failure can dispose before iteration without creating a second decoder',()=>{
 const source=nativeImageRows('uri','settings',()=>{});source.dispose();source.dispose()
 expect(native.created).toBe(1);expect(native.freed).toBe(1);expect(native.reads).toBe(0)
 expect(()=>source.linearRows().next()).toThrow('disposed')
})
