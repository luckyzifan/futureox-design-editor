import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, effect, node, type DesignNode } from './model'

test.each([
  ['paint transform', 4, (n: DesignNode) => { n.fills[0].transform = [1, 0, 0, 1, 0, 0] }],
  ['glass', 5, (n: DesignNode) => { n.effects = [effect('glass')] }],
  ['texture', 5, (n: DesignNode) => { n.effects = [effect('texture')] }],
] as const)('legacy admission sees newly authored %s and preserves history', (_name, version, mutate) => {
  const doc = blank(), shape = node('rectangle', 0, 0, 30, 30)
  doc.schemaVersion = 2; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const result = editor.change('Author feature', draft => { mutate(draft.nodes[shape.id]) })
    expect(result?.status).toBe('committed')
    const after = editor.state.doc
    expect(after.schemaVersion).toBe(version)
    expect(before.nodes[shape.id]).toEqual(shape)
    editor.undo(); expect(editor.state.doc).toBe(before)
    editor.redo(); expect(editor.state.doc).toBe(after)
  } finally { editor.dispose() }
})
