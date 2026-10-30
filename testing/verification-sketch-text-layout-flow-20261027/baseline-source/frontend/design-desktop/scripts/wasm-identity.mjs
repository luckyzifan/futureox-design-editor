import assert from 'node:assert/strict'
import path from 'node:path'

export function verifyWasmIdentity(packagedName, packagedHash, sources) {
  const name = path.basename(packagedName)
  const candidates = sources.filter(({ name: input }) => {
    const base = path.basename(input)
    const prefix = `${base.slice(0, -'.wasm'.length)}-`
    const viteHash =
      name.startsWith(prefix) && name.endsWith('.wasm')
        ? name.slice(prefix.length, -'.wasm'.length)
        : ''
    return name === base || (base.endsWith('.wasm') && /^[A-Za-z0-9_-]+$/.test(viteHash))
  })
  assert.ok(candidates.length, `Missing WASM source for ${packagedName}`)
  assert.equal(candidates.length, 1, `Ambiguous WASM source for ${packagedName}`)
  assert.equal(packagedHash, candidates[0].sha256, `Stale WASM: ${packagedName}`)
  return candidates[0].name
}
