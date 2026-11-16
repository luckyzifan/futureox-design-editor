// Component and notice inventory read from an Electron packager directory.
// Membership is the files inside that directory. Lockfiles and cargo metadata
// only attach version, source, and license to a file or to a binary that is
// actually in the package. A missing signature stays not_run.
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { ELECTRON_ATTRIBUTION_FILES, MAC_ELECTRON_NOTICES, hashPackageIdentity, hashReadonlyFile } from './release-package-resources.mjs'
import { FFMPEG_PACKAGE_NOTICES, requiresBundledFfmpeg } from './ffmpeg-bundle.mjs'
import { verifyWasmIdentity } from './wasm-identity.mjs'

const HOST_TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-gnu' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-gnu' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' },
  'win32-x64': { platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { platform: 'win32', arch: 'arm64', target: 'aarch64-pc-windows-msvc' },
}
const EXPECTED_TRIPLES = ['linux-x64', 'darwin-arm64', 'win32-x64']
const KERNEL_WASM = /^design_kernel_bg(?:-[A-Za-z0-9_-]+)?\.wasm$/
const QUICKJS_WASM = /^emscripten-module(?:-[A-Za-z0-9_-]+)?\.wasm$/
const NATIVE_CRATES = {
  'futureox-design-desktop-backend': 'futureox-design-desktop-backend',
  'design-render': 'futureox-design-gpu',
  'design-prepare': 'futureox-design-kernel',
  'futureox-design-agent': 'futureox-design-agent',
}
const SKIP_WALK = new Set(['node_modules', 'target', '.git'])

function isFile(file) {
  try {
    const info = lstatSync(file)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function isDirectory(file) {
  try {
    const info = lstatSync(file)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

export function electronPackageLayout(directory) {
  if (!isDirectory(directory)) return null
  const macResources = path.join(directory, 'Contents/Resources')
  if (isFile(path.join(macResources, 'app.asar')) && (isFile(path.join(directory, 'Contents/Info.plist')) || isFile(path.join(directory, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')))) {
    return { packageDir: directory, resourcesRoot: macResources, resourcesPrefix: 'Contents/Resources', style: 'mac-app' }
  }
  // Keep support for older packager outputs with notices next to the .app.
  const apps = childDirectories(directory).filter(entry => entry.endsWith('.app'))
  if (apps.length === 1 && isFile(path.join(apps[0], 'Contents/Resources/app.asar')) &&
      isFile(path.join(apps[0], 'Contents/Info.plist'))) {
    const resourcesPrefix = path.posix.join(path.basename(apps[0]), 'Contents/Resources')
    return { packageDir: directory, resourcesRoot: path.join(apps[0], 'Contents/Resources'), resourcesPrefix, style: 'mac-app' }
  }
  const resources = path.join(directory, 'resources')
  if (isFile(path.join(resources, 'app.asar')) && (isFile(path.join(directory, 'version')) || isFile(path.join(directory, 'LICENSES.chromium.html')))) {
    return { packageDir: directory, resourcesRoot: resources, resourcesPrefix: 'resources', style: 'electron-directory' }
  }
  return null
}

function childDirectories(directory) {
  const found = []
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (SKIP_WALK.has(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue
    found.push(path.join(directory, entry.name))
  }
  return found
}

export function locateElectronPackage(releaseDir) {
  if (!releaseDir || !existsSync(releaseDir)) return null
  let info
  try {
    info = lstatSync(releaseDir)
  } catch {
    return null
  }
  if (info.isSymbolicLink()) return { rejected: 'symlink' }
  if (!info.isDirectory()) return null
  const found = []
  const visit = (directory, depth) => {
    const layout = electronPackageLayout(directory)
    if (layout) {
      found.push(layout)
      return
    }
    if (depth === 0) return
    for (const child of childDirectories(directory)) visit(child, depth - 1)
  }
  visit(releaseDir, 3)
  if (!found.length) return null
  found.sort((left, right) => left.packageDir.length - right.packageDir.length)
  const hostKey = `${process.platform}-${process.arch}`
  return found.find(layout => path.basename(layout.packageDir).includes(hostKey)) ?? found[0]
}

function hostIdentity(packageDir) {
  const base = path.basename(packageDir)
  for (const [triple, identity] of Object.entries(HOST_TARGETS)) {
    if (base.endsWith(triple)) return { triple, ...identity }
  }
  return { triple: null, platform: null, arch: null, target: null }
}

function readPrefix(file, length, offset = 0) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function executableFormat(prefix) {
  if (prefix.length >= 4 && prefix.subarray(0, 4).toString('hex') === '7f454c46') return 'elf'
  if (prefix.length >= 2 && prefix.subarray(0, 2).toString() === 'MZ') return 'pe'
  if (prefix.length >= 4) {
    const magic = prefix.readUInt32LE(0)
    if (magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca) return 'macho'
  }
  if (prefix.length >= 4 && prefix.subarray(0, 4).toString() === '\0asm') return 'wasm'
  return 'unknown'
}

function electronRole(relative) {
  const base = path.posix.basename(relative)
  if (base === 'version') return 'version'
  if (base === 'LICENSE' || base === 'LICENSES.chromium.html') return 'notice'
  if (base === 'libffmpeg.so' || base === 'ffmpeg.dll' || base === 'libffmpeg.dylib') return 'chromium-ffmpeg'
  if (base === 'futureox-desgin' || base === 'futureox-desgin.exe' || relative.endsWith('/MacOS/futureox-desgin')) return 'binary'
  if (/^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/[^/]+\/Electron Framework$/.test(relative)) return 'framework-binary'
  if (relative.includes('/locales/')) return 'locale'
  if (base === 'Info.plist') return 'bundle-metadata'
  return 'runtime'
}

function electronFrameworkVersion(file) {
  const text = file?.text()
  if (!text || !/<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*com\.github\.Electron\.framework\s*<\/string>/.test(text)) return null
  return /<key>\s*CFBundleVersion\s*<\/key>\s*<string>\s*(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*<\/string>/.exec(text)?.[1] ?? null
}

function frameworkTarget(binary) {
  if (!binary) return null
  const header = binary.prefix(12)
  // The packaged macOS runtime targets a single architecture. A universal,
  // unreadable or unknown binary has no per-target attribution here.
  if (header.length < 12) return null
  const type = header.readUInt32LE(0) === 0xfeedfacf ? header.readUInt32LE(4)
    : header.readUInt32BE(0) === 0xfeedfacf ? header.readUInt32BE(4) : null
  const triple = type === 0x0100000c ? 'darwin-arm64' : type === 0x01000007 ? 'darwin-x64' : null
  return triple ? { triple, ...HOST_TARGETS[triple] } : null
}

function executableTarget(binary) {
  if (!binary) return null
  const header = binary.prefix(64)
  let triple
  if (header.length >= 20 && executableFormat(header) === 'elf' && header[4] === 2 && header[5] === 1) {
    const machine = header.readUInt16LE(18)
    triple = machine === 62 ? 'linux-x64' : machine === 183 ? 'linux-arm64' : null
  } else if (header.length >= 64 && executableFormat(header) === 'pe') {
    const offset = header.readUInt32LE(60)
    if (offset < 64 || offset > binary.bytes - 26) return null
    const pe = binary.prefix(26, offset)
    if (pe.length !== 26 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(24) !== 0x20b) return null
    const machine = pe.readUInt16LE(4)
    triple = machine === 0x8664 ? 'win32-x64' : machine === 0xaa64 ? 'win32-arm64' : null
  }
  return triple ? { triple, ...HOST_TARGETS[triple] } : null
}

function classifyResource(inner) {
  const base = path.posix.basename(inner)
  if (inner === `${MAC_ELECTRON_NOTICES}/${base}` && ELECTRON_ATTRIBUTION_FILES.includes(base)) {
    return { kind: 'electron', role: electronRole(inner) }
  }
  if (inner.endsWith('.asar')) return { kind: 'archive', role: inner === 'app.asar' ? 'app-asar' : 'asar' }
  if (inner.startsWith('app.asar.unpacked/')) return classifyApp(inner.slice('app.asar.unpacked/'.length))
  if (inner.startsWith('app/')) return classifyApp(inner.slice('app/'.length))
  if (inner.startsWith('third-party-notices/') || inner.startsWith('project-license/')) return { kind: 'notice', role: 'license' }
  if (inner.startsWith('fonts/')) return fontKind(inner)
  if (inner.startsWith('bin/')) {
    if (base === 'ffmpeg' || base === 'ffmpeg.exe' || base.startsWith('ffmpeg-')) return { kind: 'vendor', role: base === 'ffmpeg' || base === 'ffmpeg.exe' ? 'binary' : 'notice' }
    if (/^(design-render|design-prepare|futureox-design-agent)(\.exe)?$/.test(base)) return { kind: 'native', role: 'binary' }
    return { kind: 'unclassified', role: 'bin' }
  }
  if (inner.startsWith('sidecar/')) return { kind: 'native', role: 'binary' }
  if (inner.startsWith('design-mcp/')) return { kind: 'javascript', role: base.endsWith('.mjs') ? 'mcp' : 'mcp-doc' }
  return { kind: 'unclassified', role: 'resource' }
}

function fontKind(relative) {
  if (/\.(ttf|otf|woff2?)$/i.test(relative)) return { kind: 'font', role: 'font' }
  if (/(ofl|license|licence|copying|copyright)/i.test(path.posix.basename(relative))) return { kind: 'font-notice', role: 'license' }
  return { kind: 'font-notice', role: 'font-metadata' }
}

function classifyApp(relative) {
  const base = path.posix.basename(relative)
  const lower = relative.toLowerCase()
  if (base === 'resource-list.json' || base === 'package.json' || base === 'manifest.webmanifest' || base === 'inventory.json' || base === 'README.txt') {
    return { kind: 'package-metadata', role: base }
  }
  if (lower.includes('color-fixtures/')) {
    if (base === 'PROVENANCE.json') return { kind: 'notice', role: 'color-fixture-provenance' }
    if (base.endsWith('.png')) return { kind: 'color-fixture', role: 'image' }
    return { kind: 'unlicensed', role: 'color-fixture' }
  }
  if (lower.includes('/fidelity/') || lower.startsWith('fidelity/') || base === 'figma-blur-verify.html') return { kind: 'excluded', role: 'excluded-asset' }
  if (/-verify\.html$/i.test(base)) return { kind: 'unlicensed', role: 'verification-page' }
  if (lower.endsWith('.wasm')) return { kind: 'wasm', role: 'wasm' }
  if (lower.includes('/fonts/') || lower.startsWith('fonts/')) return fontKind(relative)
  if (lower.includes('branding/') || lower.includes('/icons/')) return { kind: 'icon', role: 'icon' }
  if (lower.includes('/licenses/') || lower.startsWith('licenses/') || /(^|\/)(license|licence|copying|notice)(\.|$)/i.test(lower)) {
    return { kind: 'notice', role: 'license' }
  }
  if (/\.(js|mjs|cjs|css|map)$/i.test(base)) return { kind: 'javascript', role: base.endsWith('.map') ? 'sourcemap' : base.endsWith('.css') ? 'stylesheet' : 'bundle' }
  if (base.endsWith('.html')) return { kind: 'javascript', role: 'document' }
  if (/\.(ttf|otf|woff2?)$/i.test(base)) return fontKind(relative)
  if (/^ofl([-_.]|$)/i.test(base) || /(^|[-_.])ofl\.(txt|md)$/i.test(base)) return { kind: 'font-notice', role: 'license' }
  return { kind: 'app', role: 'app-file' }
}

function classifyDisk(relative, resourcesPrefix) {
  if (relative === resourcesPrefix || relative.startsWith(`${resourcesPrefix}/`)) {
    const inner = relative === resourcesPrefix ? '' : relative.slice(resourcesPrefix.length + 1)
    if (!inner) return { kind: 'unclassified', role: 'resource-root' }
    return classifyResource(inner)
  }
  const appPrefix = resourcesPrefix.endsWith('/Contents/Resources')
    ? resourcesPrefix.slice(0, -'Contents/Resources'.length) : ''
  const resourcePath = appPrefix && relative.startsWith(appPrefix) ? relative.slice(appPrefix.length) : relative
  return { kind: 'electron', role: electronRole(resourcePath) }
}

function macFrameworkLink(packageDir, relative) {
  const framework = /^(?:[^/]+\.app\/)?Contents\/Frameworks\/[^/]+\.framework/.exec(relative)?.[0]
  if (!framework || !relative.startsWith(framework + '/')) return null
  try {
    const file = path.join(packageDir, relative)
    const target = readlinkSync(file)
    if (path.isAbsolute(target) || target.split('/').includes('..')) return null
    const resolved = path.relative(realpathSync(packageDir), realpathSync(file)).split(path.sep).join('/')
    if (!resolved.startsWith(framework + '/')) return null
    return { path: relative, target, resolved }
  } catch {
    return null
  }
}

function walkPackage(packageDir, resourcesPrefix, brandIcon) {
  const files = []
  const frameworkLinks = []
  const rejected = []
  const visit = directory => {
    let entries = []
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      rejected.push({ path: path.relative(packageDir, directory).split(path.sep).join('/'), reason: error.message })
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(packageDir, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) {
        // Inventory the alias and its in-bundle destination separately.
        // The directory walk still never opens a file through a symlink.
        const link = macFrameworkLink(packageDir, relative)
        if (link) frameworkLinks.push(link)
        else rejected.push({ path: relative, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile()) {
        rejected.push({ path: relative, reason: 'not_a_regular_file' })
        continue
      }
      try {
        const hashed = hashReadonlyFile(full)
        const classified = relative === `${resourcesPrefix}/electron.icns` && hashed.sha256 === brandIcon
          ? { kind: 'icon', role: 'icon' }
          : classifyDisk(relative, resourcesPrefix)
        files.push({
          path: relative,
          full,
          sha256: hashed.sha256,
          bytes: hashed.size,
          kind: classified.kind,
          role: classified.role,
          origin: 'file',
          text: () => hashed.size > 2_000_000 ? null : readFileSync(full, 'utf8'),
          prefix: (length = 4, offset = 0) => readPrefix(full, length, offset),
        })
      } catch (error) {
        rejected.push({ path: relative, reason: error.message })
      }
    }
  }
  visit(packageDir)
  files.sort((left, right) => left.path.localeCompare(right.path))
  frameworkLinks.sort((left, right) => left.path.localeCompare(right.path))
  return { files, rejected, frameworkLinks }
}

function packagedFfmpegName(repoRelative) {
  return FFMPEG_PACKAGE_NOTICES.find(([from]) => from === repoRelative)?.[1] ?? null
}

function fontLicense(relative) {
  const value = relative.toLowerCase()
  if (value.includes('/poppins/')) return 'OFL-1.1'
  if (value.includes('/inter/')) return 'OFL-1.1'
  if (value.includes('/dejavu/')) return 'Bitstream Vera'
  if (value.includes('/abeezee/')) return 'OFL-1.1'
  if (value.includes('notosanssc')) return 'OFL-1.1'
  return null
}

function recordedFontHash(text, base) {
  if (!text) return { sha256: null, source: null, license: null }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { sha256: null, source: null, license: null }
  }
  if (Array.isArray(json)) {
    const item = json.find(entry => entry?.name === base || entry?.file === base)
    return { sha256: item?.sha256 ?? null, source: item?.url ?? null, license: null }
  }
  if (json && typeof json === 'object' && typeof json.sha256 === 'string') {
    return { sha256: json.sha256, source: json.source ?? null, license: json.license ?? null }
  }
  return { sha256: null, source: null, license: null }
}

function sameDirectory(left, right) {
  return path.posix.dirname(left) === path.posix.dirname(right)
}

function nearestFontNotices(file, content) {
  let dir = path.posix.dirname(file.path)
  for (let depth = 0; depth < 4 && dir && dir !== '.'; depth += 1) {
    const found = content.filter(item => item.kind === 'font-notice' && path.posix.dirname(item.path) === dir && /(ofl|license|licence|copying|copyright)/i.test(path.posix.basename(item.path)))
    if (found.length) return found.map(noticeRecord)
    dir = path.posix.dirname(dir)
  }
  return []
}

function noticeRecord(file) {
  return { packagePath: file.path, sha256: file.sha256, bytes: file.bytes }
}

function indexByHash(files) {
  const map = new Map()
  for (const file of files) {
    const list = map.get(file.sha256) ?? []
    list.push(file)
    map.set(file.sha256, list)
  }
  return map
}

function rustNotices(crate, files) {
  const marker = `/cargo/${crate.name}/${crate.version}/`
  const project = crate.name.startsWith('futureox-design-') || crate.name === 'splash-glyph'
  const matched = []
  for (const expected of crate.notices ?? []) {
    let packaged
    if (project) {
      packaged = files.find(file => file.path.endsWith('/project-license/LICENSE'))
    } else if (expected.path.includes(marker)) {
      // Match a recorded text by its full crate-relative path. Provenance
      // files share this directory and are independently inventoried.
      const suffix = expected.path.slice(expected.path.indexOf(marker))
      packaged = files.find(file => file.kind === 'notice' && file.path.endsWith(suffix))
    } else {
      const named = file => file.sha256 === expected.sha256 && file.path.toLowerCase().includes(crate.name.toLowerCase())
      const base = path.posix.basename(expected.path)
      packaged = files.find(file => (file.kind === 'notice' || file.kind === 'font-notice') && named(file) && path.posix.basename(file.path) === base)
        ?? files.find(file => file.kind === 'notice' && named(file))
    }
    if (packaged) matched.push({ packaged, expected })
  }
  return matched
}

function artifactsFor(crate, hostTarget, binaries, wasmFiles) {
  const out = []
  if (hostTarget && crate.platforms.includes(hostTarget)) out.push(...binaries)
  if (crate.platforms.includes('wasm32-unknown-unknown')) out.push(...wasmFiles)
  return out.map(file => ({ packagePath: file.path, sha256: file.sha256, bytes: file.bytes, role: file.role }))
}

function inventoryWasm(files, packages, kernel, projectLicense) {
  const quickJsSources = packages.flatMap(item => item.wasm &&
    /^@jitl\/quickjs-wasmfile-(debug|release)-(sync|asyncify)$/.test(item.package)
    ? [{ name: path.posix.join(item.package, 'dist/emscripten-module.wasm'), sha256: item.wasm.sha256, item }]
    : [])
  return files.map(file => {
    const basename = path.posix.basename(file.path)
    let name = null, version = null, source = null, license = null, notices = []
    let gap = 'wasm_source_unidentified'
    if (KERNEL_WASM.test(basename)) {
      name = 'futureox-design-kernel'
      version = kernel?.version ?? null
      source = kernel?.source ?? 'wasm32-unknown-unknown'
      license = projectLicense ? 'MIT' : null
      notices = projectLicense ? [noticeRecord(projectLicense)] : []
      gap = projectLicense ? null : 'project_license_not_in_package'
    } else if (QUICKJS_WASM.test(basename)) {
      let matched
      try { matched = verifyWasmIdentity(basename, file.sha256, quickJsSources) }
      catch { /* Unknown WASM stays in the byte census with an attribution gap. */ }
      const input = quickJsSources.find(entry => entry.name === matched)
      if (input) {
        const item = input.item
        name = item.package
        version = item.version
        source = item.source.replace(/ package\/LICENSE$/, ' package/dist/emscripten-module.wasm')
        license = item.license
        notices = item.notices
        gap = item.gap
      }
    }
    return {
      kind: 'wasm', id: file.path, name, version, source, license, notices,
      packagePath: file.path, sha256: file.sha256, bytes: file.bytes,
      distribution: 'in_release_package', traceable: gap === null, gap,
    }
  })
}

function readJson(file) {
  if (!file) return null
  const text = file.text?.()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function assessColorFixtures(files, { provenanceSha256 = null } = {}) {
  const images = files.filter(file => file.path.includes('color-fixtures/') && file.path.toLowerCase().endsWith('.png'))
  const provenanceFile = files.find(file => file.path.includes('color-fixtures/') && path.posix.basename(file.path) === 'PROVENANCE.json') ?? null
  const byHash = new Map()
  for (const file of files) {
    if (!file.sha256) continue
    const list = byHash.get(file.sha256) ?? []
    list.push(file)
    byHash.set(file.sha256, list)
  }
  const blank = (image, gap) => ({
    id: image?.path ?? 'color-fixtures',
    packagePath: image?.path ?? null,
    name: image ? path.posix.basename(image.path) : null,
    sha256: image?.sha256 ?? null,
    bytes: image?.bytes ?? null,
    license: null,
    source: null,
    notices: [],
    distribution: 'in_release_package',
    traceable: false,
    gap,
  })
  if (!provenanceFile) return images.map(image => blank(image, 'no_provenance_record'))
  if (provenanceSha256 && provenanceFile.sha256 !== provenanceSha256) {
    return images.map(image => blank(image, 'provenance_differs_from_repo'))
  }
  const record = readJson(provenanceFile)
  if (!record || !Array.isArray(record.files) || !record.notices || typeof record.notices !== 'object') {
    return images.map(image => blank(image, 'provenance_unreadable'))
  }
  const results = []
  const seen = new Set()
  for (const image of images) {
    const name = path.posix.basename(image.path)
    seen.add(name)
    const entry = record.files.find(item => item?.name === name)
    if (!entry) {
      results.push(blank(image, 'no_provenance_record'))
      continue
    }
    if (entry.sha256 !== image.sha256) {
      results.push({ ...blank(image, 'provenance_hash_mismatch'), license: entry.license ?? null, source: record.generator ?? null })
      continue
    }
    const noticeIds = Array.isArray(entry.notices) ? entry.notices : []
    const notices = []
    let missing = false
    for (const id of noticeIds) {
      const spec = record.notices[id]
      const hits = spec?.sha256
        ? (byHash.get(spec.sha256) ?? []).filter(file => file !== image && file !== provenanceFile)
        : []
      if (!spec || !hits.length) {
        missing = true
        continue
      }
      notices.push({
        id,
        license: spec.license ?? null,
        repoPath: spec.repoPath ?? null,
        packagePath: hits[0].path,
        sha256: hits[0].sha256,
        bytes: hits[0].bytes ?? null,
      })
    }
    results.push({
      id: image.path,
      packagePath: image.path,
      name,
      sha256: image.sha256,
      bytes: image.bytes ?? null,
      license: entry.license ?? null,
      source: record.generator ?? null,
      icc: entry.icc ?? null,
      notices,
      provenance: { packagePath: provenanceFile.path, sha256: provenanceFile.sha256 },
      distribution: 'in_release_package',
      traceable: noticeIds.length > 0 && !missing && notices.length === noticeIds.length,
      gap: noticeIds.length > 0 && !missing ? null : 'license_text_missing',
    })
  }
  for (const entry of record.files) {
    if (!entry?.name || seen.has(entry.name)) continue
    results.push(blank({ path: `color-fixtures/${entry.name}`, sha256: null, bytes: null }, 'fixture_missing'))
  }
  return results
}

function inventoryVendor(files, required) {
  const binary = files.find(file => file.kind === 'vendor' && file.role === 'binary') ?? null
  const sourceJson = files.find(file => file.kind === 'vendor' && file.path.endsWith('/ffmpeg-source.json')) ?? null
  const meta = readJson(sourceJson)
  const related = files.filter(file => file.kind === 'vendor' && file !== binary)
  if (!binary && !related.length) return {
    present: false, traceable: false, gap: required ? 'ffmpeg_not_in_package' : null,
    binary: null, notices: [], correspondingSource: [],
  }
  const problems = []
  if (!binary) problems.push('binary_missing')
  else if (meta?.sha256 && binary.sha256 !== meta.sha256) problems.push('binary_hash')
  const correspondingSource = []
  for (const source of meta?.sources ?? []) {
    const packaged = packagedFfmpegName(source.file)
    const file = related.find(item => path.posix.basename(item.path) === packaged)
    const matchesRecord = Boolean(file && file.sha256 === source.sha256)
    if (!matchesRecord) problems.push(`source:${source.file}`)
    correspondingSource.push({
      name: source.name,
      version: source.version,
      packagePath: file?.path ?? null,
      sha256: file?.sha256 ?? null,
      recordedSha256: source.sha256,
      matchesRecord,
      source: source.obtainedFrom ?? null,
    })
  }
  const notices = []
  for (const notice of meta?.notices ?? []) {
    const packaged = packagedFfmpegName(notice.file)
    const file = related.find(item => path.posix.basename(item.path) === packaged)
    const matchesRecord = Boolean(file && file.sha256 === notice.sha256)
    if (!matchesRecord) problems.push(`notice:${notice.file}`)
    if (file) notices.push({ ...noticeRecord(file), recordedSha256: notice.sha256, matchesRecord })
  }
  if (meta?.buildRecordSha256) {
    const file = related.find(item => item.path.endsWith('/ffmpeg-BUILD.txt'))
    if (!file || file.sha256 !== meta.buildRecordSha256) problems.push('BUILD.txt')
    if (file) notices.push(noticeRecord(file))
  }
  if (meta?.rebuildScriptSha256) {
    const file = related.find(item => item.path.endsWith('/ffmpeg-rebuild.sh'))
    if (!file || file.sha256 !== meta.rebuildScriptSha256) problems.push('rebuild.sh')
    if (file) notices.push(noticeRecord(file))
  }
  for (const name of ['ffmpeg-LICENSE.txt', 'ffmpeg-COPYING.GPLv3']) {
    const file = related.find(item => item.path.endsWith(`/${name}`))
    if (!file) problems.push(name)
    else if (!notices.some(item => item.packagePath === file.path)) notices.push(noticeRecord(file))
  }
  if (sourceJson && !notices.some(item => item.packagePath === sourceJson.path)) notices.push(noticeRecord(sourceJson))
  return {
    present: Boolean(binary),
    path: binary?.path ?? null,
    version: meta?.version ?? null,
    license: meta?.license ?? null,
    source: sourceJson?.path ?? null,
    binary: binary ? { packagePath: binary.path, sha256: binary.sha256, bytes: binary.bytes, format: executableFormat(binary.prefix()) } : null,
    notices,
    correspondingSource,
    distribution: 'in_release_package',
    traceable: Boolean(binary && meta?.version && meta?.license && problems.length === 0),
    gap: problems.length ? 'ffmpeg_notice_or_source_mismatch' : (binary ? null : 'ffmpeg_not_in_package'),
    problems,
  }
}

function mitLicenseText(text) {
  if (!text) return false
  if (text.includes('MIT License')) return true
  return text.includes('Permission is hereby granted, free of charge') && text.includes('THE SOFTWARE IS PROVIDED "AS IS"')
}

function inventoryElectron(files, declaredVersion, style) {
  const electronFiles = files.filter(file => file.kind === 'electron')
  const versionFile = electronFiles.find(file => file.role === 'version')
  const framework = style === 'mac-app' ? electronFiles.find(file => file.role === 'framework-binary') : undefined
  const plistPath = framework && path.posix.join(path.posix.dirname(framework.path), 'Resources/Info.plist')
  const plist = plistPath && electronFiles.find(file => file.path === plistPath)
  const packagedVersion = versionFile?.text()?.trim()
  const version = packagedVersion || electronFrameworkVersion(plist)
  const binary = framework ?? electronFiles.find(file => file.role === 'binary') ?? null
  const notices = electronFiles.filter(file => file.role === 'notice').map(file => ({
    ...noticeRecord(file),
    role: path.posix.basename(file.path) === 'LICENSES.chromium.html' ? 'chromium' : 'electron',
  }))
  const licenseText = electronFiles.find(file => path.posix.basename(file.path) === 'LICENSE')?.text() ?? ''
  const chromium = electronFiles.find(file => file.role === 'chromium-ffmpeg') ?? null
  const traceable = Boolean(binary && version && notices.some(item => item.role === 'electron') && notices.some(item => item.role === 'chromium'))
  return {
    version,
    versionSource: (packagedVersion ? versionFile.path : version ? plist?.path : null) ?? null,
    declaredVersion: declaredVersion ?? null,
    versionMatchesDeclared: declaredVersion ? version === declaredVersion : null,
    source: version ? `https://github.com/electron/electron/releases/tag/v${version}` : null,
    license: mitLicenseText(licenseText) ? 'MIT' : (licenseText ? 'packaged-license-text' : null),
    binary: binary ? { packagePath: binary.path, sha256: binary.sha256, bytes: binary.bytes, format: executableFormat(binary.prefix()) } : null,
    notices,
    chromiumFfmpeg: chromium ? { packagePath: chromium.path, sha256: chromium.sha256, bytes: chromium.bytes } : null,
    files: electronFiles.map(file => ({ packagePath: file.path, sha256: file.sha256, bytes: file.bytes, role: file.role })),
    distribution: 'in_release_package',
    signedFutureoxPackage: false,
    traceable,
    gap: traceable ? null : 'electron_runtime_incomplete',
  }
}

export function inventoryFromPackageBytes({
  root,
  layout,
  openAsar,
  rust,
  javascript,
  declaredElectronVersion = null,
}) {
  let host = hostIdentity(layout.packageDir)
  const iconPath = path.join(root, 'frontend/design-desktop/assets/branding/futureox-desgin.icns')
  const brandIcon = isFile(iconPath) ? hashReadonlyFile(iconPath).sha256 : null
  const walked = walkPackage(layout.packageDir, layout.resourcesPrefix, brandIcon)
  const content = [...walked.files]
  const runtime = content.find(file => file.kind === 'electron' &&
    file.role === (layout.style === 'mac-app' ? 'framework-binary' : 'binary'))
  const binaryHost = layout.style === 'mac-app' ? frameworkTarget(runtime) : executableTarget(runtime)
  const targetMismatch = host.triple && binaryHost && host.triple !== binaryHost.triple
  host = binaryHost ?? host
  const archives = walked.files.filter(file => file.kind === 'archive')
  let openedAppAsar = false
  for (const asarFile of archives) {
    const opened = openAsar(readFileSync(asarFile.full))
    if (!opened) {
      walked.rejected.push({ path: asarFile.path, reason: 'asar_unreadable' })
      continue
    }
    if (asarFile.role === 'app-asar') openedAppAsar = true
    const asarPrefix = `${asarFile.path}/`
    const unpackedRoot = path.join(path.dirname(asarFile.full), `${path.basename(asarFile.full)}.unpacked`)
    for (const entry of opened.entries) {
      const unpackedFull = entry.unpacked ? path.join(unpackedRoot, entry.path) : null
      let sha = entry.sha256
      let bytes = entry.bytes
      let origin = 'asar'
      let text = () => {
        const value = opened.read(entry.path)
        if (!value || value.length > 2_000_000) return null
        return value.toString('utf8')
      }
      let prefix = () => opened.read(entry.path)?.subarray(0, 4) ?? Buffer.alloc(0)
      if (entry.unpacked && unpackedFull && isFile(unpackedFull)) {
        const hashed = hashReadonlyFile(unpackedFull)
        sha = hashed.sha256
        bytes = hashed.size
        origin = 'unpacked'
        text = () => hashed.size > 2_000_000 ? null : readFileSync(unpackedFull, 'utf8')
        prefix = () => readPrefix(unpackedFull, 4)
      }
      const classified = classifyApp(entry.path)
      content.push({
        path: `${asarPrefix}${entry.path}`,
        sha256: sha,
        bytes,
        kind: classified.kind,
        role: classified.role,
        origin,
        text,
        prefix,
      })
    }
  }
  const projectLicense = content.find(file => file.path.endsWith('project-license/LICENSE')) ?? null
  const resourceList = content.find(file => file.role === 'resource-list.json')
  const declaredList = readJson(resourceList)
  const electron = inventoryElectron(content.filter(file => file.origin === 'file'), declaredElectronVersion, layout.style)
  const wasmFiles = content.filter(file => file.kind === 'wasm')
  const kernelWasmFiles = wasmFiles.filter(file => KERNEL_WASM.test(path.posix.basename(file.path)))
  const nativeFiles = content.filter(file => file.kind === 'native' && file.role === 'binary')
  const native = nativeFiles.map(file => {
    const base = path.posix.basename(file.path).replace(/\.exe$/, '')
    const crateName = NATIVE_CRATES[base] ?? (base.startsWith('futureox-design-desktop-backend') ? 'futureox-design-desktop-backend' : null)
    const crate = rust.crates.find(item => item.name === crateName)
    return {
      id: crate?.id ?? crateName,
      name: crateName,
      version: crate?.version ?? null,
      source: crate?.source ?? null,
      license: projectLicense ? 'MIT' : null,
      packagePath: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      format: executableFormat(file.prefix()),
      notices: projectLicense ? [noticeRecord(projectLicense)] : [],
      distribution: 'in_release_package',
      traceable: Boolean(projectLicense && crate),
      gap: projectLicense ? (crate ? null : 'native_crate_not_in_graph') : 'project_license_not_in_package',
    }
  })
  const presentNative = new Set(native.map(item => item.name))
  const selectedPlatforms = new Set([host.target, kernelWasmFiles.length ? 'wasm32-unknown-unknown' : null].filter(Boolean))
  const rustDistributed = []
  const rustBuildOnly = []
  for (const crate of rust.crates) {
    if (![...selectedPlatforms].some(platform => crate.platforms.includes(platform))) continue
    const matches = rustNotices(crate, content)
    const notices = matches.map(({ packaged }) => noticeRecord(packaged))
    const differs = matches.some(({ packaged, expected }) => packaged.sha256 !== expected.sha256)
    const missingRepo = notices.length < (crate.notices?.length ?? 0)
    let gap = null
    if (!crate.license) gap = 'missing_license_expression'
    else if (!notices.length) gap = 'license_text_not_in_package'
    else if (differs) gap = 'notice_differs_from_repo'
    else if (missingRepo) gap = 'license_text_not_in_package'
    const record = {
      id: crate.id,
      name: crate.name,
      version: crate.version,
      license: crate.license,
      source: crate.source,
      registryChecksum: crate.checksum,
      platforms: crate.platforms.filter(platform => selectedPlatforms.has(platform)),
      procMacro: crate.procMacro,
      notices,
      artifacts: artifactsFor(crate, host.target, nativeFiles, kernelWasmFiles),
      distribution: crate.procMacro ? 'proc_macro_build_input' : 'linked_into_packaged_binary',
      thirdParty: crate.thirdParty,
      traceable: Boolean(crate.license && notices.length && !differs && !missingRepo),
      gap,
    }
    if (crate.procMacro) rustBuildOnly.push(record)
    else rustDistributed.push(record)
  }
  const inPackageIds = new Set([...rustDistributed, ...rustBuildOnly].map(item => item.id))
  const lockIds = new Set([...rust.crates.map(item => item.id), ...(rust.notDistributed ?? [])])
  const notInThisPackage = [...lockIds].filter(id => !inPackageIds.has(id)).sort()
  const bundles = content.filter(file => file.kind === 'javascript' && (file.role === 'bundle' || file.role === 'stylesheet' || file.role === 'sourcemap' || file.role === 'mcp' || file.role === 'document'))
  const licenseInventory = JSON.parse(readFileSync(path.join(root, 'frontend/design-client/public/licenses/inventory.json'), 'utf8'))
  const productionIds = new Set(javascript.distributed.map(item => item.package))
  const javascriptPackages = javascript.distributed.map(item => {
    const recorded = licenseInventory.packages.find(entry => entry.package === item.package)
    const named = recorded
      ? content.filter(file => file.kind === 'notice' && (file.path.endsWith(`/${recorded.file}`) || file.path.endsWith(recorded.file)))
      : []
    const notice = named.find(file => file.sha256 === recorded?.sha256) ?? named[0] ?? null
    const matches = Boolean(notice && recorded && notice.sha256 === recorded.sha256)
    const wasm = recorded?.wasm
    const verifiedWasm = typeof item.integrity === 'string' && recorded?.version === item.version &&
      wasm?.integrity === item.integrity && /^[a-f0-9]{64}$/.test(wasm.sha256) ? wasm : undefined
    return {
      package: item.package,
      version: item.version,
      license: recorded?.license ?? item.license,
      source: recorded?.source ?? item.source,
      integrity: item.integrity,
      // The WASM hash comes from the tarball verified against the lock entry.
      wasm: verifiedWasm,
      notices: notice ? [noticeRecord(notice)] : [],
      bundleArtifacts: bundles.filter(file => file.role === 'bundle').map(file => ({ packagePath: file.path, sha256: file.sha256, bytes: file.bytes })),
      distribution: 'bundled_in_release_package',
      traceable: matches,
      gap: matches ? null : (notice ? 'notice_differs_from_record' : 'notice_text_not_in_package'),
    }
  })
  const wasm = inventoryWasm(wasmFiles, javascriptPackages,
    rust.crates.find(item => item.name === 'futureox-design-kernel'), projectLicense)
  const referenceNotices = (licenseInventory.referenceImplementations ?? []).map(item => {
    const file = content.find(entry => entry.kind === 'notice' && entry.path.endsWith(`/${item.file}`) && entry.sha256 === item.sha256)
    return {
      id: item.project,
      version: item.commit,
      license: item.license,
      source: item.source,
      notices: file ? [noticeRecord(file)] : [],
      distribution: file ? 'notice_in_release_package' : 'not_in_package',
      traceable: Boolean(file),
      gap: file ? null : 'reference_notice_not_in_package',
    }
  })
  const developmentOnly = [...javascript.developmentOnly]
  const leaked = []
  for (const name of developmentOnly) {
    const needle = `node_modules/${name}/`
    const hits = content.filter(file => file.path.includes(needle))
    if (hits.length) leaked.push({ package: name, paths: hits.map(file => file.path) })
  }
  const fonts = content.filter(file => file.kind === 'font').map(file => {
    const base = path.posix.basename(file.path)
    const sourceFile = content.find(item => item.kind === 'font-notice' && (path.posix.basename(item.path) === 'source.json' || path.posix.basename(item.path) === 'sources.json') && sameDirectory(item.path, file.path))
    const recorded = recordedFontHash(sourceFile?.text?.() ?? null, base)
    const notices = nearestFontNotices(file, content)
    const license = recorded.license ?? fontLicense(file.path)
    const hashAgrees = recorded.sha256 ? recorded.sha256 === file.sha256 : true
    return {
      id: file.path,
      packagePath: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      version: null,
      source: recorded.source ?? sourceFile?.path ?? null,
      recordedSha256: recorded.sha256,
      license,
      notices,
      distribution: 'in_release_package',
      traceable: Boolean(license && notices.length && hashAgrees),
      gap: !license ? 'font_license_unmapped' : (!notices.length ? 'font_notice_not_in_package' : (hashAgrees ? null : 'source_hash_mismatch')),
    }
  })
  const icons = content.filter(file => file.kind === 'icon').map(file => ({
    id: file.path,
    packagePath: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    version: null,
    source: 'docs/BRANDING.md',
    license: projectLicense ? 'MIT' : null,
    notices: projectLicense ? [noticeRecord(projectLicense)] : [],
    distribution: 'in_release_package',
    thirdParty: false,
    traceable: Boolean(projectLicense),
    gap: projectLicense ? null : 'project_license_not_in_package',
  }))
  const vendor = inventoryVendor(content, requiresBundledFfmpeg(host.platform, host.arch))
  const provenanceRecord = path.join(root, 'frontend/design-client/public/color-fixtures/PROVENANCE.json')
  const colorFixtures = assessColorFixtures(content, {
    provenanceSha256: isFile(provenanceRecord) ? hashReadonlyFile(provenanceRecord).sha256 : null,
  })
  const unclassified = content.filter(file => file.kind === 'unclassified' || file.kind === 'unlicensed' || file.kind === 'excluded')
  const byKind = {}
  for (const file of content) byKind[file.kind] = (byKind[file.kind] ?? 0) + 1
  const identity = hashPackageIdentity(layout.packageDir)
  const signatureFile = content.some(file => file.path.endsWith('/CodeResources') || file.path.endsWith('.sig') || file.path.includes('/_CodeSignature/'))
  const gaps = []
  const addGap = (kind, id, reason) => { if (reason) gaps.push({ kind, id, gap: reason }) }
  if (targetMismatch) addGap('package', runtime.path, 'package_name_target_differs_from_runtime')
  if (!host.triple) addGap('package', runtime?.path ?? layout.packageDir, 'package_target_unidentified')
  addGap('electron', electron.version, electron.gap)
  if (electron.versionMatchesDeclared === false) addGap('electron', electron.version, 'version_file_differs_from_declared')
  for (const item of javascriptPackages) addGap('javascript', item.package, item.gap)
  for (const item of [...rustDistributed, ...rustBuildOnly]) if (item.thirdParty) addGap('rust', item.id, item.gap)
  for (const item of native) addGap('native', item.packagePath, item.gap)
  for (const [binaryName, crateName] of Object.entries(NATIVE_CRATES)) {
    if (!presentNative.has(crateName)) addGap('native', binaryName, 'binary_not_in_package')
  }
  for (const item of fonts) addGap('font', item.packagePath, item.gap)
  for (const item of icons) addGap('icon', item.packagePath, item.gap)
  for (const item of colorFixtures) addGap('color-fixture', item.packagePath ?? item.id, item.gap)
  if (!vendor.traceable) addGap('vendor', 'ffmpeg', vendor.gap)
  for (const file of unclassified) addGap(file.kind, file.path, file.kind === 'unclassified' ? 'unclassified_package_file' : file.role)
  for (const item of leaked) addGap('development', item.package, 'development_dependency_in_package')
  for (const item of walked.rejected) addGap('package', item.path, item.reason)
  if (archives.some(file => file.role === 'app-asar') && !openedAppAsar) addGap('archive', 'app.asar', 'asar_unreadable')
  addGap('signature', layout.packageDir, signatureFile ? 'signature_file_present_not_verified' : 'not_run')
  for (const triple of EXPECTED_TRIPLES) if (triple !== host.triple) addGap('platform', triple, 'not_built')
  if (!kernelWasmFiles.length) addGap('wasm', 'futureox-design-kernel', 'wasm_not_in_package')
  for (const item of wasm) addGap('wasm', item.packagePath, item.gap)
  const components = [
    {
      kind: 'electron',
      id: `electron@${electron.version}`,
      name: 'electron',
      version: electron.version,
      source: electron.source,
      license: electron.license,
      packagePath: electron.binary?.packagePath ?? null,
      sha256: electron.binary?.sha256 ?? null,
      notices: electron.notices,
      distribution: 'in_release_package',
      traceable: electron.traceable,
      gap: electron.gap,
    },
    ...javascriptPackages.map(item => ({
      kind: 'javascript',
      id: `${item.package}@${item.version}`,
      name: item.package,
      version: item.version,
      source: item.source,
      license: item.license,
      packagePath: item.notices[0]?.packagePath ?? null,
      sha256: item.notices[0]?.sha256 ?? null,
      notices: item.notices,
      distribution: item.distribution,
      traceable: item.traceable,
      gap: item.gap,
    })),
    ...rustDistributed.filter(item => item.thirdParty).map(item => ({
      kind: 'rust',
      id: item.id,
      name: item.name,
      version: item.version,
      source: item.source,
      license: item.license,
      packagePath: item.notices[0]?.packagePath ?? item.artifacts[0]?.packagePath ?? null,
      sha256: item.notices[0]?.sha256 ?? item.artifacts[0]?.sha256 ?? null,
      notices: item.notices,
      distribution: item.distribution,
      traceable: item.traceable,
      gap: item.gap,
    })),
    ...native.map(item => ({ kind: 'native', ...item })),
    ...wasm,
    ...fonts.map(item => ({ kind: 'font', name: path.posix.basename(item.packagePath), ...item })),
    ...icons.map(item => ({ kind: 'icon', name: path.posix.basename(item.packagePath), ...item })),
    ...colorFixtures.map(item => ({ kind: 'color-fixture', ...item })),
  ]
  if (vendor.present) {
    components.push({
      kind: 'vendor',
      id: `ffmpeg@${vendor.version}`,
      name: 'ffmpeg',
      version: vendor.version,
      source: vendor.source,
      license: vendor.license,
      packagePath: vendor.path,
      sha256: vendor.binary?.sha256 ?? null,
      notices: vendor.notices,
      distribution: 'in_release_package',
      traceable: vendor.traceable,
      gap: vendor.gap,
    })
  }
  return {
    producedFrom: 'release_package_bytes',
    packageDir: layout.packageDir,
    packageIdentitySha256: identity.sha256,
    packageIdentityStatus: identity.status,
    style: layout.style,
    triple: host.triple,
    platform: host.platform,
    arch: host.arch,
    target: host.target,
    profile: declaredList?.profile ?? null,
    declaredResourceList: declaredList ? {
      formalRelease: declaredList.formalRelease === true,
      signature: declaredList.signature ?? null,
      profile: declaredList.profile ?? null,
      platform: declaredList.platform ?? null,
      arch: declaredList.arch ?? null,
    } : null,
    releaseAcceptance: 'not_closed',
    formalSignedPackage: 'not_supplied',
    signature: signatureFile ? 'present_not_verified' : 'not_run',
    macElectronMetal: 'not_run',
    signedInstaller: {
      status: 'not_built',
      reason: 'This generator reads an unsigned Electron packager directory. It does not sign, notarize, or build a dmg, pkg, msi, exe installer, deb, or rpm.',
    },
    electron,
    javascript: {
      packages: javascriptPackages,
      bundles: bundles.map(file => ({ packagePath: file.path, sha256: file.sha256, bytes: file.bytes, role: file.role })),
      developmentOnly,
      leakedDevelopmentFiles: leaked,
      electronNpmPackageDistributed: content.some(file => file.path.includes('node_modules/electron/')),
    },
    rust: {
      status: rust.status,
      distributed: rustDistributed,
      buildOnly: rustBuildOnly,
    },
    native,
    wasm: wasmFiles.map(file => ({ packagePath: file.path, sha256: file.sha256, bytes: file.bytes })),
    vendor: { ffmpeg: vendor },
    fonts,
    icons,
    colorFixtures,
    referenceNotices,
    components,
    notDistribution: {
      note: 'Cargo.lock names and npm devDependencies are build inputs. A component is distributed only when this package contains its file, or a native/WASM binary whose normal dependency graph contains it. Lockfile length is not the component list.',
      cargoLockNameEntries: rust.lockfilePackages,
      notInThisPackage,
      javascriptDevelopmentOnly: developmentOnly,
      javascriptProductionIds: [...productionIds].sort(),
    },
    census: {
      packageFiles: walked.files.length,
      contentFiles: content.length,
      byKind,
      unclassified: unclassified.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, kind: file.kind, role: file.role })),
      rejected: walked.rejected,
      frameworkLinks: walked.frameworkLinks,
      files: content.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, kind: file.kind, role: file.role, origin: file.origin })),
    },
    gaps,
    summary: {
      packageFiles: walked.files.length,
      contentFiles: content.length,
      electronVersion: electron.version,
      electronBinary: Boolean(electron.binary?.sha256),
      electronNotices: electron.notices.length,
      electronFiles: electron.files.length,
      javascriptBundles: bundles.filter(file => file.role === 'bundle').length,
      javascriptPackages: javascriptPackages.length,
      javascriptPackagesWithNotice: javascriptPackages.filter(item => item.traceable).length,
      javascriptDevelopmentOnly: developmentOnly.length,
      javascriptDevelopmentLeaked: leaked.length,
      rustDistributed: rustDistributed.filter(item => item.thirdParty).length,
      rustDistributedWithNotice: rustDistributed.filter(item => item.thirdParty && item.traceable).length,
      rustBuildOnly: rustBuildOnly.length,
      lockPackagesNotInPackage: notInThisPackage.length,
      nativeBinaries: native.filter(item => item.sha256).length,
      wasmFiles: wasmFiles.length,
      fonts: fonts.length,
      fontsTraceable: fonts.filter(item => item.traceable).length,
      icons: icons.length,
      iconsTraceable: icons.filter(item => item.traceable).length,
      colorFixtures: colorFixtures.length,
      colorFixturesTraceable: colorFixtures.filter(item => item.traceable).length,
      vendorFfmpeg: vendor.traceable ? 'traceable' : (vendor.present ? 'gap' : 'absent'),
      unclassified: unclassified.length,
      gaps: gaps.length,
    },
  }
}

export function verifyPackageByteInventory(report, openAsar) {
  if (!report || report.producedFrom !== 'release_package_bytes') return { ok: false, reason: 'inventory was not produced from package bytes', mismatches: [] }
  const asarCache = new Map()
  const mismatches = []
  const frameworkLinks = report.census?.frameworkLinks ?? []
  for (const link of frameworkLinks) {
    const actual = macFrameworkLink(report.packageDir, link.path)
    if (actual?.target !== link.target || actual.resolved !== link.resolved) {
      mismatches.push({ path: link.path, reason: 'framework_link_changed' })
    }
  }
  for (const file of report.census?.files ?? []) {
    if (!file.sha256) {
      mismatches.push({ path: file.path, reason: 'missing_hash' })
      continue
    }
    const marker = '.asar/'
    const at = file.path.indexOf(marker)
    let actual = null
    if (at !== -1) {
      const asarRelative = file.path.slice(0, at + '.asar'.length)
      const entryPath = file.path.slice(at + marker.length)
      const asarPath = path.join(report.packageDir, asarRelative)
      let opened = asarCache.get(asarPath)
      if (opened === undefined) {
        opened = isFile(asarPath) ? openAsar(readFileSync(asarPath)) : null
        asarCache.set(asarPath, opened)
      }
      actual = opened?.entries.find(entry => entry.path === entryPath)?.sha256 ?? null
      if (opened?.entries.find(entry => entry.path === entryPath)?.unpacked) {
        const unpacked = path.join(path.dirname(asarPath), 'app.asar.unpacked', entryPath)
        actual = isFile(unpacked) ? hashReadonlyFile(unpacked).sha256 : null
      }
    } else {
      const full = path.join(report.packageDir, file.path)
      actual = isFile(full) ? hashReadonlyFile(full).sha256 : null
    }
    if (actual !== file.sha256) mismatches.push({ path: file.path, expected: file.sha256, actual })
  }
  return { ok: mismatches.length === 0, checked: (report.census?.files?.length ?? 0) + frameworkLinks.length, mismatches: mismatches.slice(0, 20) }
}
