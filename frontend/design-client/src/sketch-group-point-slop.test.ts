import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { import_sketch_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { emptySystem } from './design-system'
import { rasterExportBounds, targetBounds } from './export'
import { blank, node, type Bounds, type DesignDocument } from './model'

const WIREFRAME = '../../../testing/fixtures/sketch-public-20261105/Simple-Sketch-Wireframe-Kit/wireframe_kit_chevalier.sketch'
const DUST = [
  { id: '59DEDE6A-B97F-410E-BB4A-393F74BCCA7A', bounds: { x: 820, y: 9504, width: 152, height: 24 } },
  { id: '7FC376F9-61A6-4A35-9F26-F8F9E3C06AD3', bounds: { x: 550, y: 9504, width: 152, height: 24 } },
  { id: 'E56FED41-191A-4C20-B5AC-A69B873383B9', bounds: { x: 550, y: 9534, width: 152, height: 24 } },
] as const

function pageOf(doc: DesignDocument, id: string) {
  for (const page of doc.pages) {
    const stack = [...page.children]
    const seen = new Set<string>()
    while (stack.length) {
      const current = stack.pop()
      if (!current || seen.has(current)) continue
      seen.add(current)
      if (current === id) return page.id
      stack.push(...(doc.nodes[current]?.children ?? []))
    }
  }
  throw new Error(`missing page for ${id}`)
}

function decodeRgba(bytes: Uint8Array) {
  const file = Buffer.from(bytes)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const data = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(width * height * 4)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[cursor++]
    const row = Buffer.from(inflated.subarray(cursor, cursor + stride))
    cursor += stride
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0
      const up = previous[i]
      const upLeft = i >= 4 ? previous[i - 4] : 0
      if (filter === 1) row[i] = (row[i] + left) & 255
      else if (filter === 2) row[i] = (row[i] + up) & 255
      else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255
      else if (filter === 4) {
        const guess = left + up - upLeft
        const leftDistance = Math.abs(guess - left)
        const upDistance = Math.abs(guess - up)
        const diagonal = Math.abs(guess - upLeft)
        const predicted = leftDistance <= upDistance && leftDistance <= diagonal ? left : upDistance <= diagonal ? up : upLeft
        row[i] = (row[i] + predicted) & 255
      }
    }
    rgba.set(row, y * stride)
    previous = row
  }
  return { width, height, rgba }
}

function markedGroups(doc: DesignDocument) {
  const meta = doc.designSystem?.sketchContainers?.nodeMetadata as
    | Record<string, { bindings?: Record<string, string> }>
    | undefined
  return Object.values(doc.nodes).flatMap(node => {
    if (node.kind !== 'group' || meta?.[node.id]?.bindings?.sketchSourceGroup !== 'true') return []
    const pageId = pageOf(doc, node.id)
    const target = { kind: 'selection' as const, nodeIds: [node.id] }
    return [{ id: node.id, pageId, tight: targetBounds(doc, pageId, target), raster: rasterExportBounds(doc, pageId, target) }]
  })
}

test('real wireframe groups drop the empty point added by integer dust', () => {
  const bytes = new Uint8Array(readFileSync(new URL(WIREFRAME, import.meta.url)))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('95f79ed080cd7b5257e09c4bd0370249dbf53e88a5324fc1f57c4d06d8450bfe')
  const doc = (JSON.parse(import_sketch_json(bytes)) as { document: DesignDocument }).document
  const groups = markedGroups(doc)
  expect(groups).toHaveLength(49)
  const moved = groups.filter(group => JSON.stringify(group.raster) !== JSON.stringify(group.tight))
  expect(moved.length).toBe(13)
  for (const group of groups) {
    expect(Number.isInteger(group.raster.x)).toBe(true)
    expect(Number.isInteger(group.raster.y)).toBe(true)
    expect(Number.isInteger(group.raster.width)).toBe(true)
    expect(Number.isInteger(group.raster.height)).toBe(true)
    expect(group.raster.x).toBeLessThanOrEqual(group.tight.x + 1e-8)
    expect(group.raster.y).toBeLessThanOrEqual(group.tight.y + 1e-8)
    expect(group.raster.x + group.raster.width).toBeGreaterThanOrEqual(group.tight.x + group.tight.width - 1e-8)
    expect(group.raster.y + group.raster.height).toBeGreaterThanOrEqual(group.tight.y + group.tight.height - 1e-8)
    expect(group.raster.x).toBeGreaterThan(group.tight.x - 1)
    expect(group.raster.width).toBeLessThanOrEqual(group.tight.width + 1)
    expect(group.raster.height).toBeLessThanOrEqual(group.tight.height + 1)
  }
  const engine = new VectorEngine()
  try {
    engine.load_font(new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))))
    engine.load_document(JSON.stringify(doc))
    for (const item of DUST) {
      const group = groups.find(entry => entry.id === item.id)
      expect(group?.raster).toEqual(item.bounds)
      const pageId = group!.pageId
      const render = (bounds: Bounds) => new Uint8Array(engine.render_region_png(JSON.stringify({
        pageId, bounds, scale: 1, nodeIds: [item.id], rasterProfile: 'analytic',
      })))
      const snapped = decodeRgba(render(item.bounds))
      const expanded = decodeRgba(render({ x: item.bounds.x - 1, y: item.bounds.y, width: item.bounds.width + 1, height: item.bounds.height }))
      expect([snapped.width, snapped.height]).toEqual([152, 24])
      expect([expanded.width, expanded.height]).toEqual([153, 24])
      for (let y = 0; y < snapped.height; y++) {
        expect(expanded.rgba[(y * expanded.width) * 4 + 3]).toBe(0)
        const from = (y * expanded.width + 1) * 4
        expect(snapped.rgba.subarray(y * snapped.width * 4, (y + 1) * snapped.width * 4)).toEqual(
          expanded.rgba.subarray(from, from + snapped.width * 4),
        )
      }
    }
  } finally { engine.free() }
}, 60_000)

test('one-ulp dust snaps and a real fraction still expands only for a Sketch source group', () => {
  const doc = blank('尘埃编组')
  const child = node('rectangle', 0, 0, 10 + 1e-12, 8)
  const group = node('group', -1e-13, -1e-13, 10 + 1e-12, 8)
  group.children = [child.id]
  doc.nodes = { [group.id]: group, [child.id]: child }
  doc.pages[0].children = [group.id]
  doc.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: { [group.id]: { bindings: { sketchSourceGroup: 'true' } } } } }
  const target = { kind: 'selection' as const, nodeIds: [group.id] }
  expect(rasterExportBounds(doc, doc.pages[0].id, target)).toEqual({ x: 0, y: 0, width: 10, height: 8 })
  const fractional = blank('分数编组')
  const fractionalChild = node('rectangle', 0, 0, 41.25, 28.6)
  const fractionalGroup = node('group', 2.5, -1.5, 41.25, 28.6)
  fractionalGroup.children = [fractionalChild.id]
  fractional.nodes = { [fractionalGroup.id]: fractionalGroup, [fractionalChild.id]: fractionalChild }
  fractional.pages[0].children = [fractionalGroup.id]
  fractional.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: { [fractionalGroup.id]: { bindings: { sketchSourceGroup: 'true' } } } } }
  expect(rasterExportBounds(fractional, fractional.pages[0].id, { kind: 'selection', nodeIds: [fractionalGroup.id] })).toEqual({ x: 2, y: -2, width: 42, height: 30 })
  delete fractional.designSystem
  expect(rasterExportBounds(fractional, fractional.pages[0].id, { kind: 'selection', nodeIds: [fractionalGroup.id] })).toMatchObject({ x: 2.5, y: -1.5, width: 41.25, height: 28.6 })
})
