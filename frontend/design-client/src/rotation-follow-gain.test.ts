/** @vitest-environment jsdom */
// CPU/WASM measurement for issue #64. Not a GPU, Electron, or Metal result.
// The independent reference is VectorEngine.render_rgba / render_png from the
// dev-profile kernel built in this run. Gates are frozen before the run:
// interior flat samples must match that reference with channel error 0
// (stricter than the SDR < 1/255 display gate). A gesture of 4 rotation
// samples must reach those pixels at least 5% faster than rendering each
// sample, which is what main does when a nested plan is refused.
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { expect, test } from 'vitest'
import { apply, around, inverse, multiply, rotate } from './geometry'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, validateDocument, type DesignDocument, type Matrix } from './model'
import { rotationSourcePlan, type RotationSourcePlan } from './rotation-source-preview'

const INTERIOR_ERROR = 0
const MIN_SPEEDUP = 0.05
const VIEW_W = 480
const VIEW_H = 320
const ANGLES = [18, 36, 54, 72]
const ROUNDS = 5
const EDGE_MARGIN = 3

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Original synthetic PNG. Not a user sketch, screenshot, or exported fixture. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = rgba[0]
    row[2 + x * 4] = rgba[1]
    row[3 + x * 4] = rgba[2]
    row[4 + x * 4] = rgba[3]
  }
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hexByte(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

function pixel(bytes: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const index = (y * width + x) * 4
  return [bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3]]
}

function renderOptions(doc: DesignDocument, width: number, height: number) {
  return JSON.stringify({
    pageId: doc.pages[0].id, width, height,
    view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false, checkerboard: false,
    rasterProfile: 'analytic',
  })
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function inside(box: { x: number; y: number; width: number; height: number }, x: number, y: number) {
  return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height
}

function boundaryDistance(box: { x: number; y: number; width: number; height: number }, x: number, y: number) {
  if (inside(box, x, y)) return Math.min(x - box.x, y - box.y, box.x + box.width - x, box.y + box.height - y)
  const dx = Math.max(box.x - x, 0, x - (box.x + box.width))
  const dy = Math.max(box.y - y, 0, y - (box.y + box.height))
  return -Math.hypot(dx, dy)
}

function previewColor(plan: RotationSourcePlan, delta: Matrix, x: number, y: number, paint: [number, number, number]): [number, number, number] | null {
  const preimage = apply(inverse(delta), { x, y })
  const sourceDistance = boundaryDistance(plan.box, preimage.x, preimage.y)
  const clipDistance = plan.clip ? boundaryDistance(plan.clip, x, y) : Number.POSITIVE_INFINITY
  if (Math.abs(sourceDistance) < EDGE_MARGIN || Math.abs(clipDistance) < EDGE_MARGIN) return null
  if (sourceDistance >= EDGE_MARGIN && clipDistance >= EDGE_MARGIN) return paint
  let hole: string | null = null
  let holeDistance = Number.POSITIVE_INFINITY
  for (const patch of plan.holes) {
    const distance = boundaryDistance(patch.box, x, y)
    if (distance >= EDGE_MARGIN) {
      hole = patch.color
      holeDistance = distance
    }
  }
  if (!hole || holeDistance < EDGE_MARGIN) return null
  return hexByte(hole)
}

test('nested rotation pixels match the kernel where main\'s held frame does not', () => {
  const doc = blank('counterexample')
  doc.pages[0].background = '#ffffff'
  const parent = node('frame', 0, 0, 100, 100)
  parent.clip = false
  parent.fills[0].color = '#00ff00'
  const shape = node('rectangle', 80, 40, 80, 40)
  shape.fills[0].color = '#ff0000'
  parent.children = [shape.id]
  doc.nodes = { [parent.id]: parent, [shape.id]: shape }
  doc.pages[0].children = [parent.id]
  validateDocument(doc)
  const width = 200
  const height = 120
  const center = { x: 120, y: 60 }
  const delta = around(center, rotate(90))
  const rotated = structuredClone(doc)
  rotated.nodes[shape.id].transform = multiply(delta, shape.transform)
  const options = renderOptions(doc, width, height)
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    const stale = engine.render_rgba(options)
    engine.load_document(JSON.stringify(rotated))
    const reference = engine.render_rgba(options)
    const plan = rotationSourcePlan({
      node: shape, world: shape.transform, others: [], center, degrees: 90,
      pageBackground: '#ffffff', documentSpace: 'srgb', parent,
      ancestors: [{ node: parent, matrix: parent.transform }],
      nodes: doc.nodes, grid: false, checkerboard: false, pixelPreview: false,
    })
    expect(plan).not.toBeNull()
    const samples = [
      { x: 155, y: 45, expect: [255, 255, 255] as [number, number, number] },
      { x: 90, y: 50, expect: [0, 255, 0] as [number, number, number] },
      { x: 120, y: 60, expect: [255, 0, 0] as [number, number, number] },
    ]
    let staleError = 0
    let candidateError = 0
    for (const sample of samples) {
      const at = { x: sample.x + 0.5, y: sample.y + 0.5 }
      const predicted = previewColor(plan!, delta, at.x, at.y, hexByte('#ff0000'))
      expect(predicted).toEqual(sample.expect)
      const ref = pixel(reference, width, sample.x, sample.y)
      const old = pixel(stale, width, sample.x, sample.y)
      for (let channel = 0; channel < 3; channel += 1) {
        candidateError = Math.max(candidateError, Math.abs(ref[channel] - sample.expect[channel]))
        staleError = Math.max(staleError, Math.abs(old[channel] - sample.expect[channel]))
      }
      expect(ref[3]).toBe(255)
    }
    expect(candidateError).toBe(INTERIOR_ERROR)
    expect(staleError).toBeGreaterThanOrEqual(128)
    const restored = structuredClone(rotated)
    restored.nodes[shape.id].transform = shape.transform
    engine.load_document(JSON.stringify(restored))
    expect(sha256(engine.render_rgba(options))).toBe(sha256(stale))
    engine.load_document(JSON.stringify(rotated))
    const png = engine.render_png(options)
    expect(png.byteLength).toBeGreaterThan(32)
    expect(engine.render_png(options)).toEqual(png)
    console.log(JSON.stringify({
      case: 'counterexample-fidelity',
      reference: 'VectorEngine.render_rgba analytic',
      candidateError, staleError,
      undoHashMatches: true,
      pngBytes: png.byteLength,
    }))
  } finally {
    engine.free()
  }
})

test('a nested opaque image follows with fewer full rasters and the same release pixels', () => {
  const png = solidPng(VIEW_W, VIEW_H, [196, 59, 103, 255])
  const doc = blank('large-image')
  doc.pages[0].background = '#ffffff'
  const frame = node('frame', 0, 0, VIEW_W, VIEW_H)
  frame.clip = true
  frame.fills[0].color = '#112233'
  const image = node('rectangle', 0, 0, VIEW_W, VIEW_H)
  image.fills[0] = { ...image.fills[0], kind: 'image', color: '#c43b67', fit: 'stretch', image: `data:image/png;base64,${png.toString('base64')}` }
  frame.children = [image.id]
  doc.nodes = { [frame.id]: frame, [image.id]: image }
  doc.pages[0].children = [frame.id]
  validateDocument(doc)
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 }
  const options = renderOptions(doc, VIEW_W, VIEW_H)
  const engine = new VectorEngine()
  const posePath = { retained: 0, reloaded: 0 }
  const show = (pose: DesignDocument) => {
    const local = pose.nodes[image.id].transform
    const retained = engine.apply_interaction_transforms(JSON.stringify({ [image.id]: local }))
    if (retained) posePath.retained += 1
    else {
      engine.load_document(JSON.stringify(pose))
      posePath.reloaded += 1
    }
  }
  const poseAt = (degrees: number) => {
    const next = structuredClone(doc)
    next.nodes[image.id].transform = multiply(around(center, rotate(degrees)), image.transform)
    return next
  }
  try {
    engine.load_document(JSON.stringify(doc))
    engine.render_rgba(options)
    const plan = rotationSourcePlan({
      node: image, world: image.transform, others: [], center, degrees: ANGLES[0],
      pageBackground: doc.pages[0].background, documentSpace: 'srgb', parent: frame,
      ancestors: [{ node: frame, matrix: frame.transform }],
      nodes: doc.nodes, grid: false, checkerboard: false, pixelPreview: false,
    })
    expect(plan?.paint.kind).toBe('image')
    expect(plan?.box).toEqual({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
    const degrees = 36
    const delta = around(center, rotate(degrees))
    show(poseAt(degrees))
    const reference = engine.render_rgba(options)
    show(doc)
    const stale = engine.render_rgba(options)
    let scored = 0
    let candidateError = 0
    let staleError = 0
    for (let y = 8; y < VIEW_H; y += 32) {
      for (let x = 8; x < VIEW_W; x += 32) {
        const predicted = previewColor(plan!, delta, x + 0.5, y + 0.5, hexByte('#c43b67'))
        if (!predicted) continue
        scored += 1
        const ref = pixel(reference, VIEW_W, x, y)
        const old = pixel(stale, VIEW_W, x, y)
        for (let channel = 0; channel < 3; channel += 1) {
          candidateError = Math.max(candidateError, Math.abs(ref[channel] - predicted[channel]))
          staleError = Math.max(staleError, Math.abs(old[channel] - predicted[channel]))
        }
      }
    }
    expect(scored).toBeGreaterThan(20)
    expect(candidateError).toBe(INTERIOR_ERROR)
    expect(staleError).toBeGreaterThanOrEqual(128)

    const baseline: number[] = []
    const candidate: number[] = []
    for (let round = 0; round < ROUNDS + 1; round += 1) {
      let baselineMs = 0
      for (const angle of ANGLES) {
        const started = performance.now()
        show(poseAt(angle))
        engine.render_rgba(options)
        baselineMs += performance.now() - started
      }
      let candidateMs = 0
      for (const angle of ANGLES) {
        const started = performance.now()
        const admitted = rotationSourcePlan({
          node: image, world: image.transform, others: [], center, degrees: angle,
          pageBackground: doc.pages[0].background, documentSpace: 'srgb', parent: frame,
          ancestors: [{ node: frame, matrix: frame.transform }],
          nodes: doc.nodes, grid: false, checkerboard: false, pixelPreview: false,
        })
        if (!admitted) throw new Error('nested image plan was refused')
        multiply(around(center, rotate(angle)), image.transform)
        candidateMs += performance.now() - started
      }
      const started = performance.now()
      show(poseAt(ANGLES[ANGLES.length - 1]))
      const release = engine.render_rgba(options)
      candidateMs += performance.now() - started
      show(poseAt(ANGLES[ANGLES.length - 1]))
      const full = engine.render_rgba(options)
      expect(sha256(release)).toBe(sha256(full))
      if (round === 0) continue
      baseline.push(baselineMs)
      candidate.push(candidateMs)
    }
    const baselineMedian = median(baseline)
    const candidateMedian = median(candidate)
    const speedup = (baselineMedian - candidateMedian) / baselineMedian
    const heap = process.memoryUsage()
    console.log(JSON.stringify({
      case: 'large-image-gesture',
      profile: 'wasm dev, unoptimized, no wasm-opt',
      viewport: [VIEW_W, VIEW_H],
      angles: ANGLES,
      rounds: ROUNDS,
      baselineMs: baseline,
      candidateMs: candidate,
      baselineMedian, candidateMedian, speedup,
      scored, candidateError, staleError,
      posePath,
      rgbaBytes: VIEW_W * VIEW_H * 4,
      heapUsed: heap.heapUsed,
      rss: heap.rss,
      pngBytes: png.byteLength,
    }))
    expect(speedup).toBeGreaterThanOrEqual(MIN_SPEEDUP)
  } finally {
    engine.free()
  }
})
