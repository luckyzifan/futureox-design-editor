import { expect, test } from 'vitest'
import { applyNotationChannel, eyedropperReadout, nearestStopIndex, notationChannels } from './color-field'

test('Mac picker fields for #D9D9D9 are Hex D9D9D9, RGB 217 217 217 and HSB 0 0 85', () => {
  expect(eyedropperReadout('#d9d9d9', 'HEX')).toBe('D9D9D9')
  expect(eyedropperReadout('#D9D9D9', 'RGB')).toBe('RGB 217 217 217')
  expect(eyedropperReadout('#D9D9D9', 'HSB')).toBe('HSB 0° 0 85')
  expect(eyedropperReadout('#D9D9D9', 'HSL')).toBe('HSL 0° 0 85')
  expect(notationChannels('#D9D9D9', 'RGB')).toEqual([217, 217, 217])
  expect(notationChannels('#D9D9D9', 'HSB')).toEqual([0, 0, 85])
  expect(applyNotationChannel('#D9D9D9', 'RGB', 0, 10)).toBe('#0ad9d9')
})

test('eyedropper readout keeps primary hues and black', () => {
  expect(eyedropperReadout('#ff0000', 'HSB')).toBe('HSB 0° 100 100')
  expect(eyedropperReadout('#00ff00', 'HSL')).toBe('HSL 120° 100 50')
  expect(eyedropperReadout('#0000ff', 'HSB')).toBe('HSB 240° 100 100')
  expect(eyedropperReadout('#000000', 'HSB')).toBe('HSB 0° 0 0')
  expect(eyedropperReadout('#ffffff', 'HSB')).toBe('HSB 0° 0 100')
})

test('gradient stop selection picks the nearest offset', () => {
  const stops = [{ offset: 0 }, { offset: 0.5 }, { offset: 1 }]
  expect(nearestStopIndex(stops, 0.2)).toBe(0)
  expect(nearestStopIndex(stops, 0.4)).toBe(1)
  expect(nearestStopIndex(stops, 0.9)).toBe(2)
})
