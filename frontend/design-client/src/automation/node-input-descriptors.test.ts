import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Editor } from '../engine'
import { blank, paint, stroke, effect } from '../model'
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
  const tools = (await rpc('tools/list')).result.tools as { name: string; inputSchema: Json }[]
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

const evidence: Json[] = []
const evidenceDir = join(process.env.FUTUREOX_TEST_RESULTS_DIR || 'test-results', 'input-schemas')
async function capture(label: string, value: any) { evidence.push({label,value}); await mkdir(evidenceDir,{recursive:true}); await writeFile(join(evidenceDir, 'results.json'), JSON.stringify(evidence,null,2)) }
describe('Typed native node inputs over real MCP JSON-RPC', () => {
 it('publishes every native patch field and shares the create/update descriptor', async () => {
  const f = await fixture()
  const update = f.tools.find(t => t.name === 'design_node_update')!.inputSchema
  const create = f.tools.find(t => t.name === 'design_node_create')!.inputSchema
  await capture('tools-list-native-inputs', { update, create })
  const patch = update.properties.params.properties.patch
  expect(patch).toEqual(create.properties.params.properties.patch)
  expect(patch.additionalProperties).toBe(false)
  expect(Object.keys(patch.properties).sort()).toEqual('repeat vectorBrush name transform width height visible locked opacity blend fills strokes effects radii smoothing clip mask maskType points innerRadius network text fontSize textStyle textRuns layout sizing constraints layoutGrid guides arc cornerRadius constrainProportions booleanOperation exportSettings textPath pathOffset connector board'.split(' ').sort())
  for (const descriptor of Object.values(patch.properties) as Json[]) expect(descriptor.type || descriptor.anyOf).toBeTruthy()
  expect(patch.properties.width).toMatchObject({type:'number',minimum:0.000001,maximum:10000000})
  expect(patch.properties.transform).toMatchObject({type:'array',minItems:6,maxItems:6,items:{minimum:-10000000,maximum:10000000}})
  expect(patch.properties.textStyle.anyOf[0].properties.letterSpacing).toMatchObject({minimum:-1000,maximum:1000})
  expect(patch.properties.fills.items.properties.stops.maxItems).toBe(32)
 })
 it('accepts negative coordinates/reflections, precise line extents and native nested boundary values', async () => {
  const f=await fixture(); const id='32000000-0000-4000-8000-000000000001', textId='32000000-0000-4000-8000-000000000002'; const created=await f.mutate('node.create',{id,kind:'rectangle',patch:{transform:[-2,0,0,3,-10000000,10000000],width:0.01,height:10000000,opacity:0,radii:[0,1,2,10000000]}})
  expect(created.isError,JSON.stringify(created)).toBe(false)
  expect(f.editor.state.doc.nodes[id].transform).toEqual([-2,0,0,3,-10000000,10000000])
  const line=await f.mutate('node.create',{kind:'line',patch:{width:0.000001,height:0.000001}})
  expect(line.isError,JSON.stringify(line)).toBe(false)
  const text=await f.mutate('node.create',{id:textId,kind:'text',patch:{text:'ab',fontSize:4096,textStyle:{weight:1000,lineHeight:0.1,letterSpacing:-1000,paragraphIndent:-10000},textRuns:[{start:0,end:2,fontSize:1}]}})
  expect(text.isError,JSON.stringify(text)).toBe(false)
  const clear=await f.mutate('node.update',{ids:[textId],patch:{textRuns:null,textStyle:null}})
  expect(clear.isError,JSON.stringify(clear)).toBe(false)
  expect(f.editor.state.doc.nodes[textId].textStyle).toBeUndefined()
  const styled=await f.mutate('node.update',{ids:[id],patch:{fills:[{...paint(),opacity:1,transform:[-1,0,0,1,-5,10]}],strokes:[{...stroke(),width:10000,dashOffset:-10000000}],effects:[{...effect('shadow'),radius:1000,x:-10000000,y:10000000}]}})
  expect(styled.isError,JSON.stringify(styled)).toBe(false)
  expect(f.editor.state.doc.nodes[id].fills[0].transform).toEqual([-1,0,0,1,-5,10])
  await capture('valid-boundaries',{created,line,text,clear,styled})
 })
 it('rejects typed, range, array, nested and semantic violations atomically over JSON-RPC', async () => {
  const f=await fixture(); const id='33000000-0000-4000-8000-000000000001'; const created=await f.mutate('node.create',{id,kind:'rectangle'});expect(created.isError).toBe(false)
  const cases: [string,Json][] = [
   ['negative width',{width:-1}],['zero height',{height:0}],['wrong numeric type',{width:'12px'}],['extent above max',{width:10000001}],
   ['rectangle below kind minimum',{width:0.000001}],['singular transform',{transform:[0,0,0,0,0,0]}],['short transform',{transform:[1,0,0,1,0]}],['transform above max',{transform:[1,0,0,1,10000001,0]}],
   ['invalid opacity',{opacity:1.0001}],['negative radius',{radii:[0,0,0,-1]}],['null required field',{width:null}],['custom property',{customfields:{anything:1}}],
   ['nested style range',{textStyle:{letterSpacing:-1001}}],['nested style type',{textStyle:{wrap:'yes'}}],['nested unknown style',{textStyle:{arbitrary:1}}],['too many fills',{fills:Array.from({length:17},()=>paint())}],
   ['paint opacity',{fills:[{...paint(),opacity:-0.1}]}],['paint matrix singular',{fills:[{...paint(),transform:[0,0,0,0,0,0]}]}],['stroke width',{strokes:[{...stroke(),width:10001}]}],
   ['effect radius',{effects:[{...effect('shadow'),radius:1001}]}],['invalid text run',{text:'ab',textRuns:[{start:1,end:3}]}],['unknown blend',{blend:'made-up'}],
  ]
  for(const [label,patch] of cases){
   const before=f.editor.state.doc, revision=f.editor.state.version
   const result=await f.mutate('node.update',{ids:[id],patch})
   expect(result.isError,label+JSON.stringify(result)).toBe(true)
   const modelFailures = ['rectangle below kind minimum','singular transform','paint matrix singular','invalid text run']
   expect(result.structuredContent.error.code,label+JSON.stringify(result)).toBe(modelFailures.includes(label) ? 'commit_failed' : 'invalid_params')
   expect(f.editor.state.doc,label).toBe(before);expect(f.editor.state.version,label).toBe(revision)
   await capture(label,result)
  }
 })
})

it('MCP authors editable vector brushes and rejects unsupported or over-budget edits atomically', async () => {
  const { pathNetwork } = await import('../path-network')
  const { defaultVectorBrush } = await import('../vector-brush')
  const f=await fixture(), id='34000000-0000-4000-8000-000000000001'
  const brush=defaultVectorBrush(pathNetwork('M-2 -1C-1 -3 1 -3 2 -1L2 1L-2 1Z'))
  const create=await f.mutate('node.create',{id,kind:'vector',patch:{network:pathNetwork('M0 0C0 40 40 40 40 0'),fills:[paint()],vectorBrush:brush}})
  expect(create.isError,JSON.stringify(create)).toBe(false)
  expect(f.editor.state.doc.nodes[id].vectorBrush).toEqual(brush)
  expect(f.editor.state.doc.schemaVersion).toBe(15)
  for(const patch of [{vectorBrush:{...brush,mode:'stretch'}},{vectorBrush:{...brush,spacing:.001}},{vectorBrush:{...brush,seed:-1}}]) {
    const before=f.editor.state.doc,revision=f.editor.state.version
    const result=await f.mutate('node.update',{ids:[id],patch})
    expect(result.isError,JSON.stringify(result)).toBe(true)
    expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(revision)
  }
  const clear=await f.mutate('node.update',{ids:[id],patch:{vectorBrush:null}})
  expect(clear.isError,JSON.stringify(clear)).toBe(false)
  expect(f.editor.state.doc.nodes[id].vectorBrush).toBeUndefined()
  await capture('vector-brush-authoring',{create,clear})
})
