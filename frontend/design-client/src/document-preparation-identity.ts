import { producerIdentityFields } from '../../design-desktop/src/render-diagnostic-identity.mjs'
import { pickingPreparationResources } from './kernel/picking'

export type DocumentPreparationBuild = Readonly<{ sourceSha256: string; wasmInputSha256: string }>
export type DocumentPreparationRuntime = Readonly<{
  build: DocumentPreparationBuild; wasmSha256: string; fontSha256: string
}>
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
/** Dev/HMR, missing build identity, custom resources and unavailable hashes keep
 * the existing synchronous contract. Never label unknown inputs as same-build. */
export function documentPreparationBuild(): DocumentPreparationBuild | undefined {
  const value = producerIdentityFields()
  if (value.producerIdentityStatus !== 2 || value.producerBuildMode !== 1 ||
      !digest(value.producerSourceSha256) || !digest(value.producerWasmInputSha256)) return
  return Object.freeze({ sourceSha256: value.producerSourceSha256, wasmInputSha256: value.producerWasmInputSha256 })
}
export function documentPreparationRuntime(): DocumentPreparationRuntime | undefined {
  const build = documentPreparationBuild(), resources = pickingPreparationResources()
  if (!build || !resources?.bundled || !digest(resources.wasmSha256) || !digest(resources.fontSha256) ||
      resources.wasmSha256 !== build.wasmInputSha256) return
  return Object.freeze({ build, wasmSha256: resources.wasmSha256, fontSha256: resources.fontSha256 })
}
export function sameDocumentPreparationBuild(a: DocumentPreparationBuild | undefined, b: DocumentPreparationBuild | undefined) {
  return !!a && !!b && a.sourceSha256 === b.sourceSha256 && a.wasmInputSha256 === b.wasmInputSha256
}
export function sameDocumentPreparationRuntime(a: DocumentPreparationRuntime | undefined, b: DocumentPreparationRuntime | undefined) {
  return !!a && !!b && sameDocumentPreparationBuild(a.build, b.build) && a.wasmSha256 === b.wasmSha256 && a.fontSha256 === b.fontSha256
}
