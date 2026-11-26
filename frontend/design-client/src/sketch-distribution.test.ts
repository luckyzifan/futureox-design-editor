import { afterEach, expect, test } from 'vitest'
import { alignSelection } from './alignment-availability'
import { Editor } from './engine'
import { apply, boxPoints, bounds, worldMatrix } from './geometry'
import { interfacePreference } from './interface-preference'
import { blank, node, type DesignNode } from './model'
import { bindSketchDistributionDialog, type SketchDistributionRequest } from './sketch-distribution'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
})

function fixture(positions = [0, 15, 31], widths = [10, 10, 10], rotatedParent = false, axis: 'x' | 'y' = 'x') {
  const document = blank()
  const layers = positions.map((at, i) => {
    const x = rotatedParent ? 4 : axis === 'x' ? at : 3
    const y = rotatedParent ? 90 - at : axis === 'y' ? at : 3
    return node('rectangle', x, y, widths[i], 10)
  })
  const parent = rotatedParent ? node('frame', 100, 50, 200, 200) : undefined
  if (parent) {
    parent.transform = [0, 1, -1, 0, 100, 50]
    parent.children = layers.map(layer => layer.id)
  }
  document.nodes = Object.fromEntries([...layers, ...(parent ? [parent] : [])].map(layer => [layer.id, layer]))
  document.pages[0].children = parent ? [parent.id] : layers.map(layer => layer.id)
  const editor = new Editor(document)
  editors.push(editor)
  editor.select(layers.map(layer => layer.id).reverse())
  interfacePreference.set({ uiMode: 'sketch' })
  editor.set({ snapPixels: true })
  const requests: SketchDistributionRequest[] = []
  bindSketchDistributionDialog(editor, request => requests.push(request))
  return { editor, layers, parent, requests }
}

function worldEdges(editor: Editor, layers: DesignNode[]) {
  return layers.map(({ id, width, height }) => {
    const matrix = worldMatrix(editor.state.doc, id)
    return bounds(boxPoints({ x: 0, y: 0, width, height }).map(point => apply(matrix, point))).x
  })
}

test.each(['pixels', 'subpixels'] as const)('Sketch chooses %s before authoring and commits one edit', choice => {
  const { editor, layers, requests } = fixture(), before = editor.state.doc
  alignSelection(editor, 'x', 'distribute')
  expect(worldEdges(editor, layers)).toEqual([0, 15, 31])
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(requests).toHaveLength(1)
  const request = requests[0]
  expect(request.isCurrent()).toBe(true)
  request.apply(choice)
  expect(worldEdges(editor, layers)).toEqual([0, choice === 'pixels' ? 16 : 15.5, 31])
  const after = editor.state.doc
  request.apply(choice === 'pixels' ? 'subpixels' : 'pixels')
  expect(editor.state.doc).toBe(after)
  expect(editor.state.version).toBe(1)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  editor.redo()
  expect(editor.state.doc).toEqual(after)
})

test('offers whole pixels even when a vertical selection already has exact fractional spacing', () => {
  const { editor, layers, requests } = fixture([0, 15.5, 31], undefined, false, 'y')
  const before = editor.state.doc
  alignSelection(editor, 'y', 'distribute')
  expect(requests).toHaveLength(1)
  requests[0].apply('subpixels')
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  alignSelection(editor, 'y', 'distribute')
  requests[1].apply('pixels')
  expect(layers.map(({ id }) => editor.state.doc.nodes[id].transform.slice(4))).toEqual([[3, 0], [3, 16], [3, 31]])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('uses the world-space plan inside a rotated parent and preserves off-axis coordinates', () => {
  const { editor, layers, parent, requests } = fixture(undefined, undefined, true)
  const before = editor.state.doc
  alignSelection(editor, 'x', 'distribute')
  expect(requests).toHaveLength(1)
  requests[0].apply('pixels')
  expect(worldEdges(editor, layers)).toEqual([0, 16, 31])
  expect(editor.state.doc.nodes[parent!.id]).toEqual(before.nodes[parent!.id])
  expect(editor.state.doc.nodes[layers[1].id].transform).toEqual([1, 0, 0, 1, 4, 74])
  expect(editor.state.doc.nodes[layers[0].id]).toEqual(before.nodes[layers[0].id])
  expect(editor.state.doc.nodes[layers[2].id]).toEqual(before.nodes[layers[2].id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('negative positions and signed gaps keep the equivalent world endpoints', () => {
  const { editor, layers, requests } = fixture([-13, -8, 0])
  alignSelection(editor, 'x', 'distribute')
  expect(requests).toHaveLength(1)
  requests[0].apply('pixels')
  expect(worldEdges(editor, layers)).toEqual([-13, -7, 0])
})

test.each(['pixels-off', 'figma', 'integer', 'no-feasible-whole-pixel'] as const)('%s uses only the existing exact distribution', boundary => {
  const { editor, layers, requests } = boundary === 'no-feasible-whole-pixel'
    ? fixture([0, 10.7, 21], [10.4, 10.1, 10])
    : fixture(boundary === 'integer' ? [0, 14, 32] : undefined)
  if (boundary === 'pixels-off') editor.set({ snapPixels: false })
  if (boundary === 'figma') interfacePreference.set({ uiMode: 'figma' })
  alignSelection(editor, 'x', 'distribute')
  expect(requests).toHaveLength(0)
  expect(worldEdges(editor, layers)[1]).toBeCloseTo(boundary === 'integer' ? 16 :
    boundary === 'no-feasible-whole-pixel' ? 10.65 : 15.5, 10)
})

test.each(['selection', 'revision', 'same-id-session', 'pixel-setting', 'cancel'] as const)('%s invalidates the pending decision', boundary => {
  const { editor, layers, requests } = fixture()
  alignSelection(editor, 'x', 'distribute')
  expect(requests).toHaveLength(1)
  const request = requests[0]
  if (boundary === 'selection') editor.select([layers[0].id])
  if (boundary === 'revision') editor.update([layers[0].id], { name: 'Other edit' })
  if (boundary === 'same-id-session') editor.load(structuredClone(editor.state.doc), true)
  if (boundary === 'pixel-setting') editor.set({ snapPixels: false })
  if (boundary === 'cancel') request.cancel()
  const current = editor.state.doc, version = editor.state.version
  expect(request.isCurrent()).toBe(false)
  request.apply('pixels')
  expect(editor.state.doc).toBe(current)
  expect(editor.state.version).toBe(version)
  expect(worldEdges(editor, layers)).toEqual([0, 15, 31])
})
