import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { matchBundledImportFonts } from './bundled-import-fonts'
import { emptySystem } from './design-system'
import { decodeFig, importFig } from './import-fig'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, defaultTextStyle, node, validateDocument, type DesignNode } from './model'

/** Em advances FIG stored for "Back to Home" / Poppins Bold digest 45dc28c4… at 13px.
 * Source file sha256 90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c. */
const FIG_BACK_TO_HOME = [
  0.6740000247955322, 0.7130000591278076, 0.7640000581741333, 0.7200000286102295,
  0.30000001192092896, 0.6080000400543213, 0.7880000472068787, 0.30000001192092896,
  0.7630000114440918, 0.7880000472068787, 0.9450000524520874, 0.5720000267028809,
]
const V2_BOLD = 'b8b92424acfd9581c9dd74723a5627b6a5882a643b2148bd0463e9cd077d3728'
const V4_BOLD = '983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c'
const DIGEST_SHA: Record<string, string> = {
  '58ca484f2ec5b8817a63136af362e1db1d29d49e': '4554cfac77e8cefa48f89ffcd4f1705f7c02ee34bd9b25415d1208065e4edb52',
  '01be8feaed323d19eeccf16fd79ea3b74206cfdb': '2f0180fd06a508c270696893eec11bb01fe595be9cb88cd2122bc33e638f6f6f',
  '45dc28c425c3ee2237440bf9cb926753c5aa3b5c': V2_BOLD,
  '86a425be5a919d86729b85b2bc1d07da5ce413d4': '7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba',
  'e837165aedb031ea74872c5983a3217d1c190a1a': '90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05',
  '45e4d582cbb4dab2bbad3f624fad9ae567c66547': V4_BOLD,
  '27a9e143d0a2f245006abdc4e1c644f6c6c50233': '2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9',
}

function emAdvances(engine: VectorEngine, text: DesignNode) {
  const layout = JSON.parse(engine.text_layout(JSON.stringify(text))) as { glyphs: { advance: number }[] }
  return layout.glyphs.map(glyph => glyph.advance / text.fontSize)
}

test('the digest file reproduces FIG advances, and switching files reflows', async () => {
  const doc = blank('回排')
  const text = node('text', 0, 0, 400, 40)
  text.text = 'Back to Home'
  text.fontSize = 13
  text.textStyle = { ...defaultTextStyle(), weight: 700, textCase: 'upper', wrap: false }
  doc.nodes = { [text.id]: text }
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'Poppins Bold', digest: '45dc28c425c3ee2237440bf9cb926753c5aa3b5c' } } }
  const other = node('text', 0, 40, 400, 40)
  other.text = 'Back to Home'
  other.fontSize = 13
  other.textStyle = { ...defaultTextStyle(), weight: 700, textCase: 'upper', wrap: false }
  doc.nodes[other.id] = other
  doc.designSystem.fontSources![other.id] = { style: 'Poppins Bold', digest: '45e4d582cbb4dab2bbad3f624fad9ae567c66547' }
  await matchBundledImportFonts(doc)
  expect(text.textStyle?.fontId).toBe(`${V2_BOLD}-0`)
  expect(other.textStyle?.fontId).toBe(`${V4_BOLD}-0`)
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify(doc.fonts))
    const source = emAdvances(engine, text)
    const switched = emAdvances(engine, other)
    expect(source).toHaveLength(FIG_BACK_TO_HOME.length)
    source.forEach((em, index) => expect(Math.abs(em - FIG_BACK_TO_HOME[index]), `glyph ${index}`).toBeLessThanOrEqual(0.001))
    expect(Math.abs(switched[4] - FIG_BACK_TO_HOME[4])).toBeGreaterThan(0.05)
  } finally { engine.free() }
})

test('Poppins 2.000 keeps the FIG wrap of the login sentence', async () => {
  const doc = blank('换行')
  const text = node('text', 0, 0, 294, 80)
  text.text = 'To keep connected with us please login with your personal info.'
  text.fontSize = 14
  text.textStyle = { ...defaultTextStyle(), weight: 500, wrap: true }
  doc.nodes = { [text.id]: text }
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'Poppins Medium', digest: '01be8feaed323d19eeccf16fd79ea3b74206cfdb' } } }
  await matchBundledImportFonts(doc)
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify(doc.fonts))
    const layout = JSON.parse(engine.text_layout(JSON.stringify(text))) as { lines: { end: number }[] }
    expect(layout.lines.map(line => line.end)).toEqual([39, text.text.length])
  } finally { engine.free() }
})

function realFig(relative: string) {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 8).toString() === 'version ') return
  return new Uint8Array(bytes)
}

test('structure.fig uses its exact Inter version and reproduces the stored glyph advances', async () => {
  const bytes = realFig('../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/structure.fig')
  expect(bytes, 'structure.fig bytes').toBeTruthy()
  const source = decodeFig(bytes!).data.nodeChanges.find((change: any) => change.type === 'TEXT' && change.textData?.characters === 'ABC')
  const advances = source.textData.glyphs.map((glyph: { advance: number }) => glyph.advance)
  const imported = importFig(bytes!, 'structure.fig')
  const fonts = await matchBundledImportFonts(imported.document)
  expect(fonts.digestMismatches).toEqual([])
  const text = Object.values(imported.document.nodes).find(node => node.kind === 'text' && node.text === 'ABC')!
  expect(text.textStyle?.fontId).toBe('9ee35efa458e90e993897c32c5101bd9e0b14d6d40716798aa8ce426216e72a9-0')
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify(imported.document.fonts))
    const actual = emAdvances(engine, text)
    expect(actual).toHaveLength(advances.length)
    actual.forEach((advance, index) => expect(Math.abs(advance - advances[index])).toBeLessThanOrEqual(0.001))
  } finally { engine.free() }
})

const youliao = realFig('../../../testing/fixtures/user-regression-20261109/01有料素材.fig')
test.skipIf(!youliao)('01有料素材 attaches the digest file, not the same-named version 4 cut', async () => {
  const bytes = youliao
  if (!bytes) throw new Error('01有料素材.fig bytes were not read')
  const imported = importFig(bytes, '01有料素材.fig')
  validateDocument(imported.document)
  const fonts = await matchBundledImportFonts(imported.document)
  let correct = 0
  let wrong = 0
  let undigested = 0
  for (const node of Object.values(imported.document.nodes)) {
    if (node.kind !== 'text') continue
    const digest = imported.document.designSystem?.fontSources?.[node.id]?.digest
    if (!digest) { undigested++; continue }
    const sha = DIGEST_SHA[digest]
    const fontId = node.textStyle?.fontId
    if (sha && fontId === `${sha}-0`) correct++
    else wrong++
  }
  console.log('FIG_FONT_DIGEST', JSON.stringify({
    file: '01有料素材.fig',
    sha256: '90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c',
    correct, wrong, undigested,
    missing: fonts.missing.length,
    digestMismatches: fonts.digestMismatches.length,
  }))
  expect(wrong).toBe(0)
  expect(correct).toBe(1299)
  expect(undigested).toBe(83)
}, 60_000)
