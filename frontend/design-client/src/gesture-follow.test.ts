import { expect, test } from 'vitest'
import { blank, node } from './model'
import { apply, around, rotate, translate } from './commands/affine'
import { elementMatrix, followCamera, isolatedGestureCrop, gestureHoleColor, screenWarp, visibleFollowBox } from './gesture-follow'

test('a world translation becomes the same screen translation at the crop origin', () => {
  const view = { x: 10, y: 20, zoom: 2 }
  const warp = screenWarp(view, translate(3, -4))
  expect(warp).toEqual([1, 0, 0, 1, 6, -8])
  const local = elementMatrix(warp!, { x: 12, y: 24 })
  expect(local[4]).toBeCloseTo(6)
  expect(local[5]).toBeCloseTo(-8)
  const screen = { x: 12 + local[4], y: 24 + local[5] }
  expect(screen).toEqual({ x: 18, y: 16 })
})

test('rotation around the world origin maps the snapshot corner with the selection', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  const delta = around({ x: 0, y: 0 }, rotate(90))
  const warp = screenWarp(view, delta)!
  const crop = { x: 10, y: 0 }
  const local = elementMatrix(warp, crop)
  const moved = { x: crop.x + local[4], y: crop.y + local[5] }
  expect(moved.x).toBeCloseTo(0)
  expect(moved.y).toBeCloseTo(10)
  const corner = apply(followCamera(view), apply(delta, { x: 10, y: 0 }))
  expect(corner.x).toBeCloseTo(moved.x)
  expect(corner.y).toBeCloseTo(moved.y)
})

test('the punched hole uses a solid parent fill, otherwise the page background', () => {
  const document = blank()
  document.pages[0].background = '#eeeeee'
  const frame = node('frame', 0, 0, 100, 80)
  frame.fills = [{ ...frame.fills[0], kind: 'solid', color: '#336699', visible: true, opacity: 1 }]
  expect(gestureHoleColor(document, document.pages[0].id, frame)).toBe('#336699')
  frame.fills[0].visible = false
  expect(gestureHoleColor(document, document.pages[0].id, frame)).toBe('#eeeeee')
  expect(gestureHoleColor(document, document.pages[0].id, undefined)).toBe('#eeeeee')
})

test('follow crops stay inside the viewport instead of failing at the edge', () => {
  const view = { x: 0, y: 0, zoom: 2 }
  const fitted = visibleFollowBox({ x: -40, y: 10, width: 80, height: 30 }, view, 100, 80)
  expect(fitted?.x).toBeGreaterThan(0)
  expect(fitted!.x + fitted!.width).toBeLessThan(50)
  expect(visibleFollowBox({ x: 1000, y: 1000, width: 10, height: 10 }, view, 100, 80)).toBeNull()
})

test('a singular camera does not invent a follow warp', () => {
  expect(screenWarp({ x: 0, y: 0, zoom: 0 }, translate(1, 1))).toBeNull()
  expect(screenWarp({ x: 0, y: 0, zoom: 1 }, [1, 0, 0, 0, 0, 0])).toBeNull()
})

test('an isolated screen crop excludes a stationary neighbor at both ends of a drag', () => {
  const box={x:110,y:100,width:20,height:20}, neighbor={x:160,y:100,width:16,height:16}
  const view={x:0,y:0,zoom:1}
  expect(isolatedGestureCrop(box,[neighbor],view,[1,0,0,1,180,0],460,275)).toEqual(box)
  expect(isolatedGestureCrop(box,[neighbor],view,[1,0,0,1,50,0],460,275)).toBeUndefined()
  expect(isolatedGestureCrop(box,[{...neighbor,x:131}],view,[1,0,0,1,180,0],460,275)).toBeUndefined()
})
