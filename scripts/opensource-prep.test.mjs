import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectLicenseCoverage } from './check-license-coverage.mjs'
import { classifyAsset, inventoryPublicationAssets } from './inventory-publication-assets.mjs'

const repo = path.resolve(import.meta.dirname, '..')

test('project MIT metadata stays separate from vendored crate licenses', () => {
  const report = inspectLicenseCoverage(repo)
  assert.deepEqual(report.problems, [])
  assert.equal(report.projectLicense, 'MIT')
  assert.equal(report.vendors.find(item => item.crate === 'vendor/moxcms').license, 'BSD-3-Clause OR Apache-2.0')
  assert.equal(report.vendors.find(item => item.crate === 'vendor/flo_curves').license, 'Apache-2.0')
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(JSON.stringify(report).includes('visibilityUnchanged'), true)
})

test('asset classification never turns a nearby license into a grant', () => {
  assert.equal(classifyAsset({
    lfs: { oid: 'ab'.repeat(32), size: 4 },
    manifestEntry: { sha256: 'ab'.repeat(32) },
    manifestLicenseNote: 'inclusion does not grant a new redistribution license',
  }).record, 'lfs_oid_matches_manifest')
  assert.equal(classifyAsset({ provenance: 'provenance.json' }).publication, 'withhold')
  assert.equal(classifyAsset({}).record, 'no_provenance_record')
  const mismatched = classifyAsset({
    lfs: { oid: 'aa'.repeat(32), size: 1 },
    manifestEntry: { sha256: 'bb'.repeat(32) },
  })
  assert.equal(mismatched.record, 'lfs_oid_mismatch')
  assert.equal(mismatched.publication, 'withhold')
})

test('the current fidelity and fixture scan withholds every file', async () => {
  const report = await inventoryPublicationAssets(repo)
  assert.equal(report.proposedPublic.length, 0)
  assert.equal(report.files.every(file => file.publication === 'withhold' && file.nearestLicenseApplied === false), true)
  assert.ok(report.missingCitations.includes('testing/fixtures/design/io/provenance.json'))
  const sketch = report.files.find(file => file.path === 'testing/fixtures/user-regression-20261109/117.sketch')
  assert.equal(sketch.record, 'lfs_oid_matches_manifest')
  assert.equal(sketch.lfsOid, 'd494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70')
  const fidelity = report.files.filter(file => file.path.startsWith('frontend/design-client/public/fidelity/'))
  assert.equal(fidelity.length, 349)
  assert.equal(report.files.find(file => file.path === 'frontend/design-client/public/fidelity/alpha-curve.png').record, 'no_provenance_record')
  assert.equal(report.files.find(file => file.path === 'frontend/design-client/public/fidelity/mask-provenance.json').record, 'provenance_record_file')
  assert.ok(fidelity.some(file => file.record === 'provenance_json_in_directory'))
  assert.equal(JSON.stringify(report).includes('"license":"MIT"'), false)
  const committed = JSON.parse(await readFile(new URL('../docs/publication/asset-inventory.json', import.meta.url), 'utf8'))
  assert.equal(committed.fileCount, report.fileCount)
  assert.deepEqual(committed.counts, report.counts)
  assert.equal(committed.files.length, report.files.length)
  assert.equal(committed.proposedPublic.length, 0)
})

test('a parent LICENSE inside a fixture tree is recorded and not applied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-assets-'))
  try {
    const dir = path.join(root, 'testing/fixtures/sample')
    const fidelity = path.join(root, 'frontend/design-client/public/fidelity/empty')
    await mkdir(dir, { recursive: true })
    await mkdir(fidelity, { recursive: true })
    await writeFile(path.join(dir, 'LICENSE'), 'MIT License\nCopyright (c) someone else\n')
    await writeFile(path.join(dir, 'mark.png'), 'not-a-real-png')
    await writeFile(path.join(root, 'LICENSE'), 'MIT License\nCopyright (c) 2026 Cookieboty and contributors\n')
    const report = await inventoryPublicationAssets(root)
    const mark = report.files.find(file => file.path.endsWith('mark.png'))
    assert.equal(mark.nearestLicenseFile, 'testing/fixtures/sample/LICENSE')
    assert.equal(mark.nearestLicenseApplied, false)
    assert.equal(mark.publication, 'withhold')
    assert.equal(mark.record, 'no_provenance_record')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
