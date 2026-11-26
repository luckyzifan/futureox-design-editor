/** Headless exact RGBA comparison of pinned Figma reference files. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { figmaFixture, referenceScale, referenceSize, type ReferenceCase } from '../src/figma-fixtures'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel'

type Size = { width: number; height: number }
type ManifestCase = {
  id: string
  reference?: string
  referenceSha256?: string
  options: Size & Record<string, unknown>
  document?: object
  strictComparable?: boolean
  mappingNote?: string
}
type Pack = { name: string; directory: string; scope: string; fixtures?: boolean }
type PixelComparison = Size & ReturnType<typeof compareRgba> & {
  status: 'match' | 'different'
  referenceSha256: string
  referenceRgbaSha256: string
  actualRgbaSha256: string
}
type Row = { pack: string; manifest?: string; id: string; reference?: string } & (
  | { status: 'missing' | 'invalid' | 'uncomparable' | 'render-error'; reason: string }
  | (PixelComparison & { reused?: true })
)
const comparisons = new Map<string, PixelComparison>()
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const decode = `
import io, sys
from PIL import Image
data = sys.stdin.buffer.read()
with Image.open(io.BytesIO(data)) as image:
    if image.format != 'PNG':
        raise ValueError('Expected a PNG image')
    image.verify()
with Image.open(io.BytesIO(data)) as image:
    sys.stdout.buffer.write(image.convert('RGBA').tobytes())
`
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const inside = (scope: string, file: string) => {
  const rel = relative(scope, file)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

function dimensions(png: Buffer, options: Size) {
  const { width, height } = options ?? {}
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 64_000_000)
    throw Error('Invalid pinned dimensions')
  if (png.length < 33 || !png.subarray(0, 8).equals(pngSignature) ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR')
    throw Error('Invalid PNG header')
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height)
    throw Error(`PNG dimensions differ from pinned ${width}×${height}`)
  return { width, height }
}

function fixtureInput(kind: ReferenceCase, size: Size) {
  const document = figmaFixture(kind)
  const expected = referenceSize(kind)
  if (expected.width !== size.width || expected.height !== size.height)
    throw Error('Existing fixture dimensions differ from the manifest')
  return {
    document,
    options: { ...size, pageId: document.pages[0].id, view: { x: 0, y: 0, zoom: referenceScale(kind) },
      transparent: kind === 'alpha-curve', grid: false },
  }
}

function compareRgba(actual: Uint8Array, expected: Uint8Array, width: number) {
  if (actual.length !== expected.length) throw Error('CPU RGBA byte length differs from the reference')
  let differentPixels = 0, maxChannelDelta = 0
  let firstDifference
  for (let i = 0; i < expected.length; i += 4) {
    let delta = 0
    for (let ch = 0; ch < 4; ch++) delta = Math.max(delta, Math.abs(actual[i + ch] - expected[i + ch]))
    if (delta === 0) continue
    differentPixels++
    maxChannelDelta = Math.max(maxChannelDelta, delta)
    firstDifference ??= { x: (i / 4) % width, y: Math.floor(i / 4 / width),
      expected: [...expected.subarray(i, i + 4)], actual: [...actual.subarray(i, i + 4)] }
  }
  return { differentPixels, maxChannelDelta, firstDifference }
}

async function compareCase(pack: Pack, manifest: string, entry: ManifestCase, font: Uint8Array): Promise<Row> {
  const row = { pack: pack.name, manifest, id: entry.id, reference: entry.reference }
  if (entry.reference === undefined)
    return { ...row, status: 'missing', reason: 'Manifest template has no pinned PNG' }
  if (typeof entry.reference !== 'string' || !entry.reference.endsWith('.png') ||
      typeof entry.referenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.referenceSha256))
    return { ...row, status: 'invalid', reason: 'Reference must name a PNG with a pinned SHA-256' }
  const file = resolve(pack.directory, entry.reference)
  let png: Buffer, size: Size
  try {
    if (!inside(pack.scope, file)) throw Error('Reference path leaves the pack scope')
    const canonical = await realpath(file)
    if (!inside(pack.scope, canonical)) throw Error('Reference path leaves the pack scope')
    png = await readFile(canonical)
    if (sha256(png) !== entry.referenceSha256) throw Error('Reference SHA-256 differs from manifest')
    size = dimensions(png, entry.options)
  } catch (error) {
    return { ...row, status: missing(error) ? 'missing' : 'invalid', reason: reason(error) }
  }
  if (entry.strictComparable === false || (!pack.fixtures && !entry.document))
    return { ...row, status: 'uncomparable', reason: entry.mappingNote || 'No equivalent authored case in this pack' }
  let documentJson: string, optionsJson: string
  try {
    const { document, options } = pack.fixtures
      ? fixtureInput(entry.id as ReferenceCase, size) : entry
    documentJson = JSON.stringify(document)
    optionsJson = JSON.stringify({ ...options, rasterProfile: 'figma' })
  } catch (error) {
    return { ...row, status: 'render-error', reason: reason(error) }
  }
  // Aggregate manifests can repeat identical inputs. Recheck each file's pins
  // above, then share only the comparison for the same document, view and PNG.
  const key = [sha256(Buffer.from(documentJson)), sha256(Buffer.from(optionsJson)), entry.referenceSha256].join(':')
  const prior = comparisons.get(key)
  if (prior) return { ...row, ...prior, reused: true }
  let expected: Buffer
  try {
    const bytes = size.width * size.height * 4
    expected = execFileSync('python3', ['-c', decode], { input: png, maxBuffer: bytes + 65536, stdio: ['pipe', 'pipe', 'pipe'] })
    if (expected.length !== bytes) throw Error('Decoded PNG differs from the pinned dimensions')
  } catch (error) {
    return { ...row, status: 'invalid', reason: reason(error) }
  }
  const engine = new VectorEngine()
  try {
    engine.load_font(font)
    engine.load_document(documentJson)
    const actual = engine.render_rgba(optionsJson)
    const result = compareRgba(actual, expected, size.width)
    const comparison: PixelComparison = {
      status: result.differentPixels ? 'different' : 'match', ...size,
      referenceSha256: entry.referenceSha256, referenceRgbaSha256: sha256(expected),
      actualRgbaSha256: sha256(actual), ...result,
    }
    comparisons.set(key, comparison)
    return { ...row, ...comparison }
  } catch (error) {
    return { ...row, status: 'render-error', reason: reason(error) }
  } finally { engine.free() }
}

async function manifestCases(pack: Pack, manifest: string) {
  const source = JSON.parse(await readFile(join(pack.directory, manifest), 'utf8'))
  // This reference set shares the existing browser fixtures and pins its PNGs in provenance.json.
  const cases = pack.name === 'mcp-2026-10-06' && pack.fixtures
    ? source.cases.map(({ kind, pngSha256, parameters }: { kind: string; pngSha256: string; parameters: Size }) =>
        ({ id: kind, reference: kind + '.png', referenceSha256: pngSha256,
          options: { width: parameters.width, height: parameters.height } }))
    : source
  if (!Array.isArray(cases) || !cases.length ||
      cases.some(entry => !entry || typeof entry.id !== 'string' || !entry.id) ||
      new Set(cases.map(entry => entry.id)).size !== cases.length)
    throw Error('Reference cases must be nonempty with unique IDs')
  if (pack.name === 'root' && (cases.length !== 20 ||
      cases.some(entry => entry.reference !== entry.id + '.png')))
    throw Error('Expected 20 uniquely pinned root PNGs with matching case IDs')
  return cases as ManifestCase[]
}

const args = process.argv.slice(2)
if (args.length > 1 || (args.length && args[0] !== '--root-only'))
  throw Error('Usage: bun run test:figma-pixels [--root-only]')
const rootOnly = args.includes('--root-only')
const directory = await realpath(fileURLToPath(new URL('../public/fidelity', import.meta.url)))
const local = (await readdir(directory, { withFileTypes: true })).filter(file => file.isDirectory())
  .map(file => file.name).sort()
const packs: Pack[] = [{ name: 'root', directory, scope: directory, fixtures: true }]
if (!rootOnly) {
  for (const name of local) packs.push({ name, directory: join(directory, name), scope: directory, fixtures: name === 'mcp-2026-10-06' })
  if (process.env.DESIGN_FIGMA_REFERENCES) {
    const requested = resolve(process.env.DESIGN_FIGMA_REFERENCES)
    const external = await realpath(requested).catch(() => requested)
    packs.push({ name: 'external', directory: external, scope: external })
  }
}

const wasm = await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url))
const kernelSha256 = sha256(wasm)
if (process.env.FUTUREOX_EXPECT_KERNEL_SHA256 && process.env.FUTUREOX_EXPECT_KERNEL_SHA256 !== kernelSha256)
  throw Error('Test kernel bytes do not match FUTUREOX_EXPECT_KERNEL_SHA256')
const font = await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))
initSync({ module: wasm })

const rows: Row[] = []
const lists = []
for (const pack of packs) {
  let files: string[]
  try { files = (await readdir(pack.directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort() }
  catch (error) {
    rows.push({ pack: pack.name, id: 'directory', status: missing(error) ? 'missing' : 'invalid', reason: reason(error) })
    continue
  }
  const pngs = files.filter(file => file.endsWith('.png'))
  const manifests = pack.name === 'root' || pack.name === 'external' ? ['cases.json']
    : pack.fixtures ? ['provenance.json'] : files.filter(file => file === 'cases.json' || file.endsWith('-cases.json'))
  lists.push({ pack: pack.name, pngs: pngs.length, manifests })
  const seen = new Set<string>()
  for (const manifest of manifests) {
    let cases
    try { cases = await manifestCases(pack, manifest) }
    catch (error) {
      rows.push({ pack: pack.name, id: manifest, status: missing(error) ? 'missing' : 'invalid', reason: reason(error) })
      continue
    }
    for (const entry of cases) {
      if (typeof entry.reference === 'string') seen.add(resolve(pack.directory, entry.reference))
      rows.push(await compareCase(pack, manifest, entry, font))
    }
  }
  for (const png of pngs) if (!seen.has(join(pack.directory, png))) {
    rows.push({ pack: pack.name, id: basename(png, '.png'), reference: png,
      status: pack.name === 'root' ? 'invalid' : 'uncomparable', reason: 'No manifest case for this PNG' })
  }
}
const counts = { match: 0, different: 0, missing: 0, invalid: 0, uncomparable: 0, 'render-error': 0 }
for (const row of rows) counts[row.status]++
console.log(JSON.stringify({
  backend: 'cpu-wasm', rasterProfile: 'figma', kernelSha256, fontSha256: sha256(font),
  localPacks: local, packs: lists, counts, uniqueComparisons: comparisons.size, rows,
}, null, 2))
process.exitCode = counts.different || counts.missing || counts.invalid || counts['render-error'] ? 1 : 0
