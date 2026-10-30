import { expect, test } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { import_sketch_json, export_sketch_json } from './generated/design-kernel/design_kernel'
import { uid, validateDocument } from './model'

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
