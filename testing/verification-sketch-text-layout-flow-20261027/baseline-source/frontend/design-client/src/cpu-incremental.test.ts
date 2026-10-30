import { expect, test } from 'vitest'
import { Editor } from './engine'
import { emptySystem } from './design-system'
import { blank, node, paint, effect, defaultLayoutGrid, defaultImageAdjust, defaultPatternTile, validateDocument, type DesignDocument } from './model'

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const promotions: { version: DesignDocument['schemaVersion']; edit: (d: DesignDocument, id: string) => void }[] = [
  { version: 4, edit: (d, id) => { d.nodes[id].fills[0].transform = [1, 0, 0, 1, 0, 0] } },
  { version: 5, edit: (d, id) => { d.nodes[id].effects = [effect('glass')] } },
  { version: 6, edit: (d, id) => { d.designSystem = emptySystem(); d.designSystem.collections.theme = { name: 'Theme', modes: ['day'], defaultMode: 'day' }; d.nodes[id].variableModes = { theme: 'day' } } },
  { version: 7, edit: (d, id) => { d.nodes[id].constrainProportions = true } },
  { version: 8, edit: (d, id) => { d.nodes[id].exportSettings = [{ id: 'export', format: 'png', scale: 1, suffix: '' }] } },
  { version: 9, edit: (d, id) => { d.nodes[id].effects = [{ ...effect('blur'), radius: 2, gradientBlur: { start: [0, 0], end: [40, 0], startCount: 0, endCount: 3, smooth: true } }] } },
  { version: 10, edit: (d, id) => { d.nodes[id].kind = 'slice'; d.nodes[id].fills = [] } },
  { version: 11, edit: d => { d.pages[0].guides = [{ id: 'guide', axis: 'x', position: 12.5 }] } },
  { version: 12, edit: (d, id) => { d.nodes[id].layoutGrid = defaultLayoutGrid() } },
  { version: 13, edit: (d, id) => { d.nodes[id].fills = [{ ...paint('#000000', 'image'), image, adjust: defaultImageAdjust() }] } },
  { version: 14, edit: (d, id) => { d.nodes[id].fills = [{ ...paint('#000000', 'image'), image, tile: defaultPatternTile() }] } },
]
for (const { version, edit } of promotions) test(`schema ${version} promotion remains monotonic and history-faithful`, () => {
  const doc = blank(), n = node('frame'); doc.nodes[n.id] = n; doc.pages[0].children = [n.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const result = editor.change('Upgrade', draft => edit(draft, n.id))
    expect(result?.status, editor.state.message).toBe('committed')
    expect(editor.state.doc.schemaVersion).toBe(version); validateDocument(editor.state.doc)
    const upgraded = editor.state.doc
    editor.undo(); expect(editor.state.doc).toBe(before)
    editor.redo(); expect(editor.state.doc).toBe(upgraded)
    expect(editor.change('No-op', () => {})?.status).toBe('unchanged'); expect(editor.state.doc).toBe(upgraded)
    expect(editor.change('Rename', draft => { draft.nodes[n.id].name = 'After upgrade' })?.status).toBe('committed')
    expect(editor.state.doc.schemaVersion).toBe(version)
  } finally { editor.dispose() }
})

test.each([2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const)('schema %i still rejects invalid authored edits atomically', schemaVersion => {
  const doc = blank(), n = node('rectangle'); doc.schemaVersion = schemaVersion; doc.nodes[n.id] = n; doc.pages[0].children = [n.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc, revision = editor.state.version
    for (const edit of [(d: DesignDocument) => { d.nodes[n.id].opacity = 2 }, (d: DesignDocument) => { d.nodes[n.id].fills[0].color = 'invalid' }, (d: DesignDocument) => { d.nodes[n.id].width = -1 }]) {
      expect(editor.change('Invalid', edit)?.status).toBe('rejected')
      expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(revision); expect(editor.canUndo).toBe(false)
    }
  } finally { editor.dispose() }
})
