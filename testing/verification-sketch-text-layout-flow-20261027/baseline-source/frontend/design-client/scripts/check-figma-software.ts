/** Strict current-reference gate through the real worker and both browser GPUs. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, repository, runProof, sha256 } from './exact-prefix-proof-utils'

const references = process.env.DESIGN_FIGMA_REFERENCES
  ? resolve(process.env.DESIGN_FIGMA_REFERENCES)
  : join(repository, 'testing/review/design-desktop-macos-gui-2026-10-10/glass-current-iteration/references')
const casesFile = join(references, 'cases.json')
const cases = JSON.parse(await readFile(casesFile, 'utf8'))
if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length)
  throw Error('Reference cases must be nonempty and unique')
for (const c of cases)
  if (sha256(await readFile(join(references, c.reference))) !== c.referenceSha256)
    throw Error(`Reference changed: ${c.id}`)
const decoded = await command('python3', ['-c', `
import base64,json,sys
from pathlib import Path
from PIL import Image
p=Path(sys.argv[1]);cases=json.loads((p/'cases.json').read_text());result=[]
for case in cases:
    image=Image.open(p/case['reference']).convert('RGBA')
    assert image.size==(case['options']['width'],case['options']['height'])
    result.append(base64.b64encode(image.tobytes()).decode('ascii'))
print(json.dumps(result))
`, references])
const expected: string[] = JSON.parse(decoded.stdout)

await runProof('forma-figma-software', [casesFile, ...cases.map(c => join(references, c.reference))], async proof => {
  if (proof.prepareOnly) return { cases: cases.length, profiles: ['figmaSoftware'] }
  const rows = await proof.browser(async page => {
    return page.evaluate(async ({ cases, expected }) => {
      const { KernelClient } = await import('/src/kernel/client.ts')
      const client = new KernelClient()
      const records = []
      try {
        for (let index = 0; index < cases.length; index++) {
          const c = cases[index]
          const reference = Uint8Array.from(atob(expected[index]), x => x.charCodeAt(0))
          let cpu: Uint8Array | undefined
          for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
            const result = await client.render(
              { ...c.document, rasterProfile: 'figmaSoftware' },
              { ...c.options, rasterProfile: 'figmaSoftware' }, false, backend, true,
            )
            result.bitmap?.close()
            if (result.backend !== backend || !result.bytes || result.bytes.length !== reference.length)
              throw Error(`Missing ${backend} readback or unexpected fallback: ${c.id}`)
            if (backend === 'cpu') cpu = new Uint8Array(result.bytes)
            let differentPixels = 0, maxChannelError = 0, cpuDifferentPixels = 0
            for (let i = 0; i < reference.length; i += 4) {
              let different = false, cpuDifferent = false
              for (let ch = 0; ch < 4; ch++) {
                const delta = Math.abs(result.bytes[i + ch] - reference[i + ch])
                maxChannelError = Math.max(maxChannelError, delta)
                different ||= delta !== 0
                cpuDifferent ||= result.bytes[i + ch] !== cpu![i + ch]
              }
              differentPixels += Number(different)
              cpuDifferentPixels += Number(cpuDifferent)
            }
            records.push({ id: c.id, backend, differentPixels, maxChannelError, cpuDifferentPixels,
              referenceSha256: c.referenceSha256, rgba: Array.from(result.bytes), stats: result.stats })
          }
        }
      } finally { client.dispose() }
      return records
    }, { cases, expected })
  })
  const records = []
  for (let i = 0; i < rows.length; i++) {
    const { rgba, ...row } = rows[i]
    const bytes = Uint8Array.from(rgba)
    await writeFile(join(proof.output, `${i}-${row.backend}.rgba`), bytes, { flag: 'wx' })
    records.push({ ...row, rgbaSha256: sha256(bytes) })
  }
  await proof.write('comparisons.json', records)
  const failures = records.filter(r => r.differentPixels || r.cpuDifferentPixels)
  if (failures.length) throw Error(`${failures.length}/${records.length} strict reference comparisons failed; see comparisons.json`)
  return { cases: cases.length, backends: ['cpu', 'webgpu', 'webgl2'], comparisons: records.length, differentPixels: 0 }
})
