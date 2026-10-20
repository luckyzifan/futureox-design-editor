import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { blank, node, paint, effect, validateDocument } from '../model'
import { layoutFixture } from '../layout-fixtures'
import { componentFixture } from '../component-fixtures'
import { emptySystem } from '../design-system'
import { getDesignContext } from './context'
import { decodeDocumentBinary } from '../kernel/binfmt'
import { defaultTextStyle } from '../model'
import { Editor } from '../engine'
import { createDesignAutomation } from './core'
import { exportDesignCode, exportDesignSvg, exportNativeDocument, exportBinaryDocument, importNativeDocument, captureDesignPreview, exportExtensions } from './export'

function fixture() {
  const document = blank('Export fixture'), frame = node('frame', 5, 10, 300, 200), text = node('text', 10, 10, 150, 50)
  text.text = 'Native to semantic'; text.fontSize = 20; frame.children = [text.id]
  document.nodes = { [frame.id]: frame, [text.id]: text }; document.pages[0].children = [frame.id]
  return { document, frame, text }
}
describe('AI-friendly semantic export', () => {
  it.each(['horizontal', 'grid'] as const)('exports the real %s layout deterministically with complete stable node-ID mappings', kind => {
    const document = layoutFixture(kind), before = JSON.stringify(document)
    const a = exportDesignCode(document), b = exportDesignCode(document)
    expect(a).toEqual(b); expect(JSON.stringify(document)).toBe(before)
    expect(a.css).toContain(kind === 'grid' ? 'display:grid' : 'display:flex')
    for (const id of Object.keys(document.nodes)) {
      expect(a.html).toContain(`data-node-id="${id}"`)
      expect(a.css).toContain(a.nodeIdMap[id].selector)
    }
    expect(a.warnings.some(w => w.code === 'LAYOUT_APPROXIMATION')).toBe(true)
    expect(a.fidelity).toBe('approximate')
  })
  it('escapes hostile names, text and URLs without emitting executable user strings', () => {
    const { document, frame, text } = fixture(); document.schemaVersion = 5
    document.name = '</title><script>alert(1)</script>'
    frame.name = '"><img src=x onerror=alert(1)>'
    text.text = '<script>alert("unsafe")</script>'
    text.textRuns = [{ start: 0, end: text.text.length, link: 'javascript:alert(1)' }]
    const image = paint('#fff', 'image'); image.image = 'data:image/svg+xml,<svg onload="alert(1)"/>'; frame.fills.push(image)
    const result = exportDesignCode(document)
    expect(result.html).not.toContain('<script>'); expect(result.html).not.toContain('<img ')
    expect(result.html).toContain('&lt;script&gt;'); expect(result.html).not.toContain('href="javascript:')
    expect(result.css).not.toContain('onload'); expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNSAFE_ASSET_URL' }), expect.objectContaining({ code: 'UNSAFE_LINK' })]))
    expect(result.html).toContain("script-src 'none'")
  })
  it('exports portable image manifests and safe links, and flags unsupported material effects', () => {
    const { document, frame, text } = fixture(); document.schemaVersion = 5
    const image = paint('#fff', 'image'); image.image = 'data:image/png;base64,iVBORw0KGgo='; frame.fills = [image]; frame.effects = [effect('glass'), effect('noise')]
    text.textRuns = [{ start: 0, end: text.text.length, link: 'https://example.test/?a=1&b=2', underline: true }]
    const result = exportDesignCode(document)
    expect(result.assets[0]).toMatchObject({ source: 'embedded', emitted: true, dataUrl: image.image })
    expect(result.html).toContain('href="https://example.test/?a=1&amp;b=2"')
    expect(result.css).toContain('text-decoration:underline')
    expect(result.warnings.some(w => w.code === 'UNSUPPORTED_EFFECT' && w.nodeId === frame.id)).toBe(true)
  })
  it('keeps old 32-bit hash collisions distinct while deduplicating genuinely identical images', () => {
    // These two different URLs collide under the previous FNV-1a identity.
    const urls = ['https://assets.example.test/000339ff.png', 'https://assets.example.test/00078880.png']
    const legacyHash = (value: string) => { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
    expect(legacyHash(urls[0])).toBe(legacyHash(urls[1]))
    const document = blank('Asset identities'), nodes = [0, 1, 0].map(index => {
      const n = node('rectangle'), p = paint('#fff', 'image'); p.image = urls[index]; n.fills = [p]
      document.nodes[n.id] = n; document.pages[0].children.push(n.id); return n
    })
    const context = getDesignContext(document), code = exportDesignCode(document)
    expect(context.assets).toHaveLength(2); expect(code.assets).toHaveLength(2)
    expect(context.assets[0].id).not.toBe(context.assets[1].id)
    expect(context.assets[0].nodeIds).toEqual([nodes[0].id, nodes[2].id])
    expect(code.assets.map(a => a.id)).toEqual(context.assets.map(a => a.id))
    expect(code.assets.map(a => a.uri)).toEqual(urls)
    expect(context.nodes[0].materialRefs[0].assetId).toBe(context.nodes[2].materialRefs[0].assetId)
    expect(context.nodes[1].materialRefs[0].assetId).not.toBe(context.nodes[0].materialRefs[0].assetId)
    const pageOne = getDesignContext(document, { limit: 1 }), pageTwo = getDesignContext(document, { limit: 1, cursor: pageOne.pagination.nextCursor! })
    expect(pageOne.assets[0].id).toBe(context.assets[0].id)
    expect(pageTwo.assets[0].id).toBe(context.assets[1].id)
  })
  it('exports component-resolved content and token values through existing kernel layout', () => {
    const { doc } = componentFixture()
    const result = exportDesignCode(doc)
    expect(result.html).toContain('继续')
    expect(Object.keys(result.nodeIdMap).length).toBeGreaterThan(5)
    const { document, text } = fixture(); document.schemaVersion = 4; document.designSystem = emptySystem()
    document.designSystem.collections.colors = { name: 'Colors', modes: ['light'], defaultMode: 'light' }
    document.designSystem.variables.brand = { name: 'Brand', kind: 'color', collection: 'colors', values: { light: '#123456' } }
    text.bindings = { 'fills.0.color': 'brand' }
    expect(exportDesignCode(document).css).toContain('#123456')
  })
  it('fails bounded scope instead of silently dropping nodes', () => {
    const { document } = fixture()
    expect(() => exportDesignCode(document, { maxNodes: 1 })).toThrow('maxNodes')
    expect(() => exportDesignCode(document, { nodeIds: ['missing'] })).toThrow('selected page')
  })
})
describe('native document roundtrip', () => {
  it('returns lossless deterministic source and appends with remapped graph IDs, tokens and behavior', () => {
    const { document: source, frame, text } = fixture(); source.schemaVersion = 4
    source.designSystem = emptySystem(); source.designSystem.collections.c = { name: 'Spacing', modes: ['base'], defaultMode: 'base' }
    source.designSystem.variables.size = { name: 'Size', kind: 'number', collection: 'c', values: { base: 20 } }; text.bindings = { fontSize: 'size' }
    source.prototype = { startNode: frame.id, interactions: { [frame.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: text.id }] }] } }
    const exported = exportNativeDocument(source)
    expect(validateDocument(JSON.parse(exported.content))).toEqual(source)
    expect(exportNativeDocument(source)).toEqual(exported)
    const destination = blank('Destination'), originalId = destination.id, context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'native-json', content: exported.content }, context)
    expect(destination.id).toBe(originalId); expect(result.rootIds).toHaveLength(1)
    expect(result.nodeIdMap[frame.id]).not.toBe(frame.id)
    expect(destination.nodes[result.nodeIdMap[frame.id]].children).toEqual([result.nodeIdMap[text.id]])
    expect(destination.nodes[result.nodeIdMap[text.id]].text).toBe(text.text)
    expect(destination.prototype?.interactions[result.nodeIdMap[frame.id]][0].actions[0].target).toBe(result.nodeIdMap[text.id])
    expect(Object.keys(destination.designSystem!.variables)).toHaveLength(1)
    expect(context.createdIds).toHaveLength(3)
  })
  it('roundtrips actual .fd binfmt with a valid embedded font, components, and checksum rejection', () => {
    // Tiny valid TTF built from one original triangle glyph, no external font or OS dependency.
    const font = 'AAEAAAAKAIAAAwAgT1MvMkUARDUAAAEoAAAAYGNtYXAAdQBbAAABkAAAADxnbHlmGK0tqwAAAdQAAAAYaGVhZC9jsVYAAACsAAAANmhoZWEFFgH2AAAA5AAAACRobXR4AlgAAAAAAYgAAAAIbG9jYQAMAAwAAAHMAAAACG1heHAABQAFAAABCAAAACBuYW1lUXVW+QAAAewAAAFxcG9zdAApAAMAAANgAAAAKAABAAAAAQAA2FGhaF8PPPUAAQPoAAAAAOb7tt0AAAAA5vu23QAyAAACJgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYAAAAZAH0AAEAAAAAAAAAAAAAAAAAAAABAAEAAAADAAMAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAQQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAKAAAAAYABAABAAIAIABB//8AAAAgAEH////i/8AAAQAAAAAAAAAAAAAADAAMAAEAMgAAAiYCvAACAAAzExMy+voCvP1EAAAACgB+AAEAAAAAAAEAFAAAAAEAAAAAAAIABwAUAAEAAAAAAAMAGgAbAAEAAAAAAAQAHAA1AAEAAAAAAAYAGgAbAAMAAQQJAAEAKABRAAMAAQQJAAIADgB5AAMAAQQJAAMANACHAAMAAQQJAAQAOAC7AAMAAQQJAAYANACHQXV0b21hdGlvbiBUZXN0IEZvbnRSZWd1bGFyQXV0b21hdGlvblRlc3RGb250LVJlZ3VsYXJBdXRvbWF0aW9uIFRlc3QgRm9udCBSZWd1bGFyAEEAdQB0AG8AbQBhAHQAaQBvAG4AIABUAGUAcwB0ACAARgBvAG4AdABSAGUAZwB1AGwAYQByAEEAdQB0AG8AbQBhAHQAaQBvAG4AVABlAHMAdABGAG8AbgB0AC0AUgBlAGcAdQBsAGEAcgBBAHUAdABvAG0AYQB0AGkAbwBuACAAVABlAHMAdAAgAEYAbwBuAHQAIABSAGUAZwB1AGwAYQByAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAACQAAw=='
    const { doc: source, ids } = componentFixture(); source.schemaVersion = 4
    source.fonts = { test: { family: 'Automation Test Font', data: font } }
    source.nodes[ids.label].text = 'A A'
    source.nodes[ids.button].component!.properties[ids.title].defaultValue = 'A A'
    source.nodes[ids.label].textStyle = { ...defaultTextStyle(), fontId: 'test' }
    const exported = exportBinaryDocument(source)
    expect(exported.filename).toBe('design.fd'); expect(exported.mimeType).toBe('application/vnd.futureox-desgin')
    const bytes = Uint8Array.from(atob(exported.base64), c => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('FXDK')
    expect(decodeDocumentBinary(bytes)).toEqual(source)
    const destination = blank(), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'fd', base64: exported.base64 }, context)
    expect(Object.values(destination.fonts ?? {}).some(f => f.data === font)).toBe(true)
    expect(destination.nodes[result.nodeIdMap[ids.a]].instance?.componentId).toBe(result.nodeIdMap[ids.button])
    expect(destination.nodes[result.nodeIdMap[ids.label]].text).toBe('A A')
    const before = JSON.stringify(destination)
    bytes[bytes.length - 1] ^= 1
    const corrupt = btoa(String.fromCharCode(...bytes))
    expect(() => importNativeDocument(destination, { format: 'fd', base64: corrupt }, context)).toThrow('checksum')
    expect(JSON.stringify(destination)).toBe(before)
  })
  it('carries the bundled 17.77 MB CJK font through real .fd import/export under the 32 MiB envelope', async () => {
    const font = await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))
    const { document: source, text } = fixture()
    source.fonts = { cjk: { family: 'Noto Sans SC', data: font.toString('base64') } }
    text.textStyle = { ...defaultTextStyle(), fontId: 'cjk' }; text.text = '真实字体'
    const exported = exportBinaryDocument(source)
    expect(exported.base64.length).toBeGreaterThan(8 * 1024 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(exported)).byteLength).toBeLessThan(32 * 1024 * 1024)
    const destination = blank(), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'fd', base64: exported.base64 }, context)
    expect(destination.nodes[result.nodeIdMap[text.id]].text).toBe('真实字体')
    expect(Object.values(destination.fonts ?? {})[0].data).toBe(font.toString('base64'))
  }, 30000)
  it('rejects malformed/native-format mismatches atomically', () => {
    const destination = blank(), before = JSON.stringify(destination), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    for (const params of [{ format: 'html', content: '<html/>' }, { format: 'native-json', content: '{bad' }, { format: 'native-json', document: {} }, { format: 'native-json', content: '{}', document: {} }]) {
      expect(() => importNativeDocument(destination, params, context)).toThrow()
      expect(JSON.stringify(destination)).toBe(before); expect(context.createdIds).toEqual([])
    }
  })
  it('runs import/export through the actual automation boundary and one-step undo', () => {
    const { document: source } = fixture(), editor = new Editor(blank()), api = createDesignAutomation(editor, exportExtensions)
    try {
      const read = api.execute({ method: 'document.export' }); expect(read.ok).toBe(true)
      const before = editor.state.doc
      const imported = api.execute({ method: 'document.import', documentId: read.documentId, session: read.session, expectedRevision: read.revision, params: { format: 'native-json', content: exportNativeDocument(source).content } })
      expect(imported.ok).toBe(true); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(3)
      const exported = api.execute({ method: 'document.export' }); expect(exported.ok).toBe(true)
      if (exported.ok) expect(Object.keys(JSON.parse((exported.result as { content: string }).content).nodes)).toHaveLength(3)
      editor.undo(); expect(editor.state.doc).toEqual(before)
    } finally { api.dispose(); editor.dispose() }
  })
})
describe('existing vector and raster adapters', () => {
  it('exports actual native SVG text outlines for a whole page', () => {
    const { document } = fixture(), result = exportDesignSvg(document)
    expect(result.content).toContain('<svg'); expect(result.content).toContain('<path')
    expect(result.content).not.toContain('<text'); expect(result.bounds.width).toBeGreaterThan(0)
    expect(result.sourceNodeIds).toEqual(document.pages[0].children)
  })
  it('rejects unsupported SVG materials and unsafe URLs rather than claiming fidelity', () => {
    const { document, frame } = fixture(); frame.effects = [effect('glass')]
    expect(() => exportDesignSvg(document)).toThrow('cannot faithfully')
    frame.effects = []; const image = paint('#fff', 'image'); image.image = 'javascript:alert(1)'; frame.fills = [image]
    expect(() => exportDesignSvg(document)).toThrow('unsafe image')
  })
  it('rejects unavailable or over-budget raster requests before rendering and respects cancellation', async () => {
    const { document, frame } = fixture()
    await expect(captureDesignPreview(document, { scale: 0 })).rejects.toThrow('scale')
    const controller = new AbortController(); controller.abort()
    await expect(captureDesignPreview(document, { signal: controller.signal })).rejects.toThrow()
    frame.width = 10000; frame.height = 10000
    await expect(captureDesignPreview(document)).rejects.toThrow('megapixels')
  })
})

it('MCP vector export validates type-specific options and returns real gzip/precision output', async () => {
  const { gunzipSync } = await import('fflate')
  const { document } = fixture(), editor = new Editor(document), api = createDesignAutomation(editor, exportExtensions)
  const result = api.execute({ method: 'vector.export', params: { pageId: document.pages[0].id, scale: 2, precision: 3, compression: 'gzip' } })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const out = result.result as { filename: string; base64: string; options: object; precisionLossy: boolean; warnings: { code: string }[] }
  expect(out.filename).toBe('design.svgz'); expect(out.precisionLossy).toBe(true)
  expect(out.options).toEqual({ scale: 2, precision: 3, compression: 'gzip', textMode: 'outlines', fontMode: 'references' })
  expect(out.warnings.some(w => w.code === 'SVG_PRECISION_LOSS')).toBe(true)
  expect(new TextDecoder().decode(gunzipSync(Uint8Array.from(atob(out.base64), c => c.charCodeAt(0))))).toContain('<svg')
  for (const [method, params] of [['vector.export', { precision: 9 }], ['vector.export', { quality: 90 }], ['vector.export', { compression: 'zip' }], ['document.export', { format: 'fd', precision: 2 }], ['document.export', { format: 'fd', compression: 'gzip' }]] as const) expect(api.execute({ method, params }).ok).toBe(false)
  editor.dispose()
})

it('FD component instance nodeIdMap points to committed materialized descendants', () => {
  const source = componentFixture().doc, editor = new Editor(blank()), api = createDesignAutomation(editor, exportExtensions)
  try {
    const read = api.execute({ method: 'document.export' })
    const response = api.execute({ method: 'document.import', documentId: read.documentId, session: read.session, expectedRevision: read.revision, params: { format: 'fd', base64: exportBinaryDocument(source).base64 } })
    expect(response.ok, JSON.stringify(response)).toBe(true); if (!response.ok) return
    const result = response.result as { operations: { result: { nodeIdMap: Record<string, string>; createdIds: string[] } }[] }
    const imported = result.operations[0].result
    expect(Object.keys(imported.nodeIdMap).length).toBeGreaterThan(10)
    for (const id of Object.values(imported.nodeIdMap)) expect(editor.state.doc.nodes[id], id).toBeDefined()
    for (const id of imported.createdIds) expect(editor.state.doc.nodes[id], id).toBeDefined()
    editor.undo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
  } finally { api.dispose(); editor.dispose() }
})
