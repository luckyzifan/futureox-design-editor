import { beforeAll, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { zipSync } from 'fflate'
import { initializePicking } from './kernel/picking'
import { export_sketch_json, import_sketch_json } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { validateDocument, type DesignDocument } from './model'

const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const DOC = '66666666-6666-4666-8666-666666666666'
const PAGE = '55555555-5555-4555-8555-555555555555'
const MASTER = '11111111-1111-4111-8111-111111111111'
const SHAPE = '22222222-2222-4222-8222-222222222222'
const INSTANCE = '33333333-3333-4333-8333-333333333333'
const STYLE = '44444444-4444-4444-8444-444444444444'
const sketch = () => zipSync({
  'meta.json': text({ version: 144, appVersion: '99' }),
  'document.json': text({
    _class: 'document', do_objectID: DOC, colorSpace: 1,
    pages: [{ _class: 'MSJSONFileReference', _ref: `pages/${PAGE}` }],
    layerStyles: { _class: 'sharedStyleContainer', objects: [{
      _class: 'sharedStyle', do_objectID: STYLE, name: 'Brand',
      value: { _class: 'style', fills: [{ _class: 'fill', isEnabled: true, fillType: 0, color: { _class: 'color', red: 1, green: 0, blue: 0, alpha: 1 } }], borders: [], shadows: [] },
    }] },
  }),
  [`pages/${PAGE}.json`]: text({
    _class: 'page', do_objectID: PAGE, name: 'Page', layers: [
      { _class: 'symbolMaster', do_objectID: MASTER, name: 'MASTER', symbolID: '77777777-7777-4777-8777-777777777777', frame: { _class: 'rect', x: 100, y: 0, width: 16, height: 16 }, layers: [
        { _class: 'rectangle', do_objectID: SHAPE, name: 'SHAPE', frame: { _class: 'rect', x: 0, y: 0, width: 16, height: 16 }, style: { _class: 'style', fills: [] } },
      ] },
      { _class: 'symbolInstance', do_objectID: INSTANCE, name: 'INSTANCE', symbolID: '77777777-7777-4777-8777-777777777777', frame: { _class: 'rect', x: 0, y: 0, width: 16, height: 16 }, overrideValues: [
        { _class: 'overrideValue', overrideName: `${SHAPE}_layerStyle`, value: STYLE },
      ] },
    ],
  }),
})

beforeAll(async () => {
  await initializePicking({
    wasm: readFileSync(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    font: readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
  })
})

test('a Sketch layerStyle override stays editable through undo and Sketch reopen', () => {
  const imported = JSON.parse(import_sketch_json(sketch())) as { document: DesignDocument }
  const document = imported.document
  validateDocument(document)
  expect(document.nodes[INSTANCE].instance?.overrides[SHAPE].styleRefs).toMatchObject({ fills: STYLE })
  const editor = new Editor(document)
  try {
    const color = () => (editor.state.doc.designSystem!.styles[STYLE].value as { color: string }[])[0].color
    expect(color()).toBe('#ff0000')
    editor.change('recolor shared layer style', (draft) => {
      ;(draft.designSystem!.styles[STYLE].value as { color: string }[])[0].color = '#00ff00'
    })
    expect(color()).toBe('#00ff00')
    editor.undo()
    expect(color()).toBe('#ff0000')
    editor.redo()
    expect(color()).toBe('#00ff00')
    const reopened = JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(editor.state.doc)))) as { document: DesignDocument }
    validateDocument(reopened.document)
    expect(reopened.document.nodes[INSTANCE].instance?.overrides[SHAPE].styleRefs).toMatchObject({ fills: STYLE })
    expect((reopened.document.designSystem!.styles[STYLE].value as { color: string }[])[0].color).toBe('#00ff00')
  } finally {
    editor.dispose()
  }
})
