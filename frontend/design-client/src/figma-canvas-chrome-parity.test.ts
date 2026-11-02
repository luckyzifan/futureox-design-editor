import { expect, test } from 'vitest'
import { canvasMarqueeSelection, marqueeReleasePlan } from './canvas-selection-workflows'
import { apply, bounds, boxPoints, scene } from './geometry'
import { blank, node, type DesignNode } from './model'
import { canvasOverlayCommands } from './canvas-overlay-commands'
import { selectionLocalBounds } from './canvas-view'
import { HOVER_BLUE, SELECTION_BLUE } from './selection-blue'
import { measureBounds, spacingDiagram, SPACING_RED } from './canvas-measurements'
import { selectionSizeLabel } from './selection-size-label'

function documentOf(nodes: DesignNode[], roots = nodes.map(item => item.id)) {
  const doc = blank('chrome parity')
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = roots
  return doc
}

const marquee = (doc: ReturnType<typeof documentOf>, area: { x: number; y: number; width: number; height: number }, origin: string[] = [], options: { deep?: boolean; additive?: boolean } = {}) =>
  canvasMarqueeSelection(doc, doc.pages[0].id, origin, scene(doc, doc.pages[0].id), area, {
    deep: !!options.deep, contained: false, additive: !!options.additive, toggle: false,
  })

test('a Figma marquee takes a touched layer, skips a miss, and Shift adds without removing the prior layer', () => {
  const left = node('rectangle', 0, 0, 40, 40)
  const right = node('rectangle', 100, 0, 40, 40)
  const doc = documentOf([left, right])
  const touch = { x: 60, y: 0, width: 40, height: 40 }
  expect(marquee(doc, touch)).toEqual([right.id])
  expect(marquee(doc, { x: 50, y: 0, width: 40, height: 40 })).toEqual([])
  expect(marquee(doc, touch, [left.id], { additive: true })).toEqual([left.id, right.id])
  expect(marqueeReleasePlan({
    sketch: false, shift: true, alt: true, deep: false, multiselect: false,
    startedAdditive: false, passedThreshold: true,
  })).toMatchObject({ apply: true, additive: true, toggle: false, contained: false })
  expect(marqueeReleasePlan({
    sketch: false, shift: false, alt: false, deep: false, multiselect: false,
    startedAdditive: false, passedThreshold: false,
  })).toEqual({ apply: false })
})

test('a page marquee selects the group, and a deep marquee selects the child it covers', () => {
  const group = node('group', 0, 0, 80, 80)
  const child = node('rectangle', 10, 10, 30, 30)
  const beside = node('rectangle', 200, 0, 20, 20)
  group.children = [child.id]
  const doc = documentOf([group, child, beside], [group.id, beside.id])
  const area = { x: 0, y: 0, width: 50, height: 50 }
  expect(marquee(doc, area)).toEqual([group.id])
  expect(marquee(doc, area, [], { deep: true })).toEqual([child.id])
  const hidden = node('rectangle', 0, 0, 30, 30)
  hidden.visible = false
  const locked = node('rectangle', 0, 0, 30, 30)
  locked.locked = true
  const blocked = documentOf([hidden, locked])
  expect(marquee(blocked, { x: 0, y: 0, width: 40, height: 40 })).toEqual([])
})

test('Alt spacing is red, meets a sibling gap, and reports four paddings inside a frame', () => {
  expect(SPACING_RED).toBe('#e05634')
  expect(HOVER_BLUE).toBe(SELECTION_BLUE)
  expect(selectionSizeLabel({ x: 0, y: 0, width: 60, height: 47 }, { x: 0, y: 0, width: 60, height: 47 })).toBe('60 × 47')
  const frame = node('frame', 0, 0, 300, 200)
  const child = node('rectangle', 40, 50, 50, 40)
  const sibling = node('rectangle', 140, 50, 40, 40)
  frame.children = [child.id, sibling.id]
  const doc = documentOf([frame, child, sibling], [frame.id])
  const entries = scene(doc, doc.pages[0].id)
  const childEntry = entries.find(entry => entry.id === child.id)!
  const siblingEntry = entries.find(entry => entry.id === sibling.id)!
  const frameEntry = entries.find(entry => entry.id === frame.id)!
  const local = selectionLocalBounds(doc, child.id)
  const corners = boxPoints(local).map(point => apply(childEntry.matrix, point))
  const gap = canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool: 'select', pixelGrid: false, canTransform: true,
    selected: [childEntry], owners: [child.id], frameTitles: [frameEntry],
    localSelection: local, selectionCorners: corners, selectionBox: bounds(corners),
    measurementTarget: { id: sibling.id, bounds: siblingEntry.bounds },
  })
  expect(gap.commands.labels?.filter(label => label.kind === 'measurement').map(label => label.text).sort()).toEqual(['40', '50', '50'])
  expect(gap.commands.labels?.find(label => label.kind === 'measurement')).toMatchObject({ color: '#ffffff', frame: 'measure' })
  const one = measureBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 10, height: 10 })
  expect(one.map(item => item.distance)).toEqual([1])
  expect(String(Number(one[0].distance.toFixed(2)))).toBe('1')
  expect(gap.commands.labels?.find(label => label.kind === 'selection-size')).toMatchObject({ color: '#ffffff', frame: 'accent' })
  const padding = measureBounds(bounds(corners), frameEntry.bounds).map(item => item.distance)
  expect(padding).toEqual([40, 210, 50, 110])
})
