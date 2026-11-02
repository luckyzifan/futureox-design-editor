import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { blank, node } from './model'
import { apply, bounds, boxPoints, scene } from './geometry'
import { canvasOverlayCommands, selectionChromeChipWidth } from './canvas-overlay-commands'

test('chrome keeps the blue accent and warms the neutral surfaces', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).toMatch(/--workspace-accent:\s*#3459d4;/)
  expect(css).toMatch(/--workspace-accent-hover:\s*#2747b6;/)
  expect(css).toContain('--workspace-canvas: #f3eee6;')
  expect(css).toContain('--workspace-panel: #fffcf9;')
  expect(css).toContain('.selection-chrome-frame')
  expect(css).toContain('.selection-size-pill { fill: #3459d4; stroke: none; }')
  expect(css).toContain('.selection-rotate-glyph { opacity: 0; }')
  expect(css).toContain('animation: panel-enter-left 140ms ease-out')
  expect(css).toContain('@keyframes panel-enter-left { from { transform: translateX(-4px); } to { transform: translateX(0); } }')
  expect(css).not.toContain('panel-enter-left { from { opacity: 0')
})

test('selection name and size use a pill frame and keep the existing blue', () => {
  const doc = blank('chrome')
  const frame = node('frame', 0, 0, 400, 300)
  frame.name = '画板'
  const rect = node('rectangle', 40, 50, 120, 80)
  rect.name = '按钮'
  frame.children = [rect.id]
  doc.nodes[frame.id] = frame
  doc.nodes[rect.id] = rect
  doc.pages[0].children = [frame.id]
  const entries = scene(doc, doc.pages[0].id)
  const selected = entries.filter(entry => entry.id === rect.id)
  const local = { x: 0, y: 0, width: rect.width, height: rect.height }
  const corners = boxPoints(local).map(point => apply(selected[0].matrix, point))
  const labels = canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool: 'select', pixelGrid: false, canTransform: true,
    selected, owners: [rect.id],
    frameTitles: entries.filter(entry => entry.id === frame.id),
    localSelection: local, selectionCorners: corners, selectionBox: bounds(corners), measurementTarget: null,
  }).commands.labels ?? []
  expect(labels.find(label => label.kind === 'selection-name')).toMatchObject({ text: '按钮', color: '#3459d4', frame: 'pill' })
  expect(labels.find(label => label.kind === 'selection-size')).toMatchObject({ text: '120 × 80', color: '#ffffff', frame: 'accent' })
  expect(labels.find(label => label.kind === 'frame-title')).toMatchObject({ text: '画板', color: '#73778b' })
  expect(labels.find(label => label.kind === 'frame-title')).not.toHaveProperty('frame')
  expect(selectionChromeChipWidth('按钮', 11)).toBe(22)
  expect(selectionChromeChipWidth('120 × 80', 10)).toBeGreaterThan(20)
})
