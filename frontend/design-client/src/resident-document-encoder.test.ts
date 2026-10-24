import { expect,test } from 'vitest'
import { ResidentDocumentEncoder, type CodecDelta } from './resident-document-encoder'
import { blank,node } from './model'
import { applyDocumentPatch } from './document-patch'
// @ts-expect-error The actual desktop codec is an ESM host module.
import { ResidentDocumentCodec } from '../../design-desktop/src/resident-document-codec.mjs'

test('immutable snapshots use changed values and remain exact through undo and worker retirement',async()=>{
 let codec=new ResidentDocumentCodec(2**20);const sent:CodecDelta[]=[]
 const encoder=new ResidentDocumentEncoder(async request=>{sent.push(request);return codec.encode(request)})
 const before=blank(),shape=node('rectangle',0,0,20,30);before.nodes[shape.id]=shape;before.pages[0].children=[shape.id]
 before.fonts=[{id:'font',data:'x'.repeat(100000)}] as any
 const changed=applyDocumentPatch(before,{nodes:{[shape.id]:{...shape,width:80}},fields:{}})
 expect(await encoder.encode(before)).toBe(JSON.stringify(before))
 expect(await encoder.encode(changed)).toBe(JSON.stringify(changed))
 expect(JSON.stringify(sent[1]).length).toBeLessThan(3000)
 expect(sent[1].fields).toEqual([])
 expect(await encoder.encode(before)).toBe(JSON.stringify(before))
 codec=new ResidentDocumentCodec(2**20)
 expect(await encoder.encode(changed)).toBe(JSON.stringify(changed))
 expect(sent.at(-1)?.install).toBe(true)
})
test('queued edits own their snapshots and bad receipts cannot advance the base',async()=>{
 const codec=new ResidentDocumentCodec(2**20),a=blank(),b={...a,name:'next'},sent:CodecDelta[]=[]
 let resolve!:()=>void;const gate=new Promise<void>(done=>{resolve=done})
 const encoder=new ResidentDocumentEncoder(async request=>{sent.push(request);if(sent.length===1)await gate;return codec.encode(request)})
 const first=encoder.encode(a),second=encoder.encode(b);await Promise.resolve();expect(sent).toHaveLength(1);resolve()
 expect(await first).toBe(JSON.stringify(a));expect(await second).toBe(JSON.stringify(b));expect(sent[1].base).toBe(sent[0].sequence)
 const invalid=new ResidentDocumentEncoder(async request=>({...codec.encode({...request,install:true,base:0}),sequence:99}))
 await expect(invalid.encode(a)).rejects.toThrow('receipt')
})
test('certified import bytes seed the first changed save without cloning cold nodes',async()=>{
 let codec=new ResidentDocumentCodec(2**20);const sent:CodecDelta[]=[]
 const before=blank(),shape=node('rectangle',0,0,20,30),cold=node('rectangle',40,0,20,30)
 before.nodes[shape.id]=shape;before.nodes[cold.id]=cold;before.pages[0].children=[shape.id,cold.id]
 const json=JSON.stringify(before),encoder=new ResidentDocumentEncoder(async request=>{sent.push(request);return codec.encode(request)},{document:before,json})
 expect(await encoder.encode(before)).toBe(json);expect(sent).toHaveLength(0)
 const changed=applyDocumentPatch(before,{nodes:{[shape.id]:{...shape,opacity:.75}},fields:{}})
 expect(await encoder.encode(changed)).toBe(JSON.stringify(changed))
 expect(sent[0].installJson).toBe(json);expect(sent[0].nodes.map(([id])=>id)).toEqual([shape.id]);expect(sent[0].fields).toEqual([])
 expect(await encoder.encode(before)).toBe(json);expect(sent[1].installJson).toBeUndefined()
 codec=new ResidentDocumentCodec(2**20)
 expect(await encoder.encode(changed)).toBe(JSON.stringify(changed));expect(sent.at(-1)?.install).toBe(true)
 const other={...before,id:crypto.randomUUID()};expect(await encoder.encode(other)).toBe(JSON.stringify(other))
})
