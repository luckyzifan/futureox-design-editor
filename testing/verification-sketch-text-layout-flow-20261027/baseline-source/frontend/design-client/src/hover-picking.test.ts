import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { scene, SpatialIndex } from './geometry'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture() {
  const doc = blank(), board = node('frame', 0, 0, 400, 300),
    group = node('group', 0, 0, 400, 300), text = node('text', 40, 40, 100, 30),
    container = node('frame', 20, 20, 300, 200)
  text.text = 'Small label'; container.fills = []; container.clip = false
  board.children = [group.id, container.id]; group.children = [text.id]
  doc.nodes = Object.fromEntries([board, group, text, container].map(n => [n.id, n]))
  doc.pages[0].children = [board.id]
  const editor = new Editor(doc); editors.push(editor)
  return { editor, board, text, container, point: { x: 60, y: 50 } }
}

test('hover prefers a small nested label over a larger container in the same board', () => {
  const { editor, board, text, container, point } = fixture()
  expect(editor.hit(point, true)).toBe(container.id)
  expect(editor.hoverHit(point)).toBe(text.id)
  editor.select([board.id])
  expect(editor.hoverHit(point)).toBe(text.id)
  expect(editor.state.selection).toEqual([board.id])
  expect(editor.hoverHit({ x: 310, y: 200 })).toBe(container.id)
  expect(editor.hoverHit({ x: 380, y: 280 })).toBe(board.id)
})

test('equal-size hits retain paint order and hidden or locked leaves do not steal hover', () => {
  const { editor, board, text, container, point } = fixture()
  const peer = node('text', 40, 40, 100, 30); peer.text = 'Top label'
  editor.change('Add peer', d => { d.nodes[peer.id] = peer; d.nodes[board.id].children.push(peer.id) })
  expect(editor.hoverHit(point)).toBe(peer.id)
  editor.update([peer.id], { locked: true }, '切换锁定')
  expect(editor.hoverHit(point)).toBe(text.id)
  editor.update([text.id], { visible: false }, '切换可见性')
  expect(editor.hoverHit(point)).toBe(container.id)
})

test('the smallest candidate must hit its actual shape, not just its bounds', () => {
  const { editor, board, text } = fixture(), icon = node('ellipse', 55, 45, 30, 30)
  editor.change('Add small icon', d => { d.nodes[icon.id] = icon; d.nodes[board.id].children.push(icon.id) })
  expect(editor.hoverHit({ x: 70, y: 60 })).toBe(icon.id)
  expect(editor.hoverHit({ x: 56, y: 46 })).toBe(text.id)
})

test('hover does not penetrate a foreground board to smaller objects behind it', () => {
  const { editor, board, point } = fixture(), front = node('frame', 0, 0, 400, 300), section = node('section', 0, 0, 800, 600)
  editor.change('Overlap boards in section', d => {
    section.children = [board.id, front.id]
    d.nodes[front.id] = front; d.nodes[section.id] = section; d.pages[0].children = [section.id]
  })
  expect(editor.hoverHit(point)).toBe(front.id)
})

test('children clipped outside their parent never become the smallest hover target', () => {
  const { editor, board, text, container } = fixture()
  editor.change('Clip child', d => {
    d.nodes[container.id].clip = true
    d.nodes[container.id].children = [text.id]
    d.nodes[text.id].transform = [1, 0, 0, 1, 350, 20]
    d.nodes[board.id].children = [container.id]
  })
  expect(editor.hoverHit({ x: 380, y: 50 })).toBe(board.id)
})

test('smallest hover uses presented geometry but still checks live visibility', () => {
  const { editor, text, point, container } = fixture()
  const snapshot = { document: editor.state.doc, pageId: editor.state.page }, index = new SpatialIndex(scene(snapshot.document, snapshot.pageId))
  editor.update([text.id], { transform: [1, 0, 0, 1, 200, 50] }, 'Move text')
  expect(editor.hoverHit(point, index, 1, snapshot)).toBe(text.id)
  editor.update([text.id], { visible: false }, '切换可见性')
  expect(editor.hoverHit(point, index, 1, snapshot)).toBe(container.id)
})
