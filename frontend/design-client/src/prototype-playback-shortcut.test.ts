import { expect, test } from 'vitest'
import { blank, node } from './model'
import { inlinePrototypePreviewChord, pageHasFrame, presentPrototypeChord, prototypePlaybackReady } from './prototype-playback-shortcut'

const bare = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

test('present and inline preview chords follow Mac desktop Figma and the Windows present chord', () => {
  const present = { key: 'Enter', code: 'Enter', ...bare, metaKey: true, altKey: true }
  const windowsPresent = { key: 'Enter', code: 'Enter', ...bare, ctrlKey: true, altKey: true }
  const preview = { key: ' ', code: 'Space', ...bare, shiftKey: true }
  expect(presentPrototypeChord(present, 'mac')).toBe(true)
  expect(presentPrototypeChord(windowsPresent, 'mac')).toBe(false)
  expect(presentPrototypeChord(present, 'windows')).toBe(false)
  expect(presentPrototypeChord(present, 'linux')).toBe(false)
  expect(presentPrototypeChord(windowsPresent, 'windows')).toBe(true)
  expect(presentPrototypeChord(windowsPresent, 'linux')).toBe(true)
  expect(presentPrototypeChord({ ...present, shiftKey: true }, 'mac')).toBe(false)
  expect(presentPrototypeChord({ ...present, ctrlKey: true }, 'mac')).toBe(false)
  expect(inlinePrototypePreviewChord(preview)).toBe(true)
  expect(inlinePrototypePreviewChord({ key: ' ', code: 'Space', ...bare })).toBe(false)
  expect(inlinePrototypePreviewChord({ ...preview, metaKey: true })).toBe(false)
  expect(inlinePrototypePreviewChord({ ...preview, altKey: true })).toBe(false)
  expect(inlinePrototypePreviewChord({ key: 'Enter', code: 'Enter', ...bare, shiftKey: true })).toBe(false)
})

test('inline preview requires a frame on the page, and playback requires a live start node', () => {
  const doc = blank('Gates')
  const frame = node('frame')
  const group = node('group')
  const nested = node('frame')
  const shape = node('rectangle')
  const section = node('section')
  group.children = [nested.id]
  doc.nodes = { [frame.id]: frame, [group.id]: group, [nested.id]: nested, [shape.id]: shape, [section.id]: section }
  const page = doc.pages[0]
  page.children = [shape.id]
  expect(pageHasFrame(doc, page.id)).toBe(false)
  expect(prototypePlaybackReady(doc)).toBe(true)
  page.children = [section.id]
  expect(pageHasFrame(doc, page.id)).toBe(false)
  page.children = [group.id]
  expect(pageHasFrame(doc, page.id)).toBe(true)
  page.children = []
  doc.prototype = { interactions: {}, startNode: frame.id }
  expect(pageHasFrame(doc, page.id)).toBe(false)
  expect(prototypePlaybackReady(doc)).toBe(true)
  doc.prototype = { interactions: {}, startNode: 'missing' }
  expect(prototypePlaybackReady(doc)).toBe(false)
  doc.prototype = undefined
  expect(prototypePlaybackReady(doc)).toBe(false)
})
