import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, uid } from './model'
import { scene } from './geometry'
import { hitPrototypeHead, hitPrototypeLink, jumpFrame, jumpPage, jumpToNode, orderedFrames, pageOfNode, prototypeLinks } from './canvas-navigation'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()) })

function document() {
  const doc = blank('导航')
  doc.schemaVersion = 4
  const left = node('frame', 0, 0, 200, 100)
  const right = node('frame', 360, 8, 160, 90)
  const child = node('rectangle', 20, 20, 40, 30)
  left.children = [child.id]
  const other = node('frame', 12, 18, 140, 80)
  const page = { id: uid(), name: '第二页', children: [other.id], background: '#ffffff' }
  doc.nodes = { [left.id]: left, [right.id]: right, [child.id]: child, [other.id]: other }
  doc.pages[0].children = [left.id, right.id]
  doc.pages.push(page)
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: other.id }] }], [left.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: right.id }] }] } }
  return { doc, left, right, child, other, page }
}

test('frame order, page ownership and prototype noodles follow the canvas', () => {
  const { doc, left, right, child, other } = document()
  expect(orderedFrames(doc, doc.pages[0].id).map(frame => frame.id)).toEqual([left.id, right.id])
  expect(pageOfNode(doc, child.id)).toBe(doc.pages[0].id)
  expect(pageOfNode(doc, other.id)).toBe(doc.pages[1].id)
  const links = prototypeLinks(doc, doc.pages[0].id)
  expect(links.map(link => link.targetId).sort()).toEqual([other.id, right.id].sort())
  const local = links.find(link => link.targetId === right.id)!
  const remote = links.find(link => link.targetId === other.id)!
  expect(remote.offPage).toBe(true)
  expect(remote.label).toBe('第二页')
  expect(hitPrototypeLink(links, local.from, 1)?.id).toBe(local.id)
  expect(hitPrototypeHead(local, local.to, 1)).toBe(true)
  expect(hitPrototypeLink(links, { x: -100, y: -100 }, 1)).toBeNull()
  expect(scene(doc, doc.pages[0].id).some(entry => entry.id === other.id)).toBe(false)
})

test('zoom-to follows a prototype target onto another page, and page or frame jumps stop at the ends', () => {
  const { doc, left, right, other } = document()
  const editor = new Editor(doc)
  editors.push(editor)
  const size = { width: 800, height: 600 }
  expect(jumpToNode(editor, other.id, size)).toBe(true)
  expect(editor.state.page).toBe(doc.pages[1].id)
  expect(editor.state.selection).toEqual([other.id])
  expect(editor.state.view.zoom).toBeGreaterThan(1)
  expect(jumpPage(editor, 1)).toBe(false)
  expect(jumpPage(editor, -1)).toBe(true)
  expect(editor.state.page).toBe(doc.pages[0].id)
  expect(jumpFrame(editor, 1, size)).toBe(true)
  expect(editor.state.selection).toEqual([left.id])
  expect(jumpFrame(editor, 1, size)).toBe(true)
  expect(editor.state.selection).toEqual([right.id])
  expect(jumpFrame(editor, 1, size)).toBe(false)
  editor.select([left.children[0]])
  expect(jumpFrame(editor, 1, size)).toBe(true)
  expect(editor.state.selection).toEqual([right.id])
})
