// Per-file record for fidelity references and fixture images/archives.
// A provenance file or nearby LICENSE path is evidence that a record exists.
// It is not a new redistribution grant. Nothing in this scan is marked allowed
// unless this file is later changed to recognize an explicit in-repo grant.
import { createHash } from 'node:crypto'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.fig', '.sketch', '.svg', '.tif', '.tiff', '.pdf', '.zip', '.fd'])
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'OFL.txt', 'COPYING', 'COPYING.GPLv3']
const CITED_MISSING = ['testing/fixtures/design/io/provenance.json']

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

export function classifyAsset({ lfs, provenance, selfProvenance, manifestEntry, manifestLicenseNote }) {
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
  if (provenance) {
    return {
      record: 'provenance_json_in_directory',
      publication: 'withhold',
      reason: 'directory provenance.json was found; it is not treated as a redistribution grant',
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

export async function inventoryPublicationAssets(root = repo) {
  const fidelityRoot = path.join(root, 'frontend/design-client/public/fidelity')
  const fixtureRoot = path.join(root, 'testing/fixtures')
  const fidelity = await filesUnder(fidelityRoot, () => true)
  const fixtures = await filesUnder(fixtureRoot, file => BINARY_EXT.has(path.extname(file).toLowerCase()))
  const selected = [...fidelity, ...fixtures].sort()
  const files = []
  for (const full of selected) {
    const relative = path.relative(root, full)
    const bytes = await readFile(full)
    const textHead = bytes.subarray(0, 200).toString('utf8')
    const lfs = parseLfs(textHead.startsWith('version https://git-lfs.github.com/spec/v1') ? bytes.toString('utf8') : '')
    const base = path.basename(full)
    const selfProvenance = base.endsWith('.json') && base.toLowerCase().includes('provenance')
    const provenancePath = path.join(path.dirname(full), 'provenance.json')
    const provenance = !selfProvenance && await exists(provenancePath)
      ? path.relative(root, provenancePath)
      : null
    let manifestEntry = null
    let manifestLicenseNote = null
    const manifestPath = path.join(path.dirname(full), 'manifest.json')
    if (await exists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifestLicenseNote = typeof manifest.licenseNote === 'string' ? manifest.licenseNote : null
      manifestEntry = Array.isArray(manifest.files)
        ? manifest.files.find(item => item.file === path.basename(full)) ?? null
        : null
    }
    const classified = classifyAsset({ lfs, provenance, selfProvenance, manifestEntry, manifestLicenseNote })
    files.push({
      path: relative,
      bytes: lfs ? lfs.size : bytes.length,
      checkoutSha256: createHash('sha256').update(bytes).digest('hex'),
      lfsOid: lfs?.oid ?? null,
      provenance,
      nearestLicenseFile: await nearestWithin(
        root,
        full,
        full.startsWith(fidelityRoot + path.sep) || full === fidelityRoot ? fidelityRoot : fixtureRoot,
        LICENSE_NAMES,
      ),
      nearestLicenseApplied: false,
      manifestSha256: manifestEntry?.sha256 ?? null,
      ...classified,
    })
  }
  const missingCitations = []
  for (const relative of CITED_MISSING) {
    if (!(await exists(path.join(root, relative)))) missingCitations.push(relative)
  }
  const counts = {}
  for (const file of files) counts[file.record] = (counts[file.record] ?? 0) + 1
  return {
    schema: 1,
    issue: 89,
    classification: 'opensource_prep',
    confirmedRuntimeFault: false,
    proposedPublic: [],
    publicationRule: 'withhold unless a later explicit in-repo grant names the file; this scan grants none',
    counts,
    fileCount: files.length,
    missingCitations,
    files,
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = await inventoryPublicationAssets(repo)
  const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length)
  const summary = { ...report, files: undefined, fileCount: report.fileCount, counts: report.counts, missingCitations: report.missingCitations, proposedPublic: report.proposedPublic }
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
}
