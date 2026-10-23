import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildInputs } from './build-inputs.mjs'
import { publicWasmInputHash } from '../../design-client/scripts/production-public.mjs'
const exec = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
export const identityFingerprint = entries => sha(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))

// Runs at Vite configuration time, never per request/frame. The existing source
// inventory excludes generated bindings; the public runtime WASM gets a separate hash.
// Missing files/git are explicit unknowns, not stale hard-coded release labels.
export async function renderDiagnosticBuildIdentity(core, command, dependencies = {}) {
  const sources = dependencies.sources ?? (() => buildInputs(core))
  const head = dependencies.head ?? (async () => (await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: core, timeout: 2000, maxBuffer: 1024 })).stdout.trim())
  const out = { producerIdentityStatus: 0, producerCommitStatus: 0, producerBuildMode: command === 'build' ? 1 : 2 }
  // A dev server may hot-replace modules after config time. Do not stamp that
  // startup snapshot as if it identified the currently executing HMR producer.
  if (command !== 'build') return out
  try {
    const commit = await head()
    if (/^[0-9a-f]{40}$/.test(commit)) { out.producerCommit = commit; out.producerCommitStatus = 1 }
  } catch { /* Git is optional in a source increment. */ }
  try {
    const inputs = await sources()
    if (!Object.keys(inputs).length || Object.values(inputs).some(value => !/^[0-9a-f]{64}$/.test(value))) return out
    const dictionary = inputs['frontend/design-client/src/kernel/render-failure-telemetry.ts']
    if (!dictionary) return out
    out.producerSourceSha256 = identityFingerprint(inputs)
    out.failureDictionarySha256 = dictionary
    out.producerIdentityStatus = 1 // Complete configured source inventory; no verified WASM yet.
    // The copy plugin uses the same public-input consistency check and verifies
    // its captured hash again before/after copying the distributed runtime file.
    out.producerWasmInputSha256 = await publicWasmInputHash(
      path.join(core, 'frontend/design-client/public'),
      path.join(core, 'frontend/design-client/src/generated/design-kernel'),
      dependencies,
    )
    out.producerIdentityStatus = 2 // Source inventory + exact public WASM build input.
  } catch { /* Diagnostics must not turn an otherwise valid build into failure. */ }
  return out
}
