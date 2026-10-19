import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { import_sketch_json } from '../generated/design-kernel/design_kernel'
import { blank, defaultTextStyle, node, validateDocument } from '../model'
import { Editor } from '../engine'
import { createEditorDesignAutomation } from './index'
import { exportSketchDocument, importSketchDocument, SKETCH_LIMITS } from './sketch'
import type { AutomationResponse } from './types'

const ids = {
  page: '10000000-0000-0000-0000-000000000001',
  board: '10000000-0000-0000-0000-000000000002',
  master: '10000000-0000-0000-0000-000000000003',
  label: '10000000-0000-0000-0000-000000000004',
  instance: '10000000-0000-0000-0000-000000000005',
  rotated: '10000000-0000-0000-0000-000000000006',
  symbol: '10000000-0000-0000-0000-000000000099',
}
function nativeArchive(symbols = false) {
  // Original native-format fixture, generated for every run. No private fixture,
  // application export, futureox userInfo or skipped test substitutes for input.
  const style = { _class: 'style', fills: [{ _class: 'fill', isEnabled: true, fillType: 0,
    color: { _class: 'color', red: 0.2, green: 0.4, blue: 0.8, alpha: 1 } }] }
  const layer = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
    _class: kind, do_objectID: id, name: kind, isVisible: true,
    frame: { x: 10, y: 20, width: 120, height: 40 }, style, ...extra,
  })
  const text = layer(ids.label, 'text', { textBehaviour: 2,
    attributedString: { _class: 'attributedString', string: 'Original Sketch text', attributes: [{ location: 0, length: 20, attributes: {
      MSAttributedStringFontAttribute: { _class: 'fontDescriptor', attributes: { name: 'UnavailableDemo-Regular', size: 18 } },
    } }] },
  })
  const layers = symbols ? [
    layer(ids.master, 'symbolMaster', { symbolID: ids.symbol, layers: [text] }),
    layer(ids.instance, 'symbolInstance', { symbolID: ids.symbol, frame: { x: 200, y: 20, width: 120, height: 40 }, overrideValues: [] }),
  ] : [text]
  layers.push(layer(ids.rotated, 'rectangle', { rotation: 30, isFlippedHorizontal: true }))
  return zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 144, appVersion: '93' })),
    'document.json': strToU8(JSON.stringify({ _class: 'document', pages: [{ _ref: `pages/${ids.page}` }] })),
    [`pages/${ids.page}.json`]: strToU8(JSON.stringify({ _class: 'page', do_objectID: ids.page, name: 'Original synthetic page', layers: [
      layer(ids.board, 'artboard', { frame: { x: 50, y: 60, width: 600, height: 400 }, layers }),
    ] })),
  }, { level: 0 })
}
function base64(bytes: Uint8Array) { return Buffer.from(bytes).toString('base64') }
function bytes(value: string) { return new Uint8Array(Buffer.from(value, 'base64')) }
function context(document: ReturnType<typeof blank>) { return { pageId: document.pages[0].id, selection: [], createdIds: [] as string[] } }
function result<T>(response: AutomationResponse): T {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.result as T
}
type Imported = ReturnType<typeof importSketchDocument>
type Exported = ReturnType<typeof exportSketchDocument>
function current(editor: Editor) { return { expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration } }

describe('real local Sketch binary automation', () => {
  it('appends native ZIP nodes with fresh IDs and authored local transforms, reporting actual font substitution', () => {
    const source = nativeArchive(), report = JSON.parse(import_sketch_json(source))
    const document = blank('Destination'), documentId = document.id, ctx = context(document)
    const imported = importSketchDocument(document, { base64: base64(source), name: 'original-synthetic.sketch' }, ctx)
    expect(document.id).toBe(documentId)
    expect(imported).toMatchObject({ sourceFormat: 'sketch', mode: 'append', fidelity: 'compatibility', lossless: false })
    expect(Object.keys(imported.nodeIdMap).sort()).toEqual([ids.board, ids.label, ids.rotated].sort())
    for (const [sourceId, localId] of Object.entries(imported.nodeIdMap)) {
      expect(localId).not.toBe(sourceId)
      expect(document.nodes[localId].transform).toEqual(report.document.nodes[sourceId].transform)
    }
    const text = document.nodes[imported.nodeIdMap[ids.label]]
    expect(text.text).toBe('Original Sketch text'); expect(text.textStyle?.fontId).toBe('default')
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SKETCH_FONT_RESOURCES' }),
      expect.objectContaining({ code: 'SKETCH_SOURCE_FONTS', message: expect.stringContaining('UnavailableDemo-Regular') }),
      expect.objectContaining({ code: 'SKETCH_APPEND_SOURCE_METADATA' }),
      expect.objectContaining({ code: 'SKETCH_CODEC_NOTICE', message: expect.stringContaining('fonts without embedded resources') }),
    ]))
    expect(imported.omittedSourceContainers).toContain('nodeMetadata')
    expect(document.nodes[imported.rootIds[0]].name).toBe('original-synthetic.sketch')
    expect(ctx.createdIds.sort()).toEqual(Object.keys(document.nodes).sort())
    expect(validateDocument(document)).toBe(document)
  })

  it('maps native Sketch symbol IDs to editable master IDs and remaps instances on append', () => {
    const document = blank(), ctx = context(document)
    expect(() => import_sketch_json(nativeArchive(true))).not.toThrow()
    const imported = importSketchDocument(document, { base64: base64(nativeArchive(true)) }, ctx)
    const master = document.nodes[imported.nodeIdMap[ids.master]], instance = document.nodes[imported.nodeIdMap[ids.instance]]
    expect(master.component).toBeDefined()
    expect(instance.instance?.componentId).toBe(master.id)
    expect(master.children).toContain(imported.nodeIdMap[ids.label])
    expect(validateDocument(document)).toBe(document)
  })

  it('exports an actual Sketch ZIP and reimports editable content and transforms through the shared registry', () => {
    const editor = new Editor(blank('Registry')), api = createEditorDesignAutomation(editor)
    try {
      const before = structuredClone(editor.state.doc)
      expect(api.methods().map(method => method.name)).toEqual(expect.arrayContaining(['sketch.import', 'sketch.export']))
      const imported = result<{ operations: { result: Imported }[] }>(api.execute({ method: 'sketch.import', ...current(editor), params: { base64: base64(nativeArchive()), name: 'original-synthetic.sketch' } })).operations[0].result
      const after = structuredClone(editor.state.doc)
      const exported = result<Exported>(api.execute({ method: 'sketch.export' }))
      expect(exported).toMatchObject({ filename: 'design.sketch', mimeType: 'application/zip', encoding: 'base64', lossless: false })
      const binary = bytes(exported.base64)
      expect([...binary.subarray(0, 4)]).toEqual([0x50, 0x4b, 3, 4])
      const files = unzipSync(binary)
      expect(Object.keys(files)).toContain('document.json')
      expect(JSON.parse(strFromU8(files['document.json']))._class).toBe('document')
      const reopened = JSON.parse(import_sketch_json(binary)).document
      expect(Object.keys(reopened.nodes).length).toBe(Object.keys(after.nodes).length)
      expect(reopened.nodes[imported.nodeIdMap[ids.label]].text).toBe('Original Sketch text')
      reopened.nodes[imported.nodeIdMap[ids.rotated]].transform.forEach((value: number, index: number) =>
        expect(value).toBeCloseTo(after.nodes[imported.nodeIdMap[ids.rotated]].transform[index], 12))
      expect(editor.state.doc).toEqual(after)
      editor.undo(); expect(editor.state.doc).toEqual(before)
      editor.redo(); expect(editor.state.doc).toEqual(after)
    } finally { api.dispose(); editor.dispose() }
  })

  it('does not alias caller document state and repeated imports have disjoint fresh IDs', () => {
    const document = blank(), ctx = context(document), params = { base64: base64(nativeArchive()) }
    const first = importSketchDocument(document, params, ctx), snapshot = structuredClone(document)
    const second = importSketchDocument(document, params, ctx)
    expect(new Set([...first.createdIds, ...second.createdIds]).size).toBe(first.createdIds.length + second.createdIds.length)
    for (const id of first.createdIds) expect(document.nodes[id]).toEqual(snapshot.nodes[id])
    document.nodes[second.nodeIdMap[ids.label]].text = 'Edited independently'
    expect(document.nodes[first.nodeIdMap[ids.label]].text).toBe('Original Sketch text')
  })

  it('exports current API-edited rotation/flip/translation instead of stale imported placement metadata', () => {
    const editor = new Editor(blank()), api = createEditorDesignAutomation(editor)
    try {
      const imported = result<{ operations: { result: Imported }[] }>(api.execute({ method: 'sketch.import', ...current(editor), params: { base64: base64(nativeArchive()) } })).operations[0].result
      const id = imported.nodeIdMap[ids.rotated], angle = 0.47
      const transform = [Math.cos(angle), Math.sin(angle), Math.sin(angle), -Math.cos(angle), 333.25, -77.5]
      result(api.execute({ method: 'node.update', ...current(editor), params: { ids: [id], patch: { transform } } }))
      const exported = result<Exported>(api.execute({ method: 'sketch.export' }))
      const reopened = JSON.parse(import_sketch_json(bytes(exported.base64))).document
      reopened.nodes[id].transform.forEach((value: number, index: number) => expect(value).toBeCloseTo(transform[index], 12))
    } finally { api.dispose(); editor.dispose() }
  })

  it('exports new authored rigid transforms without Sketch metadata and explicitly rejects shear/scale', () => {
    const document = blank(), rectangle = node('rectangle', 0, 0, 100, 40), angle = 1.1
    rectangle.transform = [Math.cos(angle), Math.sin(angle), Math.sin(angle), -Math.cos(angle), 10.125, 20.75]
    document.nodes[rectangle.id] = rectangle; document.pages[0].children.push(rectangle.id)
    const exported = exportSketchDocument(document)
    const reopened = JSON.parse(import_sketch_json(bytes(exported.base64))).document
    reopened.nodes[rectangle.id].transform.forEach((value: number, index: number) => expect(value).toBeCloseTo(rectangle.transform[index], 12))
    for (const transform of [[1, 0, 0.25, 1, 10, 20], [2, 0, 0, 1, 10, 20]]) {
      rectangle.transform = transform as typeof rectangle.transform
      expect(() => exportSketchDocument(document)).toThrow('could not export')
    }
  })

  it('rejects fake formats, malformed base64 and corrupt or unsafe archives without changing the destination', () => {
    const document = blank(), before = structuredClone(document), ctx = context(document)
    const badArchives = [
      base64(strToU8('<svg/>')), base64(strToU8('{"_class":"document"}')), '!!!!', 'A===', 'AB==',
      base64(nativeArchive().subarray(0, 60)),
      base64(zipSync({ 'meta.json': strToU8('{}'), '../escape.json': strToU8('{}') })),
      base64(zipSync({ 'meta.json': strToU8('{}'), 'document.json': strToU8('{broken') })),
      base64(zipSync({ 'canvas.fig': strToU8('fig-kiwi') })),
    ]
    for (const input of badArchives) {
      expect(() => importSketchDocument(document, { base64: input }, ctx)).toThrow()
      expect(document).toEqual(before); expect(ctx.createdIds).toEqual([])
    }
    expect(() => importSketchDocument(document, { base64: base64(nativeArchive()), pageId: 'missing' }, ctx)).toThrow()
    expect(document).toEqual(before); expect(ctx.createdIds).toEqual([])
  })

  it('enforces transfer and authoritative ZIP expansion budgets without fake passes', () => {
    const document = blank(), before = structuredClone(document), ctx = context(document)
    expect(() => importSketchDocument(document, { base64: 'A'.repeat(SKETCH_LIMITS.transferBytes + 4) }, ctx)).toThrow('transfer budget')
    const bomb = zipSync({ 'meta.json': strToU8('{}'), 'document.json': new Uint8Array(2 * 1024 * 1024) }, { level: 9 })
    expect(bomb.byteLength).toBeLessThan(20000)
    expect(() => importSketchDocument(document, { base64: base64(bomb) }, ctx)).toThrow('rejected the archive')
    expect(document).toEqual(before); expect(ctx.createdIds).toEqual([])
  })

  it('requires mutation fences and rolls back a batch containing a failed Sketch import', () => {
    const editor = new Editor(blank()), api = createEditorDesignAutomation(editor), before = structuredClone(editor.state.doc)
    try {
      const unfenced = api.execute({ method: 'sketch.import', params: { base64: base64(nativeArchive()) } })
      expect(unfenced).toMatchObject({ ok: false, error: { code: 'missing_revision' } })
      const failed = api.execute({ method: 'batch.apply', ...current(editor), params: { operations: [
        { method: 'sketch.import', params: { base64: base64(nativeArchive()) } },
        { method: 'sketch.import', params: { base64: base64(strToU8('not an archive')) } },
      ] } })
      expect(failed.ok).toBe(false); expect(editor.state.doc).toEqual(before); expect(editor.state.version).toBe(0)
    } finally { api.dispose(); editor.dispose() }
  })

  it('warns about actual embedded font-binary loss instead of claiming native-document fidelity', async () => {
    const document = blank(), text = node('text', 0, 0, 200, 50)
    const font = await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))
    document.fonts = { local: { family: 'Noto Sans SC', data: font.toString('base64') } }
    text.text = 'Font export'; text.textStyle = { ...defaultTextStyle(), fontId: 'local' }
    document.nodes[text.id] = text; document.pages[0].children.push(text.id)
    const exported = exportSketchDocument(document)
    expect(exported.lossless).toBe(false)
    expect(exported.warnings.some(warning => warning.code === 'SKETCH_FONT_RESOURCES')).toBe(true)
    const reopened = JSON.parse(import_sketch_json(bytes(exported.base64))).document
    expect(reopened.nodes[text.id].textStyle.fontId).toBe('default')
    expect(Object.keys(reopened.fonts ?? {})).toHaveLength(0)
    expect(exported.bytes).toBeLessThan(font.byteLength)
  }, 30000)
})
