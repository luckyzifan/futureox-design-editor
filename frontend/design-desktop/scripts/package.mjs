import { packager } from '@electron/packager'
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const exact = process.argv.includes('--exact')
const preview = process.argv.includes('--preview')
const buildTag = process.argv.find(value => value.startsWith('--build-tag='))?.slice('--build-tag='.length)
if (buildTag !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(buildTag)) throw new Error('Invalid build tag')
const local = process.argv.includes('--local')
if ([exact, preview, local].filter(Boolean).length > 1) throw new Error('Select only one package variant')
const packageName = exact ? 'futureox-desgin Exact' : preview ? 'futureox-desgin Preview' : 'futureox-desgin'
const bundleId = local ? 'com.futureox.desgin.local' : exact ? 'com.futureox.desgin.exact' : preview ? 'com.futureox.desgin.preview' : 'com.futureox.desgin'
const staging = path.join(root, 'dist/package-app')
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await cp(path.join(root, 'assets'), path.join(staging, 'assets'), { recursive: true })
await cp(path.join(root, 'src'), path.join(staging, 'src'), { recursive: true })
if (existsSync(path.join(root, 'dist/renderer/fidelity'))) throw new Error('Reference fixtures found in renderer output; rebuild before packaging')
if (existsSync(path.join(root, 'dist/renderer/figma-blur-verify.html'))) throw new Error('Experimental verification page found in renderer output; rebuild before packaging')
await cp(path.join(root, 'dist/renderer'), path.join(staging, 'renderer'), { recursive: true })
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const electronZipDir = process.env.ELECTRON_ZIP_DIR
if (electronZipDir) {
  const filename = `electron-v${metadata.devDependencies.electron}-${process.platform}-${process.arch}.zip`
  const checksums = JSON.parse(await readFile(path.join(path.dirname(require.resolve('electron')), 'checksums.json'), 'utf8'))
  const expected = checksums[filename]
  if (typeof expected !== 'string') throw new Error(`Electron checksum is unavailable for ${filename}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path.join(electronZipDir, filename))) hash.update(chunk)
  if (hash.digest('hex') !== expected) throw new Error(`Electron ZIP checksum mismatch: ${filename}`)
}
await writeFile(
  path.join(staging, 'package.json'),
  JSON.stringify(
    {
      name: 'futureox-desgin',
      productName: packageName,
      version: metadata.version,
      description: metadata.description,
      main: 'src/main.mjs',
      type: 'module',
      private: true,
    },
    null,
    2,
  ),
)
// Package only for this machine: the bundled Rust executable must match the OS/CPU.
// Code signing, notarization and installers are separate release work on each target OS.
const outputs = await packager({
  dir: staging,
  name: packageName,
  appBundleId: bundleId,
  icon: path.join(root, 'assets/branding', `futureox-desgin.${process.platform === 'darwin' ? 'icns' : process.platform === 'win32' ? 'ico' : 'png'}`),
  extendInfo: {
    NSHighResolutionCapable: true,
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'futureox-desgin Document', CFBundleTypeRole: 'Editor',
      LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.futureox.desgin.document'], CFBundleTypeExtensions: ['fd'] }],
    UTExportedTypeDeclarations: [{ UTTypeIdentifier: 'com.futureox.desgin.document', UTTypeDescription: 'futureox-desgin Document',
      UTTypeConformsTo: ['public.data', 'public.content'], UTTypeTagSpecification: { 'public.filename-extension': ['fd'], 'public.mime-type': ['application/vnd.futureox-desgin'] } }],
  },
  executableName: 'futureox-desgin',
  platform: process.platform,
  arch: process.arch,
  electronVersion: metadata.devDependencies.electron,
  download: { cacheRoot: process.env.ELECTRON_CACHE || process.env.electron_config_cache },
  electronZipDir,
  appVersion: metadata.version,
  out: path.join(root, 'release', ...(local ? ['local'] : exact ? ['exact'] : preview ? ['preview'] : []), ...(buildTag ? [buildTag] : [])),
  overwrite: true,
  asar: true,
  prune: false,
  extraResource: [path.join(root, 'dist/sidecar'), path.join(root, 'dist/bin'), path.join(root, 'dist/fonts')],
})
for (const output of outputs) console.log(`Unsigned native development bundle: ${output}`)
