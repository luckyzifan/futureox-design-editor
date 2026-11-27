import { expect, test } from 'vitest'
import { blank, node } from './model'
import { prototypeFixedViews } from './prototype'

function scrollingFrame() {
  const doc = blank('fixed prototype')
  doc.schemaVersion = 37
  const frame = node('frame', 10, 20, 320, 640)
  frame.prototypeOverflow = 'vertical'
  const header = node('rectangle', 0, 0, 320, 64); header.name = 'Header'; header.fixedToViewport = true
  const body = node('rectangle', 0, 64, 320, 900); body.name = 'Body'
  const badge = node('ellipse', 280, 20, 24, 24); badge.name = 'Badge'; badge.fixedToViewport = true
  header.children = [badge.id]
  frame.children = [header.id, body.id]
  doc.nodes = Object.fromEntries([frame, header, body, badge].map(item => [item.id, item]))
  doc.pages[0].children = [frame.id]
  return { doc, frame, header, body, badge }
}

test('a fixed layer is hidden in the scrolling view and kept in an unscrolled overlay view', () => {
  const { doc, frame, header, body, badge } = scrollingFrame()
  const views = prototypeFixedViews(doc, frame.id, true)!
  expect(views.ids.sort()).toEqual([header.id, badge.id].sort())
  expect(views.topIds).toEqual([header.id])
  expect(views.main.nodes[header.id].visible).toBe(false)
  expect(views.main.nodes[body.id].visible).toBe(true)
  expect(views.fixed.nodes[header.id].visible).toBe(true)
  expect(views.fixed.nodes[badge.id].visible).toBe(true)
  expect(views.fixed.nodes[body.id].visible).toBe(false)
  expect(views.fixed.nodes[frame.id].fills).toEqual([])
  expect(views.fixed.pages[0].background).toBe('rgba(0,0,0,0)')
  expect(doc.nodes[header.id].fixedToViewport).toBe(true)
})

test('nested fixed layers follow their pinned ancestor and the scrolling frame itself is ignored', () => {
  const { doc, frame, header, body, badge } = scrollingFrame()
  doc.nodes[frame.id].fixedToViewport = true
  const views = prototypeFixedViews(doc, frame.id)!
  expect(views.ids.sort()).toEqual([header.id, badge.id].sort())
  expect(views.topIds).toEqual([header.id])
  expect(views.main.nodes[frame.id].visible).toBe(true)
  delete doc.nodes[frame.id].fixedToViewport
  doc.nodes[body.id].fixedToViewport = true
  const both = prototypeFixedViews(doc, frame.id)!
  expect(both.ids.sort()).toEqual([header.id, badge.id, body.id].sort())
  expect(both.topIds).toEqual([header.id, body.id])
  expect(both.main.nodes[header.id].visible).toBe(false)
  expect(both.main.nodes[body.id].visible).toBe(false)
  expect(both.fixed.nodes[header.id].visible).toBe(true)
})

test('a frame without fixed descendants needs no second surface', () => {
  const { doc, frame, header } = scrollingFrame()
  delete header.fixedToViewport
  for (const child of header.children) delete doc.nodes[child].fixedToViewport
  expect(prototypeFixedViews(doc, frame.id)).toBeNull()
})