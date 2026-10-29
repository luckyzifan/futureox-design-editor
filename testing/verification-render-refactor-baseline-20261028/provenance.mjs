import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
export async function verifyArtifacts(base, bundle, manifest) {
  if (!manifest.artifacts || !Object.keys(manifest.artifacts).length) throw Error('Missing artifact manifest')
  let checked = 0
  for (const [relative, expected] of Object.entries(manifest.artifacts)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..' || x === '')) throw Error('Unsafe artifact path')
    const file = relative.startsWith('products/') ? path.join(base, relative) : path.join(bundle, relative)
    const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex')
    if (actual !== expected) throw Error(`Artifact drift: ${relative}`)
    checked++
  }
  return {checked, matched:true}
}
