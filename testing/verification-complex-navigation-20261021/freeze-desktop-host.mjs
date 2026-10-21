// Complete an isolated --out-dir build with the unchanged production host.
// Run from the repository root. Never copies a user profile or design file.
import { cp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const [directory, ...extra] = process.argv.slice(2)
if (!directory || extra.length) throw Error('Expected a fresh host directory containing only its guarded dist/ build')
const root = process.cwd(), source = path.join(root, 'frontend/design-desktop'), destination = path.resolve(directory)
const entries = await readdir(destination)
if (entries.length !== 1 || entries[0] !== 'dist') throw Error('Refusing to overwrite an existing host or profile')
const hash = value => createHash('sha256').update(value).digest('hex')
const before = await readFile(path.join(destination, 'dist/build-manifest.json'))
const manifest = JSON.parse(before)
if (manifest.profile !== 'release') throw Error('This verification requires release native products')
for (const folder of ['src', 'assets']) await cp(path.join(source, folder), path.join(destination, folder), { recursive: true, force: false, errorOnExist: true })
await cp(path.join(source, 'package.json'), path.join(destination, 'package.json'), { errorOnExist: true, force: false })
await symlink(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'dir')
const files = {}
async function visit(folder) {
  for (const entry of (await readdir(path.join(destination, folder), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(folder, entry.name)
    if (entry.isDirectory()) await visit(relative)
    else if (entry.isFile()) files[relative] = hash(await readFile(path.join(destination, relative)))
    else throw Error('Unexpected host/build symlink: ' + relative)
  }
}
for (const folder of ['src', 'assets', 'dist']) await visit(folder)
for (const [relative, digest] of Object.entries(files).filter(([name]) => name.startsWith('src/'))) {
  if (digest !== manifest.sources['frontend/design-desktop/' + relative]) throw Error('Host source changed after guarded build: ' + relative)
}
for (const [relative, native] of [['bin/design-prepare', 'design-prepare'], ['bin/design-render', 'design-render'], ['sidecar/futureox-design-desktop-backend', 'futureox-design-desktop-backend']]) {
  if (files['dist/' + relative] !== hash(await readFile(path.join(root, 'design-studio/target/release', native))))
    throw Error('Isolated native product differs from the recorded release target: ' + relative)
}
if (!before.equals(await readFile(path.join(destination, 'dist/build-manifest.json')))) throw Error('Build changed during host snapshot')
await writeFile(path.join(destination, 'frozen-runtime.json'), JSON.stringify({
  scope: 'Guarded isolated release output and hash-matched unchanged production host. Shared node_modules is a read-only runtime dependency. No user document/profile copied.',
  buildManifestSha256: hash(before), files,
}, null, 2) + '\n')
console.log(JSON.stringify({ files: Object.keys(files).length, profile: manifest.profile, wasmSha256: files['dist/renderer/kernel/design_kernel_bg.wasm'] }))
