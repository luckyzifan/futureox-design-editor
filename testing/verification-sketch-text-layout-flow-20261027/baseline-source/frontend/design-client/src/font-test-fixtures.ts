/** Test-only real font fixtures, regenerated from the baseline font into an OS
 * temporary cache. No generated font copies are required in the source ZIP. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type FontFixtureName = 'noto-latin' | 'noto-cjk'
type FontFixtureRecord = { file: string; glyphSubset: string; bytes: number; sha256: string }
export type FontFixtureSet = {
  directory: string
  manifest: { schemaVersion: number; sourceSha256: string; sourceBytes: number; fontToolsVersion: string; fonts: FontFixtureRecord[] }
  bytes: Record<FontFixtureName, Buffer>
}
export function prepareFontTestFixtures(options: { python?: string; cacheRoot?: string } = {}): FontFixtureSet {
  const python = options.python || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const script = fileURLToPath(new URL('../../../testing/generate-font-fixtures.py', import.meta.url))
  const result = spawnSync(python, [script, '--cache-root', options.cacheRoot || join(tmpdir(), 'core-font-test-fixtures')], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONHASHSEED: '0' },
  })
  if (result.error || result.status !== 0) throw new Error(
    `Real font fixtures could not be generated. Require Python >= 3.10 and fonttools==4.61.1 from testing/font-fixtures-requirements.txt; no installation, fallback or skip occurs. ${result.error?.message || result.stderr || `exit ${result.status}, signal ${result.signal}`}`,
  )
  const ready = JSON.parse(result.stdout) as Omit<FontFixtureSet, 'bytes'>
  if (ready.manifest.schemaVersion !== 1 || ready.manifest.fontToolsVersion !== '4.61.1' ||
    ready.manifest.sourceSha256 !== 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da' ||
    ready.manifest.fonts.length !== 2) throw new Error('Generated font fixture manifest is incompatible')
  const bytes = {} as Record<FontFixtureName, Buffer>
  for (const name of ['noto-latin', 'noto-cjk'] as const) {
    const expected = ready.manifest.fonts.find(font => font.file === `${name}.ttf`)
    if (!expected || expected.bytes > 65_536) throw new Error(`Missing or oversized font fixture: ${name}`)
    const data = readFileSync(join(ready.directory, `${name}.ttf`))
    if (data.length !== expected.bytes || createHash('sha256').update(data).digest('hex') !== expected.sha256)
      throw new Error(`Generated font fixture changed after verification: ${name}`)
    bytes[name] = data
  }
  return { ...ready, bytes }
}
let cached: FontFixtureSet | undefined
export function fontTestBytes(name: FontFixtureName): Buffer {
  cached ??= prepareFontTestFixtures()
  return Buffer.from(cached.bytes[name])
}
