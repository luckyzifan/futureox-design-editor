import { expect, test } from 'vitest'
import { apply, bounds, boxPoints, scene } from './geometry'
import { blank, node } from './model'
import { selectionLocalBounds } from './canvas-view'
import { canvasOverlayCommands } from './canvas-overlay-commands'

test('selection chrome names a shape in blue and turns only the selected frame title blue', () => {
  const doc = blank(), frame = node('frame', 0, 0, 200, 120), rect = node('rectangle', 10, 20, 40, 30)
  frame.name = 'Card'
  rect.name = 'Thumb'
  frame.children = [rect.id]
  doc.nodes = { [frame.id]: frame, [rect.id]: rect }
  doc.pages[0].children = [frame.id]
  const entries = scene(doc, doc.pages[0].id)
  const frameEntry = entries.find(entry => entry.id === frame.id)!
  const rectEntry = entries.find(entry => entry.id === rect.id)!
  const local = selectionLocalBounds(doc, rect.id)
  const corners = boxPoints(local).map(point => apply(rectEntry.matrix, point))
  const shape = canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool: 'select', pixelGrid: false, canTransform: true,
    selected: [rectEntry], owners: [rect.id], frameTitles: [frameEntry],
    localSelection: local, selectionCorners: corners, selectionBox: bounds(corners), measurementTarget: null,
  })
  const shapeLabels = shape.commands.labels ?? []
  expect(shapeLabels.find(label => label.text === 'Thumb')?.color).toBe('#4597f7')
  expect(shapeLabels.find(label => label.text === 'Card')?.color).toBe('#73778b')
  const frameLocal = selectionLocalBounds(doc, frame.id)
  const frameCorners = boxPoints(frameLocal).map(point => apply(frameEntry.matrix, point))
  const selectedFrame = canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool: 'select', pixelGrid: false, canTransform: true,
    selected: [frameEntry], owners: [frame.id], frameTitles: [frameEntry],
    localSelection: frameLocal, selectionCorners: frameCorners, selectionBox: bounds(frameCorners), measurementTarget: null,
  })
  const titles = (selectedFrame.commands.labels ?? []).filter(label => label.text === 'Card')
  expect(titles).toHaveLength(1)
  expect(titles[0].color).toBe('#4597f7')
  expect(shape.uiIdentity).not.toBe(selectedFrame.uiIdentity)
})
