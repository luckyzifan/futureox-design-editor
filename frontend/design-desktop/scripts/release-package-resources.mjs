// Identity and resource listing for a release package. This does not install,
// launch, sign, or accept a formal desktop package. GUI steps stay not_run.
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Tree identity is path, size, and content SHA-256, each length-prefixed.
// The previous hash concatenated path text with file bytes, so "a"+"bc" and
// "ab"+"c" were the same digest. A single-file installer still uses the raw
// content SHA-256.
const TREE_DOMAIN = 'futureox-release-tree-v2\n'
const HEADER_LIMIT = 8 * 1024 * 1024
const INSTALLER_EXTENSIONS = new Set(['.dmg', '.pkg', '.mpkg', '.msi', '.exe', '.deb', '.rpm', '.appimage'])

export function expectedNativeInstallPaths(platform) {
  const suffix = platform === 'win32' ? '.exe' : ''
  return [
    `sidecar/futureox-design-desktop-backend${suffix}`,
    `bin/design-render${suffix}`,
    `bin/design-prepare${suffix}`,
    `bin/futureox-design-agent${suffix}`,
    `bin/ffmpeg${suffix}`,
  ]
}

function openFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
}

export function hashReadonlyFile(file) {
  const fd = openSync(file, openFlags())
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error(`not a regular file: ${file}`)
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < info.size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - offset), offset)
      if (read <= 0) throw new Error(`short read: ${file}`)
      hash.update(buffer.subarray(0, read))
      offset += read
    }
    return { sha256: hash.digest('hex'), size: info.size }
  } finally {
    closeSync(fd)
  }
}

function hashRange(file, start, size) {
  const fd = openSync(file, openFlags())
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = start
    let remaining = size
    while (remaining > 0) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), offset)
      if (read <= 0) throw new Error(`short asar read: ${file}`)
      hash.update(buffer.subarray(0, read))
      offset += read
      remaining -= read
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function readRange(file, start, size) {
  const fd = openSync(file, openFlags())
  try {
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, start + offset)
      if (read <= 0) throw new Error(`short asar read: ${file}`)
      offset += read
    }
    return buffer
  } finally {
    closeSync(fd)
  }
}

function posixRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function walkRegularFiles(root) {
  if (!existsSync(root)) return []
  const info = lstatSync(root)
  if (info.isSymbolicLink()) throw new Error(`refusing to follow symlink: ${root}`)
  if (!info.isDirectory()) throw new Error(`not a directory: ${root}`)
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`refusing to follow symlink: ${full}`)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) files.push(full)
      else throw new Error(`unexpected package entry: ${full}`)
    }
  }
  visit(root)
  return files
}

export function hashPackageIdentity(packagePath) {
  if (!packagePath) return { present: false, status: 'missing', sha256: null, files: 0 }
  let info
  try {
    info = lstatSync(packagePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, status: 'missing', sha256: null, files: 0 }
    throw error
  }
  if (info.isSymbolicLink()) return { present: true, status: 'rejected_symlink', sha256: null, files: 0 }
  if (info.isFile()) {
    const hashed = hashReadonlyFile(packagePath)
    return { present: true, status: 'hashed', sha256: hashed.sha256, files: 1 }
  }
  if (!info.isDirectory()) return { present: true, status: 'rejected', sha256: null, files: 0 }
  const records = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name)
      const relative = posixRelative(packagePath, full)
      if (entry.isSymbolicLink()) records.push({ kind: 'link', relative, link: readlinkSync(full) })
      else if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) records.push({ kind: 'file', relative, full })
      else records.push({ kind: 'other', relative })
    }
  }
  visit(packagePath)
  if (records.some(record => record.kind === 'other')) return { present: true, status: 'rejected', sha256: null, files: records.filter(record => record.kind === 'file').length }
  const hash = createHash('sha256')
  const field = value => {
    const bytes = Buffer.from(value)
    hash.update(String(bytes.length))
    hash.update(':')
    hash.update(bytes)
    hash.update('\0')
  }
  hash.update(TREE_DOMAIN)
  field(String(records.length))
  for (const record of records) {
    field(record.kind)
    field(record.relative)
    if (record.kind === 'file') {
      const hashed = hashReadonlyFile(record.full)
      field(String(hashed.size))
      field(hashed.sha256)
    } else field(record.link)
  }
  return { present: true, status: 'hashed', sha256: hash.digest('hex'), files: records.filter(record => record.kind === 'file').length }
}

function pickleUInt32(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(value >>> 0, 4)
  return buffer
}

function pickleString(value) {
  const bytes = Buffer.from(value)
  const aligned = bytes.length + (4 - (bytes.length % 4)) % 4
  const payload = 4 + aligned
  const buffer = Buffer.alloc(4 + payload)
  buffer.writeUInt32LE(payload, 0)
  buffer.writeInt32LE(bytes.length, 4)
  bytes.copy(buffer, 8)
  return buffer
}

export function writeAsarArchive(destination, files) {
  const root = { files: {} }
  let offset = 0
  const bodies = []
  for (const file of files) {
    const segments = file.path.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`invalid asar path: ${file.path}`)
    let node = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]
      if (!node.files[name]) node.files[name] = { files: {} }
      if (!node.files[name].files) throw new Error(`asar path collision: ${file.path}`)
      node = node.files[name]
    }
    const base = segments[segments.length - 1]
    if (node.files[base]) throw new Error(`asar path collision: ${file.path}`)
    node.files[base] = { size: file.data.length, offset: String(offset) }
    bodies.push(file.data)
    offset += file.data.length
  }
  const header = pickleString(JSON.stringify(root))
  writeFileSync(destination, Buffer.concat([pickleUInt32(header.length), header, ...bodies]))
}

export function readAsarHeader(archive) {
  const info = lstatSync(archive)
  if (!info.isFile()) throw new Error(`asar is not a regular file: ${archive}`)
  if (info.size < 8) throw new Error('asar header is truncated')
  const sizeBuffer = readRange(archive, 0, 8)
  if (sizeBuffer.readUInt32LE(0) !== 4) throw new Error('asar size pickle is not a uint32')
  const headerSize = sizeBuffer.readUInt32LE(4)
  if (headerSize < 8 || headerSize > HEADER_LIMIT || 8 + headerSize > info.size) throw new Error('asar header size is out of range')
  const headerBuffer = readRange(archive, 8, headerSize)
  const payloadSize = headerBuffer.readUInt32LE(0)
  if (payloadSize + 4 !== headerSize) throw new Error('asar header pickle size mismatch')
  const jsonLength = headerBuffer.readInt32LE(4)
  if (jsonLength < 2 || 8 + jsonLength > headerBuffer.length) throw new Error('asar header string is out of range')
  const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString('utf8'))
  if (!header || typeof header !== 'object' || !header.files) throw new Error('asar header has no file map')
  return { header, headerSize, dataOffset: 8 + headerSize, archiveSize: info.size }
}

function lookupAsar(header, relative) {
  let node = header
  for (const segment of relative.split('/')) {
    if (!node?.files?.[segment]) return null
    node = node.files[segment]
  }
  return node
}

function asarFiles(node, prefix, out) {
  if (typeof node.link === 'string') {
    out.push({ path: prefix, link: node.link })
    return
  }
  if (node.files) {
    for (const name of Object.keys(node.files).sort()) asarFiles(node.files[name], prefix ? `${prefix}/${name}` : name, out)
    return
  }
  if (typeof node.size !== 'number' || !Number.isSafeInteger(node.size) || node.size < 0) throw new Error(`asar size is invalid: ${prefix}`)
  out.push({ path: prefix, size: node.size, offset: node.offset, unpacked: node.unpacked === true })
}

function resourceKind(relative) {
  const extension = path.posix.extname(relative)
  if (extension === '.wasm') return 'wasm'
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'js'
  return null
}

function entryFromFile(kind, installPath, file) {
  const hashed = hashReadonlyFile(file)
  return { kind, installPath, sha256: hashed.sha256, size: hashed.size, present: true }
}

function listAppDirectory(root, prefix) {
  const entries = []
  if (!existsSync(root)) return entries
  for (const file of walkRegularFiles(root)) {
    const relative = posixRelative(root, file)
    if (relative === 'resource-list.json') continue
    const kind = resourceKind(relative)
    if (!kind) continue
    entries.push(entryFromFile(kind, prefix ? `${prefix}/${relative}` : relative, file))
  }
  return entries
}

function listAsarResources(archive) {
  const { header, dataOffset, archiveSize } = readAsarHeader(archive)
  const files = []
  asarFiles(header, '', files)
  const entries = []
  for (const file of files) {
    if (file.path === 'resource-list.json') continue
    const kind = resourceKind(file.path)
    if (!kind) continue
    if (file.link) throw new Error(`refusing to follow asar link: ${file.path}`)
    if (file.unpacked) {
      const unpacked = path.join(`${archive}.unpacked`, file.path)
      const info = lstatSync(unpacked)
      if (!info.isFile()) throw new Error(`unpacked asar resource is not a regular file: ${file.path}`)
      entries.push(entryFromFile(kind, `app.asar/${file.path}`, unpacked))
      continue
    }
    const offset = Number(file.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`asar offset is invalid: ${file.path}`)
    const start = dataOffset + offset
    if (start + file.size > archiveSize) throw new Error(`asar file range is outside the archive: ${file.path}`)
    entries.push({ kind, installPath: `app.asar/${file.path}`, sha256: hashRange(archive, start, file.size), size: file.size, present: true })
  }
  return { entries, header }
}

function readJsonFile(file) {
  try {
    if (!lstatSync(file).isFile()) return null
  } catch {
    return null
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function readDeclaredList(archive, resourcesRoot) {
  if (archive) {
    try {
      const { header, dataOffset, archiveSize } = readAsarHeader(archive)
      const node = lookupAsar(header, 'resource-list.json')
      if (node && !node.link && node.unpacked !== true && typeof node.size === 'number') {
        const offset = Number(node.offset)
        const start = dataOffset + offset
        if (Number.isSafeInteger(offset) && offset >= 0 && start + node.size <= archiveSize) {
          return JSON.parse(readRange(archive, start, node.size).toString('utf8'))
        }
      }
    } catch {
      return { invalid: true }
    }
  }
  return readJsonFile(path.join(resourcesRoot, 'app/resource-list.json'))
    || readJsonFile(path.join(resourcesRoot, 'resource-list.json'))
}

function readProfile(resourcesRoot, declared) {
  if (declared && !declared.invalid) {
    return {
      profile: typeof declared.profile === 'string' ? declared.profile : null,
      packagePlatform: typeof declared.platform === 'string' ? declared.platform : null,
      packageArch: typeof declared.arch === 'string' ? declared.arch : null,
      declared,
    }
  }
  const manifest = readJsonFile(path.join(resourcesRoot, 'build-manifest.json'))
    || readJsonFile(path.join(resourcesRoot, 'app/build-manifest.json'))
  if (!manifest) return { profile: null, packagePlatform: null, packageArch: null, declared: declared?.invalid ? declared : null }
  return {
    profile: typeof manifest.profile === 'string' ? manifest.profile : null,
    packagePlatform: typeof manifest.platform === 'string' ? manifest.platform : null,
    packageArch: typeof manifest.arch === 'string' ? manifest.arch : null,
    declared: declared?.invalid ? declared : null,
  }
}

function nativeEntries(resourcesRoot, platform) {
  const found = new Map()
  const candidates = new Set([
    ...expectedNativeInstallPaths('linux'),
    ...expectedNativeInstallPaths('darwin'),
    ...expectedNativeInstallPaths('win32'),
  ])
  for (const installPath of candidates) {
    const file = path.join(resourcesRoot, installPath)
    try {
      if (lstatSync(file).isFile()) found.set(installPath, entryFromFile('native', installPath, file))
    } catch {
      // Absent candidate. Expected holes are added only for a recorded platform.
    }
  }
  if (platform) {
    for (const installPath of expectedNativeInstallPaths(platform)) {
      if (!found.has(installPath)) found.set(installPath, { kind: 'native', installPath, sha256: null, size: null, present: false })
    }
  }
  return [...found.values()]
}

function mcpEntries(resourcesRoot) {
  const root = path.join(resourcesRoot, 'design-mcp')
  try {
    if (!lstatSync(root).isDirectory()) return []
  } catch {
    return []
  }
  return listAppDirectory(root, 'design-mcp').map(entry => ({ ...entry, kind: 'js' }))
}

function countsOf(entries) {
  const present = entries.filter(entry => entry.present)
  return {
    js: present.filter(entry => entry.kind === 'js').length,
    wasm: present.filter(entry => entry.kind === 'wasm').length,
    native: present.filter(entry => entry.kind === 'native').length,
  }
}

export function logicalResourcePath(installPath) {
  if (installPath.startsWith('app.asar/')) return installPath.slice('app.asar/'.length)
  if (installPath.startsWith('app/')) return installPath.slice('app/'.length)
  return installPath
}

function layoutOf(packagePath) {
  const info = lstatSync(packagePath)
  if (info.isSymbolicLink()) return { kind: 'symlink' }
  if (info.isFile()) {
    const extension = path.extname(packagePath).toLowerCase()
    return { kind: INSTALLER_EXTENSIONS.has(extension) ? 'installer' : 'opaque_file', extension }
  }
  if (!info.isDirectory()) return { kind: 'rejected' }
  const ownContents = path.join(packagePath, 'Contents/Resources')
  if (existsSync(ownContents) && lstatSync(ownContents).isDirectory()) return { kind: 'bundle', resourcesRoot: ownContents, installRoot: 'Contents/Resources' }
  let appName = null
  try {
    appName = readdirSync(packagePath).find(name => name.endsWith('.app') && lstatSync(path.join(packagePath, name)).isDirectory())
  } catch {
    appName = null
  }
  if (appName) {
    const resources = path.join(packagePath, appName, 'Contents/Resources')
    if (existsSync(resources) && lstatSync(resources).isDirectory()) return { kind: 'bundle', resourcesRoot: resources, installRoot: `${appName}/Contents/Resources` }
  }
  const resources = path.join(packagePath, 'resources')
  if (existsSync(resources) && lstatSync(resources).isDirectory()) {
    const markers = ['app.asar', 'app', 'sidecar', 'bin']
    if (markers.some(name => existsSync(path.join(resources, name)))) return { kind: 'bundle', resourcesRoot: resources, installRoot: 'resources' }
  }
  if (['renderer', 'sidecar', 'bin'].some(name => {
    const candidate = path.join(packagePath, name)
    return existsSync(candidate) && lstatSync(candidate).isDirectory()
  })) return { kind: 'development_runtime', resourcesRoot: packagePath, installRoot: '.' }
  return { kind: 'unrecognized' }
}

function evidenceFor(layoutKind, profile) {
  const signature = 'not_run'
  const formalRelease = false
  if (layoutKind === 'development_runtime') {
    return { kind: 'development_runtime', formalRelease, signature, note: 'Development runtime tree, not an installed formal package. GUI steps stay not_run.' }
  }
  if (profile === 'desktop-dev' || profile === 'debug') {
    return { kind: 'unsigned_development_bundle', formalRelease, signature, note: 'desktop-dev or debug profile bundle. It is not a signed formal release, and GUI steps stay not_run.' }
  }
  if (profile === 'release') {
    return { kind: 'unsigned_release_profile_bundle', formalRelease, signature, note: 'Release-profile bundle without a signature check. Signature stays not_run. This is not formal release acceptance.' }
  }
  return { kind: 'unsigned_bundle', formalRelease, signature, note: 'Bundle layout without a signed-release record. Signature stays not_run. This is not formal release acceptance.' }
}

function emptyComparison(status, reason) {
  return { status, reason, byteMatches: [], byteMismatches: [], runtimeMissing: [], packageMissing: [] }
}

export function compareResourceEntries(packaged, runtime) {
  const runtimeByPath = new Map(runtime.filter(entry => entry.present && entry.sha256).map(entry => [logicalResourcePath(entry.installPath), entry]))
  const seen = new Set()
  const byteMatches = []
  const byteMismatches = []
  const runtimeMissing = []
  for (const entry of packaged) {
    if (!entry.present || !entry.sha256) continue
    const key = logicalResourcePath(entry.installPath)
    seen.add(key)
    const other = runtimeByPath.get(key)
    if (!other) runtimeMissing.push(key)
    else if (other.sha256 !== entry.sha256) byteMismatches.push({ path: key, packageSha256: entry.sha256, runtimeSha256: other.sha256 })
    else byteMatches.push(key)
  }
  const packageMissing = [...runtimeByPath.keys()].filter(key => !seen.has(key)).sort()
  runtimeMissing.sort()
  let status = 'byte_match'
  if (byteMismatches.length) status = 'byte_mismatch'
  else if (runtimeMissing.length || packageMissing.length) status = 'incomplete'
  else if (!byteMatches.length) status = 'empty'
  return { status, byteMatches, byteMismatches, runtimeMissing, packageMissing }
}

function diffDeclared(declared, actual) {
  if (!declared) return { status: 'not_run', reason: 'package has no resource-list.json', mismatches: [] }
  if (declared.invalid) return { status: 'mismatch', reason: 'resource-list.json could not be read', mismatches: [] }
  const actualByPath = new Map(actual.map(entry => [entry.installPath, entry]))
  const declaredByPath = new Map((declared.entries || []).map(entry => [entry.installPath, entry]))
  const mismatches = []
  for (const [installPath, entry] of declaredByPath) {
    const found = actualByPath.get(installPath)
    if (!found || found.present !== entry.present || found.sha256 !== entry.sha256 || found.kind !== entry.kind) {
      mismatches.push({ installPath, declaredSha256: entry.sha256 ?? null, actualSha256: found?.sha256 ?? null })
    }
  }
  for (const installPath of actualByPath.keys()) {
    if (!declaredByPath.has(installPath)) mismatches.push({ installPath, declaredSha256: null, actualSha256: actualByPath.get(installPath).sha256 })
  }
  return mismatches.length
    ? { status: 'mismatch', mismatches }
    : { status: 'match', mismatches: [] }
}

function listResources(layout, meta) {
  const archive = path.join(layout.resourcesRoot, 'app.asar')
  let entries = []
  let archiveInfo = null
  try {
    archiveInfo = lstatSync(archive)
  } catch {
    archiveInfo = null
  }
  if (archiveInfo?.isSymbolicLink()) throw new Error('refusing to follow app.asar symlink')
  if (archiveInfo?.isFile()) entries = listAsarResources(archive).entries
  else if (layout.kind === 'development_runtime') {
    for (const directory of ['src', 'renderer']) {
      const root = path.join(layout.resourcesRoot, directory)
      if (existsSync(root) && lstatSync(root).isDirectory()) entries.push(...listAppDirectory(root, directory))
    }
  } else {
    const app = path.join(layout.resourcesRoot, 'app')
    if (existsSync(app) && lstatSync(app).isDirectory()) entries.push(...listAppDirectory(app, 'app'))
  }
  entries.push(...nativeEntries(layout.resourcesRoot, meta.packagePlatform))
  entries.push(...mcpEntries(layout.resourcesRoot))
  entries.sort((left, right) => left.installPath.localeCompare(right.installPath))
  return entries
}

export function describePackage(packagePath, { runtimeRoot, platform = process.platform, arch = process.arch } = {}) {
  const identity = hashPackageIdentity(packagePath)
  const base = {
    identity,
    evidence: { kind: 'missing_environment', formalRelease: false, signature: 'not_run', profile: null, packagePlatform: null, packageArch: null, note: 'No frozen release package was supplied. Desktop steps stay not_run.' },
    resources: {
      status: 'not_run',
      reason: 'no frozen release package was supplied',
      installRoot: null,
      entries: [],
      counts: { js: 0, wasm: 0, native: 0 },
      declaredVersusBytes: { status: 'not_run', reason: 'no frozen release package was supplied', mismatches: [] },
      comparison: emptyComparison('not_run', 'no runtime tree supplied'),
    },
  }
  if (!identity.present) return base
  if (identity.status === 'rejected_symlink') {
    return {
      ...base,
      evidence: { ...base.evidence, kind: 'rejected_symlink', note: 'The package path is a symlink and was not followed.' },
      resources: { ...base.resources, status: 'rejected', reason: 'package path is a symlink' },
    }
  }
  if (identity.status === 'rejected') {
    return {
      ...base,
      evidence: { ...base.evidence, kind: 'rejected', note: 'Package identity could not be hashed.' },
      resources: { ...base.resources, status: 'rejected', reason: 'package identity could not be hashed' },
    }
  }
  const layout = layoutOf(packagePath)
  if (layout.kind === 'installer' || layout.kind === 'opaque_file') {
    const installer = layout.kind === 'installer'
    return {
      identity,
      evidence: {
        kind: installer ? 'unopened_installer' : 'opaque_file',
        formalRelease: false,
        signature: 'not_run',
        profile: null,
        packagePlatform: null,
        packageArch: null,
        note: installer
          ? 'Installer bytes were hashed and not opened. This is not a completed install or a formal acceptance.'
          : 'The file was hashed and not opened. It is not a recorded install layout.',
      },
      resources: {
        ...base.resources,
        status: 'not_inspected',
        reason: installer ? 'installer was not mounted or executed' : 'opaque file was not opened',
        comparison: emptyComparison('not_run', 'package contents were not inspected'),
        declaredVersusBytes: { status: 'not_run', reason: 'package contents were not inspected', mismatches: [] },
      },
    }
  }
  if (layout.kind === 'unrecognized') {
    return {
      identity,
      evidence: { ...base.evidence, kind: 'unrecognized_directory', note: 'Directory is not an Electron install layout or development runtime. Resources were not inferred.' },
      resources: { ...base.resources, status: 'not_inspected', reason: 'directory is not an install layout', comparison: emptyComparison('not_run', 'package contents were not inspected') },
    }
  }
  try {
    const archive = path.join(layout.resourcesRoot, 'app.asar')
    const hasArchive = existsSync(archive) && lstatSync(archive).isFile()
    const declared = readDeclaredList(hasArchive ? archive : null, layout.resourcesRoot)
    const meta = readProfile(layout.resourcesRoot, declared)
    const evidence = { ...evidenceFor(layout.kind, meta.profile), profile: meta.profile, packagePlatform: meta.packagePlatform, packageArch: meta.packageArch }
    if (meta.packagePlatform && meta.packagePlatform !== platform) evidence.note += ` Host ${platform}/${arch} is not the recorded package platform ${meta.packagePlatform}/${meta.packageArch ?? 'unknown'}; the app was not launched.`
    const entries = listResources(layout, meta)
    const declaredVersusBytes = diffDeclared(meta.declared, entries)
    let comparison = emptyComparison('not_run', 'no runtime tree supplied')
    if (runtimeRoot) {
      let runtimeInfo
      try {
        runtimeInfo = lstatSync(runtimeRoot)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        runtimeInfo = null
      }
      if (!runtimeInfo || runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) {
        comparison = emptyComparison('rejected', 'runtime tree is missing or is not a real directory')
      } else {
        const runtimeLayout = layoutOf(runtimeRoot)
        if (!runtimeLayout.resourcesRoot) comparison = emptyComparison('rejected', 'runtime tree is not an install layout or development runtime')
        else {
          const runtimeMeta = readProfile(runtimeLayout.resourcesRoot, null)
          const runtimeEntries = listResources(runtimeLayout, { packagePlatform: runtimeMeta.packagePlatform || platform })
          comparison = compareResourceEntries(entries, runtimeEntries)
        }
      }
    }
    return {
      identity,
      evidence,
      resources: {
        status: 'listed',
        reason: null,
        installRoot: layout.installRoot,
        entries,
        counts: countsOf(entries),
        declaredVersusBytes,
        comparison,
      },
    }
  } catch (error) {
    return {
      identity,
      evidence: { ...base.evidence, kind: 'rejected', note: 'Package resources could not be listed.' },
      resources: { ...base.resources, status: 'rejected', reason: error.message, comparison: emptyComparison('not_run', 'package contents were not inspected') },
    }
  }
}

export function recordReadonlyOriginals(paths = []) {
  if (!paths.length) return { status: 'not_run', appSession: 'not_run', files: [] }
  const files = paths.map(file => {
    let info
    try {
      info = lstatSync(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: file, missing: true, unchanged: false, sha256Before: null, sha256After: null, sizeBefore: null, sizeAfter: null }
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) return { path: file, rejected: info.isSymbolicLink() ? 'symlink' : 'not_a_file', unchanged: false, sha256Before: null, sha256After: null, sizeBefore: null, sizeAfter: null }
    const before = hashReadonlyFile(file)
    const after = hashReadonlyFile(file)
    return {
      path: file,
      sha256Before: before.sha256,
      sha256After: after.sha256,
      sizeBefore: before.size,
      sizeAfter: after.size,
      unchanged: before.sha256 === after.sha256 && before.size === after.size,
    }
  })
  const rejected = files.some(file => file.unchanged === false)
  return { status: rejected ? 'rejected' : 'script_readonly', appSession: 'not_run', files }
}

export function writeUnsignedResourceList({ staging, desktop, platform = process.platform, arch = process.arch }) {
  const manifestPath = path.join(desktop, 'dist/build-manifest.json')
  let profile = null
  if (existsSync(manifestPath) && lstatSync(manifestPath).isFile()) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.platform && manifest.platform !== platform) throw new Error(`build manifest platform ${manifest.platform} does not match package host ${platform}`)
    if (manifest.arch && manifest.arch !== arch) throw new Error(`build manifest arch ${manifest.arch} does not match package host ${arch}`)
    profile = typeof manifest.profile === 'string' ? manifest.profile : null
  }
  const entries = []
  for (const file of walkRegularFiles(staging)) {
    const relative = posixRelative(staging, file)
    if (relative === 'resource-list.json') continue
    const kind = resourceKind(relative)
    if (!kind) continue
    const hashed = hashReadonlyFile(file)
    entries.push({ kind, installPath: `app.asar/${relative}`, sha256: hashed.sha256, size: hashed.size, present: true })
  }
  for (const installPath of expectedNativeInstallPaths(platform)) {
    const source = path.join(desktop, 'dist', installPath)
    try {
      if (!lstatSync(source).isFile()) {
        entries.push({ kind: 'native', installPath, sha256: null, size: null, present: false })
        continue
      }
    } catch {
      entries.push({ kind: 'native', installPath, sha256: null, size: null, present: false })
      continue
    }
    const hashed = hashReadonlyFile(source)
    entries.push({ kind: 'native', installPath, sha256: hashed.sha256, size: hashed.size, present: true })
  }
  const mcp = path.join(desktop, 'dist/design-mcp')
  try {
    if (lstatSync(mcp).isDirectory()) entries.push(...listAppDirectory(mcp, 'design-mcp'))
  } catch {
    // MCP staging is absent until package.mjs copies it.
  }
  entries.sort((left, right) => left.installPath.localeCompare(right.installPath))
  const list = {
    schema: 1,
    role: 'unsigned_development_bundle_inputs',
    formalRelease: false,
    signature: 'not_run',
    profile,
    platform,
    arch,
    entries,
  }
  writeFileSync(path.join(staging, 'resource-list.json'), `${JSON.stringify(list, null, 2)}\n`)
  return list
}

function actualExtractedEntries({ appRoot, resourcesRoot, platform }) {
  const entries = listAppDirectory(appRoot, 'app.asar')
  entries.push(...nativeEntries(resourcesRoot, platform))
  entries.push(...mcpEntries(resourcesRoot))
  entries.sort((left, right) => left.installPath.localeCompare(right.installPath))
  return entries
}

export function verifyDeclaredResourceList(list, { appRoot, resourcesRoot, profile, platform, arch }) {
  if (!list || list.schema !== 1) throw new Error('resource list schema is not 1')
  if (list.role !== 'unsigned_development_bundle_inputs') throw new Error('resource list role is not an unsigned development bundle')
  if (list.formalRelease !== false) throw new Error('unsigned packager cannot mark formalRelease true')
  if (list.signature !== 'not_run') throw new Error('unsigned packager cannot record a signature result')
  if (list.platform !== platform) throw new Error(`resource list platform ${list.platform} does not match ${platform}`)
  if (list.arch !== arch) throw new Error(`resource list arch ${list.arch} does not match ${arch}`)
  if ((list.profile ?? null) !== (profile ?? null)) throw new Error(`resource list profile ${list.profile} does not match build profile ${profile}`)
  if (!Array.isArray(list.entries)) throw new Error('resource list entries are missing')
  const actual = actualExtractedEntries({ appRoot, resourcesRoot, platform })
  const diff = diffDeclared(list, actual)
  if (diff.status !== 'match') {
    const sample = diff.mismatches.slice(0, 5).map(item => item.installPath).join(', ')
    throw new Error(`resource list does not match packaged bytes (${diff.mismatches.length} paths${sample ? `: ${sample}` : ''})`)
  }
  return { entries: actual.length, formalRelease: false }
}

export function releaseEvidenceFailed(described, originals) {
  if (!described) return false
  if (described.identity?.status === 'rejected' || described.identity?.status === 'rejected_symlink') return true
  if (described.resources?.status === 'rejected') return true
  if (described.resources?.declaredVersusBytes?.status === 'mismatch') return true
  if (described.resources?.comparison?.status === 'byte_mismatch' || described.resources?.comparison?.status === 'rejected') return true
  if (originals?.status === 'rejected') return true
  return false
}
