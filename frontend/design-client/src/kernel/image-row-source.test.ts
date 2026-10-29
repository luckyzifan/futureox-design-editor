import {afterEach,expect,test,vi} from 'vitest'
const native=vi.hoisted(()=>({freed:0,reads:0}))
vi.mock('./generated-row-decoder',()=>({ImageRowDecoder:class{
 width(){return 2}height(){return 3}free(){native.freed++}
 next_rows(){native.reads++;return new Float32Array(8)}
}}))
import {nativeImageRows,largePngRowCandidate}from './image-row-source'
import {managedSceneImageLoader}from './scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope}from './decoded-image-cache'
afterEach(()=>{native.freed=0;native.reads=0})
test('dimension-only reads do not hold an unconsumed native decoder',()=>{
 const source=nativeImageRows('uri','settings',()=>{})
 expect([source.width,source.height]).toEqual([2,3]);expect(native.freed).toBe(1);expect(native.reads).toBe(0)
})
test('abandoned upload frees the live row decoder',()=>{
 const source=nativeImageRows('uri','settings',()=>{}),iterator=source.linearRows()
 expect(iterator.next().value?.y).toBe(0);iterator.return()
 expect(native.freed).toBe(2)
})
test('scope cancellation interrupts rows and frees its native decoder',()=>{
 let current=true;const source=nativeImageRows('uri','settings',()=>{if(!current)throw Error('PREVIEW_CANCELLED')})
 const iterator=source.linearRows();iterator.next();current=false
 expect(()=>iterator.next()).toThrow('PREVIEW_CANCELLED');expect(native.freed).toBe(2)
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
 if(kind==='budget'){const source=run();expect(source.width).toBe(2);expect(source.pixels.length).toBe(0);expect(native.freed).toBe(1)}
 else{expect(run).toThrow(failure);expect(native.freed).toBe(0)}
})
