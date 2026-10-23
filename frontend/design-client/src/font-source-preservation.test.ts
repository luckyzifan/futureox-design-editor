import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, defaultTextStyle, node, type DesignDocument } from './model'
import { emptySystem } from './design-system'
import { importFigTextRuns } from './import-fig-text'
import { applyMatchedFonts, unmatchedSourceFonts } from './font-matching'
import { matchSourceFontsInDocument } from './font-management'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { fontTestBytes } from './font-test-fixtures'
import { componentFixture, originNode } from './component-fixtures'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
const resource = { family: 'Noto Sans SC Latin subset', data: fontTestBytes('noto-latin').toString('base64'), index: 0 }

// This is the actual FIG importer path: a run's different source identity can
// be metadata-only, with no fontId override while both fonts use the fallback.
function fixture() {
  const document = blank('Partial font matching'), text = node('text', 0, 0, 200, 40)
  text.text = 'ABCD'; text.textStyle = defaultTextStyle()
  const source = importFigTextRuns(text, {
    fontName: { family: 'Source', style: 'Regular' },
    textData: { characterStyleIDs: [0, 1, 2, 3], styleOverrideTable: [
      { styleID: 1, fontName: { family: 'Source', style: 'Bold' }, fontSize: 17.125 },
      { styleID: 2, fontName: { family: 'Source', style: 'Regular' } },
      { styleID: 3, textDecoration: 'UNDERLINE' },
    ] },
  }, new Set<string>())
  document.nodes[text.id] = text; document.pages[0].children.push(text.id)
  document.designSystem = { ...emptySystem(), fontSources: { [text.id]: source } }
  document.schemaVersion = 4
  const editor = new Editor(document); editors.push(editor)
  return { editor, id: text.id }
}

test('an instance with a style-only override defers matching rather than retargeting inherited runs', () => {
  const { doc, ids } = componentFixture()
  doc.nodes[ids.label].textStyle = defaultTextStyle()
  doc.nodes[ids.label].textRuns = [{ start: 0, end: 1, weight: 700 }]
  const editor = new Editor(doc); editors.push(editor)
  const key = editor.state.doc.nodes[ids.label].componentKey!
  const instanceText = originNode(editor.state.doc, ids.a, key)
  editor.updateProperties([instanceText.id], text => { text.textStyle!.letterSpacing = .125 })
  editor.change('Imported source identity', document => {
    document.designSystem ??= emptySystem()
    document.designSystem.fontSources = { [instanceText.id]: { style: 'Source Regular', runs: { 0: 'Source Bold' } } }
  })
  const before = editor.state.doc, version = editor.state.version
  expect(before.nodes[ids.a].instance!.overrides[key].textStyle).toBeDefined()
  expect(before.nodes[ids.a].instance!.overrides[key].textRuns).toBeUndefined()
  expect(before.nodes[instanceText.id].textRuns![0].fontId).toBeUndefined()
  editor.change('Match base source', document => {
    matchSourceFontsInDocument(document, new Map([['Source Regular', { id: 'matched-regular', resource }]]))
  })
  expect(editor.state.doc.nodes[instanceText.id].textStyle?.fontId).toBe('default')
  expect(editor.state.doc.nodes[ids.a].instance!.overrides[key].textRuns).toBeUndefined()
  expect(unmatchedSourceFonts(editor.state.doc, editor.state.doc.nodes[instanceText.id])).toEqual(['Source Regular', 'Source Bold'])
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
})

for (const [route, apply] of [
  ['matching helper', applyMatchedFonts],
  ['document matching', matchSourceFontsInDocument],
] as const) {
  test(`${route} preserves another missing face after a partial family/style match`, () => {
    const { editor, id } = fixture(), before = editor.state.doc, version = editor.state.version
    expect(before.nodes[id].textRuns?.[0].fontId).toBeUndefined()
    const beforeBytes = encodeDocumentBinary(before)
    const change = editor.change('Match one exact source face', document => {
      apply(document, new Map([['Source Regular', { id: 'matched-regular', resource }]]))
    })
    expect(change?.status).toBe('committed'); expect(editor.state.version).toBe(version + 1)
    const after = editor.state.doc, text = after.nodes[id]
    expect(text.textStyle?.fontId).toBe('matched-regular')
    expect(text.textRuns?.[0]).toEqual({ ...before.nodes[id].textRuns![0], fontId: 'default' })
    expect(text.textRuns?.[1].fontId).toBe('matched-regular')
    expect(text.textRuns?.[2]).toEqual(before.nodes[id].textRuns![2])
    expect(text.textStyle?.fallbacks).toEqual(before.nodes[id].textStyle?.fallbacks)
    expect(unmatchedSourceFonts(after, text)).toEqual(['Source Bold'])
    expect(after.designSystem?.fontSources).toEqual(before.designSystem?.fontSources)
    const afterBytes = encodeDocumentBinary(after)
    const reopened = new Editor(decodeDocumentBinary(afterBytes) as DesignDocument); editors.push(reopened)
    expect(reopened.state.doc).toEqual(after)
    editor.undo(); expect(encodeDocumentBinary(editor.state.doc)).toEqual(beforeBytes)
    editor.redo(); expect(encodeDocumentBinary(editor.state.doc)).toEqual(afterBytes)
  })

  test(`${route} leaves explicitly chosen run fonts and no-match documents unchanged`, () => {
    const { editor, id } = fixture()
    editor.change('Choose a run font', document => {
      document.fonts = { chosen: resource }; document.nodes[id].textRuns![0].fontId = 'chosen'
    })
    const before = editor.state.doc
    editor.change('No match', document => { apply(document, new Map()) })
    expect(editor.state.doc).toBe(before)
    editor.change('Match base only', document => {
      apply(document, new Map([['Source Regular', { id: 'matched-regular', resource }]]))
    })
    expect(editor.state.doc.nodes[id].textRuns![0]).toEqual(before.nodes[id].textRuns![0])
  })
}
