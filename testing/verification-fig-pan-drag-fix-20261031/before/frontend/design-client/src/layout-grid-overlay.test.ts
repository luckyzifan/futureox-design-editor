import { expect, test } from 'vitest'
import { blank, node, defaultLayoutGrid } from './model'
import { layoutGridRectangles } from './grid-overlay'

const documentWithFrame = (width: number, height: number) => {
  const d = blank()
  const frame = node('frame', 0, 0, width, height)
  d.nodes[frame.id] = frame
  d.pages[0].children = [frame.id]
  return { d, frame }
}

test('column grids lay lit bands through the kernel section predicate', () => {
  const { d, frame } = documentWithFrame(300, 200)
  frame.layoutGrid = { ...defaultLayoutGrid(), axis: 'column', count: 3, gutter: 20, margin: 30 }
  const bands = layoutGridRectangles(frame.layoutGrid, frame.id, d)
  // 3 columns, all lit (equal tracks): x = 30, 30+90, 30+180, width 70.
  // track = (300 - 2*30 - 2*20) / 3 = 100/3? -> 300-60-40=200, /3 = 66.67
  const track = (300 - 60 - 40) / 3
  expect(bands).toHaveLength(3)
  expect(bands[0].x).toBeCloseTo(30, 6)
  expect(bands[0].width).toBeCloseTo(track, 6)
  expect(bands[0].height).toBeCloseTo(200 - 60, 6)
  expect(bands[1].x).toBeCloseTo(30 + track + 20, 6)
  expect(bands[2].x).toBeCloseTo(30 + 2 * (track + 20), 6)
})

test('row and uniform grids cover both axis shapes', () => {
  const { d, frame } = documentWithFrame(200, 120)
  frame.layoutGrid = { ...defaultLayoutGrid(), axis: 'row', count: 4, gutter: 0, margin: 0 }
  const rows = layoutGridRectangles(frame.layoutGrid, frame.id, d)
  expect(rows).toHaveLength(4)
  expect(rows[0].height).toBeCloseTo(30, 6)
  expect(rows[3].y).toBeCloseTo(90, 6)

  frame.layoutGrid = { ...defaultLayoutGrid(), axis: 'uniform', count: 5, gutter: 0, margin: 0 }
  const cells = layoutGridRectangles(frame.layoutGrid, frame.id, d)
  expect(cells).toHaveLength(25)
  expect(cells[0].width).toBeCloseTo(40, 6)
  expect(cells[24].x).toBeCloseTo(160, 6)
})

test('invisible grids render nothing', () => {
  const { d, frame } = documentWithFrame(200, 200)
  frame.layoutGrid = { ...defaultLayoutGrid(), visible: false }
  expect(layoutGridRectangles(frame.layoutGrid, frame.id, d)).toEqual([])
})
