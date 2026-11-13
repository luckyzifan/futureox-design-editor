import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// This identifies the public build input, not bytes authenticated at runtime.
// Generated output is an optional consistency check, never a fallback source.
export async function publicWasmInputHash(publicDirectory, generatedDirectory, dependencies = {}) {
  const read = dependencies.read ?? readFile, list = dependencies.list ?? readdir
  const name = 'design_kernel_bg.wasm'
  const runtimeHash = sha(await read(path.join(publicDirectory, 'kernel', name)))
  if (generatedDirectory) {
    let files
    try { files = (await list(generatedDirectory)).filter(value => value.endsWith('.wasm')).sort() }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      files = [] // Portable archives may include bindings/public WASM only.
    }
    if (files.length > 1 || (files.length === 1 && files[0] !== name))
      throw new Error('Ambiguous generated WASM input')
    if (files.length === 1 && sha(await read(path.join(generatedDirectory, name))) !== runtimeHash)
      throw new Error('Generated and public WASM inputs differ')
  }
  return runtimeHash
}

export async function assertPublicWasmHash(directory, expected, generatedDirectory) {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Invalid expected public WASM hash')
  if (await publicWasmInputHash(directory, generatedDirectory) !== expected)
    throw new Error('Public WASM changed during production build')
}

// Reference fixtures remain available to development/test tooling, but must not
// silently become distributed product assets through Vite's public-directory copy.
export async function copyProductionPublic(source, destination, wasmIdentity = {}) {
  const from = path.resolve(source), to = path.resolve(destination)
  if (to === from || to.startsWith(from + path.sep) || from.startsWith(to + path.sep))
    throw new Error('Production output and public sources must be separate directories')
  const { expectedWasmSha256, generatedDirectory } = wasmIdentity
  const verified = expectedWasmSha256 !== undefined
  if (verified) await assertPublicWasmHash(from, expectedWasmSha256, generatedDirectory)
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    if (entry === 'fidelity' || entry === 'figma-blur-verify.html' || entry === 'canvas-chrome-verify.html' || entry === 'sdf-shadow-verify.html') continue
    await cp(path.join(from, entry), path.join(to, entry), { recursive: true })
  }
  if (verified) {
    await assertPublicWasmHash(from, expectedWasmSha256, generatedDirectory)
    await assertPublicWasmHash(to, expectedWasmSha256)
  }
}

export function productionPublicAssets({ expectedWasmSha256 } = {}) {
  let config
  return {
    name: 'futureox-production-public-assets',
    apply: 'build',
    config: () => ({ build: { copyPublicDir: false } }),
    configResolved(value) { config = value },
    async writeBundle() {
      if (config.publicDir) await copyProductionPublic(config.publicDir, path.resolve(config.root, config.build.outDir), {
        expectedWasmSha256,
        generatedDirectory: path.resolve(config.root, 'src/generated/design-kernel'),
      })
    },
  }
}
