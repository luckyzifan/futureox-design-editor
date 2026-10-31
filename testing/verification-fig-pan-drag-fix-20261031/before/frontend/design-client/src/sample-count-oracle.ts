// Independent test oracle for opaque, single-paint paths. Count the exact
// rotated-grid samples, then emulate the observed per-pass spatial filter and
// running export average using independent binary64 arithmetic.
import type { GpuScene, PathMesh } from './kernel/gpu/types'

function roundEven(value: number) {
  const integer = Math.floor(value), remainder = value - integer
  return integer + Number(remainder > .5 || (remainder === .5 && integer % 2 === 1))
}
// Interpret the packed continuous binary64 intervals directly in JS. This
// reference uses neither the GPU's u32 endpoint comparator nor its shaders.
// Exact path/scanline geometry has separate contour and hardware tests; this
// oracle checks sample membership, stroke alignment, and integer resolve.
function intervalPredicate(scene: GpuScene, path: PathMesh): (x: number, y: number) => boolean {
  const packet = path.area,
    data = scene.curves
  if (!packet || !data) throw new Error('Sample oracle requires interval geometry')
  const base = packet.first * 4,
    kind = data[base]
  if (kind === 2 || path.count === 0) return () => false
  const decode = (at: number) => {
    const buffer = new ArrayBuffer(8),
      view = new DataView(buffer)
    let bits = 0n
    for (let i = 0; i < 4; i++) bits |= BigInt(data[at + i]) << BigInt(i * 16)
    view.setBigUint64(0, bits, true)
    return view.getFloat64(0, true)
  }
  const endpoint = (range: number, bits: number, side: number, origin: number) =>
    origin + data[range + side] + data[range + side + 2] + decode(bits)
  if (kind === 4) {
    const left = endpoint(base + 4, base + 12, 0, path.rect.x),
      right = endpoint(base + 4, base + 16, 1, path.rect.x)
    const top = endpoint(base + 8, base + 20, 0, path.rect.y),
      bottom = endpoint(base + 8, base + 24, 1, path.rect.y)
    return (x, y) => x >= left && x < right && y >= top && y < bottom
  }
  if (kind !== 3) throw new Error('Sample oracle requires four-sample intervals')
  const rows: [number, number][][] = []
  for (let row = 0; row < path.rect.h * 4; row++) {
    const header = base + (data[base + 1] + row) * 4,
      first = base + data[header] * 4,
      count = data[header + 1]
    const ranges: [number, number][] = []
    for (let i = 0; i < count; i++) {
      const at = first + i * 12
      ranges.push([endpoint(at, at + 4, 0, path.rect.x), endpoint(at, at + 8, 1, path.rect.x)])
    }
    rows.push(ranges)
  }
  return (x, y) => {
    const row = Math.floor((y - path.rect.y) * 4)
    return (
      row >= 0 && row < rows.length && rows[row].some(([left, right]) => x >= left && x < right)
    )
  }
}

export function opaqueStrokeOracle(
  scene: GpuScene,
  id: string,
  rgb: number[],
  width: number,
  height: number,
) {
  scene = { ...scene, curves: Array.from(new Float32Array(scene.curves || [])) }
  const node = scene.nodes[id]
  if (node.strokes.length !== 1 || node.fills.length || node.effects.length || node.opacity !== 1)
    throw new Error('Sample oracle only accepts a single opaque stroke')
  const stroke = node.strokes[0]
  const strokeInside = intervalPredicate(scene, stroke.path),
    fillInside = intervalPredicate(scene, node.fill)
  const scale = scene.resolve ? 2 : 1
  const offsets = [
    [0.375, 0.125],
    [0.875, 0.375],
    [0.125, 0.625],
    [0.625, 0.875],
  ]
  const bytes = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const counts = [0, 0, 0, 0]
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++)
          for (let sample = 0; sample < offsets.length; sample++) {
            const [sx, sy] = offsets[sample]
            const px = x * scale + dx + sx, py = y * scale + dy + sy
            if (!strokeInside(px, py)) continue
            if (stroke.align !== 'center') {
              const filled = fillInside(px, py)
              if (stroke.align === 'inside' ? !filled : filled) continue
            }
            counts[sample]++
          }
      const accumulated = [0, 0, 0, 0]
      const sourceColor = [...rgb, 255]
      for (const [pass, sample] of [3, 0, 2, 1].entries()) {
        const weight = Math.fround(1 / (pass + 1))
        for (let c = 0; c < 4; c++) {
          const filtered = Math.fround(counts[sample] * sourceColor[c] / (255 * scale * scale))
          const previous = Math.fround(accumulated[c] / 255), difference = Math.fround(filtered - previous)
          // Bounded normalized byte inputs have enough exponent overlap for
          // binary64 to hold the exact product+sum before one binary32 rounding.
          accumulated[c] = roundEven(Math.fround(difference * weight + previous) * 255)
        }
      }
      const alpha = accumulated[3], offset = (y * width + x) * 4
      bytes[offset + 3] = alpha
      if (alpha)
        for (let c = 0; c < 3; c++)
          bytes[offset + c] = Math.min(255, Math.floor((accumulated[c] * 510 + alpha) / (alpha * 2)))
    }
  return bytes
}
