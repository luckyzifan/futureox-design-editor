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
  // Several installed packages can share one basename, as the QuickJS wasm
  // variants do. Exact bytes choose among them. Two sources with the same
  // bytes stay ambiguous, and a hash that matches none is stale.
  const exact = candidates.filter(candidate => candidate.sha256 === packagedHash)
  if (candidates.length > 1) {
    assert.equal(exact.length, 1, exact.length ? `Ambiguous WASM source for ${packagedName}` : `Stale WASM: ${packagedName}`)
    return exact[0].name
  }
  assert.equal(packagedHash, candidates[0].sha256, `Stale WASM: ${packagedName}`)
  return candidates[0].name
}
