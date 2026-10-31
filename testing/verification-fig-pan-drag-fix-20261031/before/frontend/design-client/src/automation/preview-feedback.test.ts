import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Editor } from '../engine'
import { blank, node, paint, type DesignDocument } from '../model'
import { VectorEngine, transcode_export_png } from '../generated/design-kernel/design_kernel'
import type { KernelOptions } from '../kernel/client'
import * as raster from '../export'
import { captureDesignPreview, PREVIEW_LIMITS } from './export'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport } from './bridge'
import type { AutomationCapabilities, AutomationRequest } from './types'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

type Json = Record<string, any>
type WorkerRequest = { id: number; document?: string; options: KernelOptions; png: boolean; backend: string }
const cleanup: Array<() => void | Promise<void>> = []
const workers: ProductCpuWorker[] = [], requests: WorkerRequest[] = []
let defaultFont: Uint8Array, held = false
beforeAll(async () => { defaultFont = new Uint8Array(await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))) })
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  workers.splice(0).forEach(worker => worker.terminate()); requests.splice(0); held = false
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
/** Only the Web Worker message/lifetime boundary is replaced. The product
 * exportImage/KernelClient code and real WASM CPU raster/transcoder run unchanged.
 * No browser, socket, GPU, DOM renderer or SVG rasterizer is used here. */
class ProductCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor() { this.engine.load_font(defaultFont); workers.push(this) }
  postMessage(request: WorkerRequest) {
    requests.push(request)
    if (held) return
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (!request.png || request.backend !== 'cpu' || !request.options.exportRegion) throw Error('Only the product CPU export path is allowed by this harness')
        if (request.document) this.engine.load_document(request.document)
        let bytes = this.engine.render_region_png(JSON.stringify({ pageId: request.options.pageId, ...request.options.exportRegion, rasterProfile: request.options.rasterProfile, colorOutput: request.options.colorOutput }))
        if (request.options.exportFormat) bytes = transcode_export_png(bytes, request.options.exportFormat, request.options.exportRegion.scale)
        this.onmessage?.({ data: { id: request.id, buffer: bytes.buffer, stats: JSON.parse(this.engine.stats()), backend: 'cpu' } })
      } catch (error) { this.onmessage?.({ data: { id: request.id, error: String(error) } }) }
    })
  }
  terminate() { if (!this.terminated) { this.terminated = true; this.engine.free() } }
}
const installWorker = () => vi.stubGlobal('Worker', ProductCpuWorker)
const bytesOf = (result: Awaited<ReturnType<typeof captureDesignPreview>>) => Buffer.from(result.dataUrl.split(',')[1], 'base64')
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function sceneFixture() {
  const document = blank('Product CPU visual feedback')
  const board = node('frame', -12.5, 8.25, 480, 280), title = node('text', 28, 32, 420, 40), button = node('rectangle', 28, 180, 180, 52), label = node('text', 42, 192, 160, 28)
  board.name = 'Review card'; board.fills = [paint('#f5f6fa')]
  title.text = 'Review before you publish'; title.fontSize = 26; title.fills = [paint('#17233b')]
  button.name = 'Primary action'; button.fills = [paint('#b44138')]; button.radii = [10, 10, 10, 10]
  label.text = 'Preview changes'; label.fontSize = 18; label.fills = [paint('#ffffff')]
  board.children = [title.id, button.id, label.id]
  for (const item of [board, title, button, label]) document.nodes[item.id] = item
  document.pages[0].children = [board.id]
  return { document, board, title, button, label }
}
async function liveMcp(document: DesignDocument) {
  const editor = new Editor(document)
  let listener!: (request: DesktopAutomationRequest) => void, cancel!: (value: { requestId: string }) => void, sequence = 0
  const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const transport = {
    register: async () => {}, recordEdit: async () => ({ accepted: true }),
    respond: async (value: { requestId: string; result?: unknown; error?: { code: string; message: string } }) => {
      const waiter = waiting.get(value.requestId); waiting.delete(value.requestId)
      if (value.error) waiter?.reject(Object.assign(new Error(value.error.message), { code: value.error.code }))
      else waiter?.resolve(value.result)
    },
    onRequest: (callback: typeof listener) => { listener = callback; return () => {} },
    onCancel: (callback: typeof cancel) => { cancel = callback; return () => {} },
  } as unknown as DesktopAutomationTransport
  const detach = attachDesktopAutomation(editor, transport)
  const dispatch = (kind: 'execute' | 'capabilities', request?: AutomationRequest, signal?: AbortSignal) => new Promise<any>((resolve, reject) => {
    const requestId = `renderer-${++sequence}`, abort = () => cancel({ requestId })
    waiting.set(requestId, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value) }, reject })
    signal?.addEventListener('abort', abort, { once: true })
    listener({ requestId, kind, sessionId: 'in-memory-authorized-session', scope: 'write', documentId: editor.state.doc.id, session: editor.sessionGeneration, deadline: Date.now() + 15000, request })
  })
  const capabilities = (await dispatch('capabilities')).capabilities as AutomationCapabilities
  const backend = new OperationBackend({ capabilities, target: { documentId: editor.state.doc.id, session: editor.sessionGeneration }, execute: (request, context) => dispatch('execute', request, context.signal) })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', rpcId = 0
  const pending = new Map<number, (message: Json) => void>(), transcript: Json[] = []
  output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const resolve = pending.get(response.id); pending.delete(response.id); resolve?.(response) } })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); detach(); editor.dispose(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const id = ++rpcId, timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP ${id} timed out`)) }, 20000)
    pending.set(id, response => { clearTimeout(timer); transcript.push({ id, method, responseBytes: Buffer.byteLength(JSON.stringify(response)), ...(method === 'tools/call' ? { tool: params?.name, ok: response.result?.structuredContent?.ok, revision: response.result?.structuredContent?.revision } : {}) }); resolve(response) })
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'product-cpu-preview-regression', version: '1' } })
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (method: string, params: Json = {}, fence: Json = {}) => {
    const response = await rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...fence } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    return response.result
  }
  return { editor, rpc, call, transcript }
}

describe('actual product CPU preview raster', () => {
  it('captures PNG/JPEG/WebP with exact origin, dimensions and requested scale; preserves the document', async () => {
    installWorker()
    const { document, board } = sceneFixture(), before = JSON.stringify(document)
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const result = await captureDesignPreview(document, { nodeIds: [board.id], format, scale: 1.5 })
      const bytes = bytesOf(result)
      expect(result).toMatchObject({ documentId: document.id, pageId: document.pages[0].id, nodeIds: [board.id], width: 720, height: 420, scale: 1.5, bounds: { x: -12.5, y: 8.25, width: 480, height: 280 }, renderer: 'product-cpu-export', backend: 'cpu', screenshot: false, bytes: bytes.length })
      if (format === 'png') { expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([720, 420]) }
      if (format === 'jpeg') expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255])
      if (format === 'webp') { expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.toString('ascii', 8, 12)).toBe('WEBP') }
      expect(JSON.stringify(document)).toBe(before)
    }
    expect(workers).toHaveLength(3); expect(workers.every(worker => worker.terminated)).toBe(true)
    expect(requests.every(request => request.backend === 'cpu' && request.png && request.options.exportRegion?.scale === 1.5)).toBe(true)
  })
  it('rejects over-pixel and invalid scopes before allocating a raster worker', async () => {
    installWorker(); const { document, board } = sceneFixture()
    document.nodes[board.id].width = 5000; document.nodes[board.id].height = 5000
    await expect(captureDesignPreview(document)).rejects.toMatchObject({ code: 'preview_limit' })
    for (const options of [{ pageId: 'missing' }, { nodeIds: ['missing'] }, { nodeIds: [] }, { scale: 0.01 }]) await expect(captureDesignPreview(document, options)).rejects.toThrow()
    expect(workers).toHaveLength(0)
  })
  it('reports missing real renderer without an SVG or placeholder fallback', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(captureDesignPreview(sceneFixture().document)).rejects.toMatchObject({ code: 'renderer_unavailable' })
    expect(workers).toHaveLength(0)
  })
  it('cancels a held export and disposes its actual KernelClient worker boundary', async () => {
    installWorker(); held = true
    const controller = new AbortController(), pending = captureDesignPreview(sceneFixture().document, { signal: controller.signal })
    await vi.waitFor(() => expect(workers.length).toBe(1)); controller.abort(Error('Cancel preview'))
    await expect(pending).rejects.toThrow(); expect(workers[0].terminated).toBe(true)
  })
  it('counts base64 expansion before reading a large Blob and rejects inconsistent metadata', async () => {
    installWorker(); const { document } = sceneFixture()
    const blob = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/png' }), read = vi.spyOn(blob, 'arrayBuffer')
    vi.spyOn(raster, 'exportImage').mockResolvedValue({ name: 'large.png', blob, backend: 'cpu', width: 480, height: 280 })
    await expect(captureDesignPreview(document)).rejects.toMatchObject({ code: 'response_limit' })
    expect(blob.size).toBeLessThan(PREVIEW_LIMITS.responseBytes); expect(read).not.toHaveBeenCalled()
    vi.mocked(raster.exportImage).mockResolvedValue({ name: 'wrong.png', blob: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), backend: 'cpu', width: 480, height: 280 })
    await expect(captureDesignPreview(document)).rejects.toMatchObject({ code: 'invalid_preview' })
  })
})

it('runs inspect → guarded modification → actual CPU preview through renderer bridge and MCP image/resources', async () => {
  installWorker()
  const fixture = sceneFixture(), f = await liveMcp(fixture.document), pageId = fixture.document.pages[0].id
  const inspect = await f.call('context.get', { pageId, nodeIds: [fixture.board.id] })
  expect(inspect.isError).toBe(false)
  const observed = inspect.structuredContent, fence = { documentId: observed.documentId, session: observed.session, expectedRevision: observed.revision }
  const before = await f.call('preview.capture', { pageId, nodeIds: [fixture.board.id], scale: 1 }, fence)
  expect(before.isError, JSON.stringify(before.structuredContent.error)).toBe(false)
  const beforeImage = before.content.find((item: Json) => item.type === 'image')
  expect(beforeImage.mimeType).toBe('image/png'); expect(before.structuredContent.result.dataUrl).toBeUndefined()
  const beforeRef = before.structuredContent.result.resources[0]
  const readBefore = await f.rpc('resources/read', { uri: beforeRef.uri })
  expect(readBefore.result.contents[0].blob).toBe(beforeImage.data)
  const edit = await f.call('node.update', { ids: [fixture.button.id], patch: { fills: [paint('#245bd6')] } }, fence)
  expect(edit.isError).toBe(false); expect(edit.structuredContent.revision).toBe(fence.expectedRevision + 1)
  const stale = await f.call('preview.capture', { pageId }, fence)
  expect(stale.isError).toBe(true); expect(stale.structuredContent.error.code).toBe('REVISION_CONFLICT')
  const current = { ...fence, expectedRevision: edit.structuredContent.revision }
  const after = await f.call('preview.capture', { pageId, nodeIds: [fixture.board.id], scale: 1 }, current)
  expect(after.isError, JSON.stringify(after.structuredContent.error)).toBe(false)
  const afterImage = after.content.find((item: Json) => item.type === 'image')
  expect(afterImage.data).not.toBe(beforeImage.data)
  expect(after.structuredContent.result).toMatchObject({ revision: current.expectedRevision, session: fence.session, documentId: fence.documentId, pageId, nodeIds: [fixture.board.id], width: 480, height: 280, scale: 1, renderer: 'product-cpu-export' })
  // Old resources keep their original capture bytes, never masquerade as the new revision.
  expect((await f.rpc('resources/read', { uri: beforeRef.uri })).result.contents[0].blob).toBe(beforeImage.data)
  const afterRead = await f.rpc('resources/read', { uri: after.structuredContent.result.resources[0].uri })
  expect(afterRead.result.contents[0].blob).toBe(afterImage.data)
  expect(f.editor.state.doc.nodes[fixture.title.id]).toEqual(fixture.title)
  expect(f.editor.state.doc.nodes[fixture.button.id].fills[0].color).toBe('#245bd6')
  const undo = await f.call('history.undo', {}, current)
  expect(undo.isError).toBe(false)
  const restored = await f.call('preview.capture', { pageId, nodeIds: [fixture.board.id] }, { ...current, expectedRevision: undo.structuredContent.revision })
  expect(restored.content.find((item: Json) => item.type === 'image').data).toBe(beforeImage.data)
  const destination = process.env.FUTUREOX_VISUAL_FEEDBACK_DIR
  if (destination) {
    if (!path.isAbsolute(destination)) throw Error('FUTUREOX_VISUAL_FEEDBACK_DIR must be absolute')
    await mkdir(destination, { recursive: true })
    const beforeBytes = Buffer.from(beforeImage.data, 'base64'), afterBytes = Buffer.from(afterImage.data, 'base64')
    await writeFile(path.join(destination, 'product-cpu-before.png'), beforeBytes)
    await writeFile(path.join(destination, 'product-cpu-after.png'), afterBytes)
    await writeFile(path.join(destination, 'cpu-feedback-evidence.json'), JSON.stringify({
      kind: 'scripted-closed-loop-regression', renderer: 'actual product exportImage + KernelClient + WASM VectorEngine.render_region_png',
      boundaries: { worker: 'in-process adapter; real WASM raster and transcode', transport: 'real MCP NDJSON in memory', browser: 'not run', electron: 'not run', osSocket: 'not run', gpu: 'not run', externalModel: 'not used' },
      before: { ...before.structuredContent.result, resources: undefined, sha256: hash(beforeBytes) }, after: { ...after.structuredContent.result, resources: undefined, sha256: hash(afterBytes) },
      assertions: ['inspect and guarded edit through MCP', 'PNG pixels changed after authored fill edit', 'same size and requested scale', 'exact image/resource bytes', 'no duplicate inline base64', 'stale revision rejected', 'old resources immutable', 'undo restores exact PNG bytes', 'unrelated title unchanged'],
      wasmSha256: hash(await readFile(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))), transcript: f.transcript,
    }, null, 2) + '\n')
  }
}, 60000)

it('replays the agent visual-review decision against the exact previously inspected CPU pixels', async () => {
  installWorker()
  const decision = JSON.parse(await readFile(new URL('../../../../testing/verification-visual-feedback/agent-refinement.json', import.meta.url), 'utf8'))
  const fixture = sceneFixture(); fixture.button.fills = [paint('#245bd6')]
  const f = await liveMcp(fixture.document), pageId = fixture.document.pages[0].id
  const inspected = await f.call('context.get', { pageId, nodeIds: [fixture.board.id] })
  const observed = inspected.structuredContent, fence = { documentId: observed.documentId, session: observed.session, expectedRevision: observed.revision }
  const before = await f.call('preview.capture', { pageId, nodeIds: [fixture.board.id], scale: 1 }, fence)
  expect(before.isError).toBe(false)
  const baseline = Buffer.from(before.content.find((item: Json) => item.type === 'image').data, 'base64')
  expect(hash(baseline)).toBe(decision.observedSha256)
  expect(decision.decision.targetRole).toBe('label')
  const transform = [...fixture.label.transform]; transform[4] = decision.decision.x
  const modified = await f.call('batch.apply', { operations: [
    { method: 'node.update', params: { ids: [fixture.label.id], patch: { transform, width: decision.decision.width } } },
    { method: 'text.set', params: { ids: [fixture.label.id], textStyle: { align: decision.decision.align } } },
  ] }, fence)
  expect(modified.isError, JSON.stringify(modified.structuredContent.error)).toBe(false)
  const after = await f.call('preview.capture', { pageId, nodeIds: [fixture.board.id], scale: 1 }, { ...fence, expectedRevision: modified.structuredContent.revision })
  expect(after.isError).toBe(false)
  const reviewed = Buffer.from(after.content.find((item: Json) => item.type === 'image').data, 'base64')
  expect(hash(reviewed)).not.toBe(hash(baseline))
  expect(after.structuredContent.result).toMatchObject({ width: 480, height: 280, scale: 1, renderer: 'product-cpu-export' })
  expect(f.editor.state.doc.nodes[fixture.button.id]).toEqual(fixture.button)
  expect(f.editor.state.doc.nodes[fixture.title.id]).toEqual(fixture.title)
  expect(f.editor.state.doc.nodes[fixture.label.id]).toMatchObject({ width: 180, textStyle: { align: 'center' } })
  const destination = process.env.FUTUREOX_VISUAL_FEEDBACK_DIR
  if (destination) {
    if (!path.isAbsolute(destination)) throw Error('FUTUREOX_VISUAL_FEEDBACK_DIR must be absolute')
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'product-cpu-reviewed.png'), reviewed)
    await writeFile(path.join(destination, 'agent-review-evidence.json'), JSON.stringify({
      kind: 'actual-agent-inspection-followed-by-guarded-refinement', decision, beforeSha256: hash(baseline), afterSha256: hash(reviewed),
      metadata: { ...after.structuredContent.result, resources: undefined },
      assertions: ['input PNG exactly matches inspected source hash', 'decision loaded after inspection from recorded refinement', 'real MCP fenced atomic batch', 'actual product CPU PNG changes', 'dimensions and scale unchanged', 'button and title preserved'],
      limits: 'Synthetic card. In-process Worker and NDJSON transport boundaries. Browser/Electron/socket/GPU not run. No external model provider.', transcript: f.transcript,
    }, null, 2) + '\n')
  }
}, 60000)
