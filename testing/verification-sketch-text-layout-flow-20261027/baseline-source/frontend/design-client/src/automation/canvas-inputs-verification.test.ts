import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Editor } from '../engine'
import { blank, node, paint, stroke, effect } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationResponse } from './types'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

type Json = Record<string, any>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture(document = blank('MCP live document'), scope: 'read' | 'write' = 'write') {
  const editor = new Editor(document)
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request), scope })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', id = 0
  const pending = new Map<number, (message: Json) => void>()
  output.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, newline)) as Json
      buffer = buffer.slice(newline + 1)
      const resolve = pending.get(response.id)
      pending.delete(response.id)
      if (resolve) resolve(response)
    }
  })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() })
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP request ${requestId} timed out`)) }, 20000)
    server.done.then(() => { if (pending.delete(requestId)) { clearTimeout(timer); reject(new Error('MCP connection closed before response')) } })
    pending.set(requestId, response => { clearTimeout(timer); resolve(response) })
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'real-editor-e2e', version: '1' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools as { name: string }[]
  const toolName = (method: string) => `design_${method.replaceAll('.', '_')}`
  const call = async (method: string, params: Json = {}, fences: Json = {}) => {
    expect(tools.some(tool => tool.name === toolName(method))).toBe(true)
    const response = await rpc('tools/call', { name: toolName(method), arguments: { params, ...fences } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    return response.result as Json
  }
  // Explicit file-saving client behavior; model-facing tools/call remains metadata-only.
  const materialize = async (value: Json) => {
    const result = { ...value.result }
    for (const ref of result.resources ?? []) {
      const response = await rpc('resources/read', { uri: ref.uri })
      expect(response.error).toBeUndefined()
      const content = response.result.contents[0]
      const data = ref.encoding === 'json' ? JSON.parse(content.text) : ref.encoding === 'base64' ? content.blob : ref.encoding === 'data-url' ? `data:${ref.mimeType};base64,${content.blob}` : content.text
      if (ref.field === '$metadata') Object.assign(result, data)
      else result[ref.field] = data
    }
    return { ...value, result } as AutomationResponse & { result: Json }
  }
  const read = async (method: string, params: Json = {}) => {
    const response = await call(method, params)
    expect(response.isError, response.structuredContent.ok ? undefined : JSON.stringify(response.structuredContent.error)).toBe(false)
    return materialize(response.structuredContent)
  }
  const mutate = async (method: string, params: Json = {}) => {
    const state = await read('document.get')
    return call(method, params, { documentId: state.documentId, session: state.session, expectedRevision: state.revision })
  }
  return { editor, api, rpc, call, read, mutate, tools, materialize }
}

const P = '20000000-0000-4000-8000-000000000001'
const F = '20000000-0000-4000-8000-000000000002'
const C = '20000000-0000-4000-8000-000000000003'
const T = '20000000-0000-4000-8000-000000000004'
const evidence: Json[] = []
const evidenceDir = join(process.env.FUTUREOX_TEST_RESULTS_DIR || 'test-results', 'canvas-inputs')
async function capture(label: string, value: any) { evidence.push({label,value}); await mkdir(evidenceDir,{recursive:true}); await writeFile(join(evidenceDir, 'results.json'), JSON.stringify(evidence,null,2)) }
describe('Independent canvas/input real MCP verification', () => {
 it('distinguishes pages from frames, counts, defaults, custom dimensions and parent-local transforms', async()=>{
  const f=await fixture(); const initial=await f.read('document.get');
  await capture('initial',initial)
  const create=await f.mutate('batch.apply',{operations:[
   {method:'page.create',params:{id:P,name:'Other page'}},
   {method:'node.create',params:{id:F,parentId:P,kind:'frame',width:400,height:300,x:100,y:200}},
   {method:'node.create',params:{id:C,parentId:F,kind:'rectangle',x:10,y:20}},
  ]}); expect(create.isError).toBe(false)
  const pages=await f.read('page.list'), count=await f.read('document.get'), child=await f.read('node.get',{id:C});
  expect(pages.result.pages).toHaveLength(2);expect(count.result.nodeCount).toBe(2)
  expect(child.result).toMatchObject({pageId:P,parentId:F,width:160,height:120,worldBounds:{x:110,y:220,width:160,height:120}})
  expect((await f.read('node.find',{kind:'frame'})).result.total).toBe(0)
  expect((await f.read('node.find',{kind:'frame',allPages:true})).result.total).toBe(1)
  await capture('pages-count-defaults-transform',{pages:pages.result,metadata:count.result,child:child.result})
  expect((await f.mutate('node.update',{ids:[F],patch:{width:640,height:480}})).isError).toBe(false)
  expect((await f.read('node.get',{id:F})).result.width).toBe(640)
 });
 it('selects only one page, navigates explicitly, and edits/moves across pages atomically', async()=>{
  const f=await fixture();const home=(await f.read('selection.get')).result.pageId
  expect((await f.mutate('batch.apply',{operations:[{method:'page.create',params:{id:P}},{method:'node.create',params:{id:F,parentId:P,kind:'frame',x:100,y:200}},{method:'node.create',params:{id:C,parentId:F,kind:'rectangle',x:10,y:20}}]})).isError).toBe(false)
  const invalid=await f.mutate('selection.set',{ids:[C]});expect(invalid.isError).toBe(true);expect(invalid.structuredContent.error.code).toBe('invalid_selection')
  expect((await f.mutate('selection.set',{ids:[C],pageId:P})).isError).toBe(false)
  expect((await f.read('selection.get')).result).toEqual({pageId:P,ids:[C]})
  expect((await f.mutate('page.setCurrent',{id:home})).isError).toBe(false)
  const before=f.editor.state.doc,version=f.editor.state.version
  const rollback=await f.mutate('batch.apply',{operations:[{method:'node.update',params:{ids:[C],patch:{width:90}}},{method:'node.create',params:{kind:'rectangle',width:-1}}]});expect(rollback.isError).toBe(true);expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(version)
  expect((await f.mutate('node.move',{ids:[C],parentId:home})).isError).toBe(false)
  const moved=await f.read('node.get',{id:C});expect(moved.result).toMatchObject({pageId:home,transform:[1,0,0,1,110,220]})
  await capture('cross-page-selection-rollback-move',{invalid:invalid.structuredContent,rollback:rollback.structuredContent,moved:moved.result})
 });
 it('rejects missing required fields, invalid sizes, units, unknown/custom fields and singular matrices',async()=>{
  const f=await fixture();expect((await f.mutate('node.create',{id:F,kind:'frame'})).isError).toBe(false)
  for(const [label,method,params] of [
   ['missing kind','node.create',{}],['zero size','node.create',{kind:'frame',width:0}],['negative size','node.create',{kind:'frame',width:-1}],['string units','node.create',{kind:'frame',width:'400px'}],['unknown param','node.create',{kind:'frame',custom:1}],['custom node property','node.update',{ids:[F],patch:{custom:{foo:1}}}],['singular matrix','node.update',{ids:[F],patch:{transform:[0,0,0,0,0,0]}}],['negative update','node.update',{ids:[F],patch:{width:-1}}]
  ] as [string,string,Json][]){ const before=f.editor.state.doc;const r=await f.mutate(method,params);expect(r.isError,label).toBe(true);expect(f.editor.state.doc).toBe(before);await capture(label,r.structuredContent) }
 });
 it('enforces corrected advertised text and style bounds',async()=>{
  const f=await fixture();expect((await f.mutate('node.create',{id:T,kind:'text'})).isError).toBe(false)
  const tool=(await f.rpc('tools/list')).result.tools.find((t:Json)=>t.name==='design_text_set');await capture('text.set advertised schema',tool.inputSchema)
  expect(tool.inputSchema.properties.params.properties.fontSize).toMatchObject({minimum:1,maximum:4096}); expect(tool.inputSchema.properties.params.properties.text.maxLength).toBe(100000); expect(tool.inputSchema.properties.params.properties.textRuns.maxItems).toBe(4096)
  for(const fontSize of [1,4096]){const r=await f.mutate('text.set',{ids:[T],fontSize});expect(r.isError).toBe(false);expect((await f.read('node.get',{id:T})).result.node.fontSize).toBe(fontSize)}
  for(const fontSize of [0.99,4097]){const r=await f.mutate('text.set',{ids:[T],fontSize});expect(r.isError).toBe(true);await capture('fontSize '+fontSize,r.structuredContent)}
  const long=await f.mutate('text.set',{ids:[T],text:'x'.repeat(100001)});expect(long.isError).toBe(true);await capture('text length100001',long.structuredContent)
  for(const [field,make] of [['fills',()=>paint()],['strokes',()=>stroke()],['effects',()=>effect('shadow')]] as [string, () => unknown][]){
   const good=await f.mutate('style.set',{ids:[T],[field]:Array.from({length:16},make)});expect(good.isError,JSON.stringify(good)).toBe(false)
   const bad=await f.mutate('style.set',{ids:[T],[field]:Array.from({length:17},make)});await capture(field+' boundary16/17',bad.structuredContent);expect(bad.isError).toBe(true);expect(bad.structuredContent.error.code).toBe('invalid_params')
  }
  const runs=await f.mutate('text.set',{ids:[T],textRuns:Array.from({length:4097},()=>({start:0,end:1}))});expect(runs.isError).toBe(true);expect(runs.structuredContent.error.code).toBe('invalid_params')

 });
 it('fences document/session/revision and rejects identifier collisions without changes',async()=>{
  const f=await fixture(),state=await f.read('document.get');
  for(const [label,fences,code] of [
   ['wrong document',{documentId:P,session:state.session,expectedRevision:state.revision},'document_mismatch'],
   ['wrong session',{documentId:state.documentId,session:state.session+1,expectedRevision:state.revision},'session_mismatch'],
   ['wrong revision',{documentId:state.documentId,session:state.session,expectedRevision:state.revision+1},'stale_revision']
  ] as [string,Json,string][]){const r=await f.call('node.create',{kind:'frame'},fences);expect(r.isError).toBe(true);expect(r.structuredContent.error.code).toBe(code);await capture(label,r.structuredContent)}
  expect((await f.mutate('page.create',{id:P})).isError).toBe(false)
  const collision=await f.mutate('node.create',{id:P,kind:'frame'});expect(collision.isError).toBe(true);expect(collision.structuredContent.error.code).toBe('duplicate_id')
  const badid=await f.mutate('node.create',{id:'not-a-uuid',kind:'frame'});expect(badid.isError).toBe(true)
  expect((await f.read('document.get')).result.nodeCount).toBe(0)
 });
 it('returns full query totals with bounded pages and rejects stale cursors',async()=>{
  const f=await fixture();expect((await f.mutate('batch.apply',{operations:[F,C,T].map(id=>({method:'node.create',params:{id,kind:'frame'}}))})).isError).toBe(false)
  const first=await f.read('node.find',{kind:'frame',limit:1});expect(first.result.total).toBe(3);expect(first.result.nodes).toHaveLength(1);expect(first.result.nextCursor).toBeTruthy()
  const next=await f.read('node.find',{kind:'frame',limit:1,cursor:first.result.nextCursor});expect(next.result.total).toBe(3);expect(next.result.nodes[0].id).not.toBe(first.result.nodes[0].id)
  expect((await f.mutate('node.update',{ids:[F],patch:{width:200}})).isError).toBe(false)
  const stale=await f.call('node.find',{kind:'frame',limit:1,cursor:first.result.nextCursor});expect(stale.isError).toBe(true);expect(stale.structuredContent.error.code).toBe('stale_cursor');await capture('pagination',{first:first.result,next:next.result,stale:stale.structuredContent})
 });

})
