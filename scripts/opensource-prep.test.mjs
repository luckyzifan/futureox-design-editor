import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectLicenseCoverage } from './check-license-coverage.mjs'
import { classifyAsset, evaluateGrant, inventoryPublicationAssets, matchSourceNotice } from './inventory-publication-assets.mjs'

const repo = path.resolve(import.meta.dirname, '..')
const syntheticSource = 'Locally generated synthetic pixels; no user images or Figma reference pixels.'

test('project MIT metadata stays separate from vendored crate licenses', () => {
  const report = inspectLicenseCoverage(repo)
  assert.deepEqual(report.problems, [])
  assert.equal(report.projectLicense, 'MIT')
  assert.equal(report.vendors.find(item => item.crate === 'vendor/moxcms').license, 'BSD-3-Clause OR Apache-2.0')
  assert.equal(report.vendors.find(item => item.crate === 'vendor/flo_curves').license, 'Apache-2.0')
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(JSON.stringify(report).includes('visibilityUnchanged'), true)
})

test('asset classification never turns a nearby license or source list into a grant', () => {
  assert.equal(classifyAsset({
    lfs: { oid: 'ab'.repeat(32), size: 4 },
    manifestEntry: { sha256: 'ab'.repeat(32) },
    manifestLicenseNote: 'inclusion does not grant a new redistribution license',
  }).record, 'lfs_oid_matches_manifest')
  assert.equal(classifyAsset({ hashCheck: 'match', observedLicense: 'MIT' }).publication, 'withhold')
  assert.equal(classifyAsset({ hashCheck: 'match' }).record, 'source_list_hash_match')
  assert.equal(classifyAsset({}).record, 'no_provenance_record')
  assert.equal(classifyAsset({ observedLicense: 'CC0-1.0' }).record, 'upstream_notice_unverified')
  const mismatched = classifyAsset({
    lfs: { oid: 'aa'.repeat(32), size: 1 },
    manifestEntry: { sha256: 'bb'.repeat(32) },
  })
  assert.equal(mismatched.record, 'lfs_oid_mismatch')
  assert.equal(mismatched.publication, 'withhold')
  assert.equal(classifyAsset({
    grantAttempt: { ok: false, reason: 'explicit grant sha256 does not match the checkout bytes' },
    hashCheck: 'match',
  }).publication, 'withhold')
})

test('a source notice names only the files listed for that directory', () => {
  const notice = {
    sources: [
      { name: 'kit', repository: 'https://example.test/kit', license: 'MIT', files: ['named.sketch'] },
      { name: 'other', repository: 'https://example.test/other', files: ['other.sketch'] },
    ],
  }
  assert.equal(matchSourceNotice(notice, 'testing/fixtures/pack/SOURCE.json', 'testing/fixtures/pack/kit/named.sketch').match.repository, 'https://example.test/kit')
  assert.equal(matchSourceNotice(notice, 'testing/fixtures/pack/SOURCE.json', 'testing/fixtures/pack/kit/extra.png').omitEntry.name, 'kit')
  assert.equal(matchSourceNotice(notice, 'testing/fixtures/pack/SOURCE.json', 'testing/fixtures/pack/other/named.sketch').match, null)
})

test('the current fidelity and fixture scan grants only the synthetic I/O images', async () => {
  const report = await inventoryPublicationAssets(repo)
  assert.deepEqual(report.proposedPublic, [
    'testing/fixtures/design/io/display-p3-mid-icc.png',
    'testing/fixtures/design/io/lossless.webp',
    'testing/fixtures/design/io/orientation-6.jpg',
  ])
  assert.equal(report.review.hashMismatch, 0)
  assert.deepEqual(report.unboundSourceEntries, [])
  assert.deepEqual(report.missingListed, [])
  assert.equal(report.files.every(file => file.nearestLicenseApplied === false), true)
  assert.equal(report.files.every(file => file.publication === 'public' || (file.license === null && file.licenseStatus === 'not_granted')), true)
  for (const file of report.files.filter(item => item.publication === 'public')) {
    assert.equal(file.license, 'MIT')
    assert.equal(file.licenseStatus, 'granted')
    assert.equal(file.copyright, 'Copyright (c) 2026 Cookieboty and contributors')
    assert.equal(file.source, syntheticSource)
    assert.equal(file.hashCheck, 'match')
    assert.equal(file.contentBytesReviewed, true)
    assert.match(file.attribution, /generate\.py/)
  }
  const sketch = report.files.find(file => file.path === 'testing/fixtures/user-regression-20261109/117.sketch')
  assert.equal(sketch.record, 'lfs_oid_matches_manifest')
  assert.equal(sketch.publication, 'withhold')
  assert.equal(sketch.hashCheck, 'pointer_oid_match')
  assert.equal(sketch.contentBytesReviewed, false)
  assert.match(sketch.source, /Downloads/)
  assert.equal(sketch.lfsOid, 'd494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70')
  const fidelity = report.files.filter(file => file.path.startsWith('frontend/design-client/public/fidelity/'))
  assert.equal(fidelity.length, 349)
  assert.equal(fidelity.every(file => file.publication === 'withhold'), true)
  const alpha = report.files.find(file => file.path === 'frontend/design-client/public/fidelity/alpha-curve.png')
  assert.equal(alpha.record, 'source_list_omits_file')
  assert.equal(alpha.hashCheck, 'not_listed')
  assert.equal(alpha.license, null)
  const mask = report.files.find(file => file.path === 'frontend/design-client/public/fidelity/mask-overlap.png')
  assert.equal(mask.record, 'source_list_hash_match')
  assert.match(mask.source, /Figma desktop native/)
  assert.equal(mask.publication, 'withhold')
  const fig = report.files.find(file => file.path === 'testing/fixtures/design/figma-materials-native-2026-10-08.fig')
  assert.equal(fig.hashCheck, 'match')
  assert.match(fig.source, /nativeFigSha256/)
  assert.equal(fig.publication, 'withhold')
  const vector = report.files.find(file => file.path === 'testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/vector.fig')
  assert.equal(vector.observedLicense, 'MIT')
  assert.equal(vector.publication, 'withhold')
  assert.equal(vector.source, 'https://github.com/sketch-hq/fig2sketch')
  const semantic = report.files.find(file => file.path === 'testing/fixtures/sketch-public-20261105/semantic-ui-kit-for-sketch/semantic-ui-kit.sketch')
  assert.equal(semantic.observedLicense, 'CC0-1.0')
  assert.equal(semantic.source, 'https://github.com/guacamoly/semantic-ui-kit-for-sketch')
  assert.match(semantic.attribution, /Lato/)
  assert.equal(semantic.publication, 'withhold')
  const logos = report.files.find(file => file.path === 'testing/fixtures/sketch-public-20261105/ui-design-kit/WFP Logos.sketch')
  assert.equal(logos.source, 'https://github.com/wfp/ui-design-kit')
  assert.equal(logos.license, null)
  assert.match(logos.attribution, /logos/i)
  const imageMetadata = await readFile(new URL('../design-studio/crates/design-kernel/tests/image_metadata.rs', import.meta.url), 'utf8')
  const ioCheck = await readFile(new URL('../frontend/design-client/scripts/check-io-import.ts', import.meta.url), 'utf8')
  for (const name of ['orientation-6.jpg', 'display-p3-mid-icc.png']) assert.match(imageMetadata, new RegExp(name.replaceAll('.', '\\.')))
  assert.equal(imageMetadata.includes('user-regression'), false)
  assert.equal(imageMetadata.includes('public/fidelity'), false)
  for (const rel of report.proposedPublic) assert.match(ioCheck, new RegExp(path.posix.basename(rel).replaceAll('.', '\\.')))
  const committed = JSON.parse(await readFile(new URL('../docs/publication/asset-inventory.json', import.meta.url), 'utf8'))
  assert.deepEqual(committed, report)
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
    assert.equal(mark.observedLicense, 'MIT')
    assert.equal(mark.publication, 'withhold')
    assert.equal(mark.license, null)
    assert.equal(mark.record, 'upstream_notice_unverified')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an explicit synthetic grant is rejected when the checkout bytes differ', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-grant-'))
  try {
    const dir = path.join(root, 'testing/fixtures/design/io')
    await mkdir(dir, { recursive: true })
    await mkdir(path.join(root, 'frontend/design-client/public/fidelity'), { recursive: true })
    await mkdir(path.join(root, 'docs/publication'), { recursive: true })
    const bytes = Buffer.from('synthetic-pixels')
    const sha = createHash('sha256').update(bytes).digest('hex')
    await writeFile(path.join(dir, 'sample.png'), bytes)
    await writeFile(path.join(dir, 'provenance.json'), `${JSON.stringify({
      source: syntheticSource,
      generator: 'generate.py',
      images: [{ file: 'sample.png', sha256: sha, bytes: bytes.length }],
    }, null, 2)}\n`)
    await writeFile(path.join(root, 'LICENSE'), 'MIT License\nCopyright (c) 2026 Cookieboty and contributors\n')
    const grant = {
      schema: 1,
      files: [{
        path: 'testing/fixtures/design/io/sample.png',
        sha256: sha,
        source: syntheticSource,
        attribution: 'Project-authored sample from generate.py.',
        license: 'MIT',
        copyright: 'Copyright (c) 2026 Cookieboty and contributors',
        provenance: 'testing/fixtures/design/io/provenance.json',
      }],
    }
    await writeFile(path.join(root, 'docs/publication/explicit-grants.json'), `${JSON.stringify(grant, null, 2)}\n`)
    const accepted = await inventoryPublicationAssets(root)
    assert.deepEqual(accepted.proposedPublic, ['testing/fixtures/design/io/sample.png'])
    await writeFile(path.join(dir, 'sample.png'), Buffer.from('synthetic-pixels-changed'))
    const rejected = await inventoryPublicationAssets(root)
    assert.deepEqual(rejected.proposedPublic, [])
    const sample = rejected.files.find(file => file.path.endsWith('sample.png'))
    assert.equal(sample.record, 'explicit_grant_rejected')
    assert.equal(sample.publication, 'withhold')
    assert.equal(sample.license, null)
    const parsed = new Map([['testing/fixtures/design/io/provenance.json', JSON.parse(await readFile(path.join(dir, 'provenance.json'), 'utf8'))]])
    const decision = await evaluateGrant({ ...grant.files[0], license: 'CC0-1.0' }, { path: grant.files[0].path, checkoutSha256: sha, lfs: null }, root, parsed)
    assert.equal(decision.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
