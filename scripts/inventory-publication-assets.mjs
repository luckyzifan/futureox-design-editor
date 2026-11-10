// Per-file source, attribution, and license review for fidelity references
// and fixture images/archives. A nearby LICENSE, provenance.json, or manifest
// is evidence. It becomes a publication grant only when docs/publication/
// explicit-grants.json names that path and the checkout bytes match the
// synthetic-pixel provenance it cites.
import { createHash } from 'node:crypto'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.fig', '.sketch', '.svg', '.tif', '.tiff', '.pdf', '.zip', '.fd'])
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'OFL.txt', 'COPYING', 'COPYING.GPLv3']
const SHA_RE = /^[0-9a-f]{64}$/
const SYNTHETIC_SOURCE = 'Locally generated synthetic pixels; no user images or Figma reference pixels.'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function filesUnder(directory, include) {
  const found = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && include(full)) found.push(full)
    }
  }
  if (await exists(directory)) await walk(directory)
  return found
}

function parseLfs(text) {
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n')) return null
  return {
    oid: text.match(/^oid sha256:([0-9a-f]{64})$/m)?.[1] ?? null,
    size: Number(text.match(/^size (\d+)$/m)?.[1] ?? 'NaN'),
  }
}

async function nearestWithin(root, file, stop, names) {
  let directory = path.dirname(file)
  const limit = path.resolve(stop)
  while (directory === limit || directory.startsWith(limit + path.sep)) {
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (await exists(candidate)) return path.relative(root, candidate)
    }
    if (directory === limit) break
    directory = path.dirname(directory)
  }
  return null
}

export function identifyLicense(text) {
  const trimmed = text.trim()
  if (/^MIT License\b/.test(trimmed)) return 'MIT'
  if (/^CC0 1\.0 Universal\b/.test(trimmed)) return 'CC0-1.0'
  return 'unrecognized'
}

export function matchSourceNotice(notice, noticeRel, filePath) {
  if (!notice || !Array.isArray(notice.sources)) return { match: null, omitEntry: null }
  const base = path.posix.basename(filePath)
  const root = path.posix.dirname(noticeRel)
  for (const item of notice.sources) {
    if (!item || typeof item.name !== 'string') continue
    const dir = `${root}/${item.name}/`
    if (!filePath.startsWith(dir)) continue
    if (Array.isArray(item.files)) {
      if (item.files.includes(base)) return { match: item, omitEntry: null }
      return { match: null, omitEntry: item }
    }
    return { match: item, omitEntry: null }
  }
  return { match: null, omitEntry: null }
}

function sourceNoticeAttribution(notice, item, base) {
  if (Array.isArray(item.files)) {
    const claim = typeof item.license === 'string' ? item.license : 'no license claim'
    return `repository ${item.repository}; SOURCE.json license claim: ${claim}; file list names ${base}; claim not applied`
  }
  return typeof notice.note === 'string' ? notice.note : null
}

function isSha(value) {
  return typeof value === 'string' && SHA_RE.test(value)
}

function safeRel(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '' || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) return null
  return normalized
}

export function sourceText(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  for (const key of ['source', 'exportSource', 'provenance']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim()
  }
  return null
}

function nodeIdOf(value) {
  if (!value || typeof value !== 'object') return null
  for (const key of ['nodeId', 'figmaNodeId', 'shapeId', 'node', 'frameId']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key]
  }
  if (typeof value.id === 'string' && value.id.includes(':')) return value.id
  return null
}

function namedAsset(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.image === 'string') return value.image
  if (typeof value.file === 'string') return value.file
  if (typeof value.reference === 'string') return value.reference
  if (typeof value.name === 'string') {
    if (/\.(png|jpe?g|webp|gif|svg|tiff?)$/i.test(value.name)) return value.name
    return `${value.name}.png`
  }
  return null
}

function hashList(value, keys) {
  const found = []
  for (const key of keys) {
    if (isSha(value?.[key])) found.push(value[key])
  }
  return [...new Set(found)]
}

function entriesFromProvenance(data, jsonRel) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const base = {
    source: sourceText(data),
    record: jsonRel,
    fileKey: typeof data.fileKey === 'string' ? data.fileKey : null,
    fileUrl: typeof data.file === 'string' && data.file.startsWith('http') ? data.file : null,
    archive: typeof data.archive === 'string' ? data.archive : null,
    board: typeof data.board === 'string' ? data.board : typeof data.boardId === 'string' ? data.boardId : null,
    date: typeof data.date === 'string' ? data.date : null,
  }
  const entries = []
  const add = partial => {
    const hashes = partial.hashes ?? (isSha(partial.sha256) ? [partial.sha256] : [])
    if (!hashes.length) return
    entries.push({ ...base, ...partial, hashes, sha256: hashes[0], conflict: hashes.length > 1 })
  }
  if (data.files && typeof data.files === 'object' && !Array.isArray(data.files)) {
    for (const [name, value] of Object.entries(data.files)) {
      if (isSha(value)) add({ name, sha256: value, nodeId: null, caseName: name })
      else if (value && typeof value === 'object') add({ name: value.file || name, hashes: hashList(value, ['sha256']), nodeId: nodeIdOf(value), caseName: name })
    }
  }
  if (Array.isArray(data.files)) {
    for (const value of data.files) add({ name: namedAsset(value), hashes: hashList(value, ['sha256']), nodeId: nodeIdOf(value), caseName: value?.name || value?.file || null })
  }
  if (Array.isArray(data.cases)) {
    for (const value of data.cases) {
      add({
        name: namedAsset(value),
        hashes: hashList(value, ['sha256', 'pngSha256', 'exportSha256', 'referenceSha256']),
        nodeId: nodeIdOf(value),
        caseName: value?.name || value?.id || null,
      })
    }
  } else if (data.cases && typeof data.cases === 'object') {
    for (const [caseName, value] of Object.entries(data.cases)) {
      if (value && typeof value === 'object') add({ name: null, hashes: hashList(value, ['sha256']), nodeId: null, caseName })
    }
  }
  if (Array.isArray(data.rows)) {
    for (const value of data.rows) {
      add({
        name: namedAsset(value),
        hashes: hashList(value, ['sha256', 'pngSha256', 'exportSha256']),
        nodeId: nodeIdOf(value),
        caseName: value?.name || null,
      })
    }
  }
  if (Array.isArray(data.images)) {
    for (const value of data.images) add({ name: value?.file, hashes: hashList(value, ['sha256']), nodeId: null, caseName: value?.file || null })
  }
  if (Array.isArray(data.comparisonToStoredReference)) {
    for (const value of data.comparisonToStoredReference) {
      add({ name: null, hashes: hashList(value, ['storedSha256']), nodeId: null, caseName: value?.kind || null, bind: 'storedSha256' })
    }
  }
  if (isSha(data.nativeFigSha256)) add({ name: null, sha256: data.nativeFigSha256, nodeId: null, caseName: null, bind: 'nativeFigSha256' })
  if (typeof data.baselineFile === 'string' && isSha(data.baselinePngSha256)) {
    add({ name: data.baselineFile, sha256: data.baselinePngSha256, nodeId: null, caseName: 'baselineFile', bind: 'baselineFile' })
  }
  return entries
}

export function entriesFromDocument(data, jsonRel) {
  if (Array.isArray(data)) {
    return data.flatMap(item => entriesFromProvenance({ cases: [item] }, jsonRel))
  }
  return entriesFromProvenance(data, jsonRel)
}

function attributionOf(entry) {
  if (entry.bind === 'nativeFigSha256') return `sha256 matches nativeFigSha256 in ${entry.record}`
  if (entry.bind === 'storedSha256') return `storedSha256 for ${entry.caseName ?? 'an unnamed kind'} in ${entry.record}; the fresh export hash in that comparison is not this file`
  const parts = []
  if (entry.fileKey) parts.push(`fileKey ${entry.fileKey}`)
  if (entry.fileUrl) parts.push(entry.fileUrl)
  if (entry.nodeId) parts.push(`node ${entry.nodeId}`)
  if (entry.caseName) parts.push(`case ${entry.caseName}`)
  if (entry.archive) parts.push(`archive ${entry.archive}`)
  if (entry.board) parts.push(`board ${entry.board}`)
  if (entry.date) parts.push(`date ${entry.date}`)
  return parts.length ? parts.join('; ') : null
}

function sourceOf(entry, resolvedPath, dirSource) {
  if (entry.bind === 'nativeFigSha256') {
    return `Identified by nativeFigSha256 in ${entry.record}. That record does not state a redistribution license for the FIG bytes.`
  }
  if (entry.bind === 'storedSha256') {
    return `Checkout bytes match comparisonToStoredReference.storedSha256 for ${entry.caseName ?? 'an unnamed kind'} in ${entry.record}. The fresh export hash in that comparison is a different file, and the record does not state a redistribution license.`
  }
  if (entry.source) return entry.source
  if (resolvedPath) return dirSource.get(path.posix.dirname(resolvedPath)) ?? null
  return null
}

function inScope(rel) {
  return rel.startsWith('frontend/design-client/public/fidelity/') || rel.startsWith('testing/fixtures/')
}

export function bindSourceLists(drafts, entries, dirSource) {
  const pathSet = new Set(drafts.map(draft => draft.path))
  const byBase = new Map()
  const draftByPath = new Map(drafts.map(draft => [draft.path, draft]))
  for (const draft of drafts) {
    const base = path.posix.basename(draft.path)
    const list = byBase.get(base) ?? []
    list.push(draft.path)
    byBase.set(base, list)
  }
  const named = []
  const hashOnly = []
  const missingListed = []
  const unbound = []
  for (const entry of entries) {
    const raw = entry.name
    if (!raw) {
      hashOnly.push(entry)
      continue
    }
    const slash = raw.includes('/') || raw.includes('\\')
    let rel = null
    let sameDirectory = false
    let relative = false
    let crossBasename = false
    if (slash) {
      const normalized = raw.replaceAll('\\', '/')
      rel = normalized.startsWith('.')
        ? safeRel(path.posix.normalize(path.posix.join(path.posix.dirname(entry.record), normalized)))
        : safeRel(normalized)
      relative = true
    } else {
      const local = path.posix.join(path.posix.dirname(entry.record), raw)
      if (pathSet.has(local)) {
        rel = local
        sameDirectory = true
      } else {
        const bases = byBase.get(raw) ?? []
        if (bases.length === 1) {
          rel = bases[0]
          crossBasename = true
        } else if (bases.length === 0) {
          if (inScope(local)) missingListed.push({ path: local, sha256: entry.sha256, sourceRecord: entry.record })
          else unbound.push({ sha256: entry.sha256, sourceRecord: entry.record, reason: 'named file is outside the scanned trees' })
          continue
        } else {
          unbound.push({ sha256: entry.sha256, sourceRecord: entry.record, reason: `basename ${raw} matches more than one scanned file` })
          continue
        }
      }
    }
    if (!rel) {
      unbound.push({ sha256: entry.sha256, sourceRecord: entry.record, reason: 'asset path could not be resolved' })
      continue
    }
    if (!pathSet.has(rel)) {
      if (inScope(rel)) missingListed.push({ path: rel, sha256: entry.sha256, sourceRecord: entry.record })
      continue
    }
    named.push({
      path: rel,
      sha256: entry.sha256,
      conflict: entry.conflict,
      hashes: entry.hashes,
      source: sourceOf(entry, rel, dirSource),
      attribution: attributionOf(entry),
      sourceRecord: entry.record,
      sameDirectory,
      relative,
      crossBasename,
    })
  }
  const byPath = new Map()
  const groups = new Map()
  for (const item of named) {
    const group = groups.get(item.path) ?? []
    group.push(item)
    groups.set(item.path, group)
  }
  for (const [filePath, group] of groups) {
    const draft = draftByPath.get(filePath)
    if (!draft || draft.lfs || draft.selfProvenance) continue
    const rank = item => (item.sameDirectory ? 1 : item.relative ? 2 : item.crossBasename ? 3 : 4)
    const disagrees = group.filter(item => item.conflict || !item.hashes.every(hash => hash === draft.checkoutSha256))
    if (disagrees.length) {
      const chosen = disagrees.sort((a, b) => rank(a) - rank(b))[0]
      byPath.set(filePath, {
        hashCheck: 'mismatch',
        source: chosen.source,
        attribution: chosen.attribution,
        listedSha256: chosen.sha256,
        sourceRecord: chosen.sourceRecord,
      })
      continue
    }
    const chosen = group.sort((a, b) => rank(a) - rank(b))[0]
    byPath.set(filePath, {
      hashCheck: 'match',
      source: chosen.source,
      attribution: chosen.attribution,
      listedSha256: chosen.sha256,
      sourceRecord: chosen.sourceRecord,
    })
  }
  for (const entry of hashOnly) {
    const owners = drafts.filter(draft => !draft.lfs && !draft.selfProvenance && draft.checkoutSha256 === entry.sha256)
    const unboundOwners = owners.filter(owner => !byPath.has(owner.path))
    if (unboundOwners.length !== 1) {
      unbound.push({
        sha256: entry.sha256,
        sourceRecord: entry.record,
        reason: owners.length === 0 ? 'hash matches no scanned file' : 'hash matches more than one scanned file that is not already named by a source list',
      })
      continue
    }
    const owner = unboundOwners[0]
    byPath.set(owner.path, {
      hashCheck: 'match',
      source: sourceOf(entry, owner.path, dirSource),
      attribution: attributionOf(entry),
      listedSha256: entry.sha256,
      sourceRecord: entry.record,
    })
  }
  missingListed.sort((a, b) => a.path.localeCompare(b.path) || a.sourceRecord.localeCompare(b.sourceRecord))
  return { byPath, missingListed, unbound }
}

export function classifyAsset({
  lfs,
  selfProvenance,
  manifestEntry,
  manifestLicenseNote,
  hashCheck,
  observedLicense,
  directoryHasSourceList,
  grantAttempt,
}) {
  if (grantAttempt?.ok) {
    return {
      record: 'explicit_grant',
      publication: 'public',
      reason: 'explicit grant names this path, matching sha256, synthetic-pixel source, attribution, copyright, and MIT license',
    }
  }
  if (grantAttempt && grantAttempt.ok === false) {
    return {
      record: 'explicit_grant_rejected',
      publication: 'withhold',
      reason: grantAttempt.reason,
    }
  }
  if (lfs) {
    const matches = Boolean(manifestEntry && lfs.oid && manifestEntry.sha256 === lfs.oid)
    return {
      record: matches ? 'lfs_oid_matches_manifest' : manifestEntry ? 'lfs_oid_mismatch' : 'git_lfs_pointer',
      publication: 'withhold',
      reason: manifestLicenseNote
        ? 'manifest says inclusion does not grant a new redistribution license'
        : 'git-lfs pointer; design bytes are not in this checkout',
    }
  }
  if (selfProvenance) {
    return {
      record: 'provenance_record_file',
      publication: 'withhold',
      reason: 'this file is a provenance record; it is not a redistribution grant for other files',
    }
  }
  if (hashCheck === 'match') {
    return {
      record: 'source_list_hash_match',
      publication: 'withhold',
      reason: 'a source list sha256 matches these bytes; that list is not a redistribution grant',
    }
  }
  if (hashCheck === 'mismatch') {
    return {
      record: 'source_list_hash_mismatch',
      publication: 'withhold',
      reason: 'a source list names this file but the listed sha256 does not match the checkout bytes',
    }
  }
  if (observedLicense) {
    return {
      record: 'upstream_notice_unverified',
      publication: 'withhold',
      reason: 'a nearby license or source notice was recorded and not applied; no per-file revision pin matched these bytes',
    }
  }
  if (directoryHasSourceList) {
    return {
      record: 'source_list_omits_file',
      publication: 'withhold',
      reason: 'a source list in this directory does not name this file',
    }
  }
  if (manifestEntry) {
    return {
      record: 'named_in_manifest',
      publication: 'withhold',
      reason: manifestLicenseNote || 'named by a manifest without a redistribution grant',
    }
  }
  return {
    record: 'no_provenance_record',
    publication: 'withhold',
    reason: 'no provenance.json, manifest entry, or explicit grant was found for this file',
  }
}

function readmeNotes(text, hasLicense) {
  const notes = []
  if (text.includes('Lato')) notes.push('README names the Lato font family and this review did not license embedded font bytes')
  if (text.includes('ThemeSelection credit')) notes.push('README requests a ThemeSelection credit link in addition to the LICENSE text')
  if (!hasLicense && /logo/i.test(text)) notes.push('README mentions logos and this directory has no LICENSE file')
  return notes.join('; ')
}

async function loadSourceLists(root) {
  const fidelity = path.join(root, 'frontend/design-client/public/fidelity')
  const jsons = await filesUnder(fidelity, file => {
    const base = path.basename(file)
    return base === 'cases.json' || base === 'flattened-cases.json' || base.endsWith('provenance.json')
  })
  const extra = path.join(root, 'testing/fixtures/design/io/provenance.json')
  if (await exists(extra)) jsons.push(extra)
  const parsed = new Map()
  const entries = []
  const dirSource = new Map()
  const directories = new Set()
  for (const full of jsons) {
    const rel = path.posix.normalize(path.relative(root, full).split(path.sep).join('/'))
    let data
    try {
      data = JSON.parse(await readFile(full, 'utf8'))
    } catch {
      continue
    }
    parsed.set(rel, data)
    directories.add(path.posix.dirname(rel))
    const text = sourceText(data)
    if (text && path.posix.basename(rel) === 'provenance.json') dirSource.set(path.posix.dirname(rel), text)
    entries.push(...entriesFromDocument(data, rel))
  }
  return { parsed, entries, dirSource, directories }
}

async function loadGrants(root) {
  const file = path.join(root, 'docs/publication/explicit-grants.json')
  if (!(await exists(file))) return []
  const data = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(data.files)) throw new Error('docs/publication/explicit-grants.json files must be an array')
  return data.files
}

async function sha256Of(root, rel) {
  const safe = safeRel(rel)
  if (!safe) return null
  const full = path.join(root, safe)
  if (!(await exists(full))) return null
  return createHash('sha256').update(await readFile(full)).digest('hex')
}

export async function evaluateGrant(grant, draft, root, parsed) {
  if (!grant) return null
  if (!draft || draft.lfs) return { ok: false, reason: 'explicit grant does not match a reviewed non-LFS checkout file' }
  if (!isSha(grant.sha256) || grant.sha256 !== draft.checkoutSha256) return { ok: false, reason: 'explicit grant sha256 does not match the checkout bytes' }
  if (grant.license !== 'MIT') return { ok: false, reason: 'this scan only accepts an explicit MIT grant for project-authored synthetic pixels' }
  for (const key of ['source', 'attribution', 'copyright', 'provenance']) {
    if (typeof grant[key] !== 'string' || !grant[key].trim()) return { ok: false, reason: `explicit grant ${key} is empty` }
  }
  if (grant.source !== SYNTHETIC_SOURCE) return { ok: false, reason: 'explicit grant source does not state that the pixels are synthetic and contain no user or Figma reference pixels' }
  const provenanceRel = safeRel(grant.provenance)
  const provenance = provenanceRel ? parsed.get(provenanceRel) : null
  if (!provenance) return { ok: false, reason: 'explicit grant provenance file is missing' }
  if (sourceText(provenance) !== grant.source) return { ok: false, reason: 'explicit grant source does not match the provenance source' }
  if (provenance.generator !== 'generate.py') return { ok: false, reason: 'explicit grant provenance generator is not generate.py' }
  const listed = Array.isArray(provenance.images) ? provenance.images.find(item => item?.file === path.posix.basename(draft.path)) : null
  if (!listed || listed.sha256 !== draft.checkoutSha256) return { ok: false, reason: 'explicit grant file is not listed with this sha256 in provenance images' }
  const licenseText = await exists(path.join(root, 'LICENSE')) ? await readFile(path.join(root, 'LICENSE'), 'utf8') : ''
  if (!licenseText.startsWith('MIT License\n') || !licenseText.includes(grant.copyright)) {
    return { ok: false, reason: 'explicit grant copyright is not the copyright line in the root MIT LICENSE' }
  }
  if (Array.isArray(grant.filesMustMatch)) {
    for (const check of grant.filesMustMatch) {
      const actual = await sha256Of(root, check?.path)
      if (!isSha(check?.sha256) || actual !== check.sha256) {
        return { ok: false, reason: `explicit grant evidence file does not match: ${check?.path ?? '(missing path)'}` }
      }
    }
  }
  return { ok: true }
}

export async function inventoryPublicationAssets(root = repo) {
  const fidelityRoot = path.join(root, 'frontend/design-client/public/fidelity')
  const fixtureRoot = path.join(root, 'testing/fixtures')
  const fidelity = await filesUnder(fidelityRoot, () => true)
  const fixtures = await filesUnder(fixtureRoot, file => BINARY_EXT.has(path.extname(file).toLowerCase()))
  const selected = [...fidelity, ...fixtures].sort()
  const drafts = []
  for (const full of selected) {
    const relative = path.posix.normalize(path.relative(root, full).split(path.sep).join('/'))
    const bytes = await readFile(full)
    const textHead = bytes.subarray(0, 200).toString('utf8')
    const lfs = parseLfs(textHead.startsWith('version https://git-lfs.github.com/spec/v1') ? bytes.toString('utf8') : '')
    const base = path.basename(full)
    const selfProvenance = base.endsWith('.json') && base.toLowerCase().includes('provenance')
    const stop = full.startsWith(fidelityRoot + path.sep) || full === fidelityRoot ? fidelityRoot : fixtureRoot
    const nearestLicenseFile = await nearestWithin(root, full, stop, LICENSE_NAMES)
    const licenseBody = nearestLicenseFile ? await readFile(path.join(root, nearestLicenseFile), 'utf8') : null
    const observedLicense = licenseBody ? identifyLicense(licenseBody) : null
    const readme = await nearestWithin(root, full, stop, ['README.md'])
    const readmeBody = readme ? await readFile(path.join(root, readme), 'utf8') : null
    const sourceNotice = await nearestWithin(root, full, stop, ['SOURCE.json'])
    let noticedSource = null
    let noticedAttribution = null
    let sourceNoticeOmits = false
    if (sourceNotice) {
      try {
        const notice = JSON.parse(await readFile(path.join(root, sourceNotice), 'utf8'))
        const matched = matchSourceNotice(notice, sourceNotice.split(path.sep).join('/'), relative)
        if (matched.match) {
          noticedSource = typeof matched.match.repository === 'string' ? matched.match.repository : null
          noticedAttribution = sourceNoticeAttribution(notice, matched.match, base)
        } else if (matched.omitEntry) {
          sourceNoticeOmits = true
          noticedAttribution = `SOURCE.json entry ${matched.omitEntry.name} (${matched.omitEntry.repository}) does not list this file`
        }
      } catch {
        noticedSource = null
      }
    }
    let manifestEntry = null
    let manifestLicenseNote = null
    let manifestSource = null
    let manifestPurpose = null
    const manifestPath = path.join(path.dirname(full), 'manifest.json')
    if (await exists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifestLicenseNote = typeof manifest.licenseNote === 'string' ? manifest.licenseNote : null
      manifestSource = typeof manifest.source === 'string' ? manifest.source : null
      manifestPurpose = typeof manifest.purpose === 'string' ? manifest.purpose : null
      manifestEntry = Array.isArray(manifest.files) ? manifest.files.find(item => item.file === base) ?? null : null
    }
    drafts.push({
      path: relative,
      bytes: lfs ? lfs.size : bytes.length,
      checkoutSha256: createHash('sha256').update(bytes).digest('hex'),
      lfs,
      selfProvenance,
      nearestLicenseFile,
      observedLicense: observedLicense === 'unrecognized' ? null : observedLicense,
      readme,
      readmeNote: readmeBody ? readmeNotes(readmeBody, Boolean(nearestLicenseFile)) : null,
      noticedSource,
      noticedAttribution,
      sourceNoticeOmits,
      manifestEntry,
      manifestLicenseNote,
      manifestSource,
      manifestPurpose,
    })
  }
  const lists = await loadSourceLists(root)
  const bound = bindSourceLists(drafts, lists.entries, lists.dirSource)
  const grants = await loadGrants(root)
  const grantByPath = new Map()
  const duplicateGrants = new Set()
  for (const grant of grants) {
    if (grantByPath.has(grant.path)) duplicateGrants.add(grant.path)
    grantByPath.set(grant.path, grant)
  }
  const files = []
  for (const draft of drafts) {
    const binding = bound.byPath.get(draft.path) ?? null
    const contentHashCheck = binding?.hashCheck ?? (isSha(draft.manifestEntry?.sha256)
      ? draft.checkoutSha256 === draft.manifestEntry.sha256 ? 'match' : 'mismatch'
      : undefined)
    let grantAttempt = null
    if (duplicateGrants.has(draft.path)) grantAttempt = { ok: false, reason: 'explicit grant names this path more than once' }
    else if (grantByPath.has(draft.path)) grantAttempt = await evaluateGrant(grantByPath.get(draft.path), draft, root, lists.parsed)
    const classified = classifyAsset({
      lfs: draft.lfs,
      selfProvenance: draft.selfProvenance,
      manifestEntry: draft.manifestEntry,
      manifestLicenseNote: draft.manifestLicenseNote,
      hashCheck: contentHashCheck,
      observedLicense: draft.observedLicense || draft.noticedSource ? draft.observedLicense || 'notice' : null,
      directoryHasSourceList: lists.directories.has(path.posix.dirname(draft.path)) || draft.sourceNoticeOmits,
      grantAttempt,
    })
    const publicGrant = grantAttempt?.ok ? grantByPath.get(draft.path) : null
    let source = publicGrant?.source ?? binding?.source ?? null
    let attribution = publicGrant?.attribution ?? binding?.attribution ?? null
    if (!source && draft.selfProvenance) source = sourceText(lists.parsed.get(draft.path))
    if (!source && draft.manifestSource) source = draft.manifestSource
    if (!source && draft.noticedSource) source = draft.noticedSource
    if (!attribution && draft.manifestPurpose) attribution = draft.manifestPurpose
    if (!attribution && draft.noticedAttribution) attribution = draft.noticedAttribution
    if (!attribution && draft.observedLicense && draft.nearestLicenseFile) {
      attribution = `LICENSE ${draft.nearestLicenseFile} identified as ${draft.observedLicense}; not applied without a verified per-file revision`
    }
    if (!attribution && draft.readme) attribution = `README ${draft.readme} does not include a LICENSE file for this asset`
    if (draft.readmeNote) attribution = attribution ? `${attribution}; ${draft.readmeNote}` : draft.readmeNote
    const hashCheck = draft.lfs
      ? draft.manifestEntry && draft.lfs.oid === draft.manifestEntry.sha256
        ? 'pointer_oid_match'
        : draft.manifestEntry
          ? 'pointer_oid_mismatch'
          : 'not_listed'
      : draft.selfProvenance
        ? 'record_only'
        : contentHashCheck ?? 'not_listed'
    files.push({
      path: draft.path,
      bytes: draft.bytes,
      checkoutSha256: draft.checkoutSha256,
      lfsOid: draft.lfs?.oid ?? null,
      provenance: binding?.sourceRecord ?? (draft.selfProvenance ? draft.path : null),
      source,
      attribution,
      license: publicGrant ? publicGrant.license : null,
      licenseStatus: publicGrant ? 'granted' : 'not_granted',
      copyright: publicGrant ? publicGrant.copyright : null,
      observedLicense: draft.observedLicense,
      hashCheck,
      listedSha256: binding?.listedSha256 ?? draft.manifestEntry?.sha256 ?? null,
      sourceRecord: binding?.sourceRecord ?? null,
      contentBytesReviewed: hashCheck === 'match',
      nearestLicenseFile: draft.nearestLicenseFile,
      nearestLicenseApplied: false,
      manifestSha256: draft.manifestEntry?.sha256 ?? null,
      ...classified,
    })
  }
  const counts = {}
  for (const file of files) counts[file.record] = (counts[file.record] ?? 0) + 1
  const proposedPublic = files.filter(file => file.publication === 'public').map(file => file.path)
  const unmatchedGrants = grants.map(grant => grant.path).filter(grantPath => !files.some(file => file.path === grantPath)).sort()
  const missingListed = bound.missingListed.filter((item, index, all) => all.findIndex(other => other.path === item.path && other.sha256 === item.sha256 && other.sourceRecord === item.sourceRecord) === index)
  return {
    schema: 2,
    issue: 89,
    classification: 'opensource_prep',
    confirmedRuntimeFault: false,
    proposedPublic,
    publicationRule: 'public only when docs/publication/explicit-grants.json names the path and the checkout bytes match its synthetic-pixel provenance; this scan applies no nearby license',
    counts,
    fileCount: files.length,
    missingListed,
    unboundSourceEntries: bound.unbound.map(item => ({
      sha256: item.sha256,
      sourceRecord: item.sourceRecord,
      reason: item.reason,
    })),
    unmatchedGrants,
    review: {
      hashMatch: files.filter(file => file.hashCheck === 'match').length,
      hashMismatch: files.filter(file => file.hashCheck === 'mismatch').length,
      notListed: files.filter(file => file.hashCheck === 'not_listed').length,
      pointerOidMatch: files.filter(file => file.hashCheck === 'pointer_oid_match').length,
      recordOnly: files.filter(file => file.hashCheck === 'record_only').length,
      public: proposedPublic.length,
    },
    files,
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = await inventoryPublicationAssets(repo)
  const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length)
  const summary = {
    schema: report.schema,
    fileCount: report.fileCount,
    counts: report.counts,
    proposedPublic: report.proposedPublic,
    review: report.review,
    missingListed: report.missingListed,
    unboundSourceEntries: report.unboundSourceEntries,
    unmatchedGrants: report.unmatchedGrants,
  }
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
}
