import { afterEach, expect, test, vi } from 'vitest'
import { blank, effect, node, paint, validateDocument, type DesignDocument } from './model'
import { defaultColorSettings } from './color'
import { Editor } from './engine'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge } from './desktop'
import { readDesignFile } from './persistence'
import { prepareDocumentForEditing } from './kernel/picking'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { KernelClient, type KernelOptions } from './kernel/client'
import { compilationWitness, coordinateSlot, ExactTileCache } from './kernel/exact-tile-cache'
import { documentPatch } from './document-patch'
import type { GpuScene } from './kernel/gpu/types'
import { exportImage, exportVisualSvg, svgExportIssues } from './export'

function gradientDocument() {
  const doc = blank('Software profile QA')
  doc.schemaVersion = 5
  doc.rasterProfile = 'figmaSoftware'
  const shape = node('rectangle', 0, 0, 32, 32)
  const fill = paint('#000000', 'linear')
  fill.angle = 0
  fill.opacity = 0.73
  fill.stops = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
  shape.fills = [fill]
  doc.nodes = { [shape.id]: shape }
  doc.pages[0].children = [shape.id]
  return doc
}
function options(doc: DesignDocument): KernelOptions {
  return { pageId: doc.pages[0].id, width: 32, height: 32,
    view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false }
}
function compile(engine: VectorEngine, doc: DesignDocument, profile?: KernelOptions['rasterProfile']) {
  engine.load_document(JSON.stringify(doc))
  return engine.compile_gpu(JSON.stringify({ ...options(doc), ...(profile ? { rasterProfile: profile } : {}) }))
}
function bits(values: Float32Array) {
  return new Uint32Array(values.buffer, values.byteOffset, values.length).slice()
}
const sessions: DesktopSession[] = []
afterEach(() => { sessions.splice(0).forEach((s) => s.dispose()); vi.unstubAllGlobals() })

test('software profile survives portable JSON file admission and editor reopening', async () => {
  const original = gradientDocument()
  const file = new File([JSON.stringify(original)], 'software.fd', { type: 'application/json' })
  const imported = await readDesignFile(file)
  const reopened = prepareDocumentForEditing(imported.document)
  const editor = new Editor()
  editor.load(reopened)
  expect(editor.state.doc.rasterProfile).toBe('figmaSoftware')
  expect(editor.state.doc.nodes).toEqual(original.nodes)
  expect(imported.warnings).toEqual([])
  expect(() => validateDocument({ ...original, rasterProfile: 'figmaSoftware-unknown' })).toThrow()
})

test('native file save and reopen retain profile through the real session lifecycle', async () => {
  const editor = new Editor(gradientDocument())
  let documentJson = ''
  const ok = { status: 'ok' } as const
  const cancelled = { status: 'cancelled' } as const
  const bridge = {
    version: 1, renderPolicy: { cpuOnly: true },
    openDocument: vi.fn(async () => ({ ...ok, handle: 'profile-file', displayName: 'profile.fd', documentJson })),
    acceptDocument: vi.fn(async () => ok),
    saveDocument: vi.fn(async (request: { documentJson: string }) => {
      documentJson = request.documentJson
      return { ...ok, handle: 'profile-file', displayName: 'profile.fd' }
    }),
    readRecovery: vi.fn(async () => cancelled), acceptRecovery: vi.fn(async () => ok),
    writeRecovery: vi.fn(async () => ok), clearRecovery: vi.fn(async () => ok),
    setDirty: vi.fn(async () => {}), onCommand: vi.fn(() => () => {}),
    onCloseRequested: vi.fn(() => () => {}), respondToClose: vi.fn(async () => ({ accepted: true })),
  } as unknown as DesktopBridge
  const session = new DesktopSession(bridge, editor, async () => 'discard')
  sessions.push(session)
  await session.start()
  expect(await session.save(true)).toBe(true)
  expect(JSON.parse(documentJson).rasterProfile).toBe('figmaSoftware')
  editor.change('Switch profile', (doc) => { doc.rasterProfile = 'figma' })
  expect(session.dirty).toBe(true)
  expect(await session.open()).toBe(true)
  expect(editor.state.doc.rasterProfile).toBe('figmaSoftware')
  expect(session.dirty).toBe(false)
})

test('undo and redo preserve profile-only edits and restore the actual CPU pixels', () => {
  const doc = gradientDocument()
  doc.rasterProfile = 'figma'
  const editor = new Editor(doc), engine = new VectorEngine()
  const render = () => {
    engine.load_document(JSON.stringify(editor.state.doc))
    return engine.render_rgba(JSON.stringify(options(doc))).slice()
  }
  try {
    const old = editor.state.doc, previous = render()
    editor.change('Software raster', (draft) => { draft.rasterProfile = 'figmaSoftware' })
    const changed = editor.state.doc, software = render()
    expect(documentPatch(old, changed).fields.rasterProfile).toBe('figmaSoftware')
    expect(software).not.toEqual(previous)
    editor.undo()
    expect(editor.state.doc.rasterProfile).toBe('figma')
    expect(render()).toEqual(previous)
    editor.redo()
    expect(editor.state.doc.rasterProfile).toBe('figmaSoftware')
    expect(render()).toEqual(software)
  } finally { engine.free() }
})

test('compiled witnesses separate old and software profiles at one exact tile coordinate', () => {
  const doc = gradientDocument(), engine = new VectorEngine()
  try {
    const old = compile(engine, doc, 'figma'), software = compile(engine, doc, 'figmaSoftware')
    const before = JSON.parse(old) as GpuScene, after = JSON.parse(software) as GpuScene
    expect(before.softwareRaster).toBe(false)
    expect(after.softwareRaster).toBe(true)
    expect(after.floatCompositing).toBe(false)
    expect(after.width).toBe(64)
    expect(after.height).toBe(64)
    expect(after.coherentSamples).toBe(true)
    expect(after.resolve).toMatchObject({ width: 32, height: 32, scale: 0.5 })
    for (const n of Object.values(after.nodes)) expect(n.fill.sampleCount).toBe(4)
    const cache = new ExactTileCache<string>(), slot = coordinateSlot([0, 0, 32, 32, 1, 0, 0, 0, 0])
    cache.set(slot, compilationWitness(old), 'old pixels', 4096)
    expect(cache.get(slot, compilationWitness(software))).toBeUndefined()
    cache.set(slot, compilationWitness(software), 'software pixels', 4096)
    expect(cache.get(slot, compilationWitness(old))).toBeUndefined()
    expect(compile(engine, doc)).toBe(software)
  } finally { engine.free() }
})

test('client sends a new revision on profile edits and preserves explicit render overrides', async () => {
  type Request = { id: number; options: KernelOptions; documentRevision: number; documentPatch?: string }
  class WorkerStub {
    static active: WorkerStub
    messages: Request[] = []
    onmessage?: (event: { data: unknown }) => void
    constructor() { WorkerStub.active = this }
    postMessage(request: Request) { this.messages.push(request) }
    terminate() {}
    reply() { const { id } = this.messages.at(-1)!; this.onmessage?.({ data: { id, backend: 'cpu', milliseconds: 0, stats: {} } }) }
  }
  vi.stubGlobal('Worker', WorkerStub)
  const client = new KernelClient(), doc = gradientDocument()
  try {
    const first = client.render(doc, options(doc), false, 'cpu'); WorkerStub.active.reply(); await first
    const previous = { ...doc, rasterProfile: 'figma' as const }
    const second = client.render(previous, options(doc), false, 'cpu'); WorkerStub.active.reply(); await second
    const undo = client.render(doc, options(doc), false, 'cpu'); WorkerStub.active.reply(); await undo
    const explicit = client.render(doc, { ...options(doc), rasterProfile: 'figma' }, false, 'cpu'); WorkerStub.active.reply(); await explicit
    const messages = WorkerStub.active.messages
    expect(messages.map((r) => r.options.rasterProfile)).toEqual(['figmaSoftware', 'figma', 'figmaSoftware', 'figma'])
    expect(messages[1].documentRevision).toBeGreaterThan(messages[0].documentRevision)
    expect(messages[2].documentRevision).toBeGreaterThan(messages[1].documentRevision)
    expect(messages[3].documentRevision).toBe(messages[2].documentRevision)
    expect(JSON.parse(messages[1].documentPatch!).fields).toEqual({ rasterProfile: 'figma' })
    expect(JSON.parse(messages[2].documentPatch!).fields).toEqual({ rasterProfile: 'figmaSoftware' })
  } finally { client.dispose() }
})

test.each([30, 315, -30])('managed glass at %s degrees keeps the existing float algorithm and sampling density', (angle) => {
  const doc = gradientDocument()
  doc.colorManagement = defaultColorSettings()
  const background = doc.nodes[doc.pages[0].children[0]]
  background.fills[0].opacity = 1
  background.fills[0].stops = [
    { offset: 0, color: 'color(srgb-linear 2 0.25 0.125)' },
    { offset: 1, color: 'color(srgb-linear 0.1 1.5 0.5)' },
  ]
  const glass = node('rectangle', 8, 8, 16, 16)
  glass.radii = [4, 4, 4, 4]
  glass.fills = [{ ...paint('#ffffff'), opacity: 0.1 }]
  const material = effect('glass')
  material.radius = 0
  material.glass = { depth: 4, refraction: 0.5, dispersion: 0.2, lightAngle: angle, lightIntensity: 0.75 }
  glass.effects = [material]
  doc.nodes[glass.id] = glass
  doc.pages[0].children.push(glass.id)
  const engine = new VectorEngine()
  try {
    validateDocument(doc)
    const previousScene = compile(engine, doc, 'figma'), softwareScene = compile(engine, doc, 'figmaSoftware')
    expect(JSON.parse(softwareScene).softwareRaster).toBe(false)
    expect(JSON.parse(softwareScene).floatCompositing).toBe(true)
    expect(JSON.parse(softwareScene).width).toBe(64)
    expect(JSON.parse(softwareScene).coherentSamples).toBe(true)
    expect(softwareScene).toBe(previousScene)
    const previous = bits(engine.render_linear(JSON.stringify({ ...options(doc), rasterProfile: 'figma' })))
    const software = engine.render_linear(JSON.stringify({ ...options(doc), rasterProfile: 'figmaSoftware' }))
    expect(software.some((value) => value > 1)).toBe(true)
    expect(bits(software)).toEqual(previous)
  } finally { engine.free() }
})

test('plain SVG reports software rounding while existing vector profiles remain supported', async () => {
  const software = gradientDocument()
  expect(svgExportIssues(software, software.pages[0].id)).toContain('软件渲染的精确像素取整')
  await expect(exportImage(software, software.pages[0].id, 'svg', 1))
    .rejects.toThrow('软件渲染的精确像素取整')
  for (const rasterProfile of ['analytic', 'figma'] as const) {
    const doc = { ...software, rasterProfile }
    expect(svgExportIssues(doc, doc.pages[0].id)).toEqual([])
    const result = await exportImage(doc, doc.pages[0].id, 'svg', 1)
    expect(await result.blob.text()).toContain('<linearGradient')
  }
})

test('visual SVG embeds actual CPU PNG with the software profile and releases its worker', async () => {
  type Request = { id: number; document?: string; options: KernelOptions; png: boolean; backend: string }
  const requests: Request[] = []
  let rendered: Uint8Array | undefined
  let terminated = false
  class CpuWorker {
    onmessage?: (event: { data: Record<string, unknown> }) => void
    private engine = new VectorEngine()
    postMessage(request: Request) {
      requests.push(request)
      queueMicrotask(() => {
        try {
          if (request.document) this.engine.load_document(request.document)
          const bytes = this.engine.render_region_png(JSON.stringify({
            pageId: request.options.pageId,
            ...request.options.exportRegion,
            rasterProfile: request.options.rasterProfile,
          }))
          rendered = bytes.slice()
          this.onmessage?.({ data: { id: request.id, buffer: bytes.buffer, backend: 'cpu',
            stats: JSON.parse(this.engine.stats()) } })
        } catch (error) {
          this.onmessage?.({ data: { id: request.id, error: String(error) } })
        }
      })
    }
    terminate() { if (!terminated) { terminated = true; this.engine.free() } }
  }
  vi.stubGlobal('Worker', CpuWorker)
  const doc = gradientDocument(), before = JSON.stringify(doc)
  const asset = await exportVisualSvg(doc, doc.pages[0].id, 1)
  const source = await asset.blob.text()
  expect(source).toContain('软件渲染的精确像素取整')
  expect(source).not.toContain('<linearGradient')
  const encoded = source.match(/data:image\/png;base64,([^\"]+)/)?.[1]
  expect(encoded).toBeDefined()
  const embedded = new Uint8Array(Buffer.from(encoded!, 'base64'))
  expect(embedded).toEqual(rendered)
  expect(Array.from(embedded.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(requests).toHaveLength(1)
  expect(requests[0].backend).toBe('cpu')
  expect(requests[0].options.rasterProfile).toBe('figmaSoftware')
  expect(terminated).toBe(true)
  expect(JSON.stringify(doc)).toBe(before)
})
