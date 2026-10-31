import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { prepareFontTestFixtures } from './font-test-fixtures'
import { VectorEngine, font_faces_json } from './generated/design-kernel/design_kernel'
import { defaultTextStyle, node } from './model'

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const script = fileURLToPath(new URL('../../../testing/generate-font-fixtures.py', import.meta.url))
const source = fileURLToPath(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))
const sourceHash = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
const hashes = {
  'noto-latin': '32924279319ac4b9bd7c2a11512be33a0f77985c54a3b97ffd4f37fa15abdceb',
  'noto-cjk': 'd364933e29d565ae7422d38abccd6965244246a917d31e1c1c531054a77fab8e',
}
const directories: string[] = []
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'font-portability-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const run = (args: string[], environment: NodeJS.ProcessEnv = {}) => spawnSync(python, args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, PYTHONHASHSEED: '0', ...environment },
})
function fails(result: ReturnType<typeof run>, reason: RegExp) {
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(reason)
}

test('minimal checkout generates from baseline font without any historical fixture tree or source writes', () => {
  const directory = temporary(), checkout = join(directory, 'checkout')
  const copiedScript = join(checkout, 'testing/generate-font-fixtures.py')
  const copiedSource = join(checkout, 'frontend/design-client/public/fonts/NotoSansSC.ttf')
  mkdirSync(dirname(copiedScript), { recursive: true }); mkdirSync(dirname(copiedSource), { recursive: true })
  copyFileSync(script, copiedScript); copyFileSync(source, copiedSource)
  const beforeScript = hash(readFileSync(copiedScript)), beforeSource = hash(readFileSync(copiedSource))
  expect(beforeSource).toBe(sourceHash)
  const result = run([copiedScript, '--cache-root', join(directory, 'cache')])
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
  const ready = JSON.parse(result.stdout)
  expect(ready.directory.startsWith(join(directory, 'cache'))).toBe(true)
  expect(ready.manifest.sourceSha256).toBe(sourceHash)
  expect(ready.manifest.fontToolsVersion).toBe('4.61.1')
  for (const name of ['noto-latin', 'noto-cjk'] as const)
    expect(hash(readFileSync(join(ready.directory, `${name}.ttf`)))).toBe(hashes[name])
  expect(existsSync(join(checkout, 'testing/verification-font-batch'))).toBe(false)
  expect(readdirSync(join(checkout, 'testing'))).toEqual(['generate-font-fixtures.py'])
  expect(readdirSync(dirname(copiedSource))).toEqual(['NotoSansSC.ttf'])
  expect(hash(readFileSync(copiedScript))).toBe(beforeScript)
  expect(hash(readFileSync(copiedSource))).toBe(beforeSource)
}, 15_000)

test('two isolated generations and a verified cache hit have identical pinned bytes and manifest', () => {
  const first = prepareFontTestFixtures({ cacheRoot: temporary() })
  const secondRoot = temporary(), second = prepareFontTestFixtures({ cacheRoot: secondRoot })
  const cached = prepareFontTestFixtures({ cacheRoot: secondRoot })
  expect(first.directory).not.toBe(second.directory)
  expect(first.manifest).toEqual(second.manifest); expect(cached.manifest).toEqual(second.manifest)
  for (const name of ['noto-latin', 'noto-cjk'] as const) {
    expect(hash(first.bytes[name])).toBe(hashes[name])
    expect(first.bytes[name]).toEqual(second.bytes[name]); expect(cached.bytes[name]).toEqual(second.bytes[name])
  }
  expect(readFileSync(join(first.directory, 'manifest.json'))).toEqual(readFileSync(join(second.directory, 'manifest.json')))
  expect(readdirSync(secondRoot)).toEqual([second.directory.slice(secondRoot.length + 1)])
}, 15_000)

test('concurrent processes publish one complete verified cache and remove private staging directories', async () => {
  const cacheRoot = temporary()
  const generate = () => new Promise<string>((resolve, reject) => execFile(python, [script, '--cache-root', cacheRoot], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONHASHSEED: '0' },
  }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve(stdout)))
  const results = await Promise.all([generate(), generate()])
  expect(JSON.parse(results[0])).toEqual(JSON.parse(results[1]))
  const ready = JSON.parse(results[0])
  expect(readdirSync(cacheRoot)).toEqual([ready.directory.slice(cacheRoot.length + 1)])
  expect(readdirSync(ready.directory).sort()).toEqual(['manifest.json', 'noto-cjk.ttf', 'noto-latin.ttf'])
  for (const name of ['noto-latin', 'noto-cjk'] as const)
    expect(hash(readFileSync(join(ready.directory, `${name}.ttf`)))).toBe(hashes[name])
}, 15_000)

test('ASCII subprocess output encoding still carries the exact Unicode glyph subset manifest', () => {
  const cacheRoot = temporary(), result = run([script, '--cache-root', cacheRoot], { PYTHONIOENCODING: 'ascii' })
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
  const ready = JSON.parse(result.stdout)
  expect(ready.manifest.fonts[1].glyphSubset).toBe(' 中文测试继续文字')
  expect(hash(readFileSync(join(ready.directory, 'noto-cjk.ttf')))).toBe(hashes['noto-cjk'])
}, 15_000)

test('missing, wrong-size and same-size altered source fonts hard-fail before creating cache', () => {
  const directory = temporary(), badSource = join(directory, 'source.ttf'), cacheRoot = join(directory, 'cache')
  const args = [script, '--source', badSource, '--cache-root', cacheRoot]
  fails(run(args), /Bundled source font missing or wrong size/)
  writeFileSync(badSource, 'invalid font')
  fails(run(args), /Bundled source font missing or wrong size/)
  const altered = readFileSync(source); altered[altered.length - 1] ^= 1; writeFileSync(badSource, altered)
  fails(run(args), /Bundled source font SHA-256 mismatch/)
  expect(existsSync(cacheRoot)).toBe(false)
})

test('missing dependency and wrong pinned version fail actionably, including on an existing cache', () => {
  const cacheRoot = temporary(); prepareFontTestFixtures({ cacheRoot })
  const args = [script, '--cache-root', cacheRoot]
  fails(run(['-S', ...args], { PYTHONPATH: '' }), /Missing fontTools.*testing\/font-fixtures-requirements.txt.*no automatic installation/)
  const stub = temporary(); mkdirSync(join(stub, 'fontTools'))
  writeFileSync(join(stub, 'fontTools/__init__.py'), "__version__ = '0.0.0'\n")
  fails(run(args, { PYTHONPATH: stub }), /requires fontTools==4\.61\.1; found 0\.0\.0.*no fallback or skip/)
}, 15_000)

test('generator runtime errors and helper launch failures cannot be reported as success', () => {
  const stub = temporary(); mkdirSync(join(stub, 'fontTools'))
  writeFileSync(join(stub, 'fontTools/__init__.py'), "__version__ = '4.61.1'\n")
  writeFileSync(join(stub, 'fontTools/subset.py'), "raise RuntimeError('deliberate test dependency failure')\n")
  const cacheRoot = join(stub, 'cache')
  fails(run([script, '--cache-root', cacheRoot], { PYTHONPATH: stub }), /deliberate test dependency failure/)
  expect(existsSync(cacheRoot)).toBe(false)
  expect(() => prepareFontTestFixtures({ python: join(stub, 'missing-python'), cacheRoot })).toThrow(/could not be generated.*no installation, fallback or skip/)
})

test('a modified cached font fails verification rather than silently regenerating or passing', () => {
  const cacheRoot = temporary(), ready = prepareFontTestFixtures({ cacheRoot })
  const path = join(ready.directory, 'noto-latin.ttf'), modified = readFileSync(path); modified[modified.length - 1] ^= 1
  writeFileSync(path, modified)
  expect(() => prepareFontTestFixtures({ cacheRoot })).toThrow(/Generated cache is invalid.*SHA-256 mismatch/)
  expect(readFileSync(path)).toEqual(modified)
}, 15_000)

test('generated faces are real WASM-parsed fonts with exact Latin/CJK shaping fallback', () => {
  const ready = prepareFontTestFixtures({ cacheRoot: temporary() })
  for (const name of ['noto-latin', 'noto-cjk'] as const) {
    const faces = JSON.parse(font_faces_json(new Uint8Array(ready.bytes[name])))
    // The pinned source's legacy family name (name ID 1) is Thin; typographic
    // family name (ID 16) is Noto Sans SC. The kernel returns the legacy name.
    expect(faces).toHaveLength(1); expect(faces[0].family).toBe('Noto Sans SC Thin')
  }
  const n = node('text', 0, 0, 240, 30); n.text = 'ABC中文'
  n.textStyle = { ...defaultTextStyle(), fontId: 'latin', fallbacks: ['cjk'] }
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify({
      latin: { family: 'Noto Sans SC Latin subset', data: ready.bytes['noto-latin'].toString('base64'), index: 0 },
      cjk: { family: 'Noto Sans SC CJK subset', data: ready.bytes['noto-cjk'].toString('base64'), index: 0 },
    }))
    const result = JSON.parse(engine.text_layout(JSON.stringify(n)))
    expect(result.glyphs).toHaveLength(5)
    expect(result.glyphs.every((glyph: { id: number }) => glyph.id > 0)).toBe(true)
    expect(result.glyphs.map((glyph: { fontId: string }) => glyph.fontId)).toEqual(['latin', 'latin', 'latin', 'cjk', 'cjk'])
    expect(n.textStyle.fontId).toBe('latin'); expect(n.textStyle.fallbacks).toEqual(['cjk'])
  } finally { engine.free() }
}, 15_000)
