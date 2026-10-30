import {expect,test} from 'vitest'
import {blank} from '../model'
import {allowIncompletePanPreview} from './pan-preview'

function fixture(){
 const document=blank(),pageId=document.pages[0].id
 const frame={document,pageId,epoch:1,preview:true,view:{x:10,y:20,zoom:1},width:800,height:600,pixelRatio:2,managed:false,grid:false,computeBackend:'webgpu'} as const
 return {allowed:true,frame,document,revision:4,pageId,width:800,height:600,dpr:2,
  items:[{active:true,layer:1,tile:{key:'known',serial:1,gpuTile:1,x:0,y:0,width:256,height:256,zoom:2,document,revision:4}}] as any}
}
test('partial same-source pan may move known pixels and leave unknown strips pending',()=>{
 expect(allowIncompletePanPreview(fixture())).toBe(true)
 expect(allowIncompletePanPreview({...fixture(),items:[]})).toBe(true)
})
test('the actual completed current backing can retain unchanged older tiles without relabelling their source',()=>{
 const value=fixture();value.items[0].tile.document={...value.document};value.items[0].tile.revision=2
 expect(allowIncompletePanPreview(value)).toBe(false)
 const backing={document:value.document,revision:value.revision,pageId:value.pageId,epoch:1,residents:new Map([[value.items[0].tile.key,value.items[0].tile]])}
 expect(allowIncompletePanPreview({...value,backing})).toBe(true)
 expect(allowIncompletePanPreview({...value,backing:{...backing,epoch:2}})).toBe(false)
 expect(allowIncompletePanPreview({...value,backing:{...backing,document:{...value.document}}})).toBe(false)
 expect(allowIncompletePanPreview({...value,backing:{...backing,residents:new Map([[value.items[0].tile.key,{...value.items[0].tile}]])}})).toBe(false)
 expect(value.items[0].tile.revision).toBe(2)
})
test('a final frame or changed source/output never borrows the pan preview exception',()=>{
 for(const field of ['allowed','document','pageId','width','height','dpr'] as const){
  const value=fixture();(value as any)[field]=field==='allowed'?false:field==='document'?{...value.document}:field==='pageId'?'other':0
  expect(allowIncompletePanPreview(value)).toBe(false)
 }
 for(const field of ['preview','managed','grid','checkerboard','pixelPreview']){
  const value=fixture();value.frame={...value.frame,[field]:field==='preview'?false:true} as any
  expect(allowIncompletePanPreview(value)).toBe(false)
 }
 const value=fixture();value.items[0].tile.revision=3;expect(allowIncompletePanPreview(value)).toBe(false)
})
