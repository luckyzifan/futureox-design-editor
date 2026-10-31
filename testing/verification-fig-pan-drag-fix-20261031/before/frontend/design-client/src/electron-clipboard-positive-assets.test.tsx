// Real dispatcher/export serializer and CPU WASM bytes. KernelClient transport is
// replaced with an in-process adapter; this does NOT exercise browser workers,
// Electron native-image conversion, OS clipboard acceptance, or GUI rendering.
import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { svgSource, targetBounds } from './export'

const transport = vi.hoisted(() => ({ requests: [] as any[], disposed: 0 }))
vi.mock('./kernel/client', async importOriginal => {
  const original = await importOriginal<typeof import('./kernel/client')>()
  const { VectorEngine } = await import('./generated/design-kernel/design_kernel')
  return { ...original, KernelClient: class {
    async render(doc: unknown, options: any, png: boolean, backend: string) {
      if (!png || backend !== 'cpu' || !options.exportRegion) throw Error('Unexpected export transport request')
      transport.requests.push({ doc, options, png, backend })
      const engine = new VectorEngine()
      try {
        engine.load_document(JSON.stringify(doc))
        const bytes = engine.render_region_png(JSON.stringify({ pageId: options.pageId, ...options.exportRegion, rasterProfile: options.rasterProfile, colorOutput: options.colorOutput })).slice()
        return { backend: 'cpu', bytes }
      } finally { engine.free() }
    }
    dispose() { transport.disposed++ }
  } }
})
afterEach(() => { vi.unstubAllGlobals(); transport.requests.length = 0; transport.disposed = 0 })
function fixture() {
  const d = blank('Private document'), selected = node('rectangle', 10, 20, 8, 6), unrelated = node('rectangle', 100, 100, 50, 50)
  selected.name = 'Authored red'; selected.fills = [paint('#ff0000')]; selected.strokes = []; selected.effects = []
  unrelated.name = 'Private blue'; unrelated.fills = [paint('#0000ff')]
  d.nodes = { [selected.id]: selected, [unrelated.id]: unrelated }; d.pages[0].children = [selected.id, unrelated.id]
  const editor = new Editor(d); editor.select([selected.id]); return { editor, selected, unrelated }
}
it('copy-as-svg writes actual selected SVG to native svg/text without editing source or history', async () => {
  const { editor, selected, unrelated } = fixture(), before = editor.state.doc, version = editor.state.version
  const write = vi.fn(async (_payload: any) => ({ status: 'ok' }))
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write } } })
  try {
    await dispatchEditorCommand(editor, 'copy-as-svg')
    expect(write).toHaveBeenCalledTimes(1)
    const payload = write.mock.calls[0][0]
    expect(payload.svg).toBe(svgSource(before, editor.state.page, { kind: 'selection', nodeIds: [selected.id] }).source)
    expect(payload.text).toBe(payload.svg); expect(payload.svg).toContain('<svg')
    expect(payload.svg).not.toContain(unrelated.id); expect(payload.svg).not.toContain('Private blue')
    expect(payload.image).toBeUndefined(); expect(transport.requests).toHaveLength(0)
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})
it('copy-as-png writes real CPU PNG bytes for only the selected region at 2x', async () => {
  const { editor, selected } = fixture(), before = editor.state.doc, version = editor.state.version
  const write = vi.fn(async (_payload: any) => ({ status: 'ok' }))
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write } } })
  try {
    await dispatchEditorCommand(editor, 'copy-as-png')
    expect(write).toHaveBeenCalledTimes(1); expect(transport.requests).toHaveLength(1); expect(transport.disposed).toBe(1)
    const payload = write.mock.calls[0][0]
    expect(payload.image).toMatch(/^data:image\/png;base64,/)
    const bytes = Buffer.from(payload.image.split(',')[1], 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([137,80,78,71,13,10,26,10])
    expect(bytes.readUInt32BE(16)).toBe(16); expect(bytes.readUInt32BE(20)).toBe(12)
    const request = transport.requests[0]
    expect(request.options.exportRegion.nodeIds).toEqual([selected.id]); expect(request.options.exportRegion.scale).toBe(2)
    const engine = new VectorEngine()
    try {
      engine.load_document(JSON.stringify(before))
      const expected = engine.render_region_png(JSON.stringify({ pageId: editor.state.page, bounds: targetBounds(before, editor.state.page, { kind: 'selection', nodeIds: [selected.id] }), scale: 2, nodeIds: [selected.id] }))
      expect(bytes).toEqual(Buffer.from(expected))
    } finally { engine.free() }
    expect(payload.svg).toBeUndefined(); expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})
