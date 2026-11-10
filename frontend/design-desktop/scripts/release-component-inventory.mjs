// Package-component inventory for issue 88.
// Cargo.lock names and an Electron version string are build inputs.
// Distributed components are the files and crates the desktop packager copies
// or links. A missing signed installer stays not_closed.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePackage } from './release-package-resources.mjs'
import { packageSourceFilter } from './package-source.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const NOTICE_ROOT = 'frontend/design-desktop/third-party-notices/cargo'

const SHIPPED_CRATES = [
  'futureox-design-desktop-backend',
  'futureox-design-gpu',
  'futureox-design-kernel',
  'futureox-design-agent',
]
const PLATFORM_TREES = [
  { id: 'x86_64-unknown-linux-gnu', target: 'x86_64-unknown-linux-gnu', crates: SHIPPED_CRATES },
  { id: 'aarch64-apple-darwin', target: 'aarch64-apple-darwin', crates: SHIPPED_CRATES },
  { id: 'x86_64-pc-windows-msvc', target: 'x86_64-pc-windows-msvc', crates: SHIPPED_CRATES },
  { id: 'wasm32-unknown-unknown', target: 'wasm32-unknown-unknown', crates: ['futureox-design-kernel'] },
]
const NATIVE_BINARIES = [
  { path: 'sidecar/futureox-design-desktop-backend', crate: 'futureox-design-desktop-backend' },
  { path: 'bin/design-render', crate: 'futureox-design-gpu' },
  { path: 'bin/design-prepare', crate: 'futureox-design-kernel' },
  { path: 'bin/futureox-design-agent', crate: 'futureox-design-agent' },
]
const PRODUCTION_EXCLUDED = new Set(['fidelity', 'figma-blur-verify.html'])
const LICENSE_FILE = /^(license|licence|copying|notice|unlicense|copyright)(\b|[._-]|$)/i

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(file) {
  return sha256(readFileSync(file))
}

function walk(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files.sort()
}

function parseJsonLoose(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'))
}

function parseCargoLock(text) {
  const packages = []
  for (const block of text.split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1]
    const version = block.match(/^version = "([^"]+)"/m)?.[1]
    if (!name || !version) continue
    packages.push({
      name,
      version,
      id: `${name}@${version}`,
      source: block.match(/^source = "([^"]+)"/m)?.[1] ?? 'path',
      checksum: block.match(/^checksum = "([^"]+)"/m)?.[1] ?? null,
    })
  }
  return packages
}

function parseTreeLine(line) {
  let text = line.trim()
  if (!text || text.startsWith('error:')) return null
  const tab = text.indexOf('\t')
  let spec = tab === -1 ? text : text.slice(0, tab)
  const license = tab === -1 ? '' : text.slice(tab + 1).trim()
  if (spec.endsWith(' (*)')) spec = spec.slice(0, -4)
  let procMacro = false
  if (spec.endsWith(' (proc-macro)')) {
    procMacro = true
    spec = spec.slice(0, -' (proc-macro)'.length)
  }
  let manifestDir = null
  const pathAt = spec.match(/^(.*) \((\/.*)\)$/)
  if (pathAt) {
    spec = pathAt[1]
    manifestDir = pathAt[2]
  }
  const versionAt = spec.lastIndexOf(' v')
  if (versionAt <= 0) return null
  const name = spec.slice(0, versionAt)
  const version = spec.slice(versionAt + 2)
  return { name, version, id: `${name}@${version}`, license: license || null, procMacro, manifestDir }
}

function cargoTree(root, platform) {
  const args = [
    'tree', '--locked', '--offline',
    '--manifest-path', path.join(root, 'design-studio/Cargo.toml'),
    ...platform.crates.flatMap(name => ['-p', name]),
    '--edges', 'normal',
    '--prefix', 'none',
    '--format', '{p}\t{l}',
  ]
  if (platform.target) args.push('--target', platform.target)
  const run = offline => spawnSync('cargo', offline ? args : args.filter(arg => arg !== '--offline'), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  let child = run(true)
  if (child.status !== 0) child = run(false)
  if (child.status !== 0) {
    return { ok: false, error: `${child.stderr || child.stdout || 'cargo tree failed'}`.trim() }
  }
  const crates = new Map()
  for (const line of child.stdout.split('\n')) {
    const item = parseTreeLine(line)
    if (!item) continue
    crates.set(item.id, item)
  }
  return { ok: true, crates }
}

let treeCache = null
function loadCargoTrees(root) {
  if (treeCache?.root === root) return treeCache.value
  const platforms = {}
  const errors = []
  for (const platform of PLATFORM_TREES) {
    const tree = cargoTree(root, platform)
    if (!tree.ok) errors.push({ platform: platform.id, error: tree.error })
    platforms[platform.id] = tree.ok ? [...tree.crates.values()] : []
  }
  const value = { platforms, errors }
  treeCache = { root, value }
  return value
}

function registryCrateDir(name, version) {
  const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')
  const src = path.join(home, 'registry/src')
  if (!existsSync(src)) return null
  for (const host of readdirSync(src)) {
    const dir = path.join(src, host, `${name}-${version}`)
    if (existsSync(dir)) return dir
  }
  return null
}

function collectLicenseFiles(dir) {
  if (!dir || !existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && /^(licenses|licences)$/i.test(entry.name)) {
      for (const child of readdirSync(full, { withFileTypes: true })) {
        if (!child.isFile() || child.name.startsWith('.')) continue
        out.push({ relative: `${entry.name}/${child.name}`, full: path.join(full, child.name) })
      }
      continue
    }
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) out.push({ relative: entry.name, full })
  }
  return out.sort((a, b) => a.relative.localeCompare(b.relative))
}

function noticeRecord(root, relative) {
  const full = path.join(root, relative)
  return { path: relative, sha256: sha256File(full), bytes: statSync(full).size }
}

export function materializeCargoNotices(root = repo) {
  const { platforms, errors } = loadCargoTrees(root)
  const written = []
  const seen = new Set()
  for (const crates of Object.values(platforms)) {
    for (const crate of crates) {
      if (seen.has(crate.id) || crate.manifestDir) continue
      seen.add(crate.id)
      const sourceDir = registryCrateDir(crate.name, crate.version)
      const files = collectLicenseFiles(sourceDir)
      for (const file of files) {
        const relative = path.join(NOTICE_ROOT, crate.name, crate.version, file.relative)
        const destination = path.join(root, relative)
        mkdirSync(path.dirname(destination), { recursive: true })
        copyFileSync(file.full, destination)
        written.push(relative.split(path.sep).join('/'))
      }
    }
  }
  return { written, errors }
}

function crateNotices(root, crate) {
  if (crate.name.startsWith('futureox-design-')) {
    return [noticeRecord(root, 'LICENSE')]
  }
  if (crate.manifestDir) {
    const relativeDir = path.relative(root, crate.manifestDir)
    return collectLicenseFiles(crate.manifestDir).map(file => noticeRecord(root, path.join(relativeDir, file.relative).split(path.sep).join('/')))
  }
  const stored = path.join(root, NOTICE_ROOT, crate.name, crate.version)
  return collectLicenseFiles(stored).map(file => noticeRecord(root, path.join(NOTICE_ROOT, crate.name, crate.version, file.relative).split(path.sep).join('/')))
}

function buildRust(root) {
  const lock = parseCargoLock(readFileSync(path.join(root, 'design-studio/Cargo.lock'), 'utf8'))
  const lockById = new Map(lock.map(item => [item.id, item]))
  const { platforms, errors } = loadCargoTrees(root)
  const merged = new Map()
  for (const [platform, crates] of Object.entries(platforms)) {
    for (const crate of crates) {
      const current = merged.get(crate.id) ?? { ...crate, platforms: [] }
      current.platforms.push(platform)
      if (!current.manifestDir && crate.manifestDir) current.manifestDir = crate.manifestDir
      if (!current.license && crate.license) current.license = crate.license
      merged.set(crate.id, current)
    }
  }
  const crates = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)).map(crate => {
    const locked = lockById.get(crate.id)
    const notices = crateNotices(root, crate)
    const thirdParty = !crate.name.startsWith('futureox-design-')
    const traceable = Boolean(crate.license && notices.length && locked)
    return {
      id: crate.id,
      name: crate.name,
      version: crate.version,
      license: crate.license,
      checksum: locked?.checksum ?? null,
      source: locked?.source ?? (crate.manifestDir ? path.relative(root, crate.manifestDir) : null),
      procMacro: crate.procMacro,
      platforms: crate.platforms,
      notices,
      thirdParty,
      distribution: 'cargo_tree_normal_dependency',
      binaryHash: null,
      binaryStatus: 'not_built',
      traceable,
      gap: traceable ? null : (notices.length ? 'missing_lock_identity_or_license' : 'license_text_not_in_crate_or_repo'),
    }
  })
  const distributedIds = new Set(crates.map(crate => crate.id))
  return {
    status: errors.length ? 'partial' : 'cargo_tree',
    errors,
    crates,
    notDistributed: lock.filter(item => !distributedIds.has(item.id)).map(item => item.id).sort(),
    lockfilePackages: lock.length,
  }
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier === 'electron') return null
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return name ? `${scope}/${name}` : null
  }
  return specifier.split('/')[0]
}

function specifiers(source) {
  const found = []
  const pattern = /\bfrom\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] || match[2] || match[3]
    const start = source.lastIndexOf('import', match.index)
    const statement = start >= 0 ? source.slice(start, match.index) : ''
    if (/^\s*import\s+type\b/.test(statement) || /^\s*export\s+type\b/.test(statement)) continue
    found.push(specifier.replace(/[?#].*$/, ''))
  }
  return found
}

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const extensions = ['', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.css', '.json']
  const candidates = [
    ...extensions.map(extension => base + extension),
    ...extensions.map(extension => path.join(base, `index${extension}`)),
  ]
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function importedPackages(root) {
  const entry = path.join(root, 'frontend/design-client/src/main.tsx')
  const seen = new Set()
  const packages = new Set()
  const unresolved = []
  const generatedBindings = []
  const missingGeneratedBindings = []
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of specifiers(source)) {
      const imported = packageName(specifier)
      if (imported) {
        packages.add(imported)
        continue
      }
      if (!specifier.startsWith('.')) continue
      if (specifier.includes('/generated/design-kernel/')) {
        generatedBindings.push(specifier)
        if (!resolveRelative(file, specifier)) missingGeneratedBindings.push(specifier)
        continue
      }
      const next = resolveRelative(file, specifier)
      if (next) queue.push(next)
      else unresolved.push(`${path.relative(root, file)} -> ${specifier}`)
    }
  }
  return {
    packages: [...packages].sort(),
    files: seen.size,
    unresolved: [...new Set(unresolved)],
    generatedBindings: [...new Set(generatedBindings)],
    generatedBindingsStatus: missingGeneratedBindings.length ? 'not_in_checkout' : 'present',
  }
}

function parseBunLock(file) {
  return parseJsonLoose(readFileSync(file, 'utf8'))
}

function lockClosure(lock, roots, followOptional = false) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length) {
    const name = queue.pop()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const meta = lock.packages?.[name]?.[2] ?? {}
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push(dep)
    if (followOptional) for (const dep of Object.keys(meta.optionalDependencies ?? {})) queue.push(dep)
  }
  return seen
}

function lockIdentity(lock, name) {
  const entry = lock.packages?.[name]
  if (!entry) return null
  const spec = String(entry[0] ?? '')
  const version = spec.includes('@') ? spec.slice(spec.lastIndexOf('@') + 1) : null
  return {
    version,
    tarball: entry[1] || null,
    integrity: typeof entry[3] === 'string' ? entry[3] : null,
  }
}

function buildJavaScript(root) {
  const clientLock = parseBunLock(path.join(root, 'frontend/design-client/bun.lock'))
  const desktopLock = parseBunLock(path.join(root, 'frontend/design-desktop/bun.lock'))
  const imported = importedPackages(root)
  const production = lockClosure(clientLock, imported.packages, false)
  const clientDev = lockClosure(clientLock, Object.keys(clientLock.workspaces?.['']?.devDependencies ?? {}), true)
  const desktopDev = lockClosure(desktopLock, Object.keys(desktopLock.workspaces?.['']?.devDependencies ?? {}), true)
  const inventory = JSON.parse(readFileSync(path.join(root, 'frontend/design-client/public/licenses/inventory.json'), 'utf8'))
  const notices = new Map(inventory.packages.map(item => [item.package, item]))
  const distributed = [...production].sort().map(name => {
    const identity = lockIdentity(clientLock, name)
    const notice = notices.get(name)
    const noticePath = notice ? `frontend/design-client/public/licenses/${notice.file}` : null
    const present = noticePath && existsSync(path.join(root, noticePath))
    const noticeSha = present ? sha256File(path.join(root, noticePath)) : null
    const traceable = Boolean(identity?.version && notice && present && noticeSha === notice.sha256)
    return {
      package: name,
      version: identity?.version ?? notice?.version ?? null,
      source: notice?.source ?? identity?.tarball ?? 'frontend/design-client/bun.lock',
      integrity: identity?.integrity ?? null,
      license: notice?.license ?? null,
      notices: present ? [{ path: noticePath, sha256: noticeSha }] : [],
      distribution: 'production_import_or_lock_dependency',
      bundleHash: null,
      bundleStatus: 'renderer_not_built',
      traceable,
      gap: traceable ? null : 'notice_text_missing',
    }
  })
  const developmentOnly = [...new Set([...clientDev, ...desktopDev])].filter(name => !production.has(name) && name !== 'electron').sort()
  return {
    imported: imported.packages,
    importFiles: imported.files,
    unresolvedImports: imported.unresolved,
    generatedBindings: imported.generatedBindings,
    generatedBindingsStatus: imported.generatedBindingsStatus,
    distributed,
    developmentOnly,
    electronNpmPackageDistributed: false,
  }
}

function fontLicense(relative) {
  if (relative.startsWith('fonts/poppins/')) return { license: 'OFL-1.1', notice: 'frontend/design-client/public/fonts/poppins/OFL.txt' }
  if (relative.startsWith('fonts/inter/')) return { license: 'OFL-1.1', notice: 'frontend/design-client/public/fonts/inter/LICENSE.txt' }
  if (relative.startsWith('fonts/dejavu/')) return { license: 'Bitstream Vera', notice: 'frontend/design-client/public/fonts/dejavu/COPYRIGHT.txt' }
  if (relative.startsWith('fonts/abeezee/')) return { license: 'OFL-1.1', notice: 'frontend/design-client/public/fonts/abeezee/OFL.txt' }
  if (relative === 'fonts/NotoSansSC.ttf' || relative === 'fonts/OFL.txt' || relative === 'fonts/source.json') {
    return { license: 'OFL-1.1', notice: 'frontend/design-client/public/fonts/OFL.txt' }
  }
  return null
}

function sourceHashes(root) {
  const expected = new Map()
  const poppins = JSON.parse(readFileSync(path.join(root, 'frontend/design-client/public/fonts/poppins/sources.json'), 'utf8'))
  for (const item of poppins) expected.set(`fonts/poppins/${item.name}`, item.sha256)
  const noto = JSON.parse(readFileSync(path.join(root, 'frontend/design-client/public/fonts/source.json'), 'utf8'))
  if (noto.sha256) expected.set('fonts/NotoSansSC.ttf', noto.sha256)
  return expected
}

function buildFontsAndPublic(root) {
  const publicDir = path.join(root, 'frontend/design-client/public')
  const expected = sourceHashes(root)
  const projectLicense = noticeRecord(root, 'LICENSE')
  const fonts = []
  const icons = []
  const other = []
  let fidelityFilesExcluded = 0
  const fidelityDir = path.join(publicDir, 'fidelity')
  if (existsSync(fidelityDir)) fidelityFilesExcluded = walk(fidelityDir).length
  for (const file of walk(publicDir)) {
    const relative = path.relative(publicDir, file).split(path.sep).join('/')
    const top = relative.split('/')[0]
    if (PRODUCTION_EXCLUDED.has(top) || PRODUCTION_EXCLUDED.has(relative)) continue
    const repoPath = `frontend/design-client/public/${relative}`
    const digest = sha256File(file)
    if (relative.startsWith('fonts/') && relative.endsWith('.ttf')) {
      const terms = fontLicense(relative)
      const recorded = expected.get(relative)
      const notice = terms ? noticeRecord(root, terms.notice) : null
      const hashAgrees = recorded ? recorded === digest : true
      fonts.push({
        path: repoPath,
        sha256: digest,
        source: recorded ? 'sources.json' : 'frontend/design-client/public/fonts/README.md',
        recordedSha256: recorded ?? null,
        license: terms?.license ?? null,
        notices: notice ? [notice] : [],
        distribution: 'renderer_package_input',
        traceable: Boolean(terms && notice && hashAgrees),
        gap: !terms ? 'font_license_unmapped' : (hashAgrees ? null : 'source_hash_mismatch'),
      })
      continue
    }
    if (relative.startsWith('branding/')) {
      icons.push({
        path: repoPath,
        sha256: digest,
        source: 'docs/BRANDING.md',
        license: 'MIT',
        notices: [projectLicense],
        distribution: 'renderer_package_input',
        traceable: true,
        thirdParty: false,
      })
      continue
    }
    if (relative.startsWith('color-fixtures/')) {
      other.push({ path: repoPath, sha256: digest, license: null, distribution: 'renderer_package_input', traceable: false, gap: 'no_provenance_record' })
    }
  }
  for (const file of walk(path.join(root, 'frontend/design-desktop/assets/branding'))) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    icons.push({
      path: relative,
      sha256: sha256File(file),
      source: 'docs/BRANDING.md',
      license: 'MIT',
      notices: [projectLicense],
      distribution: 'asar_asset_input',
      traceable: true,
      thirdParty: false,
    })
  }
  return { fonts, icons, unresolvedPackageInputs: other, fidelityFilesExcluded }
}

function buildFfmpeg(root) {
  const base = 'frontend/design-desktop/vendor/ffmpeg/linux-x64'
  const binary = path.join(root, base, 'ffmpeg')
  const sourcePath = path.join(root, base, 'source.json')
  if (!existsSync(binary) || !existsSync(sourcePath)) {
    return { traceable: false, gap: 'linux_ffmpeg_missing' }
  }
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const notices = []
  for (const name of ['LICENSE.txt', 'BUILD.txt', 'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'x264-COPYING', 'libvpx-LICENSE', 'source.json']) {
    notices.push(noticeRecord(root, `${base}/${name}`))
  }
  const sources = (source.sources ?? []).map(item => {
    const relative = `${base}/${item.file}`
    const digest = sha256File(path.join(root, relative))
    return { path: relative, version: item.version, sha256: digest, recordedSha256: item.sha256, matchesRecord: digest === item.sha256 }
  })
  const binarySha = sha256File(binary)
  return {
    path: `${base}/ffmpeg`,
    version: source.version,
    sha256: binarySha,
    recordedSha256: source.sha256,
    license: source.license,
    source: `${base}/source.json`,
    notices,
    correspondingSource: sources,
    otherPlatforms: ['darwin-arm64', 'darwin-x64', 'win32-x64'].map(triple => ({
      triple,
      binary: null,
      status: 'stub_readme_only',
    })),
    distribution: 'extra_resource_bin',
    traceable: binarySha === source.sha256 && sources.every(item => item.matchesRecord) && notices.length === 9,
    gap: null,
  }
}

function hashElectronDist(directory) {
  if (!directory || !existsSync(directory)) return null
  const files = walk(directory).map(file => ({
    path: path.relative(directory, file).split(path.sep).join('/'),
    sha256: sha256File(file),
    bytes: statSync(file).size,
  }))
  const license = files.find(file => file.path === 'LICENSE')
  const chromium = files.find(file => file.path === 'LICENSES.chromium.html')
  const binary = files.find(file => file.path === 'electron' || file.path === 'electron.exe' || file.path === 'Electron.app/Contents/MacOS/Electron')
  const versionFile = files.find(file => file.path === 'version')
  const version = versionFile ? readFileSync(path.join(directory, 'version'), 'utf8').trim() : null
  const chromiumFfmpeg = files.find(file => file.path === 'libffmpeg.so' || file.path.endsWith('/libffmpeg.so') || file.path.endsWith('/Libraries/libffmpeg.dylib') || file.path === 'ffmpeg.dll') ?? null
  return {
    directory,
    version,
    files,
    binary,
    notices: [license, chromium].filter(Boolean),
    chromiumFfmpeg,
    chromiumFfmpegNote: 'Electron Chromium FFmpeg is a runtime distribution component, separate from the vendored GPL command-line ffmpeg under frontend/design-desktop/vendor/ffmpeg.',
    traceable: Boolean(binary && license && chromium && version),
    distribution: 'electron_runtime_zip_unpacked',
    signedFutureoxPackage: false,
  }
}

function align(value, alignment) {
  return value + (alignment - (value % alignment)) % alignment
}

export function asarFromFiles(files) {
  const header = { files: {} }
  let cursor = 0
  for (const file of files) {
    const parts = file.path.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { offset: String(cursor), size: file.bytes.length }
    cursor += file.bytes.length
  }
  const json = Buffer.from(JSON.stringify(header))
  const payload = align(4 + json.length, 4)
  const headerPickle = Buffer.alloc(4 + payload)
  headerPickle.writeUInt32LE(payload, 0)
  headerPickle.writeInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...files.map(file => file.bytes)])
}

export function readAsarEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  const headerPickleSize = buffer.readUInt32LE(4)
  if (headerPickleSize < 8 || 8 + headerPickleSize > buffer.length) return null
  const headerPickle = buffer.subarray(8, 8 + headerPickleSize)
  const jsonLength = headerPickle.readInt32LE(4)
  if (jsonLength < 2 || 8 + jsonLength > headerPickle.length) return null
  let header
  try {
    header = JSON.parse(headerPickle.subarray(8, 8 + jsonLength).toString('utf8'))
  } catch {
    return null
  }
  const dataStart = 8 + headerPickleSize
  const entries = []
  function visit(node, prefix) {
    for (const [name, info] of Object.entries(node?.files ?? {})) {
      const relative = prefix ? `${prefix}/${name}` : name
      if (info.files) visit(info, relative)
      else if (info.unpacked) entries.push({ path: relative, unpacked: true, sha256: null })
      else {
        const start = dataStart + Number(info.offset)
        const bytes = buffer.subarray(start, start + info.size)
        entries.push({ path: relative, unpacked: false, sha256: sha256(bytes), bytes: info.size })
      }
    }
  }
  visit(header, '')
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

function classifyRelease(root, releaseDir, knownHashes) {
  if (!releaseDir || !existsSync(releaseDir)) {
    return { present: false, files: [], unmapped: [], note: 'no release bundle to map' }
  }
  const files = []
  for (const file of walk(releaseDir)) {
    const relative = path.relative(releaseDir, file).split(path.sep).join('/')
    const bytes = readFileSync(file)
    const digest = sha256(bytes)
    const record = { path: relative, sha256: digest, bytes: bytes.length, matchesPackageInput: knownHashes.get(digest) ?? null }
    if (relative.endsWith('app.asar') || path.basename(relative) === 'app.asar') {
      const entries = readAsarEntries(bytes)
      record.asarEntries = entries?.map(entry => ({ ...entry, matchesPackageInput: knownHashes.get(entry.sha256) ?? null })) ?? null
    }
    files.push(record)
  }
  const unmapped = []
  for (const file of files) {
    if (file.asarEntries) {
      for (const entry of file.asarEntries) if (!entry.unpacked && !entry.matchesPackageInput) unmapped.push(`${file.path}:${entry.path}`)
      continue
    }
    if (!file.matchesPackageInput) unmapped.push(file.path)
  }
  return {
    present: files.length > 0,
    files,
    unmapped,
    note: files.length ? 'release_directory_hashed' : 'release_directory_empty',
  }
}

export function buildComponentInventory({
  root = repo,
  releaseDir = path.join(desktop, 'release'),
  electronDist = process.env.FUTUREOX_ELECTRON_DIST || null,
  skipCargo = false,
} = {}) {
  const licenseInventory = JSON.parse(readFileSync(path.join(root, 'frontend/design-client/public/licenses/inventory.json'), 'utf8'))
  const notices = licenseInventory.packages.map(item => {
    const file = path.join(root, 'frontend/design-client/public/licenses', item.file)
    const present = existsSync(file)
    const digest = present ? sha256File(file) : null
    return { package: item.package, version: item.version, license: item.license, file: item.file, sha256: digest, matchesInventory: present && digest === item.sha256 }
  })
  const mcpFiles = walk(path.join(root, 'frontend/design-mcp/src'))
    .filter(file => file.endsWith('.mjs'))
    .map(file => ({ path: path.relative(root, file).split(path.sep).join('/'), sha256: sha256File(file) }))
  const javascript = buildJavaScript(root)
  const rust = skipCargo ? { status: 'not_run', errors: [], crates: [], notDistributed: [], lockfilePackages: parseCargoLock(readFileSync(path.join(root, 'design-studio/Cargo.lock'), 'utf8')).length } : buildRust(root)
  const assets = buildFontsAndPublic(root)
  const ffmpeg = buildFfmpeg(root)
  const electronVersion = JSON.parse(readFileSync(path.join(root, 'frontend/design-desktop/package.json'), 'utf8')).devDependencies.electron
  const electronDistReport = hashElectronDist(electronDist)
  const projectLicense = noticeRecord(root, 'LICENSE')
  const hostRoot = path.join(root, 'frontend/design-desktop/src')
  const shipHost = packageSourceFilter(hostRoot)
  const hostFiles = walk(hostRoot).filter(shipHost).map(file => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: sha256File(file),
    license: 'MIT',
    notices: [projectLicense],
    distribution: 'asar_source_input',
    traceable: true,
    thirdParty: false,
  }))
  const knownHashes = new Map()
  function remember(component) {
    if (component?.sha256) knownHashes.set(component.sha256, component.path ?? component.package ?? component.id ?? null)
    for (const notice of component?.notices ?? []) knownHashes.set(notice.sha256, notice.path)
  }
  for (const component of [...assets.fonts, ...assets.icons, ...hostFiles, ...mcpFiles, ...assets.unresolvedPackageInputs]) remember(component)
  remember(ffmpeg)
  for (const source of ffmpeg.correspondingSource ?? []) knownHashes.set(source.sha256, source.path)
  const release = classifyRelease(root, releaseDir, knownHashes)
  const described = release.present ? describePackage(releaseDir) : null
  const nativeBinaries = NATIVE_BINARIES.map(binary => {
    const candidates = [
      path.join(root, 'frontend/design-desktop/dist', binary.path),
      releaseDir ? path.join(releaseDir, 'resources', binary.path) : null,
    ].filter(Boolean)
    const present = candidates.find(candidate => existsSync(candidate))
    return {
      ...binary,
      sha256: present ? sha256File(present) : null,
      status: present ? 'hashed_build_output' : 'not_built',
      traceable: false,
    }
  })
  const traceableThirdPartyComponents = [
    ...rust.crates.filter(crate => crate.thirdParty && crate.traceable),
    ...javascript.distributed.filter(item => item.traceable),
    ...assets.fonts.filter(item => item.traceable),
    ...(ffmpeg.traceable ? [ffmpeg] : []),
  ].length
  const gaps = [
    ...rust.crates.filter(crate => crate.thirdParty && !crate.traceable).map(crate => ({ kind: 'rust', id: crate.id, gap: crate.gap, platforms: crate.platforms })),
    ...javascript.distributed.filter(item => !item.traceable).map(item => ({ kind: 'javascript', id: item.package, gap: item.gap })),
    ...assets.fonts.filter(item => !item.traceable).map(item => ({ kind: 'font', id: item.path, gap: item.gap })),
    ...assets.unresolvedPackageInputs.map(item => ({ kind: 'package_input', id: item.path, gap: item.gap })),
    ...nativeBinaries.map(item => ({ kind: 'native_binary', id: item.path, gap: item.status })),
    { kind: 'signed_release', id: 'formal-installer', gap: 'not_supplied' },
    electronDistReport?.traceable ? null : { kind: 'electron', id: electronVersion, gap: electronDist ? 'electron_dist_untraceable' : 'chromium_binary_not_in_checkout' },
  ].filter(Boolean)
  return {
    schema: 2,
    issue: 88,
    classification: 'release_prep',
    confirmedRuntimeFault: false,
    scope: release.present ? 'release_directory_hashed_not_a_signed_installer' : 'packaging_inputs_not_a_signed_release',
    releaseAcceptance: 'not_closed',
    formalSignedPackage: 'not_supplied',
    macElectronMetal: 'not_run',
    releaseDirectory: release.present ? path.relative(root, releaseDir) : null,
    notDistribution: {
      cargoLockNameEntries: rust.lockfilePackages,
      note: 'Cargo.lock name entries are build inputs. They are not the files inside a release package.',
      notDistributedLockPackages: rust.notDistributed?.length ?? null,
    },
    electron: {
      version: electronVersion,
      chromiumBinaryHashed: Boolean(electronDistReport?.binary),
      declaredIn: 'devDependencies',
      npmPackageDistributed: false,
      note: electronDistReport
        ? 'Unpacked Electron distribution hashed. This is not a signed Futureox installer.'
        : 'package.json names the Electron version. This checkout did not hash a packaged Chromium binary.',
      distribution: electronDistReport,
    },
    notices,
    designMcpSourceCount: mcpFiles.length,
    designMcpSources: mcpFiles,
    packageResources: described
      ? {
          status: described.resources.status,
          evidenceKind: described.evidence.kind,
          formalRelease: false,
          signature: 'not_run',
          profile: described.evidence.profile,
          packageSha256: described.identity.sha256,
          installRoot: described.resources.installRoot,
          counts: described.resources.counts,
          entries: described.resources.entries,
          declaredVersusBytes: described.resources.declaredVersusBytes.status,
        }
      : { status: 'not_run', reason: 'no release bundle to map', formalRelease: false, entries: [] },
    designMcpLicense: projectLicense,
    ffmpeg,
    javascript,
    rust,
    fonts: assets.fonts,
    icons: assets.icons,
    hostSourceInputs: hostFiles.length,
    unresolvedPackageInputs: assets.unresolvedPackageInputs,
    fidelityFilesExcluded: assets.fidelityFilesExcluded,
    nativeBinaries,
    releaseFiles: release,
    unmappedReleaseFiles: release.present ? release.unmapped : 'no release bundle to map',
    measurement: {
      environment: `${process.platform}/${process.arch}`,
      traceableThirdPartyComponents,
      distributedRustCrates: rust.crates.filter(crate => crate.thirdParty).length,
      distributedRustCratesWithNoticeText: rust.crates.filter(crate => crate.thirdParty && crate.traceable).length,
      lockfilePackages: rust.lockfilePackages,
      javascriptDistributed: javascript.distributed.length,
      javascriptDistributedWithNotice: javascript.distributed.filter(item => item.traceable).length,
      javascriptDevelopmentOnly: javascript.developmentOnly.length,
      fontsTraceable: assets.fonts.filter(item => item.traceable).length,
      iconsTraceable: assets.icons.filter(item => item.traceable).length,
      electronDistributionFiles: electronDistReport?.files.length ?? 0,
      nativeBinariesHashed: nativeBinaries.filter(item => item.sha256).length,
      gaps: gaps.length,
    },
    gaps,
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  if (process.argv.includes('--write-notices')) {
    const result = materializeCargoNotices(repo)
    console.log(JSON.stringify({ wrote: result.written.length, errors: result.errors }, null, 2))
    if (result.errors.length) process.exit(1)
  }
  const releaseArg = process.argv.find(arg => arg.startsWith('--release-dir='))?.slice('--release-dir='.length)
  const electronArg = process.argv.find(arg => arg.startsWith('--electron-dist='))?.slice('--electron-dist='.length)
  const report = buildComponentInventory({
    releaseDir: releaseArg ?? path.join(desktop, 'release'),
    electronDist: electronArg ?? process.env.FUTUREOX_ELECTRON_DIST ?? null,
  })
  const broken = report.notices.filter(item => !item.matchesInventory)
  console.log(JSON.stringify({
    scope: report.scope,
    releaseAcceptance: report.releaseAcceptance,
    formalSignedPackage: report.formalSignedPackage,
    macElectronMetal: report.macElectronMetal,
    measurement: report.measurement,
    notDistribution: report.notDistribution,
    electron: { version: report.electron.version, chromiumBinaryHashed: report.electron.chromiumBinaryHashed, note: report.electron.note },
    ffmpeg: { version: report.ffmpeg.version, sha256: report.ffmpeg.sha256, license: report.ffmpeg.license, traceable: report.ffmpeg.traceable },
    javascriptDistributed: report.javascript.distributed.map(item => ({ package: item.package, version: item.version, license: item.license, traceable: item.traceable })),
    javascriptDevelopmentOnly: report.javascript.developmentOnly,
    rustGaps: report.rust.crates.filter(crate => crate.thirdParty && !crate.traceable).map(crate => crate.id),
    notices: report.notices.map(item => ({ package: item.package, version: item.version, license: item.license, matchesInventory: item.matchesInventory })),
    gaps: report.gaps.length,
  }, null, 2))
  process.exit(broken.length ? 1 : 0)
}
