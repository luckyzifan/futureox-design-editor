import { expect, test, vi } from 'vitest'
import { blank, node } from './model'
import { apply, bounds, boxPoints, scene, unionBounds } from './geometry'
import { selectionLocalBounds } from './canvas-view'
import { canvasOverlayCommands } from './canvas-overlay-commands'
import { canvasText } from './canvas-interface-messages'
import { automationText } from './automation-interface-messages'
import { fileMenuText } from './file-menu-messages'
import { Editor } from './engine'

function fixture(select: 'rect' | 'frame' | 'both', tool = 'select', rectName = '按钮') {
  const doc = blank('chrome')
  const frame = node('frame', 0, 0, 400, 300)
  frame.name = '画板'
  const rect = node('rectangle', 40, 50, 120, 80)
  rect.name = rectName
  frame.children = [rect.id]
  doc.nodes[frame.id] = frame
  doc.nodes[rect.id] = rect
  doc.pages[0].children = [frame.id]
  const ids = select === 'rect' ? [rect.id] : select === 'frame' ? [frame.id] : [frame.id, rect.id]
  const entries = scene(doc, doc.pages[0].id)
  const selected = entries.filter(entry => ids.includes(entry.id))
  const local = selected.length === 1 ? selectionLocalBounds(doc, selected[0].id) : null
  const corners = local ? boxPoints(local).map(point => apply(selected[0].matrix, point)) : boxPoints(unionBounds(selected.map(entry => entry.bounds)))
  return canvasOverlayCommands({
    document: doc, pageId: doc.pages[0].id, epoch: 1, tool, pixelGrid: false, canTransform: true,
    selected, owners: ids,
    frameTitles: entries.filter(entry => ['frame', 'section'].includes(doc.nodes[entry.id].kind) && (entry.depth === 0 || ids.includes(entry.id))),
    localSelection: local, selectionCorners: corners, selectionBox: bounds(corners), measurementTarget: null,
  })
}

const labelsOf = (overlay: ReturnType<typeof fixture>) => overlay.commands.labels ?? []

test('a single shape shows its name above the box and leaves the parent frame title neutral', () => {
  const overlay = fixture('rect')
  const labels = labelsOf(overlay)
  const name = labels.find(label => label.kind === 'selection-name')
  const title = labels.find(label => label.kind === 'frame-title')
  expect(name).toMatchObject({ text: '按钮', color: '#0d99ff', offset: { x: 0, y: -24 }, frame: 'pill' })
  const corners = overlay.commands.selection!.corners
  expect(name!.anchor).toEqual({ x: Math.min(...corners.map(point => point.x)), y: Math.min(...corners.map(point => point.y)) })
  expect(title).toMatchObject({ text: '画板', color: '#73778b' })
  expect(labels.find(label => label.kind === 'selection-size')).toMatchObject({ text: '120 × 80', color: '#0d99ff', frame: 'pill' })
})

test('selecting a frame turns its title blue instead of drawing a second name', () => {
  const labels = labelsOf(fixture('frame'))
  expect(labels.find(label => label.kind === 'frame-title')).toMatchObject({ text: '画板', color: '#0d99ff' })
  expect(labels.some(label => label.kind === 'selection-name')).toBe(false)
})

test('multi-select and vector editing do not add a selection name', () => {
  expect(labelsOf(fixture('both')).some(label => label.kind === 'selection-name')).toBe(false)
  const vector = fixture('rect', 'vector')
  const labels = labelsOf(vector)
  expect(labels.some(label => label.kind === 'selection-name' || label.kind === 'selection-size')).toBe(false)
  expect(labels.find(label => label.kind === 'frame-title')?.color).toBe('#73778b')
  expect(vector.commands.selection).toBeUndefined()
})

test('renaming the selected shape changes overlay identity so a stale GPU label cannot stick', () => {
  expect(fixture('rect', 'select', '按钮').uiIdentity).not.toBe(fixture('rect', 'select', '改名').uiIdentity)
})

test('creation hints, pen chrome, and automation copy exist in both languages', () => {
  expect(canvasText['zh-CN'].creationHint).toContain('100×100')
  expect(canvasText.en.creationHint).toContain('Alt from center')
  expect(canvasText.en.creationHintLine).toContain('length 100')
  expect(canvasText['zh-CN'].penDone).toBe('完成 ↵')
  expect(canvasText.en.penDone).toBe('Done ↵')
  expect(canvasText.en.rotateOrigin).toContain('Double-click')
  expect(automationText['zh-CN'].open).toBe('设计 API')
  expect(automationText.en.open).toBe('Design API')
  expect(automationText.en.title).toBe('Design API and MCP')
  expect(automationText.en.close).toBe('Close')
  expect(`${automationText.en.title} ${automationText['zh-CN'].title}`.toLowerCase()).not.toContain('plugin')
  expect(automationText['zh-CN'].title).not.toContain('插件')
})

test('web chrome copy follows the same CN/EN catalog as the desktop file menu', () => {
  expect(canvasText['zh-CN'].creationHint).toContain('100×100')
  expect(canvasText.en.creationHint).toContain('Alt from center')
  expect(canvasText.en.creationHintLine).toContain('length 100')
  expect(fileMenuText['zh-CN'].importFormats).toBe('导入 Sketch / FIG / SVG / PDF')
  expect(fileMenuText.en.importFormats).toContain('Sketch')
  expect(fileMenuText.en.importFormats).toContain('FIG')
  expect(fileMenuText['zh-CN'].propertiesWorkspace).toBe('属性工作区')
  expect(automationText['zh-CN'].open).toBe('设计 API')
  expect(automationText.en.open).toBe('Design API')
  expect(automationText.en.webOnly).toContain('Electron')
  expect(automationText['zh-CN'].webOnly).toContain('Electron')
  expect(`${automationText.en.title} ${automationText['zh-CN'].title}`.toLowerCase()).not.toContain('plugin')
})

test('a parked wheel camera publishes the live zoom without waiting for the next frame', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const editor = new Editor(blank())
  const seen: number[] = []
  const stop = editor.subscribeCamera(() => { seen.push(editor.effectiveView().zoom) })
  try {
    editor.setViewCoalesced({ x: 12, y: 8, zoom: 2.5 })
    expect(editor.effectiveView().zoom).toBe(2.5)
    expect(seen.at(-1)).toBe(2.5)
    expect(editor.state.view.zoom).toBe(1)
    editor.flushPendingView()
    expect(editor.state.view.zoom).toBe(2.5)
  } finally {
    stop()
    editor.dispose()
  }
})
