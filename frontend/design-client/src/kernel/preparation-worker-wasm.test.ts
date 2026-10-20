import { afterEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PreparationChannel } from './preparation-channel'
vi.mock('./kernel-resources', () => ({ loadKernelResources: async () => {
  const { default: init } = await import('../generated/design-kernel/design_kernel')
  await init({module_or_path: new Uint8Array(await readFile(new URL('../generated/design-kernel/design_kernel_bg.wasm', import.meta.url)))})
  return new Uint8Array(await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)))
} }))
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals() })
async function setup() {
  vi.resetModules(); const scope: any = {}; vi.stubGlobal('self', scope)
  await import('./preparation-worker')
  const pair = new MessageChannel(), client = new PreparationChannel(pair.port1)
  scope.onmessage({data:{port:pair.port2}})
  cleanups.push(() => { client.close(); pair.port2.close() })
  return client
}
const document = () => ({ schemaVersion:1,id:'d',name:'d',pages:[{id:'p',name:'p',children:['r'],background:'#ffffff'}],
  nodes:{r:{id:'r',kind:'rectangle',width:16,height:16,transform:[1,0,0,1,8,8],fills:[{kind:'solid',color:'#ff0000'}]}},
  unknownAuthoredExtension:{retained:true} })
const options = JSON.stringify({pageId:'p',width:32,height:32,view:{x:0,y:0,zoom:1},rasterProfile:'analytic'})
test('real WASM empty derivation matches fresh packet and PNG after source replacement; failure preserves target', async () => {
  const client = await setup(), json = JSON.stringify(document())
  const loaded = await client.request('canvas','load_document',[json])
  const request = {operationId:1,baseReceipt:loaded.stateReceipt,target:'interaction',expectedTarget:null,delta:[]}
  const derived = await client.request('interaction','derive_document_v1',[request])
  expect(derived.documentFork).toBe(true)
  const packet = (await client.request('interaction','compile_gpu_packet',[options])).value
  const pixels = (await client.request('interaction','render_png',[options])).value
  const replacement = document(); replacement.nodes.r.fills[0].color = '#0000ff'
  await client.request('canvas','load_document',[JSON.stringify(replacement)])
  await expect(client.request('interaction','derive_document_v1',[{...request,operationId:2,expectedTarget:derived.stateReceipt}])).rejects.toThrow('STALE_BASE')
  expect((await client.request('interaction','render_png',[options])).value).toEqual(pixels)
  await client.request('interaction','load_document',[json])
  expect((await client.request('interaction','compile_gpu_packet',[options])).value).toEqual(packet)
  expect((await client.request('interaction','render_png',[options])).value).toEqual(pixels)
  const animated = {...document(),animations:[{id:'a',name:'a',pageId:'p',durationMs:100,tracks:[{nodeId:'r',keyframes:[{timeMs:0,value:{...document().nodes.r,opacity:1,radii:[0,0,0,0],smoothing:0,strokes:[],effects:[]}}]}]}]}
  const animation = await client.request('canvas','load_document',[JSON.stringify(animated)])
  const target = await client.request('interaction','load_document',[json])
  await expect(client.request('interaction','derive_document_v1',[{...request,operationId:3,baseReceipt:animation.stateReceipt,expectedTarget:target.stateReceipt}])).rejects.toThrow('UNSUPPORTED_STATE')
  expect((await client.request('interaction','render_png',[options])).value).toEqual(pixels)
})

test('real WASM owner, resource, retry, failed load and ABA receipts are fenced', async () => {
  const first = await setup(), json = JSON.stringify(document())
  const loaded = await first.request('canvas','load_document',[json])
  const request = {operationId:1,baseReceipt:loaded.stateReceipt,target:'interaction',expectedTarget:null,delta:[]}
  const second = await setup()
  await second.request('canvas','load_document',[json])
  await expect(second.request('interaction','derive_document_v1',[request])).rejects.toThrow('STALE_BASE')
  const target = await first.request('interaction','derive_document_v1',[request])
  await expect(first.request('interaction','derive_document_v1',[request])).rejects.toThrow('RETRY')
  const resources = await first.request('canvas','initialize',[true])
  await expect(first.request('interaction','derive_document_v1',[{...request,operationId:2,baseReceipt:resources.stateReceipt,expectedTarget:target.stateReceipt}])).rejects.toThrow('RESOURCE_POLICY')
  await expect(first.request('canvas','load_document',['invalid'])).rejects.toThrow()
  await expect(first.request('interaction','derive_document_v1',[{...request,operationId:3,baseReceipt:resources.stateReceipt,expectedTarget:target.stateReceipt}])).rejects.toThrow('STALE_BASE')
  await first.request('canvas','load_document',[json])
  await expect(first.request('interaction','derive_document_v1',[{...request,operationId:4,expectedTarget:target.stateReceipt}])).rejects.toThrow('STALE_BASE')
  const retained = (await first.request('interaction','render_png',[options])).value
  await first.request('interaction','load_document',[json])
  expect((await first.request('interaction','render_png',[options])).value).toEqual(retained)
})
