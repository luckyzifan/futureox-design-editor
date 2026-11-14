import { assertPackagedFfmpeg } from './ffmpeg-bundle.mjs'
import { verifyMcp } from './mcp-bundle.mjs'
import { verifyPackagedMcpTransport } from '../test/runtime/packaged-mcp-transport.mjs'
import { verifyWasmIdentity } from './wasm-identity.mjs'
import { buildInputs } from './build-inputs.mjs'
import { documentChildEnvironment } from '../src/document-capacity.mjs'
import { ELECTRON_ATTRIBUTION_FILES, MAC_ELECTRON_NOTICES, hashReadonlyFile, verifyDeclaredResourceList } from './release-package-resources.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..')
const require = createRequire(import.meta.url)
const asar = require(
  require.resolve('@electron/asar', {
    paths: [path.dirname(require.resolve('@electron/packager'))],
  }),
)
const exact = process.argv.includes('--exact')
const preview = process.argv.includes('--preview')
const buildTag = process.argv.find(value => value.startsWith('--build-tag='))?.slice('--build-tag='.length)
if (buildTag !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(buildTag)) throw new Error('Invalid build tag')
const local = process.argv.includes('--local')
if ([exact, preview, local].filter(Boolean).length > 1) throw new Error('Select only one package variant')
const packageName = exact ? 'futureox-desgin Exact' : preview ? 'futureox-desgin Preview' : 'futureox-desgin'
const outputRoot = path.join(desktop, 'release', ...(local ? ['local'] : exact ? ['exact'] : preview ? ['preview'] : []), ...(buildTag ? [buildTag] : []))
const bundle = path.resolve(
  process.argv.slice(2).find(value => !value.startsWith('--')) || path.join(outputRoot, `${packageName}-${process.platform}-${process.arch}`),
)
const resources =
  process.platform === 'darwin'
    ? path.join(bundle, `${packageName}.app/Contents/Resources`)
    : path.join(bundle, 'resources')
const archive = path.join(resources, 'app.asar')
const binaryName = `futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`
const binary = path.join(resources, 'sidecar', binaryName)
const temporary = await mkdtemp(path.join(os.tmpdir(), 'forma-package-verify-'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function files(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory())
      result.push(...(await files(path.join(directory, entry.name), relative)))
    else if (entry.isFile()) result.push(relative)
    else throw new Error(`Unexpected non-regular package input: ${relative}`)
  }
  return result.sort()
}
function version(command, args) {
  const child = spawnSync(command, args, { encoding: 'utf8', cwd: core })
  return child.status === 0 ? child.stdout.trim() : 'unavailable'
}
const manifest = {
  format: 1,
  createdAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  claims:
    'Source/artifact identity, unsigned resource-list bytes, and real subprocess contracts; not GUI, signing, notarization, installer launch, or formal release acceptance.',
  toolchain: {
    electron: require('electron/package.json').version,
    packager: JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'))
      .devDependencies['@electron/packager'],
    node: process.version,
    bun: version('bun', ['--version']),
    rustc: version('rustc', ['--version']),
  },
  sources: {},
  artifacts: {},
  checks: [],
  status: 'running',
}
const report = path.join(outputRoot, 'package-verification.json')
try {
  const build = JSON.parse(await readFile(path.join(desktop, 'dist/build-manifest.json'), 'utf8'))
  assert.equal(build.platform, process.platform)
  assert.equal(build.arch, process.arch)
  assert.deepEqual(
    await buildInputs(core),
    build.sources,
    'Build inputs changed; rebuild before packaging',
  )
  manifest.build = build
  if (local) assert.equal(build.profile, 'release', 'futureox-desgin must use a release Rust sidecar')
  if (process.platform === 'darwin') {
    const plist = path.join(bundle, `${packageName}.app/Contents/Info.plist`)
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', shell: false })
    assert.equal(result.status, 0, 'Packaged Info.plist must be readable')
    const info = JSON.parse(result.stdout)
    const expectedId = local ? 'com.futureox.desgin.local' : exact ? 'com.futureox.desgin.exact' : preview ? 'com.futureox.desgin.preview' : 'com.futureox.desgin'
    assert.equal(info.CFBundleIdentifier, expectedId)
    assert.ok(info.CFBundleDocumentTypes?.some(type => type.CFBundleTypeRole === 'Editor' && type.LSItemContentTypes?.includes('com.futureox.desgin.document')))
    assert.ok(info.UTExportedTypeDeclarations?.some(type => type.UTTypeIdentifier === 'com.futureox.desgin.document' && type.UTTypeTagSpecification?.['public.filename-extension']?.includes('fd')))
    manifest.checks.push('macOS bundle identity and .fd UTI document registration')
  }
  asar.extractAll(archive, temporary)
  for (const [source, packaged] of [
    [path.join(desktop, 'assets'), path.join(temporary, 'assets')],
    [path.join(desktop, 'src'), path.join(temporary, 'src')],
    [path.join(desktop, 'dist/renderer'), path.join(temporary, 'renderer')],
  ]) {
    const names = await files(source)
    assert.deepEqual(
      await files(packaged),
      names,
      'Packaged file inventory must match build inputs',
    )
    for (const name of names) {
      const expected = sha(await readFile(path.join(source, name)))
      assert.equal(
        sha(await readFile(path.join(packaged, name))),
        expected,
        `Stale packaged file: ${name}`,
      )
      manifest.artifacts[path.relative(temporary, path.join(packaged, name))] = expected
    }
  }
  const native = await readFile(binary)
  assert.equal(
    sha(native),
    sha(await readFile(path.join(desktop, 'dist/sidecar', binaryName))),
    'Sidecar must match build output',
  )
  const magic = native.subarray(0, 4).toString('hex')
  assert.ok(
    process.platform === 'linux'
      ? magic === '7f454c46'
      : process.platform === 'darwin'
        ? ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic)
        : native.subarray(0, 2).toString() === 'MZ',
    'Native executable format must match host',
  )
  await verifyMcp(core, path.join(resources, 'design-mcp'))
  const executable = process.platform === 'darwin' ? path.join(resources, '../MacOS/futureox-desgin')
    : path.join(bundle, process.platform === 'win32' ? 'futureox-desgin.exe' : 'futureox-desgin')
  await verifyPackagedMcpTransport({ resources, executable, hostSource: temporary })
  manifest.checks.push('packaged Electron stdio + loopback HTTP discovery, reads and resource revocation')
  manifest.artifacts['app.asar'] = sha(await readFile(archive))
  manifest.artifacts[`sidecar/${binaryName}`] = sha(native)
  for (const name of ['design-render', 'design-prepare', 'futureox-design-agent']) {
    const filename = `${name}${process.platform === 'win32' ? '.exe' : ''}`
    const packaged = await readFile(path.join(resources, 'bin', filename))
    assert.equal(sha(packaged), sha(await readFile(path.join(desktop, 'dist/bin', filename))), `${name} must match the current build`)
    assert.equal(packaged.subarray(0,4).toString('hex'), native.subarray(0,4).toString('hex'), `${name} must use the host executable format`)
    manifest.artifacts[`bin/${filename}`] = sha(packaged)
  }
  const ffmpegBytes = await assertPackagedFfmpeg({
    resourcesBin: path.join(resources, 'bin'),
    distBin: path.join(desktop, 'dist/bin'),
  })
  if (ffmpegBytes.present) {
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    manifest.artifacts[`bin/${ffmpegName}`] = sha(ffmpegBytes.bytes)
    manifest.checks.push('bundled ffmpeg identity')
  } else {
    manifest.checks.push('ffmpeg not vendored for this platform')
  }
  // The generated WASM may be nested under assets or wasm; verify every packaged WASM
  // against its canonical public input, including Vite content-hashed filenames.
  // Filename mapping never substitutes for exact byte identity.
  const rendererFiles = await files(path.join(temporary, 'renderer'))
  const wasmFiles = rendererFiles.filter((name) => name.endsWith('.wasm'))
  assert.ok(wasmFiles.length, 'The package must contain the real WASM kernel')
  const publicFiles = await files(path.join(core, 'frontend/design-client/public'))
  const wasmSources = await Promise.all(
    publicFiles
      .filter((name) => name.endsWith('.wasm'))
      .map(async (name) => ({
        name,
        sha256: sha(await readFile(path.join(core, 'frontend/design-client/public', name))),
      })),
  )
  const requireClient = createRequire(path.join(core, 'frontend/design-client/package.json'))
  for (const variant of [
    '@jitl/quickjs-wasmfile-debug-asyncify',
    '@jitl/quickjs-wasmfile-debug-sync',
    '@jitl/quickjs-wasmfile-release-asyncify',
    '@jitl/quickjs-wasmfile-release-sync',
  ]) {
    const wasm = path.join(path.dirname(requireClient.resolve(`${variant}/package.json`)), 'dist/emscripten-module.wasm')
    wasmSources.push({ name: path.relative(core, wasm), sha256: sha(await readFile(wasm)) })
  }
  for (const name of wasmFiles) {
    verifyWasmIdentity(
      name,
      sha(await readFile(path.join(temporary, 'renderer', name))),
      wasmSources,
    )
  }
  let resourceList
  try {
    resourceList = JSON.parse(await readFile(path.join(temporary, 'resource-list.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Unsigned resource list is missing from the package (${error.message})`)
  }
  verifyDeclaredResourceList(resourceList, {
    appRoot: temporary,
    resourcesRoot: resources,
    profile: build.profile,
    platform: process.platform,
    arch: process.arch,
  })
  manifest.checks.push('unsigned resource list matches packaged JS, WASM and native bytes')
  if (process.platform === 'darwin') {
    const notices = path.join(resources, MAC_ELECTRON_NOTICES)
    for (const name of ELECTRON_ATTRIBUTION_FILES) {
      assert.ok(hashReadonlyFile(path.join(notices, name)).size > 0, `Empty Electron attribution file: ${name}`)
    }
    assert.equal((await readFile(path.join(notices, 'version'), 'utf8')).trim(), manifest.toolchain.electron)
    manifest.checks.push('Electron and Chromium notices are present in the macOS app')
  }
  for (const directory of [
    'frontend/design-desktop/src',
    'frontend/design-desktop/scripts',
    'frontend/design-desktop/test',
    'frontend/design-client/src',
    'design-studio/crates/design-kernel/src',
    'design-studio/crates/design-desktop-backend/src',
  ]) {
    for (const name of await files(path.join(core, directory))) {
      const relative = path.posix.join(directory, name.split(path.sep).join('/'))
      manifest.sources[relative] = sha(await readFile(path.join(core, relative)))
    }
  }
  for (const name of [
    'frontend/design-client/bun.lock',
    'frontend/design-desktop/bun.lock',
    'frontend/design-desktop/package.json',
    'design-studio/Cargo.lock',
    'rust-toolchain.toml',
  ]) {
    manifest.sources[name] = sha(await readFile(path.join(core, name)))
  }
  manifest.checks.push(
    'ASAR host/renderer identity',
    'native sidecar build identity and format',
    'public/packaged WASM identity',
  )
  const tests = [
    'test/preload.test.mjs',
    'test/sidecar-lifecycle.test.mjs',
    'test/runtime/sidecar-runtime.test.mjs',
    'test/runtime/workspace-runtime.test.mjs',
  ]
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: desktop,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
    shell: false,
    env: documentChildEnvironment({
      ...process.env,
      CORE_DESKTOP_SIDECAR: binary,
      CORE_DESKTOP_TEST_SOURCE: pathToFileURL(path.join(temporary, 'src') + path.sep).href,
    }),
  })
  const log = `${result.stdout || ''}${result.stderr || ''}`
  process.stdout.write(log)
  await mkdir(path.dirname(report), { recursive: true })
  await writeFile(path.join(outputRoot, 'package-verification.log'), log)
  manifest.artifacts['package-verification.log'] = sha(Buffer.from(log))
  assert.equal(
    result.status,
    0,
    'Packaged preload and real-child persistence/lifecycle tests must pass',
  )
  manifest.checks.push(
    'packaged preload contract',
    'real child timeout/termination',
    'packaged Rust save/conflict/recovery/restart',
  )
  manifest.status = 'passed'
} catch (error) {
  manifest.status = 'failed'
  manifest.error = error.message
  throw error
} finally {
  await mkdir(path.dirname(report), { recursive: true })
  await writeFile(report, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(temporary, { recursive: true, force: true })
  console.log(`Package verification report: ${report}`)
}
