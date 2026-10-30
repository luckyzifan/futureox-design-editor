import { expect, test } from 'vitest'
import { canvasScrollAxis, scrollbarCamera } from './canvas-scrollbars'

test('scroll thumb round trips negative and large world positions without changing zoom', () => {
  for (const zoom of [.025,.5,1,32]) for (const position of [-1e6,-150,0,345,1e6]) {
    const axis=canvasScrollAxis(-1000,5000,position,zoom,800)
    expect(scrollbarCamera(axis,axis.offset,zoom)).toBeCloseTo(position,6)
    expect(axis.thumb).toBeGreaterThanOrEqual(28)
    expect(axis.offset).toBeGreaterThanOrEqual(0)
    expect(axis.offset+axis.thumb).toBeLessThanOrEqual(axis.track+1e-7)
    expect(scrollbarCamera(axis,axis.offset+10,zoom)).toBeLessThanOrEqual(position)
  }
})

test('drag mapping uses the captured range and is independent of extending viewport bounds', () => {
  const axis=canvasScrollAxis(0,100,0,1,800)
  const first=scrollbarCamera(axis,axis.offset+20,1)
  const last=scrollbarCamera(axis,axis.offset+40,1)
  expect(last).toBeCloseTo(first*2)
  expect(scrollbarCamera(axis,-1000,1)).toBe(-axis.minimum)
  expect(scrollbarCamera(axis,10000,1)).toBe(-(axis.minimum+axis.range))
})
