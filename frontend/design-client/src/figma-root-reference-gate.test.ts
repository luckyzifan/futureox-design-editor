/**
 * Repo-local CPU pixel gate for the 20 root Figma references (#1266).
 *
 * Every root PNG under `public/fidelity` is pinned by SHA-256 and size in
 * `figma-root-references.json`, then rendered through the production WASM CPU
 * `figma` profile with the matching `figmaFixture`. Packs are enumerated from
 * disk; every `cases.json` reference is checked for existence, SHA-256 and
 * dimensions. A missing root reference fails the gate. Cases whose pack
 * manifest intentionally has no reference image are printed as skipped
 * (#872) instead of silently passing.
 *
 * Non-zero tolerances are explicit and tied to the owning issue. The five
 * #1265 cases are measured from Figma exports that carry dithering in flat
 * blur/shadow ramps and half-code compositing ties; they are recorded here as
 * per-case pixel/max-channel budgets rather than ignored. #282/#284/#179 keep
 * their existing, separate budgets. Everything else must stay at zero, which
 * includes the rectangle/pass-through/rotated-curve baselines.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import {
  figmaFixture,
  referenceCases,
  referenceScale,
  referenceSize,
  type ReferenceCase,
} from './figma-fixtures'
import { VectorEngine } from './generated/design-kernel/design_kernel'

const FIDELITY = fileURLToPath(new URL('../public/fidelity/', import.meta.url))
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

type Manifest = {
  references: Record<string, { file: string; sha256: string; width: number; height: number }>
}
type Budget = { pixels: number; maxChannel: number; ticket: string }
type PackCase = {
  id: string
  reference?: string
  referenceSha256?: string
  options?: { width?: number; height?: number }
}

const manifest: Manifest = JSON.parse(
  readFileSync(new URL('./figma-root-references.json', import.meta.url), 'utf8'),
)

/**
 * Per-root pixel budgets. `pixels` counts pixels with any channel delta;
 * `maxChannel` is the largest per-channel delta. Zero is the default, so a
 * case absent from this table must match RGBA exactly.
 */
const budgets: Record<string, Budget> = {
  // #1265: group/shadow/blur references include Figma's dithered flat ramps
  // and half-code ties. Recorded 2026-11-27 on kernel SHA ab467dd7.
  'group-blur': { pixels: 2423, maxChannel: 2, ticket: '#1265' },
  'group-inner-shadow': { pixels: 646, maxChannel: 1, ticket: '#1265' },
  'group-shadow': { pixels: 509, maxChannel: 3, ticket: '#1265' },
  'pass-through-blur': { pixels: 3535, maxChannel: 2, ticket: '#1265' },
  'large-nested': { pixels: 34683, maxChannel: 2, ticket: '#1265' },
  // Existing, separately tracked residuals. Their claims do not expand.
  shadow: { pixels: 307, maxChannel: 1, ticket: '#284' },
  'layer-blur': { pixels: 1782, maxChannel: 1, ticket: '#282' },
  'blur-radii': { pixels: 11314, maxChannel: 2, ticket: '#282' },
  'backdrop-blur': { pixels: 3795, maxChannel: 4, ticket: '#179' },
}

/** Fixture cases that are not root references, with the reason. */
const noRootReference: Partial<Record<ReferenceCase, string>> = {
  'mask-half-overlap': 'captured only in the mcp-2026-10-06 pack, no root PNG',
}

type Header = { width: number; height: number; bitDepth: number; colorType: number; interlace: number }

function header(bytes: Uint8Array): Header {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new Error('not a PNG')
  const length = view.getUint32(8)
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR' || length !== 13)
    throw new Error('PNG lacks a leading IHDR')
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  }
}

/** Decode an 8-bit, non-interlaced RGBA PNG. Root references are all this form. */
function decodeRgba8Png(bytes: Uint8Array) {
  const ihdr = header(bytes)
  if (ihdr.colorType !== 6 || ihdr.bitDepth !== 8 || ihdr.interlace !== 0)
    throw new Error(
      `root reference must be 8-bit RGBA without interlace, got colorType ${ihdr.colorType} ` +
        `bitDepth ${ihdr.bitDepth} interlace ${ihdr.interlace}`,
    )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const idat: Uint8Array[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))))
  const bpp = 4
  const stride = ihdr.width * bpp
  const pixels = new Uint8Array(ihdr.width * ihdr.height * bpp)
  let source = 0
  let previous = new Uint8Array(stride)
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[source++]
    const row = raw.subarray(source, source + stride)
    source += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[i - bpp] : 0
      const up = previous[i]
      const upLeft = i >= bpp ? previous[i - bpp] : 0
      const value = row[i]
      if (filter === 0) out[i] = value
      else if (filter === 1) out[i] = (value + left) & 255
      else if (filter === 2) out[i] = (value + up) & 255
      else if (filter === 3) out[i] = (value + ((left + up) >> 1)) & 255
      else {
        const estimate = left + up - upLeft
        const pa = Math.abs(estimate - left)
        const pb = Math.abs(estimate - up)
        const pc = Math.abs(estimate - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        out[i] = (value + predictor) & 255
      }
    }
    previous = out
  }
  return { ...ihdr, pixels }
}

test('root Figma CPU references and packs are pinned and pixel-gated', { timeout: 120_000 }, () => {
  const failures: string[] = []
  const skipped: string[] = []

  // 1. Enumerate roots from disk and require the manifest to match exactly.
  const rootPngs = readdirSync(FIDELITY)
    .filter((name) => name.endsWith('.png'))
    .sort()
  const manifestPngs = Object.values(manifest.references)
    .map((entry) => entry.file)
    .sort()
  expect(rootPngs, 'root PNG set must match the pinned manifest').toEqual(manifestPngs)
  expect(rootPngs, 'the root Figma reference set contains 20 PNGs').toHaveLength(20)

  for (const kind of referenceCases) {
    if (!manifest.references[kind] && !noRootReference[kind])
      failures.push(`${kind}: fixture case has no pinned root reference and no documented exception`)
  }
  for (const kind of Object.keys(manifest.references)) {
    if (!(referenceCases as readonly string[]).includes(kind))
      failures.push(`${kind}: pinned root reference has no figmaFixture case`)
  }
  expect(
    noRootReference['mask-half-overlap'],
    'mask-half-overlap is intentionally pack-only',
  ).toBeTruthy()

  // 2. Enumerate packs and verify every available case reference.
  let packReferences = 0
  const packs = readdirSync(FIDELITY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const pack of packs) {
    const casesPath = join(FIDELITY, pack, 'cases.json')
    if (!existsSync(casesPath)) {
      const pngs = readdirSync(join(FIDELITY, pack)).filter((name) => name.endsWith('.png'))
      skipped.push(`${pack}: no cases.json (${pngs.length} PNGs not enumerated by a pack manifest)`)
      continue
    }
    const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as PackCase[]
    expect(Array.isArray(cases) && cases.length > 0, `${pack}/cases.json must be nonempty`).toBe(true)
    const unique = new Set(cases.map((entry) => entry.id))
    expect(unique.size, `${pack}/cases.json contains duplicate ids`).toBe(cases.length)
    for (const entry of cases) {
      if (!entry.reference) {
        skipped.push(`${pack}/${entry.id}: pack manifest has no reference image (#872)`)
        continue
      }
      const file = resolve(dirname(casesPath), entry.reference)
      if (!existsSync(file)) {
        failures.push(`${pack}/${entry.id}: missing reference ${entry.reference}`)
        continue
      }
      const bytes = readFileSync(file)
      if (entry.referenceSha256 && sha256(bytes) !== entry.referenceSha256)
        failures.push(`${pack}/${entry.id}: SHA-256 changed for ${entry.reference}`)
      if (entry.options?.width != null && entry.options?.height != null) {
        const { width, height } = header(bytes)
        if (width !== entry.options.width || height !== entry.options.height)
          failures.push(
            `${pack}/${entry.id}: ${entry.reference} is ${width}x${height}, ` +
              `options require ${entry.options.width}x${entry.options.height}`,
          )
      }
      packReferences++
    }
  }
  expect(packReferences, 'no pack reference was verified').toBeGreaterThan(0)
  console.info(
    `[figma-roots] packs: ${packs.length}, verified ${packReferences} references, ` +
      `skipped ${skipped.length}`,
  )
  for (const entry of skipped) console.info(`[figma-roots] skipped ${entry}`)

  // 3. Pin, decode and render every root reference through CPU `figma`.
  const engine = new VectorEngine()
  try {
    for (const kind of rootPngs.map((file) => file.slice(0, -4)) as ReferenceCase[]) {
      const pinned = manifest.references[kind]
      const file = new URL(pinned.file, new URL('../public/fidelity/', import.meta.url))
      if (!existsSync(file)) {
        failures.push(`${kind}: missing root reference ${pinned.file}`)
        continue
      }
      const bytes = readFileSync(file)
      const actualSha = sha256(bytes)
      if (actualSha !== pinned.sha256)
        failures.push(
          `${kind}: SHA-256 is ${actualSha}, pinned ${pinned.sha256}; ` +
            'reference changes need an explicit review',
        )
      let reference
      try {
        reference = decodeRgba8Png(bytes)
      } catch (error) {
        failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const size = referenceSize(kind)
      if (reference.width !== size.width || reference.height !== size.height)
        failures.push(
          `${kind}: reference is ${reference.width}x${reference.height}, ` +
            `referenceSize is ${size.width}x${size.height}`,
        )
      if (reference.width !== pinned.width || reference.height !== pinned.height)
        failures.push(
          `${kind}: reference size does not match the pinned ` +
            `${pinned.width}x${pinned.height}`,
        )
      if (
        reference.width !== size.width ||
        reference.height !== size.height ||
        actualSha !== pinned.sha256
      )
        continue

      const doc = figmaFixture(kind)
      engine.load_document(JSON.stringify(doc))
      const output = engine.render_rgba(
        JSON.stringify({
          pageId: doc.pages[0].id,
          width: size.width,
          height: size.height,
          view: { x: 0, y: 0, zoom: referenceScale(kind) },
          grid: false,
          transparent: kind === 'alpha-curve',
          rasterProfile: 'figma',
        }),
      )
      let different = 0
      let maxChannel = 0
      for (let i = 0; i < reference.pixels.length; i += 4) {
        let pixel = 0
        for (let channel = 0; channel < 4; channel++)
          pixel = Math.max(pixel, Math.abs(reference.pixels[i + channel] - output[i + channel]))
        if (pixel) different++
        maxChannel = Math.max(maxChannel, pixel)
      }
      const budget = budgets[kind] ?? { pixels: 0, maxChannel: 0, ticket: 'exact baseline' }
      console.info(
        `[figma-roots] ${kind}: ${different}px max ${maxChannel} ` +
          `(budget ${budget.pixels}px/${budget.maxChannel}, ${budget.ticket})`,
      )
      if (different > budget.pixels || maxChannel > budget.maxChannel)
        failures.push(
          `${kind}: ${different}px max ${maxChannel} exceeds ` +
            `${budget.pixels}px/${budget.maxChannel} (${budget.ticket})`,
        )
    }
  } finally {
    engine.free()
  }

  expect(failures, `Figma root reference gate failed:\n${failures.join('\n')}`).toEqual([])
})