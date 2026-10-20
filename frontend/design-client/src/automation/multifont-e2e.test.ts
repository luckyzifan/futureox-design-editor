import { afterEach, expect, it, vi } from 'vitest'
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
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks() })

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

import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { defaultTextStyle } from '../model'
import { decodeDocumentBinary, encodeDocumentBinary } from '../kernel/binfmt'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { unzlibSync } from 'fflate'
import { replaceFontReferences } from '../font-management'

function decode(blob: Blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer), width = view.getUint32(16), height = view.getUint32(20)
    expect(bytes[24]).toBe(8); expect(bytes[25]).toBe(6)
    const chunks: Uint8Array[] = []
    for (let at = 8; at < bytes.length;) { const n = view.getUint32(at); if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + n)); at += n + 12 }
    const encoded = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let at = 0
    for (const chunk of chunks) { encoded.set(chunk, at); at += chunk.length }
    const raw = unzlibSync(encoded), pixels = new Uint8Array(width * height * 4), stride = width * 4
    const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
    for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
      const filter = raw[y * (stride + 1)], i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0
      pixels[i] = raw[y * (stride + 1) + x + 1] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c))
    }
    return { width, height, pixels }
  })
}

it('three original font families survive MCP authoring, multipage mixed runs, real glyphs, pixels, FD reopen and atomic replacement', async () => {
  const evidence = process.env.MULTIFONT_EVIDENCE || join(tmpdir(), 'core-multifont-evidence')
  await mkdir(evidence, { recursive: true })
  execFileSync(process.env.PYTHON || 'python3', [new URL('../../../../testing/generate-multifont-fixtures.py', import.meta.url).pathname, join(evidence, 'fonts')])
  const f = await fixture()
  for (let i = 0; i < 3; i++) {
    const data = (await readFile(join(evidence, 'fonts', `font-${i}.ttf`))).toString('base64')
    const result = await f.mutate('font.import', { id: `family-${i}`, data, embeddingAllowed: true })
    expect(result.isError, JSON.stringify(result)).toBe(false)
  }
  const beforeInvalid = encodeDocumentBinary(f.editor.state.doc), version = f.editor.state.version
  for (const params of [
    { id: 'corrupt', data: 'AAAA', embeddingAllowed: true },
    { id: 'family-0', data: (await readFile(join(evidence, 'fonts/font-0.ttf'))).toString('base64'), embeddingAllowed: true },
  ]) expect((await f.mutate('font.import', params)).isError).toBe(true)
  expect(encodeDocumentBinary(f.editor.state.doc)).toEqual(beforeInvalid); expect(f.editor.state.version).toBe(version)
  const page0 = f.editor.state.doc.pages[0].id, page1 = '20000000-0000-4000-8000-000000000001'
  expect((await f.mutate('page.create', { id: page1, name: 'Unicode page' })).isError).toBe(false)
  const ids = Array.from({ length: 4 }, (_, i) => `30000000-0000-4000-8000-00000000000${i}`)
  for (let i = 0; i < 4; i++) {
    expect((await f.mutate('node.create', { id: ids[i], kind: 'text', parentId: i === 3 ? page1 : page0, x: 10, y: 10+i*45, width: 340, height: 45, patch: { fills: [paint('#17233b')] } })).isError).toBe(false)
    expect((await f.mutate('text.set', { ids: [ids[i]], text: i === 2 ? 'AB中文Ω' : i === 3 ? '中文Ω' : 'ABC', fontSize: 32, textStyle: { ...defaultTextStyle(), fontId: `family-${i === 3 ? 2 : i === 1 ? 1 : 0}`, fallbacks: ['family-2'] }, textRuns: i === 2 ? [{ start: 1, end: 2, fontId: 'family-1' }] : [] })).isError).toBe(false)
  }
  const settings = await f.mutate('font.apply', { nodeIds: [ids[2]], fontId: 'family-0', weight: 537, letterSpacing: .125, preserveRuns: true })
  expect(settings.isError).toBe(false)
  expect(f.editor.state.doc.nodes[ids[2]].textRuns?.[0].fontId).toBe('family-1')
  const invalidApply = encodeDocumentBinary(f.editor.state.doc)
  expect((await f.mutate('font.apply', { nodeIds: [ids[0]], fontId: 'missing' })).isError).toBe(true)
  expect(encodeDocumentBinary(f.editor.state.doc)).toEqual(invalidApply)
  const listed = await f.read('font.list'); expect(listed.result.fonts.filter((font: Json) => font.source === 'embedded')).toHaveLength(3)
  // Camera/page changes and targeted text settings must reuse admitted fonts.
  const reload = vi.spyOn(VectorEngine.prototype, 'load_document_fonts')
  for (let i = 0; i < 10; i++) f.editor.set({ view: { x: i, y: i, zoom: 1+i/100 } })
  f.editor.switchPage(page1); f.editor.switchPage(page0)
  expect((await f.mutate('font.apply', { nodeIds: [ids[0]], fontId: 'family-0', weight: 400 })).isError).toBe(false)
  expect(reload).not.toHaveBeenCalled(); reload.mockRestore()
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(f.editor.state.doc))
    const layouts = ids.map(id => JSON.parse(engine.text_layout(JSON.stringify(f.editor.state.doc.nodes[id]))))
    expect(layouts.every(layout => layout.glyphs.every((g: Json) => g.id > 0))).toBe(true)
    expect(layouts[2].glyphs.map((g: Json) => g.fontId)).toEqual(['family-0', 'family-1', 'family-2', 'family-2', 'family-2'])
    expect(layouts[1].glyphs[1].x).toBeGreaterThan(layouts[0].glyphs[1].x)
    const render = (pageId: string) => engine.render_region_png(JSON.stringify({ pageId, bounds: { x: 0, y: 0, width: 380, height: 220 }, scale: 1 }))
    const png0 = render(page0), png1 = render(page1)
    expect(png0.length).toBeGreaterThan(200); expect(png1.length).toBeGreaterThan(200); expect(png0).not.toEqual(png1)
    const pixels = await Promise.all([png0, png1].map(png => decode(new Blob([png as BlobPart]))))
    const ink = pixels.map(p => { let count = 0; for (let i = 0; i < p.pixels.length; i += 4) if (p.pixels[i+3] && p.pixels[i] < 80 && p.pixels[i+1] < 80) count++; return count })
    expect(pixels.map(p => [p.width, p.height])).toEqual([[380,220], [380,220]])
    expect(ink.every(count => count > 200)).toBe(true)
    await writeFile(join(evidence, 'page-1.png'), png0); await writeFile(join(evidence, 'page-2.png'), png1)
    const fd = await f.read('document.export', { format: 'fd' }), bytes = Buffer.from(fd.result.base64, 'base64')
    await writeFile(join(evidence, 'multifont.fd'), bytes)
    const reopened = await fixture(decodeDocumentBinary(new Uint8Array(await readFile(join(evidence, 'multifont.fd')))) as any)
    expect(reopened.editor.state.doc).toEqual(f.editor.state.doc)
    engine.load_document(JSON.stringify(reopened.editor.state.doc)); expect(render(page0)).toEqual(png0); expect(render(page1)).toEqual(png1)
    const before = encodeDocumentBinary(reopened.editor.state.doc), v = reopened.editor.state.version
    const replaced = replaceFontReferences(reopened.editor, { kind: 'document' }, 'family-0', 'family-1')
    expect(replaced.status).toBe('committed'); expect(replaced.changedNodes).toBe(2); expect(reopened.editor.state.version).toBe(v+1)
    expect(reopened.editor.state.doc.nodes[ids[2]].textStyle).toMatchObject({ fontId: 'family-1', weight: 537, letterSpacing: .125 })
    engine.load_document(JSON.stringify(reopened.editor.state.doc)); expect(render(page0)).not.toEqual(png0)
    reopened.editor.undo(); expect(encodeDocumentBinary(reopened.editor.state.doc)).toEqual(before)
    const svg = await f.read('vector.export', { pageId: page0 }); expect(svg.result.content).toContain('<svg')
    await writeFile(join(evidence, 'page-1.svg'), svg.result.content)
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ families: listed.result.fonts, layouts, inkPixels: ink, fdBytes: bytes.length, pngBytes: [png0.length, png1.length], replacement: replaced, transport: 'real in-memory MCP NDJSON', renderer: 'real Rust WASM CPU; no GUI/GPU/socket', fonts: 'three original CC0 synthetic fonts; no source/system fonts read' }, null, 2))
  } finally { engine.free() }
}, 60000)
