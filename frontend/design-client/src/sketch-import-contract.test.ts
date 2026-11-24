import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { import_sketch_json, export_sketch_json } from './generated/design-kernel/design_kernel'
import { uid, validateDocument } from './model'
import { Editor } from './engine'

function archive() {
  const page = '10000000-0000-0000-0000-000000000001'
  const path = '10000000-0000-0000-0000-000000000002'
  const text = '10000000-0000-0000-0000-000000000003'
  const style = { _class: 'style', fills: [{ _class: 'fill', isEnabled: true, fillType: 0,
    color: { _class: 'color', red: 1, green: 0, blue: 0, alpha: 1 } }] }
  const layer = (id: string, kind: string, extra: Record<string, unknown>) => ({
    _class: kind, do_objectID: id, name: kind, frame: { x: 10, y: 20, width: 100, height: 30 }, style, ...extra,
  })
  return zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 144, appVersion: '93' })),
    'document.json': strToU8(JSON.stringify({ _class: 'document', pages: [{ _ref: `pages/${page}` }] })),
    [`pages/${page}.json`]: strToU8(JSON.stringify({ _class: 'page', do_objectID: page, name: 'Page', layers: [
      layer(path, 'shapePath', { frame: { x: 10, y: 20, width: 100, height: 0 }, isClosed: false,
        points: [{ point: '{0, 0}', curveFrom: '{0, 0}', curveTo: '{0, 0}', curveMode: 1 },
          { point: '{1, 0}', curveFrom: '{1, 0}', curveTo: '{1, 0}', curveMode: 1 }] }),
      layer(text, 'text', { attributedString: { _class: 'attributedString', string: 'Local text', attributes: [] } }),
    ] })),
  })
}

test('the actual shared Sketch codec admits plain paints, text defaults and zero-extent paths in the frontend', () => {
  const report = JSON.parse(import_sketch_json(archive()))
  report.document.id = uid()
  const document = validateDocument(report.document)
  expect(document.pages).toHaveLength(1)
  expect(Object.values(document.nodes)).toHaveLength(2)
  expect(Object.values(document.nodes).find(node => node.kind === 'text')?.text).toBe('Local text')
  expect(Object.values(document.nodes).find(node => node.kind === 'vector')?.height).toBe(1e-6)
  expect(document.nodes[document.pages[0].children[0]].fills[0].stops).toEqual([])
})

test('a shared Sketch compatibility archive reopens as the same editable layer count', () => {
  const report = JSON.parse(import_sketch_json(archive()))
  const bytes = export_sketch_json(JSON.stringify(report.document))
  const reopened = JSON.parse(import_sketch_json(bytes))
  reopened.document.id = uid()
  const document = validateDocument(reopened.document)
  expect(Object.keys(document.nodes)).toHaveLength(2)
  expect(Object.values(document.nodes).find(node => node.kind === 'text')?.text).toBe('Local text')
})

test.each([false, true])('the editor keeps the archived Sketch page through reorder with a legacy index %s', legacy => {
  const pages = ['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002']
  const source = zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 146 })),
    'document.json': strToU8(JSON.stringify({ _class: 'document', currentPageIndex: 1, pages: pages.map(id => ({ _ref: `pages/${id}` })) })),
    ...Object.fromEntries(pages.map(id => [`pages/${id}.json`, strToU8(JSON.stringify({ _class: 'page', name: id, layers: [] }))])),
  })
  const imported = JSON.parse(import_sketch_json(source)).document
  imported.id = uid()
  if (legacy) delete imported.designSystem.sketchContainers.sketchCurrentPageId
  const editor = new Editor()
  try {
    expect(editor.load(imported)).toBe(true)
    expect(editor.state.page).toBe(pages[1])
    editor.reorderPage(pages[1], pages[0])
    expect(editor.state.page).toBe(pages[1])
    const bytes = export_sketch_json(JSON.stringify(editor.authoredDocument))
    const exported = JSON.parse(strFromU8(unzipSync(bytes)['document.json']))
    expect(exported.currentPageIndex).toBe(0)
    const reopened = JSON.parse(import_sketch_json(bytes)).document
    expect(reopened.pages[0].id).toBe(pages[1])
  } finally { editor.dispose() }
})

function official(path: string) {
  return readFileSync(new URL(`../../../testing/fixtures/sketch-official/${path}`, import.meta.url))
}

test('the official complete archive crosses the actual frontend codec and model contract', () => {
  const report = JSON.parse(import_sketch_json(official('file-format-series/color-library.sketch')))
  report.document.id = uid()
  const document = validateDocument(report.document)
  const exported = export_sketch_json(JSON.stringify(document))
  const reopened = JSON.parse(import_sketch_json(exported))
  reopened.document.id = uid()
  expect(validateDocument(reopened.document).pages).toHaveLength(1)
})

test('official export settings and their source metadata cross the actual frontend contract', () => {
  const root = 'reference-files/files/118/export-formats'
  const page = '5722AFCC-60DF-4DCD-81F9-8BE4BE4D4B58'
  const input = zipSync({
    'meta.json': official(`${root}/meta.json`),
    'document.json': official(`${root}/document.json`),
    'user.json': official(`${root}/user.json`),
    [`pages/${page}.json`]: official(`${root}/pages/${page}.json`),
  })
  const report = JSON.parse(import_sketch_json(input))
  report.document.id = uid()
  const document = validateDocument(report.document)
  const settings = Object.values(document.nodes).flatMap(node => node.exportSettings || [])
  expect(settings).toHaveLength(12)
  expect(settings.map(setting => setting.format)).toEqual(expect.arrayContaining(['jpg', 'tiff', 'eps']))
  expect(settings.some(setting => setting.scale === 0)).toBe(true)
  expect(JSON.stringify(document)).toContain('namingScheme')
  const exported = export_sketch_json(JSON.stringify(document))
  const reopened = JSON.parse(import_sketch_json(exported))
  reopened.document.id = uid()
  expect(validateDocument(reopened.document).nodes).toBeTruthy()
})
