import { expect, test } from 'vitest'
import { blank, effect, node, type DesignDocument, type Matrix } from '../model'
import { zoomSourceFilterHalo, zoomSourceHaloRejection, zoomSourcePreviewExceedsHalo } from './zoom-preview-admission'

function entry(id: string, x: number, y: number, width: number, height: number, ancestors: string[] = []) {
  return { id, matrix: [1, 0, 0, 1, x, y] as Matrix, bounds: { x, y, width, height }, ancestors, depth: ancestors.length, parent: ancestors.at(-1) ?? '', locked: false }
}

const DEVICE_ZOOM = 150.6 * 2

function page(withNeighbor: boolean, center: [number, number] = [0.5, 0.5]): DesignDocument {
  const doc = blank()
  doc.schemaVersion = 19
  const ellipse = node('ellipse', 0, 0, 5, 5)
  ellipse.name = '椭圆 66'
  const zoom = effect('zoom-blur')
  zoom.zoomBlur = { amount: 24, center }
  ellipse.effects = [zoom]
  const nodes = [ellipse]
  if (withNeighbor) {
    const neighbor = node('rectangle', 10, 0.2, 1.5, 1.5)
    const blur = effect('gaussian-blur')
    blur.radius = 2.5
    neighbor.effects = [blur]
    nodes.push(neighbor)
  }
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = nodes.map(item => item.id)
  return doc
}

function entriesFor(doc: DesignDocument) {
  return doc.pages[0].children.map(id => {
    const item = doc.nodes[id]
    return entry(id, item.transform[4], item.transform[5], item.width, item.height)
  })
}

test('15060% whole viewport exceeds the zoom-source halo and the ellipse tile does not', () => {
  const doc = page(true)
  const pageId = doc.pages[0].id
  const entries = entriesFor(doc)
  const viewport = { x: 0, y: 0, width: 2410 / DEVICE_ZOOM, height: 904 / DEVICE_ZOOM }
  const tile = { x: 0, y: 0, width: 514 / DEVICE_ZOOM, height: 514 / DEVICE_ZOOM }
  expect(zoomSourcePreviewExceedsHalo(doc, pageId, viewport, DEVICE_ZOOM, entries)).toBe(true)
  expect(zoomSourcePreviewExceedsHalo(doc, pageId, tile, DEVICE_ZOOM, entries)).toBe(false)
  expect(zoomSourceFilterHalo(doc.nodes[doc.pages[0].children[1]].effects[0], DEVICE_ZOOM)).toBeGreaterThan(2048)
  const ellipse = doc.nodes[doc.pages[0].children[0]]
  expect(zoomSourcePreviewExceedsHalo(doc, pageId, viewport, DEVICE_ZOOM, entries, [ellipse.id])).toBe(false)
})

test('moving the focus does not admit the same viewport, and 100% does', () => {
  const doc = page(true, [0.82, 0.2])
  const pageId = doc.pages[0].id
  const entries = entriesFor(doc)
  const viewport = { x: 0, y: 0, width: 8, height: 3 }
  expect(zoomSourcePreviewExceedsHalo(doc, pageId, viewport, DEVICE_ZOOM, entries)).toBe(true)
  expect(zoomSourcePreviewExceedsHalo(doc, pageId, viewport, 1, entries)).toBe(false)
  const plain = page(false)
  expect(zoomSourcePreviewExceedsHalo(plain, plain.pages[0].id, viewport, DEVICE_ZOOM, entriesFor(plain))).toBe(false)
})

test('halo rejection text survives a backend prefix', () => {
  expect(zoomSourceHaloRejection(Error('webgpu: Zoom source filter halo exceeds 2048 device pixels'))).toBe(true)
  expect(zoomSourceHaloRejection(Error('PREVIEW_BUDGET: webgpu: Combined zoom source dependency halo exceeds 2048 device pixels'))).toBe(true)
  expect(zoomSourceHaloRejection(Error('PREVIEW_CANCELLED'))).toBe(false)
})

test('admission over a 752-node page stays on the main thread and still rejects only the wide capture', () => {
  const doc = page(true)
  const pageId = doc.pages[0].id
  const ellipse = doc.pages[0].children[0]
  for (let index = 0; index < 750; index++) {
    const far = node('rectangle', 10_000 + index, 10_000, 4, 4)
    doc.nodes[far.id] = far
    doc.pages[0].children.push(far.id)
  }
  const started = performance.now()
  const entries = entriesFor(doc)
  const wide = zoomSourcePreviewExceedsHalo(doc, pageId, { x: 0, y: 0, width: 8, height: 3 }, DEVICE_ZOOM, entries)
  const tile = zoomSourcePreviewExceedsHalo(doc, pageId, { x: 0, y: 0, width: 514 / DEVICE_ZOOM, height: 514 / DEVICE_ZOOM }, DEVICE_ZOOM, entries)
  const elapsed = performance.now() - started
  expect(wide).toBe(true)
  expect(tile).toBe(false)
  expect(entries.some(entry => entry.id === ellipse)).toBe(true)
  expect(elapsed).toBeLessThan(50)
  console.info(`zoom-preview-admission 752 nodes: ${elapsed.toFixed(3)} ms`)
})
