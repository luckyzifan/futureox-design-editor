// Install a Linux .deb with dpkg and find the Electron bundle it owns.
// Hashing the archive is not an install. macOS and Windows installers are not opened here.
import { openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'

const EXECUTABLE = 'futureox-desgin'

export function debListingPaths(text) {
  const entries = []
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    const type = line[0]
    if (type !== '-' && type !== 'd' && type !== 'l') continue
    const match = line.match(/(\.\/\S+)\s*$/)
    if (!match) continue
    entries.push({ type, relative: match[1].replace(/^\.\//, '').replace(/\/$/, '') })
  }
  return entries
}

export function installedBundleFromListing(text) {
  const entries = debListingPaths(text)
  const executables = entries.filter(entry => entry.type === '-' && (entry.relative === EXECUTABLE || entry.relative.endsWith(`/${EXECUTABLE}`)))
  for (const candidate of executables) {
    const directory = candidate.relative.includes('/') ? candidate.relative.slice(0, candidate.relative.lastIndexOf('/')) : ''
    const resources = directory ? `${directory}/resources` : 'resources'
    const archive = `${resources}/app.asar`
    if (!entries.some(entry => entry.type === '-' && entry.relative === archive)) continue
    return { directory, executable: candidate.relative, resources }
  }
  return null
}

export function bundleLaunchContract(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8')
  return {
    acceptanceProfile: source.includes('--desktop-acceptance-profile=') || source.includes('FUTUREOX_ACCEPTANCE_PROFILE'),
    argvFiles: source.includes('launchFilesFromArgv'),
  }
}

export function workspaceSelectionSeed() {
  return '{"version":1,"kind":"default"}\n'
}

export function assertProductName(name) {
  if (typeof name !== 'string' || !name || name.length > 80 || /[/\\\0]/.test(name)) throw new Error('Installed package has no usable product name')
  return name
}

function asarHeader(fd) {
  const sizeBuf = Buffer.alloc(8)
  if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('Unable to read asar header size')
  const headerSize = sizeBuf.readUInt32LE(4)
  const header = Buffer.alloc(headerSize)
  if (readSync(fd, header, 0, headerSize, 8) !== headerSize) throw new Error('Unable to read asar header')
  const length = header.readUInt32LE(4)
  const json = JSON.parse(header.subarray(8, 8 + length).toString('utf8'))
  return { json, dataStart: 8 + headerSize }
}

function asarNode(root, name) {
  let current = root
  for (const part of name.split('/')) {
    current = current?.files?.[part]
    if (!current) return null
  }
  return current.files ? null : current
}

export function readAsarFile(archive, name) {
  const fd = openSync(archive, 'r')
  try {
    const { json, dataStart } = asarHeader(fd)
    const node = asarNode(json, name)
    if (!node || !Number.isSafeInteger(node.size) || node.size < 0 || node.offset === undefined) {
      throw new Error(`asar entry is missing: ${name}`)
    }
    const bytes = Buffer.alloc(node.size)
    const read = readSync(fd, bytes, 0, node.size, dataStart + Number(node.offset))
    if (read !== node.size) throw new Error(`asar entry is short: ${name}`)
    return bytes
  } finally {
    closeSync(fd)
  }
}

export function readAsarJson(archive, name) {
  return JSON.parse(readAsarFile(archive, name).toString('utf8'))
}

export function resolveInstalledBundle(root, listing) {
  const relative = installedBundleFromListing(listing)
  if (!relative) return null
  const directory = path.join(root, relative.directory)
  return {
    directory,
    executable: path.join(root, relative.executable),
    resources: path.join(root, relative.resources),
  }
}
