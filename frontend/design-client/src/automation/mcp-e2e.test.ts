import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Editor } from '../engine'
import { blank, node, paint } from '../model'
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
const ids = {
  frame: '10000000-0000-4000-8000-000000000001',
  title: '10000000-0000-4000-8000-000000000002',
  input: '10000000-0000-4000-8000-000000000003',
  button: '10000000-0000-4000-8000-000000000004',
  label: '10000000-0000-4000-8000-000000000005',
}
const operations = [
  { method: 'node.create', params: { id: ids.frame, kind: 'frame', width: 400, height: 340, patch: { name: 'Login card', fills: [paint('#ffffff')] } } },
  { method: 'layout.set', params: { ids: [ids.frame], layout: { mode: 'vertical', gap: 16, padding: [24, 24, 24, 24] } } },
  { method: 'node.create', params: { id: ids.title, kind: 'text', parentId: ids.frame, width: 320, height: 40 } },
  { method: 'text.set', params: { ids: [ids.title], text: 'Sign in', fontSize: 28 } },
  { method: 'node.create', params: { id: ids.input, kind: 'rectangle', parentId: ids.frame, width: 320, height: 48, patch: { name: 'Email field', fills: [paint('#f0f2f6')], radii: [8, 8, 8, 8] } } },
  { method: 'node.create', params: { id: ids.button, kind: 'frame', parentId: ids.frame, width: 320, height: 48, patch: { name: 'Submit button', fills: [paint('#2155ee')] } } },
  { method: 'node.create', params: { id: ids.label, kind: 'text', parentId: ids.button, x: 12, y: 10, width: 200, height: 28 } },
  { method: 'text.set', params: { ids: [ids.label], text: 'Continue', fontSize: 18 } },
]

it.each(['native-json', 'fd', 'sketch'] as const)('real MCP %s import distinguishes an exact retry from intentional repeated append',async format=>{
  const source=await fixture(blank('Same filename'))
  expect((await source.mutate('batch.apply',{operations})).isError).toBe(false)
  const exported=(await source.read(format==='sketch'?'sketch.export':'document.export',format==='sketch'?{}:{format})).result
  const method=format==='sketch'?'sketch.import':'document.import'
  const params=format==='sketch'?{base64:exported.base64,name:'Same filename'}:
    format==='fd'?{format,base64:exported.base64}:{format,content:exported.content}
  const target=await fixture(blank('Destination')),documentId=target.editor.state.doc.id
  const state=await target.read('document.get')
  const fences={documentId:state.documentId,session:state.session,expectedRevision:state.revision}
  const batch={mutationId:`import-${format}-one`,operations:[{method,params}]}
  const first=await target.call('batch.apply',batch,fences)
  expect(first.isError,JSON.stringify(first)).toBe(false)
  const firstResult=first.structuredContent.result
  const firstMap=firstResult.operations[0].result.nodeIdMap
  const imported=target.editor.state.doc,revision=target.editor.state.version
  expect(imported.id).toBe(documentId)
  expect((await target.call('batch.apply',batch,fences)).structuredContent.result.receipt.replayed).toBe(true)
  expect(target.editor.state.doc).toBe(imported);expect(target.editor.state.version).toBe(revision)
  target.editor.change('Keep local edits',d=>{d.nodes[firstMap[ids.title]].text='Locally edited first copy'})
  const edited=target.editor.state.doc,editedRevision=target.editor.state.version
  expect((await target.call('batch.apply',batch,fences)).structuredContent.result.receipt.replayed).toBe(true)
  expect(target.editor.state.doc).toBe(edited);expect(target.editor.state.version).toBe(editedRevision)
  const collision=await target.call('batch.apply',{...batch,label:'Different input'},fences)
  expect(collision.structuredContent).toMatchObject({ok:false,error:{code:'mutation_conflict'}})
  expect(target.editor.state.doc).toBe(edited)
  const secondState=await target.read('document.get')
  const secondFences={documentId:secondState.documentId,session:secondState.session,expectedRevision:secondState.revision}
  const secondBatch={...batch,mutationId:`import-${format}-two`}
  const second=await target.call('batch.apply',secondBatch,secondFences)
  expect(second.isError,JSON.stringify(second)).toBe(false)
  const secondMap=second.structuredContent.result.operations[0].result.nodeIdMap
  expect(Object.values(secondMap).every(id=>!Object.values(firstMap).includes(id))).toBe(true)
  expect(target.editor.state.doc.nodes[firstMap[ids.title]].text).toBe('Locally edited first copy')
  expect(target.editor.state.doc.nodes[secondMap[ids.title]].text).toBe('Sign in')
  const twice=target.editor.state.doc
  expect((await target.mutate('history.undo')).isError).toBe(false)
  expect(target.editor.state.doc).toEqual(edited)
  expect((await target.call('batch.apply',secondBatch,secondFences)).structuredContent.result.receipt.replayed).toBe(true)
  expect(target.editor.state.doc).toEqual(edited) // Receipt replay never redoes.
  expect((await target.mutate('history.redo')).isError).toBe(false)
  expect(target.editor.state.doc).toEqual(twice)
},30000)

describe('MCP JSON-RPC -> shared operation API -> real Editor/WASM', () => {
  it('creates a login design, inspects/checks, fine-edits and exports exact code resources', async () => {
    const f = await fixture()
    expect(f.tools.length).toBe(f.api.capabilities().methods.length)
    const before = f.editor.state.version
    const created = await f.mutate('batch.apply', { operations, label: 'Create login card' })
    expect(created.isError, JSON.stringify(created.structuredContent)).toBe(false)
    expect(f.editor.state.version).toBe(before + 1)
    expect(Object.keys(f.editor.state.doc.nodes)).toHaveLength(5)
    expect(f.editor.state.doc.nodes[ids.frame].children).toEqual([ids.title, ids.input, ids.button])
    expect(f.editor.state.doc.nodes[ids.frame].layout?.mode).toBe('vertical')
    const context = await f.read('context.get', { nodeIds: [ids.frame], limit: 20 })
    expect(context.result.format).toBe('futureox.design-context.v1')
    const check = await f.read('design.check', { nodeIds: [ids.frame], limit: 20 })
    expect(check.result.format).toBe('futureox.design-check.v1')
    const edited = await f.mutate('text.set', { ids: [ids.title], text: 'Welcome back', fontSize: 30 })
    expect(edited.isError).toBe(false)
    expect(f.editor.state.doc.nodes[ids.title].text).toBe('Welcome back')
    const code = await f.call('code.export', { nodeIds: [ids.frame] })
    expect(code.isError, JSON.stringify(code.structuredContent)).toBe(false)
    expect(code.structuredContent.result.html).toBeUndefined()
    const result = (await f.materialize(code.structuredContent)).result
    expect(result.fidelity).toBe('approximate')
    expect(result.html).toContain('Welcome back')
    expect(result.css).toContain('flex-direction:column')
    expect(result.nodeIdMap[ids.title]).toBeTruthy()
    const htmlLink = code.content.find((entry: Json) => entry.type === 'resource_link' && entry.mimeType === 'text/html')
    expect(htmlLink).toBeTruthy()
    const resource = await f.rpc('resources/read', { uri: htmlLink.uri })
    expect(resource.result.contents[0].text).toBe(result.html)
    const listed = await f.rpc('resources/list')
    expect(listed.result.resources.some((entry: Json) => entry.uri === htmlLink.uri)).toBe(true)
  }, 30000)

  it('losslessly exports and reimports structure with remapped IDs, then undoes/redoes one transaction', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const exported = await source.read('document.export')
    expect(exported.result.lossless).toBe(true)
    const raw = JSON.parse(exported.result.content)
    expect(raw.nodes[ids.title].text).toBe('Sign in')
    const destination = await fixture(blank('Import destination'))
    const before = destination.editor.state.doc
    const imported = await destination.mutate('document.import', { format: 'native-json', content: exported.result.content })
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBe(false)
    const mapping = imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(mapping[ids.frame]).not.toBe(ids.frame)
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].children).toEqual([mapping[ids.title], mapping[ids.input], mapping[ids.button]])
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].layout?.mode).toBe('vertical')
    expect((await destination.mutate('history.undo')).isError).toBe(false)
    expect(destination.editor.state.doc).toBe(before)
    expect((await destination.mutate('history.redo')).isError).toBe(false)
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
  }, 30000)

  it('exports true native .fd bytes as a blob resource and imports them through the real decoder', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const exported = await source.call('document.export', { format: 'fd' })
    expect(exported.isError, JSON.stringify(exported.structuredContent)).toBe(false)
    expect(exported.structuredContent.result.base64).toBeUndefined()
    const result = (await source.materialize(exported.structuredContent)).result
    expect(result.nativeFormat).toBe('fd')
    expect(result.encoding).toBe('base64')
    expect(result.mimeType).toBe('application/vnd.futureox-desgin')
    const bytes = Buffer.from(result.base64, 'base64')
    expect(bytes.length).toBe(result.bytes)
    expect(bytes.subarray(0, 1).toString()).not.toBe('{')
    const blobLink = exported.content.find((entry: Json) => entry.type === 'resource_link' && entry.name === 'design.fd')
    expect(blobLink).toBeTruthy()
    const resource = await source.rpc('resources/read', { uri: blobLink.uri })
    expect(resource.result.contents[0].blob).toBe(result.base64)
    expect(resource.result.contents[0].text).toBeUndefined()
    const destination = await fixture(blank('FD destination'))
    const imported = await destination.mutate('document.import', { format: 'fd', base64: result.base64 })
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBe(false)
    const mapping = imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].children).toEqual([mapping[ids.title], mapping[ids.input], mapping[ids.button]])
  }, 30000)

  it('stale writes and invalid multi-operation edits never partially commit', async () => {
    const f = await fixture()
    expect((await f.mutate('batch.apply', { operations })).isError).toBe(false)
    const stale = await f.read('document.get')
    expect((await f.mutate('text.set', { ids: [ids.title], text: 'Changed by another edit' })).isError).toBe(false)
    const rejected = await f.call('node.delete', { ids: [ids.frame] }, { documentId: stale.documentId, session: stale.session, expectedRevision: stale.revision })
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredContent.error.code).toBe('stale_revision')
    const before = f.editor.state.doc, version = f.editor.state.version
    const invalid = await f.mutate('batch.apply', { operations: [
      { method: 'text.set', params: { ids: [ids.title], text: 'Must roll back' } },
      { method: 'node.move', params: { ids: [ids.title], parentId: 'missing' } },
    ] })
    expect(invalid.isError).toBe(true)
    expect(f.editor.state.doc).toBe(before)
    expect(f.editor.state.version).toBe(version)
    expect(f.editor.state.doc.nodes[ids.title].text).toBe('Changed by another edit')
  }, 30000)

  it('discovers granular tools, stages an authored diff, applies once, roundtrips FD, then undoes one edit through JSON-RPC', async () => {
    const f = await fixture()
    for (const name of ['design_node_patch', 'design_layout_patch', 'design_paint_patch', 'design_text_styleRange', 'design_text_replaceRange', 'design_batch_preflight'])
      expect(f.tools.some(tool => tool.name === name)).toBe(true)
    expect((await f.mutate('batch.apply', { operations })).isError).toBe(false)
    const before = f.editor.state.doc, input = before.nodes[ids.input], originalRevision = f.editor.state.version
    const beforeSvg = await f.read('vector.export', { nodeIds: [ids.frame] })
    const edits = [
      { method: 'layout.patch', params: { ids: [ids.frame], patch: { layout: { gap: 22 } }, expected: { layout: { gap: 16 } } } },
      { method: 'node.patch', params: { ids: [ids.input], patch: { radii: { topLeft: 14 } }, expected: { radii: { topLeft: 8 } } } },
      { method: 'paint.patch', params: { ids: [ids.input], target: 'fill', paintId: input.fills[0].id, patch: { color: '#ddddee' }, expected: { color: '#f0f2f6' } } },
      { method: 'text.styleRange', params: { nodeId: ids.title, start: 0, end: 4, expectedText: 'Sign', patch: { weight: 600 } } },
    ]
    const staged = await f.read('batch.preflight', { operations: edits })
    expect(staged.result).toMatchObject({ validation: 'authored-only', derivedResolution: 'deferred', authoritativeCommitValidationRequired: true, receiptConsumed: false })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(originalRevision)
    const fences = { documentId: staged.documentId, session: staged.session, expectedRevision: staged.revision }
    const params = { operations: edits, mutationId: 'fine-edit-mcp' }
    const applied = await f.call('batch.apply', params, fences)
    expect(applied.isError, JSON.stringify(applied)).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(applied))).toBeLessThan(256 * 1024)
    expect(applied.structuredContent.result.receipt).toMatchObject({ mutationId: 'fine-edit-mcp', replayed: false })
    expect(applied.structuredContent.result.changedPaths).toContain(`/nodes/${ids.input}/radii/0`)
    const after = f.editor.state.doc, revision = f.editor.state.version
    const expected = structuredClone(before)
    expected.nodes[ids.frame].layout!.gap = 22
    expected.nodes[ids.input].radii[0] = 14; expected.nodes[ids.input].fills[0].color = '#ddddee'
    expected.nodes[ids.title].textRuns = [{ start: 0, end: 4, weight: 600 }]
    expected.nodes[ids.input].transform[5] += 6; expected.nodes[ids.button].transform[5] += 12
    expect(after).toEqual(expected)
    expect(applied.structuredContent.result.changedPaths.sort()).toEqual([
      `/nodes/${ids.frame}/layout/gap`, `/nodes/${ids.input}/radii/0`, `/nodes/${ids.input}/fills/0/color`,
      `/nodes/${ids.title}/textRuns/0`, `/nodes/${ids.input}/transform/5`, `/nodes/${ids.button}/transform/5`,
    ].sort())
    expect(after.nodes[ids.label]).toEqual(before.nodes[ids.label])
    const afterSvg = await f.read('vector.export', { nodeIds: [ids.frame] })
    expect(afterSvg.result.content).toContain('<svg'); expect(afterSvg.result.content).not.toBe(beforeSvg.result.content)
    const replay = await f.call('batch.apply', params, fences)
    expect(replay.structuredContent.result.receipt.replayed).toBe(true)
    expect(f.editor.state.version).toBe(revision)
    const exported = await f.read('document.export', { format: 'fd' })
    const destination = await fixture()
    const imported = await destination.mutate('document.import', { format: 'fd', base64: exported.result.base64 })
    expect(imported.isError, JSON.stringify(imported)).toBe(false)
    const mapping = imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(destination.editor.state.doc.nodes[mapping[ids.input]].radii).toEqual([14, 8, 8, 8])
    expect(destination.editor.state.doc.nodes[mapping[ids.input]].fills).toEqual(after.nodes[ids.input].fills)
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].textRuns).toEqual(after.nodes[ids.title].textRuns)
    expect((await f.mutate('history.undo')).isError).toBe(false)
    expect(f.editor.state.doc).toEqual(before)
    const evidence = process.env.FUTUREOX_GRANULAR_MCP_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
      await Promise.all([
        writeFile(join(evidence, 'before.svg'), beforeSvg.result.content), writeFile(join(evidence, 'after.svg'), afterSvg.result.content),
        writeFile(join(evidence, 'before.json'), json(before)), writeFile(join(evidence, 'after.json'), json(after)),
        writeFile(join(evidence, 'roundtrip.json'), json(destination.editor.state.doc)), writeFile(join(evidence, 'undo.json'), json(f.editor.state.doc)),
        writeFile(join(evidence, 'preflight.json'), json(staged)), writeFile(join(evidence, 'apply.json'), json(applied)), writeFile(join(evidence, 'replay.json'), json(replay)),
        writeFile(join(evidence, 'small-edit.fd'), Buffer.from(exported.result.base64, 'base64')),
        writeFile(join(evidence, 'manifest.json'), json({ protocol: 'MCP JSON-RPC in-memory byte streams', model: 'real Editor + scalar WASM', vectorExport: 'native SVG, not GPU or desktop screenshot', requestedChanges: 4, declaredDerivedPositionChanges: 2, exactDocumentAssertion: true, fdRoundtrip: true, oneUndo: true, receiptReplay: true })),
      ])
    }
  }, 30000)

  it('replaces the selected repeated text through MCP, preserves rich styles, exports FD and undoes once', async () => {
    const document = blank('Explicit small text edit'), title = node('text', 20, 20, 300, 80)
    title.text = 'Go Go'; title.textRuns = [{ start: 0, end: 2, weight: 600 }, { start: 3, end: 5, weight: 300, underline: true }]
    document.schemaVersion = 15; document.nodes[title.id] = title; document.pages[0].children.push(title.id)
    const f = await fixture(document), before = f.editor.state.doc
    expect(f.tools.some(tool => tool.name === 'design_text_replaceRange')).toBe(true)
    const operations = [{ method: 'text.replaceRange', params: { nodeId: title.id, start: 0, end: 2, text: 'Start', expectedText: 'Go' } }]
    const staged = await f.read('batch.preflight', { operations })
    expect(staged.result).toMatchObject({ derivedResolution: 'deferred', authoritativeCommitValidationRequired: true, receiptConsumed: false })
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    const fences = { documentId: staged.documentId, session: staged.session, expectedRevision: staged.revision }
    const params = { operations, mutationId: 'replace-first-go' }, applied = await f.call('batch.apply', params, fences)
    expect(applied.isError, JSON.stringify(applied)).toBe(false)
    const expected = structuredClone(before)
    expected.nodes[title.id].text = 'Start Go'
    expected.nodes[title.id].textRuns = [{ start: 0, end: 5, weight: 600 }, { start: 6, end: 8, weight: 300, underline: true }]
    expect(f.editor.state.doc).toEqual(expected)
    expect(applied.structuredContent.result.changedPaths.sort()).toEqual([
      `/nodes/${title.id}/text`, `/nodes/${title.id}/textRuns/0/end`, `/nodes/${title.id}/textRuns/1/start`, `/nodes/${title.id}/textRuns/1/end`,
    ].sort())
    const version = f.editor.state.version, replay = await f.call('batch.apply', params, fences)
    expect(replay.structuredContent.result.receipt.replayed).toBe(true); expect(f.editor.state.version).toBe(version)
    const exported = await f.read('document.export', { format: 'fd' }), destination = await fixture()
    const imported = await destination.mutate('document.import', { format: 'fd', base64: exported.result.base64 })
    expect(imported.isError, JSON.stringify(imported)).toBe(false)
    const mapped = imported.structuredContent.result.operations[0].result.nodeIdMap[title.id]
    expect(destination.editor.state.doc.nodes[mapped]).toMatchObject({ text: 'Start Go', textRuns: expected.nodes[title.id].textRuns })
    expect((await f.mutate('history.undo')).isError).toBe(false)
    expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    const evidence = process.env.FUTUREOX_GRANULAR_MCP_EVIDENCE_DIR
    if (evidence) {
      const directory = join(evidence, 'text-replace'); await mkdir(directory, { recursive: true })
      const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
      await Promise.all([
        writeFile(join(directory, 'before.json'), json(before)), writeFile(join(directory, 'after.json'), json(expected)),
        writeFile(join(directory, 'preflight.json'), json(staged)), writeFile(join(directory, 'apply.json'), json(applied)), writeFile(join(directory, 'replay.json'), json(replay)),
        writeFile(join(directory, 'roundtrip.json'), json(destination.editor.state.doc)), writeFile(join(directory, 'undo.json'), json(f.editor.state.doc)),
        writeFile(join(directory, 'text-edit.fd'), Buffer.from(exported.result.base64, 'base64')),
        writeFile(join(directory, 'manifest.json'), json({ protocol: 'MCP JSON-RPC in-memory byte streams', model: 'real Editor + scalar WASM', explicitRange: [0, 2], original: 'Go Go', replacement: 'Start Go', exactDocumentAssertion: true, inheritedStyle: 'right-biased at start', fdRoundtrip: true, oneUndo: true, receiptReplay: true })),
      ])
    }
  }, 30000)

  it('exposes only read-only preflight under a read grant and rejects hidden mutation tools through JSON-RPC', async () => {
    const document = blank('Read scope'), rectangle = node('rectangle')
    document.nodes[rectangle.id] = rectangle; document.pages[0].children.push(rectangle.id)
    const f = await fixture(document, 'read'), before = f.editor.state.doc
    expect(f.tools.some(tool => tool.name === 'design_node_patch')).toBe(false)
    expect(f.tools.some(tool => tool.name === 'design_text_replaceRange')).toBe(false)
    expect(f.tools.some(tool => tool.name === 'design_batch_apply')).toBe(false)
    const preview = await f.read('batch.preflight', { operations: [{ method: 'node.patch', params: { ids: [rectangle.id], patch: { opacity: .3 } } }] })
    expect(preview.result.changedPaths).toEqual([`/nodes/${rectangle.id}/opacity`])
    const denied = await f.rpc('tools/call', { name: 'design_node_patch', arguments: { params: { ids: [rectangle.id], patch: { opacity: .3 } } } })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  }, 30000)

  it('exports actual native SVG geometry, with no preview renderer substitute', async () => {
    const f = await fixture()
    expect((await f.mutate('node.create', { id: ids.input, kind: 'rectangle', width: 123, height: 45, patch: { fills: [paint('#ff0000')] } })).isError).toBe(false)
    const svg = await f.read('vector.export', { nodeIds: [ids.input] })
    expect(svg.result.mimeType).toBe('image/svg+xml')
    expect(svg.result.content).toContain('<svg')
    expect(svg.result.sourceNodeIds).toEqual([ids.input])
    expect(svg.result.content).toMatch(/123|45/)
  }, 30000)

  it('imports the actual 17.77 MB bundled font then returns sequential full FD and JSON exports', async () => {
    const f = await fixture(), started = performance.now()
    const font = await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))
    const imported = await f.mutate('font.import', { id: 'mcp-full-font', data: font.toString('base64'), embeddingAllowed: true })
    expect(imported.isError).toBe(false)
    const binaryWire = await f.call('document.export', { format: 'fd' })
    expect(Buffer.byteLength(JSON.stringify(binaryWire))).toBeLessThan(256 * 1024)
    expect(binaryWire.structuredContent.result.base64).toBeUndefined()
    const binary = await f.materialize(binaryWire.structuredContent)
    expect(binary.result.base64.length).toBeGreaterThan(30 * 1024 * 1024)
    const direct = f.api.execute({ method: 'document.export', params: { format: 'fd' } })
    expect(direct.ok).toBe(true)
    if (!direct.ok) throw new Error(direct.error.message)
    const digest = (data: string) => createHash('sha256').update(data).digest('hex')
    expect(digest(binary.result.base64)).toBe(digest((direct.result as Json).base64))
    expect(Buffer.byteLength(JSON.stringify(direct))).toBeGreaterThan(30 * 1024 * 1024)
    expect(Buffer.from(binary.result.base64, 'base64').subarray(0, 4).toString()).toBe('FXDK')
    const nativeWire = await f.call('document.export')
    expect(Buffer.byteLength(JSON.stringify(nativeWire))).toBeLessThan(256 * 1024)
    expect(nativeWire.structuredContent.result.content).toBeUndefined()
    const native = await f.materialize(nativeWire.structuredContent)
    const expired = await f.rpc('resources/read', { uri: binaryWire.structuredContent.result.resources[0].uri })
    expect(expired.error.code).toBe(-32002)
    expect(JSON.parse(native.result.content).fonts['mcp-full-font'].data).toBe(font.toString('base64'))
    expect((await f.rpc('ping')).result).toEqual({})
    console.info(JSON.stringify({ benchmark: 'mcp-full-font-sequential-native-exports', fontBytes: font.length, fdBase64Bytes: binary.result.base64.length, jsonBytes: native.result.bytes, fdToolBytes: Buffer.byteLength(JSON.stringify(binaryWire)), jsonToolBytes: Buffer.byteLength(JSON.stringify(nativeWire)), elapsedMs: Math.round(performance.now() - started) }))
  }, 30000)

  it('returns real Sketch ZIP resources and reimports the authored structure through MCP', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const wire = await source.call('sketch.export')
    expect(wire.isError).toBe(false)
    expect(wire.structuredContent.result.base64).toBeUndefined()
    expect(wire.structuredContent.result.lossless).toBe(false)
    const exported = await source.materialize(wire.structuredContent)
    expect(Buffer.from(exported.result.base64, 'base64').subarray(0, 2).toString()).toBe('PK')
    const destination = await fixture(blank('Sketch destination'))
    const imported = await destination.mutate('sketch.import', { base64: exported.result.base64, name: 'mcp-example.sketch' })
    expect(imported.isError, JSON.stringify(imported.structuredContent.error)).toBe(false)
    expect(Object.values(destination.editor.state.doc.nodes).some(item => item.text === 'Sign in')).toBe(true)
  }, 30000)

  it('handles 3,000 native nodes with bounded paginated reads and one targeted edit', async () => {
    const document = blank('Large MCP scene')
    for (let index = 0; index < 3000; index++) {
      const item = node('rectangle', (index % 60) * 12, Math.floor(index / 60) * 12, 10, 10)
      item.name = `Cell ${index}`; document.nodes[item.id] = item; document.pages[0].children.push(item.id)
    }
    const start = performance.now(), f = await fixture(document)
    let cursor: string | undefined, count = 0, firstId: string | undefined, pages = 0
    do {
      const result = await f.read('node.find', { limit: 500, ...(cursor ? { cursor } : {}) })
      count += result.result.nodes.length; firstId ??= result.result.nodes[0]?.id; cursor = result.result.nextCursor; pages++
      expect(result.result.nodes.length).toBeLessThanOrEqual(500)
    } while (cursor)
    expect(count).toBe(3000); expect(pages).toBe(6)
    expect((await f.mutate('node.update', { ids: [firstId], patch: { name: 'Fine-edited cell' } })).isError).toBe(false)
    expect(f.editor.state.doc.nodes[firstId!].name).toBe('Fine-edited cell')
    expect(Object.keys(f.editor.state.doc.nodes)).toHaveLength(3000)
    // Record a measurement without making hardware-dependent performance promises.
    console.info(JSON.stringify({ benchmark: 'mcp-real-editor-3000-nodes', nodes: count, pages, elapsedMs: Math.round(performance.now() - start) }))
  }, 60000)
})


it('committed supersession stays successful and owner-scoped through real MCP NDJSON', async () => {
  const doc = blank('Original MCP owner'), item = node('rectangle')
  doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
  const f = await fixture(doc), before = f.editor.state, session = f.editor.sessionGeneration
  let entered = false, adopted: typeof before | undefined
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.version !== before.version + 1) return
    entered = true; f.editor.load(blank('Private newer document')); adopted = f.editor.state
  })
  try {
    const response = await f.call('batch.apply', { mutationId: 'ndjson-superseded', operations: [
      { method: 'node.update', params: { ids: [item.id], patch: { name: 'Accepted original edit' } } },
    ] }, { documentId: doc.id, session, expectedRevision: before.version })
    expect(response.isError).toBe(false)
    expect(response.structuredContent).toMatchObject({ ok: true, documentId: doc.id, session, revision: before.version + 1,
      result: { noChange: false, changedIds: [item.id], completion: { status: 'committed', superseded: true, retry: 'do-not-retry', contextApplied: false },
        receipt: { revision: before.version + 1, replayed: false, replayAvailable: false } } })
    const text = JSON.parse(response.content.find((part: Json) => part.type === 'text').text)
    expect(text).toEqual(response.structuredContent)
    expect(JSON.stringify(response)).not.toContain('Private newer document')
    expect(f.editor.state).toBe(adopted)
  } finally { off() }
})

it('unchanged navigation supersession never claims an authored commit over MCP NDJSON', async () => {
  const doc = blank('Navigation only'), item = node('rectangle')
  doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
  const f = await fixture(doc), session = f.editor.sessionGeneration, before = f.editor.state
  let entered = false, adopted: typeof before | undefined
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.selection[0] !== item.id) return
    entered = true; f.editor.load(blank('New navigation owner')); adopted = f.editor.state
  })
  try {
    const response = await f.call('selection.set', { ids: [item.id] }, { documentId: doc.id, session, expectedRevision: before.version })
    expect(response.isError).toBe(false)
    expect(response.structuredContent).toMatchObject({ ok: true, documentId: doc.id, session, revision: before.version,
      result: { noChange: true, changedIds: [], completion: { status: 'unchanged', superseded: true, retry: 'read-current-state', contextApplied: false } } })
    expect(f.editor.state).toBe(adopted); expect(f.editor.canUndo).toBe(false)
  } finally { off() }
})

it('history supersession retains the accepted old history owner through real MCP NDJSON', async () => {
  const doc = blank('Old history MCP owner'), item = node('rectangle')
  doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
  const f = await fixture(doc)
  f.editor.change('Before undo', draft => { draft.nodes[item.id].name = 'Changed' })
  const before = f.editor.state, session = f.editor.sessionGeneration
  let entered = false, adopted: typeof before | undefined
  const off = f.editor.subscribe(() => {
    if (entered || f.editor.state.version !== before.version + 1) return
    entered = true; f.editor.load(blank('Private post-history owner')); adopted = f.editor.state
  })
  try {
    const response = await f.call('history.undo', {}, { documentId: doc.id, session, expectedRevision: before.version })
    expect(response.isError).toBe(false)
    expect(response.structuredContent).toMatchObject({ ok: true, documentId: doc.id, session, revision: before.version + 1,
      result: { noChange: false, canUndo: false, canRedo: true, completion: { status: 'committed', superseded: true, retry: 'do-not-retry' } } })
    expect(f.editor.state).toBe(adopted); expect(f.editor.canRedo).toBe(false)
    expect(JSON.stringify(response)).not.toContain('Private post-history owner')
  } finally { off() }
})

it('shared arrangement planners preserve MCP sequential batch, one undo/redo and retry through real NDJSON', async () => {
  const doc = blank('Shared commands'), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 30, 5, 20, 10), c = node('rectangle', 100, 10, 10, 10)
  doc.nodes = Object.fromEntries([a, b, c].map(n => [n.id, n])); doc.pages[0].children = [a.id, b.id, c.id]
  const f = await fixture(doc), before = f.editor.state.doc, events: string[] = [], stop = f.editor.subscribeEdits(event => events.push(`${event.kind}:${event.source}`))
  const group = '99cd73b2-253c-4dd5-bb69-3dded53196a7', state = await f.read('document.get')
  const params = { mutationId: 'shared-arrange', operations: [
    { method: 'node.distribute', params: { ids: [c.id, a.id, b.id], axis: 'x' } },
    { method: 'node.group', params: { ids: [a.id, b.id, c.id], id: group } },
    { method: 'node.align', params: { ids: [a.id, b.id, c.id], axis: 'y', mode: 'center' } },
    { method: 'node.ungroup', params: { ids: [group] } },
  ] }
  const fences = { documentId: state.documentId, session: state.session, expectedRevision: state.revision }
  try {
    const result = await f.call('batch.apply', params, fences)
    expect(result.isError).toBe(false); expect(f.editor.state.version).toBe(1)
    expect(f.editor.state.doc.nodes[b.id].transform[4]).toBe(45)
    expect(f.editor.state.doc.pages[0].children).toEqual([a.id, b.id, c.id]); expect(f.editor.state.doc.nodes[group]).toBeUndefined()
    const after = f.editor.state.doc
    expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
    expect((await f.mutate('history.redo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(after)
    const replay = await f.call('batch.apply', params, fences)
    expect(replay.isError).toBe(false); expect(replay.structuredContent.result.receipt.replayed).toBe(true)
    expect(f.editor.state.version).toBe(3); expect(f.editor.state.doc).toEqual(after)
    expect(events).toEqual(['edit:automation', 'undo:automation', 'redo:automation'])
  } finally { stop() }
}, 30000)

it('shared arrangement tools remain absent and fail under MCP read-only scope', async () => {
  const doc = blank(), child = node('rectangle'); doc.nodes[child.id] = child; doc.pages[0].children = [child.id]
  const f = await fixture(doc, 'read'), before = f.editor.state.doc
  for (const name of ['design_node_align', 'design_node_distribute', 'design_node_group', 'design_node_ungroup']) {
    expect(f.tools.some(tool => tool.name === name)).toBe(false)
    const denied = await f.rpc('tools/call', { name, arguments: { params: { ids: [child.id] }, documentId: doc.id, session: 0, expectedRevision: 0 } })
    expect(denied.error || denied.result?.isError).toBeTruthy()
  }
  expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(0); expect(f.editor.canUndo).toBe(false)
}, 30000)
