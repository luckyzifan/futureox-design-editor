import { afterEach, expect, test, vi } from 'vitest'
import { PreparationChannel } from './preparation-channel'
import { blank, node } from '../model'

const counts=vi.hoisted(()=>({engines:0,fonts:0,forks:0,loads:0}))
vi.mock('../generated/design-kernel/design_kernel',()=>({default:async()=>{},configure_document_capacity:()=>{},VectorEngine:class {
  doc=''; mips=false
  constructor(){counts.engines++}
  load_font(){counts.fonts++}
  set_image_mips(value:boolean){this.mips=value}
  bind_frame_scene_scope(_scope:string){}
  color_settings(){return 'null'}
  load_document(value:string){counts.loads++;if(value==='invalid')throw Error('Invalid document');this.doc=value}
  apply_document_patch_with_damage(){this.doc='patched';return '{}'}
  fork_static_render_engine(){counts.forks++;const next=new (this.constructor as any)();next.doc=this.doc;next.mips=this.mips;return next}
  free(){}
}}))
vi.mock('./module',()=>({initializeKernelModule:async()=>{}}))
vi.mock('./kernel-resources',()=>({loadKernelResources:async()=>new Uint8Array([1])}))
vi.mock('./cpu-frame',()=>({renderCpuFrame:vi.fn()}))
const cleanups:(()=>void)[]=[]
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.unstubAllGlobals()})
async function setup(){
  vi.resetModules();Object.assign(counts,{engines:0,fonts:0,forks:0,loads:0})
  const scope:any={};vi.stubGlobal('self',scope)
  await import('./preparation-worker')
  const pair=new MessageChannel(),client=new PreparationChannel(pair.port1)
  scope.onmessage({data:{port:pair.port2}})
  cleanups.push(()=>{client.close();pair.port2.close()})
  return client
}
test('a matching interaction starts from its canvas without loading the font twice',async()=>{
  const client=await setup(),doc='{"id":"document"}'
  await client.request('canvas','initialize',[false]);await client.request('canvas','load_document',[doc])
  await client.request('interaction','initialize',[false])
  expect(counts.engines).toBe(1);expect(counts.fonts).toBe(1)
  expect((await client.request('interaction','load_document',[doc])).documentFork).toBe(true)
  expect(counts).toEqual({engines:2,fonts:1,forks:1,loads:1})
  await client.request('canvas','apply_document_patch_with_damage',['{}'])
  expect((await client.request('interaction','load_document',[doc])).documentFork).toBe(false)
  expect(counts.loads).toBe(2)
})
test('different resource policy and a failed source load cannot certify a fork',async()=>{
  const client=await setup(),doc='{"id":"document"}'
  await client.request('canvas','initialize',[false]);await client.request('canvas','load_document',[doc])
  await client.request('interaction','initialize',[true])
  expect((await client.request('interaction','load_document',[doc])).documentFork).toBe(false)
  expect(counts.fonts).toBe(2)
  await client.request('interaction','initialize',[false])
  await expect(client.request('canvas','load_document',['invalid'])).rejects.toThrow('Invalid document')
  expect((await client.request('interaction','load_document',[doc])).documentFork).toBe(false)
  expect(counts.forks).toBe(0)
})

test('a successful canvas patch renews exact-source fork without another font/load', async () => {
  const client = await setup(), doc = blank(), rect = node('rectangle', 0, 0, 10, 10)
  doc.nodes[rect.id] = rect; doc.pages[0].children = [rect.id]
  await client.request('canvas', 'initialize', [false]); await client.request('canvas', 'load_document', [JSON.stringify(doc)])
  await client.request('interaction', 'initialize', [false])
  const moved = { ...rect, transform: [1, 0, 0, 1, 4, 0] }
  await client.request('canvas', 'apply_document_patch_with_damage', [JSON.stringify({nodes:{[rect.id]:moved},fields:{}})])
  const next = JSON.stringify({...doc,nodes:{...doc.nodes,[rect.id]:moved}})
  expect((await client.request('interaction', 'load_document', [next])).documentFork).toBe(true)
  expect(counts).toEqual({engines:2,fonts:1,forks:1,loads:1})
  expect((await client.request('interaction', 'load_document', [JSON.stringify(doc)])).documentFork).toBe(false)
})

test('explicit empty derive uses receipts without a full snapshot and rejects stale target/retry', async () => {
  const client = await setup()
  expect((await client.request('canvas', 'preparation_capabilities_v1')).value).toEqual({ protocol: 1, emptyDeltaDerivation: true, guardedPatchReceiptV1: true })
  const loaded = await client.request('canvas', 'load_document', ['{"id":"document"}'])
  const request = { operationId: 1, baseReceipt: loaded.stateReceipt, target: 'interaction', expectedTarget: null, delta: [] }
  const derived = await client.request('interaction', 'derive_document_v1', [request])
  expect(derived.documentFork).toBe(true); expect(derived.stateReceipt).toBeTruthy()
  expect(counts.loads).toBe(1)
  await expect(client.request('interaction', 'derive_document_v1', [request])).rejects.toThrow('RETRY')
  await expect(client.request('interaction', 'derive_document_v1', [{ ...request, operationId: 2 }])).rejects.toThrow('STALE_TARGET')
  const next = await client.request('interaction', 'derive_document_v1', [{ ...request, operationId: 3, expectedTarget: derived.stateReceipt }])
  expect(next.documentFork).toBe(true)
})

test('state receipts retire on reset, resource changes and failed mutations', async () => {
  const client = await setup()
  const loaded = await client.request('canvas', 'load_document', ['{"id":"document"}'])
  const request = { operationId: 1, baseReceipt: loaded.stateReceipt, target: 'interaction', expectedTarget: null, delta: [] }
  await client.request('canvas', 'load_document', ['{"id":"document"}'])
  await expect(client.request('interaction', 'derive_document_v1', [request])).rejects.toThrow('STALE_BASE')
  const changed = await client.request('canvas', 'initialize', [true])
  await expect(client.request('interaction', 'derive_document_v1', [{ ...request, operationId: 2, baseReceipt: changed.stateReceipt }])).rejects.toThrow('RESOURCE_POLICY')
  await expect(client.request('canvas', 'load_document', ['invalid'])).rejects.toThrow()
  await expect(client.request('interaction', 'derive_document_v1', [{ ...request, operationId: 3, baseReceipt: changed.stateReceipt }])).rejects.toThrow('STALE_BASE')
})
