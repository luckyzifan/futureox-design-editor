import { expect, test } from 'vitest'
import { blank, node, validateDocument, hasSchema12FrameProperties, defaultLayoutGrid } from './model'

const frameWithGrid = () => {
  const d = blank()
  d.schemaVersion = 12
  const frame = node('frame', 0, 0, 400, 300)
  frame.layoutGrid = defaultLayoutGrid()
  d.nodes[frame.id] = frame
  d.pages[0].children = [frame.id]
  return { d, frame }
}

test('layout grids validate on schema-12 frames and are detected', () => {
  const { d } = frameWithGrid()
  expect(() => validateDocument(d)).not.toThrow()
  expect(hasSchema12FrameProperties(d)).toBe(true)
  expect(hasSchema12FrameProperties(blank())).toBe(false)
})

test('layout grids reject older schemas, non-frames and open ranges', () => {
  const { d, frame } = frameWithGrid()
  d.schemaVersion = 11
  expect(() => validateDocument(d)).toThrow('布局网格')
  const { d: d2, frame: frame2 } = frameWithGrid()
  const text = node('text', 0, 0, 100, 20)
  text.layoutGrid = defaultLayoutGrid()
  d2.nodes[text.id] = text
  d2.pages[0].children.push(text.id)
  expect(() => validateDocument(d2)).toThrow('布局网格')
  const { d: d3, frame: frame3 } = frameWithGrid()
  frame3.layoutGrid!.count = 65
  expect(() => validateDocument(d3)).toThrow('布局网格')
  const { d: d4, frame: frame4 } = frameWithGrid()
  frame4.layoutGrid!.gutter = -1
  expect(() => validateDocument(d4)).toThrow('布局网格')
  const { d: d5, frame: frame5 } = frameWithGrid()
  frame5.layoutGrid!.color = 'not-a-color'
  expect(() => validateDocument(d5)).toThrow('布局网格')
})
