import { readFileSync, appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, defaultTextStyle, node, type DesignDocument } from './model'
import { applySelectionFont, fontTargets, replaceFontReferences, searchFontChoices } from './font-management'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { registerPendingEdit } from './pending-edits'
import { emptySystem } from './design-system'
import { componentFixture, originNode } from './component-fixtures'
import { VectorEngine, font_faces_json } from './generated/design-kernel/design_kernel'
import { fontTestBytes } from './font-test-fixtures'

const bytes = fontTestBytes
const latin = { family: 'Noto Sans SC Latin subset', data: bytes('noto-latin').toString('base64'), index: 0 }
const cjk = { family: 'Noto Sans SC CJK subset', data: bytes('noto-cjk').toString('base64'), index: 0 }
const editors: Editor[] = []
const editor = (doc: DesignDocument) => { const e = new Editor(doc); editors.push(e); return e }
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.restoreAllMocks() })
function fixture(count = 3) {
  const doc = blank('Font edits'), ids: string[] = []
  doc.fonts = { latin, cjk }
  for (let i = 0; i < count; i++) {
    const n = node('text', i * 20, 0, 240, 30); n.text = 'ABC中文'; n.fontSize = 17.125
    n.textStyle = { ...defaultTextStyle(), fontId: 'latin', fallbacks: ['cjk', 'default'], weight: 537, letterSpacing: .125 }
    n.textRuns = [{ start: 0, end: 1, fontId: 'cjk', fontSize: 11.75, weight: 625, color: '#112233' }, { start: 1, end: 3, fontId: 'latin', underline: true }, { start: 3, end: 5 }]
    doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); ids.push(n.id)
  }
  doc.schemaVersion = 4
  return { doc, ids }
}

test('replacement is one history entry and preserves mixed runs, fallbacks, precision and real disk bytes', () => {
  const { doc, ids } = fixture(), e = editor(doc), before = e.state.doc, version = e.state.version
  const change = vi.spyOn(e, 'change')
  const result = replaceFontReferences(e, { kind: 'selection', ids: ids.slice(0, 2) }, 'latin', 'cjk')
  expect(result.status).toBe('committed'); expect(result.changedReferences).toBe(4); expect(change).toHaveBeenCalledTimes(1)
  expect(e.state.version).toBe(version + 1)
  for (const id of ids.slice(0, 2)) {
    const n = e.state.doc.nodes[id]
    expect(n.textStyle).toEqual({ ...before.nodes[id].textStyle, fontId: 'cjk' })
    expect(n.textRuns).toEqual(before.nodes[id].textRuns!.map(run => ({ ...run, ...(run.fontId === 'latin' ? { fontId: 'cjk' } : {}) })))
    expect(n.text).toBe('ABC中文'); expect(n.fontSize).toBe(17.125)
  }
  expect(e.state.doc.nodes[ids[2]]).toEqual(before.nodes[ids[2]])
  const after = e.state.doc, afterBytes = encodeDocumentBinary(after), beforeBytes = encodeDocumentBinary(before)
  expect(afterBytes).not.toEqual(beforeBytes)
  e.undo(); expect(e.state.doc).toEqual(before); expect(encodeDocumentBinary(e.state.doc)).toEqual(beforeBytes)
  e.redo(); expect(e.state.doc).toEqual(after)
  const directory = mkdtempSync(join(tmpdir(), 'font-batch-'))
  try {
    const path = join(directory, 'fonts.fd'); writeFileSync(path, afterBytes)
    const reopened = editor(decodeDocumentBinary(new Uint8Array(readFileSync(path))) as DesignDocument)
    expect(reopened.state.doc).toEqual(after); expect(encodeDocumentBinary(reopened.state.doc)).toEqual(afterBytes)
    expect(reopened.state.doc.fonts).toEqual({ latin, cjk })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('whole-layer apply clears only run fonts and explicit selected locked text stays editable', () => {
  const { doc, ids } = fixture(); doc.nodes[ids[0]].locked = true
  const e = editor(doc), before = e.state.doc
  const result = applySelectionFont(e, ids.slice(0, 2), 'cjk')
  expect(result.status).toBe('committed')
  for (const id of ids.slice(0, 2)) {
    const n = e.state.doc.nodes[id]
    expect(n.textStyle).toEqual({ ...before.nodes[id].textStyle, fontId: 'cjk' })
    expect(n.textRuns).toEqual(before.nodes[id].textRuns!.map(({ fontId: _fontId, ...run }) => run))
  }
  e.undo(); expect(e.state.doc).toEqual(before)
})

test('document replacement honors ancestor locks, linked styles, and explicit fallback opt-in', () => {
  const { doc, ids } = fixture(4), group = node('group'); group.locked = true; group.children = [ids[0]]
  doc.nodes[group.id] = group; doc.pages[0].children = [group.id, ...ids.slice(1)]
  doc.designSystem = emptySystem(); doc.designSystem.styles.body = { name: 'Body', kind: 'text', value: { ...defaultTextStyle(), fontId: 'latin', fallbacks: ['cjk'] } }
  doc.nodes[ids[1]].styleRefs = { textStyle: 'body' }
  const e = editor(doc), before = e.state.doc
  const result = replaceFontReferences(e, { kind: 'document' }, 'latin', 'cjk')
  expect(result.skippedLocked).toBe(1); expect(result.skippedLinked).toBe(1)
  expect(e.state.doc.nodes[ids[0]]).toEqual(before.nodes[ids[0]]); expect(e.state.doc.nodes[ids[1]]).toEqual(before.nodes[ids[1]])
  e.undo()
  const withFallback = replaceFontReferences(e, { kind: 'selection', ids: [ids[1], ids[2]] }, 'cjk', 'default', { includeFallbacks: true, detachSharedStyle: true })
  expect(withFallback.status).toBe('committed')
  expect(e.state.doc.nodes[ids[1]].styleRefs?.textStyle).toBeUndefined()
  expect(e.state.doc.designSystem?.styles.body).toEqual(before.designSystem?.styles.body)
  expect(e.state.doc.nodes[ids[2]].textStyle?.fallbacks).toEqual(['default', 'default'])
})

test('shared-style application requires explicit local override and undo restores the link', () => {
  const { doc, ids } = fixture(1); doc.designSystem = emptySystem()
  doc.designSystem.styles.body = { name: 'Body', kind: 'text', value: { ...defaultTextStyle(), fontId: 'latin' } }
  doc.nodes[ids[0]].styleRefs = { textStyle: 'body' }
  const e = editor(doc), before = e.state.doc
  expect(applySelectionFont(e, ids, 'cjk').status).toBe('blocked'); expect(e.state.doc).toBe(before)
  expect(applySelectionFont(e, ids, 'cjk', { detachSharedStyle: true }).status).toBe('committed')
  expect(e.state.doc.nodes[ids[0]].styleRefs?.textStyle).toBeUndefined()
  expect(e.state.doc.nodes[ids[0]].textStyle?.fontId).toBe('cjk')
  e.undo(); expect(e.state.doc).toEqual(before)
})

test('document replacement preserves component inheritance and updates existing local font overrides', () => {
  const { doc, ids } = componentFixture(); doc.fonts = { latin, cjk }; doc.nodes[ids.label].textStyle = { ...defaultTextStyle(), fontId: 'latin' }
  const e = editor(doc), key = e.state.doc.nodes[ids.label].componentKey!
  const a = originNode(e.state.doc, ids.a, key), b = originNode(e.state.doc, ids.b, key)
  expect(applySelectionFont(e, [a.id], 'cjk').status).toBe('committed')
  e.updateProperties([a.id], n => { n.textStyle!.fontId = 'latin'; n.textStyle!.weight = 800 })
  const before = e.state.doc
  console.info('FONT_COMPONENT_BEFORE', JSON.stringify({ key, a: before.nodes[ids.a].instance?.overrides, generated: before.nodes[a.id].instanceOrigin, style: before.nodes[a.id].textStyle }))
  expect(before.nodes[ids.a].instance!.overrides[key]?.textStyle).toMatchObject({ fontId: 'latin', weight: 800 })
  const result = replaceFontReferences(e, { kind: 'document' }, 'latin', 'cjk')
  expect(result.status, result.message).toBe('committed'); expect(result.inherited).toBeGreaterThan(0)
  expect(e.state.doc.nodes[ids.a].instance!.overrides[key].textStyle).toMatchObject({ fontId: 'cjk' })
  expect(e.state.doc.nodes[ids.b].instance!.overrides[key]).toBeUndefined()
  expect(e.state.doc.nodes[b.id].textStyle?.fontId).toBe('cjk')
  applySelectionFont(e, [ids.label], 'default')
  expect(e.state.doc.nodes[b.id].textStyle?.fontId).toBe('default')
  expect(e.state.doc.nodes[a.id].textStyle?.fontId).toBe('cjk')
  e.undo(); e.undo(); expect(e.state.doc).toEqual(before)
})

test('invalid resources, same-font no-op, and pending drafts cannot create a partial font change', () => {
  const { doc, ids } = fixture(1), e = editor(doc), before = e.state.doc, version = e.state.version
  expect(replaceFontReferences(e, { kind: 'selection', ids }, 'latin', 'latin').status).toBe('unchanged')
  expect(replaceFontReferences(e, { kind: 'selection', ids }, 'latin', 'missing').status).toBe('rejected')
  expect(applySelectionFont(e, ids, 'bad', {}, { family: 'Bad bytes', data: btoa('not a font') }).status).toBe('rejected')
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(version)
  const unregister = registerPendingEdit(e, { dirty: () => true, commit: () => false })
  expect(applySelectionFont(e, ids, 'cjk').status).toBe('blocked')
  expect(replaceFontReferences(e, { kind: 'selection', ids }, 'latin', 'cjk').status).toBe('blocked')
  expect(e.state.doc).toBe(before); unregister()
})

test('real subset faces shape supported glyphs and missing CJK uses the explicit fallback without rewriting font IDs', () => {
  const faces = JSON.parse(font_faces_json(new Uint8Array(bytes('noto-latin'))))
  expect(faces[0].family).toContain('Noto Sans SC')
  const { doc, ids } = fixture(1), n = doc.nodes[ids[0]]; n.textRuns = []; n.text = 'ABC中文'; n.textStyle!.fallbacks = ['cjk']
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify(doc.fonts))
    const result = JSON.parse(engine.text_layout(JSON.stringify(n)))
    expect(result.glyphs.length).toBe(5)
    expect(result.glyphs.every((g: { id: number }) => g.id > 0)).toBe(true)
    expect(result.glyphs.slice(0, 3).every((g: { fontId: string }) => g.fontId === 'latin')).toBe(true)
    expect(result.glyphs.slice(3).every((g: { fontId: string }) => g.fontId === 'cjk')).toBe(true)
    expect(n.textStyle?.fontId).toBe('latin')
  } finally { engine.free() }
})

test('1000 text layers use one atomic edit and linear target/run visits, with a controlled CPU report', () => {
  const { doc, ids } = fixture(1000), e = editor(doc), before = e.state.doc, version = e.state.version
  const start = performance.now(), result = replaceFontReferences(e, { kind: 'document' }, 'latin', 'cjk'), durationMs = performance.now() - start
  expect(result.status).toBe('committed'); expect(result.visitedNodes).toBe(1000); expect(result.visitedRuns).toBe(3000)
  expect(result.changedNodes).toBe(1000); expect(result.changedReferences).toBe(2000); expect(e.state.version).toBe(version + 1)
  for (const id of ids) expect(e.state.doc.nodes[id].textStyle?.fontId).toBe('cjk')
  e.undo(); expect(e.state.doc).toEqual(before)
  const metric = { runtime: 'real Editor/WASM, CPU only; no GPU or browser FPS claim', nodes: ids.length, durationMs, ...result, targets: undefined }
  console.info('FONT_BATCH_CPU', JSON.stringify(metric))
  if (process.env.FONT_BATCH_METRICS) appendFileSync(process.env.FONT_BATCH_METRICS, JSON.stringify(metric) + '\n')
}, 120000)

test('metadata search is tokenized across real family, style and PostScript fields', () => {
  const fonts = [{ id: 'a', family: 'Noto Sans SC', style: 'Bold', postscript: 'NotoSansSC-Bold' }, { id: 'b', family: 'Noto Sans SC', style: 'Regular', postscript: 'NotoSansSC-Regular' }]
  expect(searchFontChoices(fonts, 'SC bold')).toEqual([fonts[0]])
  expect(searchFontChoices(fonts, 'NotoSansSC-Regular')).toEqual([fonts[1]])
  expect(fontTargets(fixture().doc, { kind: 'selection', ids: ['missing'] }).targets).toEqual([])
})

test('source matching keeps locked/shared text unchanged and inherited components follow the master without new overrides', async () => {
  const { matchSourceFontsInDocument } = await import('./font-management')
  const { doc, ids } = componentFixture(); doc.fonts = { latin, cjk }; doc.designSystem = emptySystem(); doc.schemaVersion = 4
  doc.designSystem.fontSources = { [ids.label]: { style: 'NotoSource' } }
  const locked = node('text'); locked.text = 'ABC'; locked.locked = true
  const linked = node('text'); linked.text = 'ABC'; linked.styleRefs = { textStyle: 'body' }
  doc.designSystem.styles.body = { name: 'Body', kind: 'text', value: defaultTextStyle() }
  for (const n of [locked, linked]) { doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); doc.designSystem.fontSources[n.id] = { style: 'NotoSource' } }
  const e = editor(doc), before = e.state.doc, key = before.nodes[ids.label].componentKey!
  const result = e.change('Match source fonts', d => { matchSourceFontsInDocument(d, new Map([['NotoSource', { id: 'latin', resource: latin }]])) })
  expect(result?.status, e.state.message).toBe('committed')
  expect(e.state.doc.nodes[ids.label].textStyle?.fontId).toBe('latin')
  expect(originNode(e.state.doc, ids.b, key).textStyle?.fontId).toBe('latin')
  expect(e.state.doc.nodes[ids.b].instance?.overrides[key]).toBeUndefined()
  expect(e.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id]); expect(e.state.doc.nodes[linked.id]).toEqual(before.nodes[linked.id])
  applySelectionFont(e, [ids.label], 'cjk')
  expect(originNode(e.state.doc, ids.b, key).textStyle?.fontId).toBe('cjk')
  e.undo(); e.undo(); expect(e.state.doc).toEqual(before)
})

test('the shared whole-text helper preserves nested font settings and component override capture', async () => {
  const { applyWholeTextStyle } = await import('./text')
  const { doc, ids } = componentFixture(); doc.fonts = { latin, cjk }; doc.schemaVersion = 4
  doc.nodes[ids.label].textStyle = { ...defaultTextStyle(), fallbacks: ['cjk', 'default'], features: ['kern'], variations: [{ tag: 'wdth', value: 75 }] }
  doc.nodes[ids.label].textRuns = [{ start: 0, end: 2, fontId: 'cjk', weight: 300, fontSize: 12.75, color: '#112233' }]
  const e = editor(doc), key = e.state.doc.nodes[ids.label].componentKey!, before = e.state.doc
  e.updateProperties([ids.label], n => applyWholeTextStyle(n, { fontId: 'latin' }))
  const a = originNode(e.state.doc, ids.a, key), b = originNode(e.state.doc, ids.b, key)
  expect(a.textStyle?.fontId, e.state.message).toBe('latin'); expect(b.textStyle?.fontId).toBe('latin')
  expect(e.state.doc.nodes[ids.a].instance!.overrides[key]).toBeUndefined(); expect(e.state.doc.nodes[ids.b].instance!.overrides[key]).toBeUndefined()
  e.updateProperties([a.id], n => applyWholeTextStyle(n, { weight: 700, features: ['kern', 'ss01'], variations: [{ tag: 'wdth', value: 90 }] }))
  expect(e.state.doc.nodes[ids.a].instance!.overrides[key]?.textStyle, e.state.message).toMatchObject({ fontId: 'latin', weight: 700, fallbacks: ['cjk', 'default'], features: ['kern', 'ss01'], variations: [{ tag: 'wdth', value: 90 }] })
  expect(e.state.doc.nodes[a.id].textRuns?.[0]).toEqual({ start: 0, end: 2, fontSize: 12.75, color: '#112233' })
  e.updateProperties([ids.label], n => applyWholeTextStyle(n, { fontId: 'cjk' }))
  expect(e.state.doc.nodes[b.id].textStyle?.fontId).toBe('cjk'); expect(e.state.doc.nodes[a.id].textStyle?.fontId).toBe('latin')
  const after = e.state.doc
  expect(editor(decodeDocumentBinary(encodeDocumentBinary(after)) as DesignDocument).state.doc).toEqual(after)
  e.undo(); e.undo(); e.undo(); expect(e.state.doc).toEqual(before)
})

test('source discovery filters ancestor locks, linked styles and inherited fields before native reads', async () => {
  const { unmatchedEditableSourceFonts } = await import('./font-management')
  const { doc, ids } = componentFixture(); doc.schemaVersion = 4; doc.designSystem = emptySystem()
  const e = editor(doc), key = e.state.doc.nodes[ids.label].componentKey!, a = originNode(e.state.doc, ids.a, key), b = originNode(e.state.doc, ids.b, key)
  e.updateProperties([a.id], n => { n.textRuns = [{ start: 0, end: 2, fontId: 'default', weight: 700 }] })
  expect(e.state.doc.nodes[ids.a].instance?.overrides[key]).toHaveProperty('textRuns')
  expect(e.state.doc.nodes[ids.a].instance?.overrides[key]).not.toHaveProperty('textStyle')
  const group = node('group'), lockedChild = node('text'), linked = node('text'); group.locked = true; group.children = [lockedChild.id]
  e.change('Source discovery fixture', d => {
    d.designSystem = emptySystem(); d.designSystem.styles.body = { name: 'Body', kind: 'text', value: defaultTextStyle() }
    linked.styleRefs = { textStyle: 'body' }
    for (const n of [group, lockedChild, linked]) d.nodes[n.id] = n
    d.pages[0].children.push(group.id, linked.id)
    d.designSystem.fontSources = {
      [ids.label]: { style: 'MasterAllowed' },
      [a.id]: { style: 'InheritedStyleSkip', runs: { 0: 'OverrideRunAllowed' } },
      [b.id]: { style: 'InheritedCopySkip' },
      [lockedChild.id]: { style: 'AncestorLockedSkip' },
      [linked.id]: { style: 'SharedStyleSkip' },
    }
  })
  expect(unmatchedEditableSourceFonts(e.state.doc).sort()).toEqual(['MasterAllowed', 'OverrideRunAllowed'])
})
