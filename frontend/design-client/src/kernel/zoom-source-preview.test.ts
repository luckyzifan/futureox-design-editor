import { expect, test } from 'vitest'
import { blank, effect, node, type DesignDocument, type Effect } from '../model'
import { isZoomSourceHaloAdmission, zoomSourceFilterHaloDevicePixels, zoomSourcePreviewExceedsDeviceHalo } from './zoom-source-preview'

function page(radius: number, place: 'covering' | 'remote') {
  const doc = blank('zoom')
  const image = node('rectangle', place === 'covering' ? -100 : 10_000, place === 'covering' ? -100 : 10_000, 240, 240)
  const ellipse = node('ellipse', 0, 0, 5, 5)
  doc.schemaVersion = 19
  image.effects = [effect('gaussian-blur')]
  image.effects[0].radius = radius
  ellipse.effects = [effect('zoom-blur')]
  ellipse.effects[0].radius = 0
  ellipse.effects[0].zoomBlur = { amount: 10, center: [0.5, 0.5] }
  doc.nodes = { [image.id]: image, [ellipse.id]: ellipse }
  doc.pages[0].children = [image.id, ellipse.id]
  return { doc, image }
}

const view = { x: 0, y: 0, width: 800 / 150.6, height: 600 / 150.6 }
const scale = 150.6 * 2

test('15060% DPR 2 rejects only the zoom source the preview viewport hits', () => {
  const covering = page(9.564871788024902, 'covering')
  const remote = page(9.564871788024902, 'remote')
  expect(zoomSourceFilterHaloDevicePixels(covering.image.effects[0], scale)).toBeGreaterThan(2048)
  expect(zoomSourcePreviewExceedsDeviceHalo(covering.doc, covering.doc.pages[0].id, scale, view)).toBe(true)
  expect(zoomSourcePreviewExceedsDeviceHalo(remote.doc, remote.doc.pages[0].id, scale, view)).toBe(false)
  expect(zoomSourcePreviewExceedsDeviceHalo(covering.doc, covering.doc.pages[0].id, 1, { x: 0, y: 0, width: 800, height: 600 })).toBe(false)
  const zoomOnly = page(9.564871788024902, 'covering')
  zoomOnly.image.effects = []
  expect(zoomSourcePreviewExceedsDeviceHalo(zoomOnly.doc, zoomOnly.doc.pages[0].id, scale, view)).toBe(false)
  const legacy = page(9.564871788024902, 'covering')
  legacy.doc.schemaVersion = 18
  expect(zoomSourcePreviewExceedsDeviceHalo(legacy.doc, legacy.doc.pages[0].id, scale, view)).toBe(false)
})

test('halo admission keeps its kernel wording', () => {
  expect(isZoomSourceHaloAdmission('webgpu: Zoom source filter halo exceeds 2048 device pixels')).toBe(true)
  expect(isZoomSourceHaloAdmission('webgpu: Combined zoom source dependency halo exceeds 2048 device pixels')).toBe(true)
  expect(isZoomSourceHaloAdmission('webgpu: GPU surface budget exceeded')).toBe(false)
  expect(isZoomSourceHaloAdmission('PREVIEW_CANCELLED')).toBe(false)
})

function scaledNeighbor(scale: number, x: number, y: number, width: number, height: number) {
  const doc = page(2.5, 'covering').doc
  const image = doc.nodes[doc.pages[0].children[0]]
  image.transform = [scale, 0, 0, scale, x, y]
  image.width = width
  image.height = height
  image.effects[0].radius = 2.5
  const ellipse = doc.nodes[doc.pages[0].children[1]]
  ellipse.effects[0].zoomBlur = { amount: 24, center: [0.5, 0.5] }
  return doc
}

test('placed node scale matches kernel zoom-source admission', () => {
  const modest = { x: 0, y: 0, width: 800 / 150, height: 600 / 150 }
  const wide = { x: 0, y: 0, width: 2410 / 301.2, height: 904 / 301.2 }
  const up = scaledNeighbor(2, 10, 0.2, 1.5, 1.5)
  const flat = scaledNeighbor(1, 10, 0.2, 1.5, 1.5)
  const down = scaledNeighbor(0.25, 10, 0.2, 1.5, 1.5)
  expect(zoomSourcePreviewExceedsDeviceHalo(up, up.pages[0].id, 150, modest)).toBe(true)
  expect(zoomSourcePreviewExceedsDeviceHalo(flat, flat.pages[0].id, 150, modest)).toBe(false)
  expect(zoomSourcePreviewExceedsDeviceHalo(down, down.pages[0].id, 301.2, wide)).toBe(false)
  const parent = scaledNeighbor(1, 0, 0, 20, 20)
  const neighbor = parent.nodes[parent.pages[0].children[0]]
  const group = node('group', 0, 0, 40, 40)
  group.transform = [2, 0, 0, 2, 0, 0]
  group.children = [neighbor.id]
  neighbor.transform = [1, 0, 0, 1, 0, 0]
  parent.nodes[group.id] = group
  parent.pages[0].children[0] = group.id
  expect(zoomSourcePreviewExceedsDeviceHalo(parent, parent.pages[0].id, 150, modest)).toBe(true)
  group.transform = [1, 0, 0, 1, 0, 0]
  expect(zoomSourcePreviewExceedsDeviceHalo(parent, parent.pages[0].id, 150, modest)).toBe(false)
  const turn = 2 * Math.cos(Math.PI / 6)
  const rise = 2 * Math.sin(Math.PI / 6)
  neighbor.transform = [turn, rise, -rise, turn, 0, 0]
  neighbor.width = 20
  neighbor.height = 20
  parent.pages[0].children[0] = neighbor.id
  expect(zoomSourcePreviewExceedsDeviceHalo(parent, parent.pages[0].id, 150, modest)).toBe(true)
})

test('gaussian support matches the kernel formula', () => {
  const effect: Effect = { id: 'e', kind: 'gaussian-blur', visible: true, radius: 9.564871788024902, x: 0, y: 0, spread: 0, color: '#000', opacity: 1, amount: 0 }
  expect(zoomSourceFilterHaloDevicePixels(effect, 301.2)).toBeCloseTo(3 * 9.564871788024902 * 301.2 + 2, 6)
})
