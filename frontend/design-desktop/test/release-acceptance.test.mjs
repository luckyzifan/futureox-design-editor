import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ffmpegProvenance } from '../scripts/ffmpeg-provenance.mjs'
import { DESKTOP_FLOW, buildDesktopFlowReport, inspectReleasePackage } from '../scripts/release-desktop-flow.mjs'
import { buildComponentInventory } from '../scripts/release-component-inventory.mjs'

test('vendored linux ffmpeg matches the rebuilt corresponding source', () => {
  const report = ffmpegProvenance()
  assert.deepEqual(report.problems, [])
  assert.equal(report.bannerChecked, process.platform === 'linux' && process.arch === 'x64')
  assert.equal(report.correspondingSourceInRepo, true)
  assert.equal(report.rebuiltFromSource, true)
  assert.equal(report.confirmedRuntimeFault, false)
  assert.deepEqual(report.sources.map(item => [item.name, item.version, item.sha256]), [
    ['ffmpeg', 'n7.0.2', '5eb46d18d664a0ccadf7b0adee03bd3b7fa72893d667f36c69e202a807e6d533'],
    ['libvpx', '1.15.2', '26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa'],
    ['x264', 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', 'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9'],
  ])
})

test('a missing release package leaves every desktop step not_run', async () => {
  const report = buildDesktopFlowReport({ packagePath: '/tmp/futureox-release-missing', platform: 'linux', arch: 'x64' })
  assert.equal(report.package.status, 'missing_environment')
  assert.equal(report.releaseAcceptance, 'not_closed')
  assert.equal(report.confirmedRuntimeFault, false)
  assert.deepEqual(report.steps.map(step => step.id), DESKTOP_FLOW)
  assert.equal(report.steps.every(step => step.status === 'not_run'), true)
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-'))
  try {
    const file = path.join(root, 'Futureox.dmg')
    await writeFile(file, 'not-a-real-installer')
    const hashed = inspectReleasePackage(file)
    assert.equal(hashed.present, true)
    assert.equal(hashed.files, 1)
    const withPackage = buildDesktopFlowReport({ packagePath: file })
    assert.equal(withPackage.package.status, 'hashed_not_installed')
    assert.equal(withPackage.steps.every(step => step.status === 'not_run'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('component inventory keeps cargo and electron out of the shipped list', () => {
  const report = buildComponentInventory({ releaseDir: '/tmp/futureox-release-missing' })
  assert.equal(report.scope, 'packaging_inputs_not_a_release_bundle')
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(report.electron.version, '44.7.0')
  assert.equal(report.electron.chromiumBinaryHashed, false)
  assert.ok(report.notDistribution.cargoLockNameEntries > 0)
  assert.match(report.notDistribution.note, /not the files inside a release package/)
  assert.equal(report.notices.every(item => item.matchesInventory), true)
  assert.equal(report.ffmpeg.sha256, ffmpegProvenance({ runBinary: false }).binarySha256)
  assert.equal(report.ffmpeg.license, 'GPL-3.0-or-later')
  assert.equal(report.ffmpeg.correspondingSourceInRepo, true)
  assert.ok(report.designMcpSourceCount > 0)
})
