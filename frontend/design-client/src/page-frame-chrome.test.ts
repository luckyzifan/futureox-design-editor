import { expect, test } from 'vitest'
import { apply, bounds, boxPoints, scene } from './geometry'
import { blank, node, paint } from './model'
import { canvasOverlayCommands } from './canvas-overlay-commands'
import { selectionLocalBounds } from './canvas-view'
import {
  frameChromeLabel, frameTitleShown, sectionLabelColor,
} from './page-frame-chrome'

test('frame titles and section labels use their own display styles', () => {
  const frame = node('frame', 0, 0, 200, 120)
  const section = node('section', 0, 0, 180, 90)
  section.fills = [paint('#102040')]
  expect(frameChromeLabel(section, false)).toMatchObject({ kind: 'section-title', chip: '#102040', color: '#ffffff', offset: { x: 6, y: -6 } })
  expect(frameChromeLabel(section, true).color).toBe('#4597f7')
  expect(frameChromeLabel(frame, false)).toMatchObject({ kind: 'frame-title', color: '#73778b', offset: { x: 0, y: -12 } })
  expect(sectionLabelColor('#e7e8ef')).toBe('#1e1e1e')
})

test('a selected frame reveals direct child frame titles and the overlay chips a section', () => {
  const doc = blank('pages')
  const frame = node('frame', 0, 0, 400, 300)
  const child = node('frame', 30, 40, 80, 50)
  child.name = 'Inner'
  const nested = node('frame', 8, 8, 20, 20)
  nested.name = 'Deep'
  child.children = [nested.id]
  frame.children = [child.id]
  const section = node('section', 20, 20, 160, 80)
  section.name = '区域'
  doc.nodes = { [frame.id]: frame, [child.id]: child, [nested.id]: nested, [section.id]: section }
  doc.pages[0].children = [frame.id, section.id]
  const entries = scene(doc, doc.pages[0].id)
  const selected = new Set([frame.id])
  const visible = entries.filter(entry => frameTitleShown(entry, doc.nodes[entry.id], selected, doc.nodes[entry.ancestors.at(-1) ?? '']))
  expect(visible.map(entry => doc.nodes[entry.id].name).sort()).toEqual(['Inner', '区域', '画板'].sort())
  const sectionEntry = entries.find(entry => entry.id === section.id)!
  const local = selectionLocalBounds(doc, section.id)
  const corners = boxPoints(local).map(point => apply(sectionEntry.matrix, point))
  const overlay = canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool: 'select', pixelGrid: false, canTransform: true,
    selected: [sectionEntry], owners: [section.id], frameTitles: [sectionEntry],
    localSelection: local, selectionCorners: corners, selectionBox: bounds(corners), measurementTarget: null,
  })
  expect(overlay.commands.labels?.find(label => label.kind === 'section-title')).toMatchObject({
    text: '区域', chip: '#e7e8ef', color: '#4597f7', offset: { x: 6, y: -6 },
  })
  expect(overlay.commands.labels?.some(label => label.kind === 'selection-name')).toBe(false)
  expect(visible.some(entry => doc.nodes[entry.id].name === 'Deep')).toBe(false)
})
