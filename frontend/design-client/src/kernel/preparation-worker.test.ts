import { afterEach, expect, test, vi } from 'vitest'
import { PreparationChannel } from './preparation-channel'

const counts=vi.hoisted(()=>({engines:0,fonts:0,forks:0,loads:0}))
vi.mock('../generated/design-kernel/design_kernel',()=>({default:async()=>{},VectorEngine:class {
  doc=''; mips=false
  constructor(){counts.engines++}
  load_font(){counts.fonts++}
  set_image_mips(value:boolean){this.mips=value}
  color_settings(){return 'null'}
  load_document(value:string){counts.loads++;if(value==='invalid')throw Error('Invalid document');this.doc=value}
  apply_document_patch_with_damage(){this.doc='patched';return '{}'}
  fork_static_render_engine(){counts.forks++;const next=new (this.constructor as any)();next.doc=this.doc;next.mips=this.mips;return next}
  free(){}
}}))
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
