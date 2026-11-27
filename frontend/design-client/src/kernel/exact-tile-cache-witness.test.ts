import { test, expect } from 'vitest'
import { compilationWitness, coordinateSlot, sameBytes, ExactTileCache } from './exact-tile-cache'
import { sameWitness, segmentedWitness } from './compilation-witness'

/* The pre-optimization byte-loop implementations stay here as the reference
 * oracle for both the equivalence assertions and the A/B microbenchmark. */
type ReferenceWitness = Uint8Array | Readonly<{ byteLength: number; parts: readonly Uint8Array[] }>
function referenceSameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
function referenceSameWitness(owned: Uint8Array, next: ReferenceWitness) {
  if (owned.byteLength !== next.byteLength) return false
  if (next instanceof Uint8Array) return referenceSameBytes(owned, next)
  let offset = 0
  for (const part of next.parts) {
    for (let i = 0; i < part.length; i++) if (owned[offset + i] !== part[i]) return false
    offset += part.length
  }
  return offset === owned.length
}
function referenceCoordinateSlot(numbers: readonly number[]) {
  const data = new DataView(new ArrayBuffer(numbers.length * 8))
  numbers.forEach((n, i) => {
    if (!Number.isFinite(n)) throw new Error('Invalid exact tile coordinate')
    data.setFloat64(i * 8, n, true)
  })
  return [...new Uint8Array(data.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function pseudoRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state >>> 24
  }
}
function filled(length: number, seed: number) {
  const bytes = new Uint8Array(length), next = pseudoRandom(seed)
  for (let i = 0; i < length; i++) bytes[i] = next()
  return bytes
}

const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 15, 16, 17, 31, 63, 64, 65, 127, 255, 256, 257, 258, 259, 1021, 4096, 4099]

test('word comparison agrees with the byte loop for every length and byte phase', () => {
  for (const length of lengths) {
    const left = filled(length + 8, length + 1), right = filled(length + 8, length + 2)
    for (let offsetA = 0; offsetA < 8; offsetA++) {
      for (let offsetB = 0; offsetB < 8; offsetB++) {
        right.set(left.subarray(offsetA, offsetA + length), offsetB)
        const a = left.subarray(offsetA, offsetA + length), b = right.subarray(offsetB, offsetB + length)
        expect(sameBytes(a, b), `equal length=${length} offsets=${offsetA},${offsetB}`).toBe(true)
        expect(referenceSameBytes(a, b)).toBe(true)
        if (length === 0) continue
        const probes = [...new Set([0, 1, 2, 3, length - 1, length >> 1].filter((at) => at < length))]
        for (const at of probes) {
          b[at] ^= 0xff
          expect(sameBytes(a, b), `differ length=${length} at=${at} offsets=${offsetA},${offsetB}`).toBe(false)
          expect(referenceSameBytes(a, b)).toBe(false)
          b[at] ^= 0xff
        }
      }
    }
  }
  expect(sameBytes(new Uint8Array(3), new Uint8Array(4))).toBe(false)
})

test('segmented witness comparison matches the byte loop across every split and phase', () => {
  const random = pseudoRandom(7)
  for (const length of [0, 1, 2, 3, 5, 8, 9, 17, 64, 255, 1023]) {
    const owner = filled(length, 11)
    for (let trials = 0; trials < 12; trials++) {
      const parts: Uint8Array[] = []
      let offset = 0
      while (offset < length) {
        const size = Math.min(length - offset, 1 + (random() % 37))
        const phase = random() % 8
        const buffer = new Uint8Array(size + phase)
        buffer.set(owner.subarray(offset, offset + size), phase)
        parts.push(buffer.subarray(phase))
        offset += size
      }
      if (random() % 3 === 0) parts.splice(random() % (parts.length + 1), 0, new Uint8Array(0))
      const witness = segmentedWitness(parts)
      expect(witness.byteLength).toBe(length)
      expect(sameWitness(owner, witness)).toBe(referenceSameWitness(owner, witness))
      expect(sameWitness(owner, witness)).toBe(true)
      if (length > 0) {
        const at = random() % length
        let start = 0
        for (const part of parts) {
          if (at < start + part.length) { part[at - start] ^= 0x5a; break }
          start += part.length
        }
        expect(sameWitness(owner, witness)).toBe(false)
        expect(referenceSameWitness(owner, witness)).toBe(false)
      }
    }
    if (length > 0) {
      const changed = owner.slice()
      changed[length - 1] ^= 0xff
      const mismatched = segmentedWitness([changed])
      expect(sameWitness(owner, mismatched)).toBe(false)
      expect(referenceSameWitness(owner, mismatched)).toBe(false)
    }
    const malformed = { byteLength: length, parts: [new Uint8Array(length + 4)] }
    expect(sameWitness(owner, malformed)).toBe(referenceSameWitness(owner, malformed))
    const truncated = { byteLength: length, parts: [] as Uint8Array[] }
    expect(sameWitness(owner, truncated)).toBe(referenceSameWitness(owner, truncated))
  }
})

test('coordinate slots keep the exact reference bytes including signed zero and extremes', () => {
  const inputs: number[][] = [
    [], [0], [-0], [1], [1 + Number.EPSILON], [-1.5, 0.5, 4], [Number.MAX_VALUE, Number.MIN_VALUE, -0],
    [5e-324, -5e-324, 2 ** -1022], [123.456, -987.654, 3.25], [0, 0, 32, 32, 1, 0, 0, 0, 0],
    [65504.03125, -0.0009765625, 1.0000001192092896],
  ]
  for (const numbers of inputs) {
    const slot = coordinateSlot(numbers)
    expect(slot).toBe(referenceCoordinateSlot(numbers))
    expect(coordinateSlot(numbers)).toBe(slot)
    if (numbers.length) expect(slot).toHaveLength(numbers.length * 16)
  }
  expect(coordinateSlot([])).toBe('')
  expect(() => coordinateSlot([NaN])).toThrow('Invalid exact tile coordinate')
  expect(() => coordinateSlot([1, Infinity])).toThrow('Invalid exact tile coordinate')
  expect(() => coordinateSlot([1, -Infinity, 2])).toThrow('Invalid exact tile coordinate')
  expect(coordinateSlot([0])).not.toBe(coordinateSlot([-0]))

  /* Random IEEE-754 bit patterns cover subnormals and every exponent, not
   * just the friendly numbers above. */
  const bits = new DataView(new ArrayBuffer(8)), random = pseudoRandom(99)
  for (let trial = 0; trial < 256; trial++) {
    for (let word = 0; word < 2; word++) bits.setUint32(word * 4, (random() << 24) | (random() << 16) | (random() << 8) | random(), true)
    const value = bits.getFloat64(0, true)
    if (!Number.isFinite(value)) continue
    for (const numbers of [[value], [value, -0, 2.5], [0, value, value, 3]]) {
      expect(coordinateSlot(numbers)).toBe(referenceCoordinateSlot(numbers))
    }
  }
})

test('cache hits accept aligned, misaligned and segmented witness views without hashing', () => {
  const raw = filled(4099, 3)
  const cache = new ExactTileCache<string>(1024 * 1024)
  cache.set('slot', raw, 'value', 8)
  const shifted = new Uint8Array(3 + 4099)
  shifted.set(raw, 3)
  const misaligned = shifted.subarray(3)
  expect(cache.get('slot', misaligned)).toBe('value')

  cache.set('multi', segmentedWitness([raw.subarray(0, 1), raw.subarray(1, 2), raw.subarray(2)]), 'multi', 8)
  expect(cache.get('multi', raw)).toBe('multi')
  const tampered = raw.slice()
  tampered[4098] ^= 1
  expect(cache.get('multi', tampered)).toBeUndefined()
})

/* Paired interleaved A/B timing: each side runs the same loop, order flips per
 * repetition, and the reported value is the median of odd-sized samples.
 * Interleaving and per-rep ratios cancel host load and thermal drift. */
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}
const timings: Record<string, number> = {}
function timePerOp(run: () => void, targetMs = 12) {
  let iterations = 1
  for (;;) {
    const started = performance.now()
    for (let i = 0; i < iterations; i++) run()
    const elapsed = performance.now() - started
    if (elapsed >= targetMs) return elapsed / iterations
    iterations *= 2
  }
}
function ab(label: string, baseline: () => void, candidate: () => void, reps = 9) {
  const base: number[] = [], cand: number[] = [], ratios: number[] = []
  baseline(); candidate()
  for (let rep = 0; rep < reps; rep++) {
    const baselineFirst = rep % 2 === 0
    const first = timePerOp(baselineFirst ? baseline : candidate)
    const second = timePerOp(baselineFirst ? candidate : baseline)
    const baselineMedian = baselineFirst ? first : second
    const candidateMedian = baselineFirst ? second : first
    base.push(baselineMedian)
    cand.push(candidateMedian)
    ratios.push(baselineMedian / candidateMedian)
  }
  const baselineMedian = median(base), candidateMedian = median(cand)
  const speedup = median(ratios)
  timings[label] = candidateMedian
  console.log(`${label}: baseline ${(baselineMedian * 1000).toFixed(1)} us, candidate ${(candidateMedian * 1000).toFixed(1)} us, pair median ${speedup.toFixed(2)}x`)
  return speedup
}

test('microbenchmark: word witness comparison and lookup slot encoding beat the reference', () => {
  let sink = 0
  const speedups: Record<string, number> = {}
  /* Rotate the changed copies so the JIT cannot hoist the constant result out
   * of the timing loop; both sides see the same rotating inputs. Early prefix
   * differences are sub-0.1 us comparisons, so this case is measured first,
   * before the large hit comparisons warm the call sites. */
  const earlyOwned = filled(4 * 1024 * 1024, 4)
  const earlyMisses = Array.from({ length: 8 }, (_, k) => {
    const copy = earlyOwned.slice()
    copy[k] ^= 1
    return copy
  })
  let missCursor = 0
  const nextMiss = () => {
    missCursor = (missCursor + 1) & 7
    return earlyMisses[missCursor]
  }
  speedups['witness-miss-first-4MB'] = ab(
    'witness compare 4MB first bytes differ',
    () => { if (referenceSameWitness(earlyOwned, nextMiss())) sink++ },
    () => { if (sameWitness(earlyOwned, nextMiss())) sink++ },
  )
  for (const megabytes of [1, 4, 8]) {
    const bytes = megabytes * 1024 * 1024
    const owned = filled(bytes, megabytes), next = owned.slice()
    speedups[`witness-${megabytes}MB`] = ab(
      `witness compare ${megabytes}MB`,
      () => { if (referenceSameWitness(owned, next)) sink++ },
      () => { if (sameWitness(owned, next)) sink++ },
    )
    if (megabytes === 4) {
      const lateMiss = next.slice()
      lateMiss[bytes - 3] ^= 1
      speedups['witness-miss-late-4MB'] = ab(
        'witness compare 4MB last word differs',
        () => { if (referenceSameWitness(owned, lateMiss)) sink++ },
        () => { if (sameWitness(owned, lateMiss)) sink++ },
      )
    }
  }
  const parts: Uint8Array[] = []
  for (const size of [1024 * 1024, 2 * 1024 * 1024, 1024 * 1024]) {
    const part = filled(size, size)
    parts.push(part)
  }
  const segmented = segmentedWitness(parts), flat = new Uint8Array(4 * 1024 * 1024)
  let offset = 0
  for (const part of parts) { flat.set(part, offset); offset += part.byteLength }
  speedups['witness-segmented-4MB'] = ab(
    'witness compare segmented 4MB',
    () => { if (referenceSameWitness(flat, segmented)) sink++ },
    () => { if (sameWitness(flat, segmented)) sink++ },
  )

  const cameras = Array.from({ length: 128 }, (_, i) => [i * 0.375 - 40.5, 7.25 - i * 1.125, 0.5 + i * 0.125])
  let cursor = 0
  const cold = (impl: (numbers: readonly number[]) => string) => () => { cursor = (cursor + 1) & 127; sink += impl(cameras[cursor]).length }
  speedups['slot-cold-3'] = ab('coordinate slot cold 3 numbers', cold(referenceCoordinateSlot), cold(coordinateSlot))
  speedups['slot-cold-9'] = ab(
    'coordinate slot cold 9 numbers',
    cold((n) => referenceCoordinateSlot([...n, ...n, ...n])),
    cold((n) => coordinateSlot([...n, ...n, ...n])),
  )
  const fixedCamera = [123.25, -456.5, 2.375]
  speedups['slot-repeat-3'] = ab(
    'coordinate slot repeated camera',
    () => { sink += referenceCoordinateSlot(fixedCamera).length },
    () => { sink += coordinateSlot(fixedCamera).length },
  )

  expect(sink).toBeGreaterThan(0)
  expect(speedups['witness-1MB']).toBeGreaterThan(1.2)
  expect(speedups['witness-4MB']).toBeGreaterThan(1.5)
  expect(speedups['witness-8MB']).toBeGreaterThan(1.5)
  expect(speedups['witness-segmented-4MB']).toBeGreaterThan(1.5)
  expect(speedups['slot-cold-9']).toBeGreaterThan(1.5)
  expect(speedups['slot-repeat-3']).toBeGreaterThan(5)
  /* A witness that diverges inside the first 128 bytes never allocates word
   * views; its comparison stays a prefix scan. Pin that absolute cost below
   * 1% of the same run's full 4MB hit so a load spike cannot hide a change. */
  expect(timings['witness compare 4MB first bytes differ'] / timings['witness compare 4MB']).toBeLessThan(0.01)
  for (const [label, value] of Object.entries(speedups))
    if (label !== 'witness-miss-first-4MB') expect(value, label).toBeGreaterThan(0.95)
}, 60_000)