import { expect, test } from 'vitest'
import { zipSync } from 'fflate'
import { import_sketch_json } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import type { DesignDocument } from './model'

const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const DOCUMENT = '11111111-1111-4111-8111-111111111111'
const PAGE = '22222222-2222-4222-8222-222222222222'
const LINKS = '33333333-3333-4333-8333-333333333333'
const GROUP_1 = '44444444-4444-4444-8444-444444444444'
const GROUP_2 = '55555555-5555-4555-8555-555555555555'

const archive = () => zipSync({
  'meta.json': text({ app: 'com.bohemiancoding.sketch3', appVersion: '69.2', version: 134 }),
  'document.json': text({ _class: 'document', do_objectID: DOCUMENT, pages: [{ _ref: `pages/${PAGE}` }] }),
  [`pages/${PAGE}.json`]: text({
    _class: 'page', do_objectID: PAGE, name: 'Page', layers: [{
      _class: 'group', do_objectID: LINKS, name: 'Links',
      frame: { _class: 'rect', x: 16, y: 20, width: 213, height: 79 },
      groupLayout: { _class: 'MSImmutableInferredGroupLayout', axis: 0, layoutAnchor: 0 },
      layers: [
        {
          _class: 'rectangle', do_objectID: GROUP_1, name: 'Group 1', isVisible: true,
          frame: { _class: 'rect', x: 0, y: 0, width: 86, height: 76 },
        },
        {
          _class: 'rectangle', do_objectID: GROUP_2, name: 'Group 2', isVisible: true,
          frame: { _class: 'rect', x: 128, y: 3, width: 85, height: 76 },
        },
      ],
    }],
  }),
})

test('hiding a Sketch Smart Layout child hugs the group and undo restores the static frames', () => {
  const report = JSON.parse(import_sketch_json(archive())) as { document: DesignDocument }
  const editor = new Editor(report.document)
  const box = (id: string) => {
    const node = editor.state.doc.nodes[id]
    return [node.transform[4], node.transform[5], node.width, node.height]
  }
  try {
    expect(box(LINKS)).toEqual([16, 20, 213, 79])
    expect(box(GROUP_1)).toEqual([0, 0, 86, 76])
    expect(box(GROUP_2)).toEqual([128, 3, 85, 76])

    editor.select([GROUP_2])
    editor.updateProperties([GROUP_2], node => { node.visible = false }, '隐藏图层')
    expect(editor.state.version).toBe(1)
    expect(box(LINKS)).toEqual([16, 20, 86, 79])
    expect(box(GROUP_1)).toEqual([0, 0, 86, 76])
    expect(box(GROUP_2)).toEqual([128, 3, 85, 76])

    editor.undo()
    expect(box(LINKS)).toEqual([16, 20, 213, 79])
    expect(box(GROUP_1)).toEqual([0, 0, 86, 76])
    expect(box(GROUP_2)).toEqual([128, 3, 85, 76])
    expect(editor.canUndo).toBe(false)
  } finally {
    editor.dispose()
  }
})