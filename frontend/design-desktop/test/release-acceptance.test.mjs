import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ffmpegProvenance } from '../scripts/ffmpeg-provenance.mjs'
import { DESKTOP_FLOW, buildDesktopFlowReport, inspectReleasePackage } from '../scripts/release-desktop-flow.mjs'
import { asarFromFiles, buildComponentInventory, readAsarEntries } from '../scripts/release-component-inventory.mjs'

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

test('component inventory maps packaged inputs and keeps the lockfile out of the shipped list', () => {
  const report = buildComponentInventory({ releaseDir: '/tmp/futureox-release-missing', electronDist: null })
  assert.equal(report.scope, 'packaging_inputs_not_a_signed_release')
  assert.equal(report.releaseAcceptance, 'not_closed')
  assert.equal(report.formalSignedPackage, 'not_supplied')
  assert.equal(report.macElectronMetal, 'not_run')
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(report.electron.version, '44.7.0')
  assert.equal(report.electron.chromiumBinaryHashed, false)
  assert.equal(report.electron.npmPackageDistributed, false)
  assert.equal(report.measurement.electronDistributionFiles, 0)
  assert.equal(report.measurement.nativeBinariesHashed, 0)
  assert.ok(report.notDistribution.cargoLockNameEntries > report.measurement.distributedRustCrates)
  assert.ok(report.notDistribution.notDistributedLockPackages > 50)
  assert.match(report.notDistribution.note, /not the files inside a release package/)
  const shipped = new Set(report.rust.crates.map(crate => crate.id))
  for (const absent of ['utoipa@6.0.0', 'sqlx-postgres@0.9.0', 'sqlx-mysql@0.9.0', 'tiny-skia@0.12.0', 'futureox-design-server@0.1.0']) {
    assert.equal(shipped.has(absent), false, absent)
  }
  for (const present of ['moxcms@0.8.1', 'moxcms@0.9.1', 'flo_curves@0.8.1', 'wasm-bindgen@0.2.130', 'im@15.1.0']) {
    assert.equal(report.rust.crates.find(crate => crate.id === present)?.traceable, true, present)
  }
  assert.deepEqual(report.rust.crates.find(crate => crate.id === 'same-file@1.0.6').platforms, ['x86_64-pc-windows-msvc'])
  const spirv = report.rust.crates.find(crate => crate.id === 'spirv@0.4.0+sdk-1.4.341.0')
  assert.equal(spirv.traceable, false)
  assert.equal(spirv.platforms.includes('aarch64-apple-darwin'), false)
  assert.equal(spirv.platforms.includes('x86_64-unknown-linux-gnu'), true)
  for (const gap of ['profiling@1.0.18', 'objc2@0.6.5', 'block2@0.6.2']) {
    assert.equal(report.rust.crates.find(crate => crate.id === gap).traceable, false, gap)
  }
  assert.equal(report.notices.every(item => item.matchesInventory), true)
  assert.equal(report.ffmpeg.sha256, ffmpegProvenance({ runBinary: false }).binarySha256)
  assert.equal(report.ffmpeg.license, 'GPL-3.0-or-later')
  assert.equal(report.ffmpeg.traceable, true)
  assert.equal(report.ffmpeg.correspondingSource.every(item => item.matchesRecord), true)
  assert.equal(report.javascript.distributed.every(item => item.traceable), true)
  assert.equal(report.javascript.developmentOnly.includes('vite'), true)
  assert.equal(report.javascript.developmentOnly.includes('lightningcss'), true)
  assert.equal(report.javascript.developmentOnly.includes('@playwright/test'), true)
  assert.equal(report.javascript.developmentOnly.includes('@electron/packager'), true)
  assert.equal(report.javascript.developmentOnly.includes('electron'), false)
  assert.equal(report.javascript.developmentOnly.includes('react'), false)
  assert.equal(report.javascript.distributed.some(item => item.package === 'quickjs-emscripten' && item.version === '0.32.0'), true)
  assert.equal(report.javascript.unresolvedImports.length, 0)
  assert.equal(report.javascript.generatedBindingsStatus, 'not_in_checkout')
  assert.equal(report.fonts.every(font => font.traceable), true)
  assert.ok(report.fonts.length >= 16)
  assert.equal(report.icons.every(icon => icon.traceable && icon.license === 'MIT'), true)
  assert.equal(report.unresolvedPackageInputs.map(item => item.path).sort().join(','), [
    'frontend/design-client/public/color-fixtures/hlg-highlights.png',
    'frontend/design-client/public/color-fixtures/p3-red-icc.png',
    'frontend/design-client/public/color-fixtures/pq-highlights.png',
  ].join(','))
  assert.equal(report.fidelityFilesExcluded, 349)
  assert.ok(report.measurement.traceableThirdPartyComponents > 200)
  assert.equal(report.nativeBinaries.every(item => item.status === 'not_built'), true)
  const moxcms08 = report.rust.crates.find(crate => crate.id === 'moxcms@0.8.1')
  const moxcms09 = report.rust.crates.find(crate => crate.id === 'moxcms@0.9.1')
  assert.deepEqual(moxcms08.notices.map(item => item.sha256).sort(), moxcms09.notices.map(item => item.sha256).sort())
  const cargoSrc = path.join(process.env.CARGO_HOME || '', 'registry/src')
  assert.equal(existsSync(cargoSrc), true, 'this acceptance run needs the cargo registry that cargo tree downloaded')
  let compared = 0
  for (const crate of report.rust.crates) {
    if (!crate.traceable || !String(crate.source).startsWith('registry+')) continue
    const hosts = readdirSync(cargoSrc)
    const dir = hosts.map(host => path.join(cargoSrc, host, `${crate.name}-${crate.version}`)).find(candidate => existsSync(candidate))
    assert.ok(dir, crate.id)
    const marker = `${crate.name}/${crate.version}/`
    for (const notice of crate.notices) {
      const relative = notice.path.slice(notice.path.indexOf(marker) + marker.length)
      const digest = createHash('sha256').update(readFileSync(path.join(dir, relative))).digest('hex')
      assert.equal(digest, notice.sha256, `${crate.id} ${relative}`)
      compared += 1
    }
  }
  assert.ok(compared > 400)
})

test('an asar entry is tied to a package input only when the bytes match', () => {
  const payload = Buffer.from('license-text')
  const archive = asarFromFiles([{ path: 'licenses/example.txt', bytes: payload }])
  const entries = readAsarEntries(archive)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, 'licenses/example.txt')
  assert.equal(entries[0].sha256, createHash('sha256').update(payload).digest('hex'))
  assert.equal(readAsarEntries(Buffer.from('not-an-asar')), null)
})

test('a release directory does not become a closed installer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-components-'))
  try {
    const font = path.join(root, 'NotoSansSC.ttf')
    await writeFile(font, await readFile(new URL('../../design-client/public/fonts/NotoSansSC.ttf', import.meta.url)))
    const extra = path.join(root, 'unknown.bin')
    await writeFile(extra, Buffer.from('not-a-shipped-component'))
    const report = buildComponentInventory({ releaseDir: root, electronDist: null })
    assert.equal(report.releaseAcceptance, 'not_closed')
    assert.equal(report.formalSignedPackage, 'not_supplied')
    const noto = report.releaseFiles.files.find(file => file.path === 'NotoSansSC.ttf')
    assert.equal(noto.matchesPackageInput, 'frontend/design-client/public/fonts/NotoSansSC.ttf')
    assert.deepEqual(report.unmappedReleaseFiles, ['unknown.bin'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('packaging copies the cargo notice directory next to the other extra resources', async () => {
  const source = await readFile(new URL('../scripts/package.mjs', import.meta.url), 'utf8')
  assert.match(source, /third-party-notices/)
  assert.equal(existsSync(new URL('../third-party-notices/cargo/serde/1.0.229', import.meta.url)), true)
})

test('the unpacked Electron distribution is hashed only when that directory is supplied', { skip: !process.env.FUTUREOX_ELECTRON_DIST }, async () => {
  const dist = process.env.FUTUREOX_ELECTRON_DIST
  const report = buildComponentInventory({ releaseDir: '/tmp/futureox-release-missing', electronDist: dist })
  assert.equal(report.electron.version, '44.7.0')
  assert.equal(report.electron.distribution.version, '44.7.0')
  assert.equal(report.electron.chromiumBinaryHashed, true)
  assert.equal(report.electron.distribution.signedFutureoxPackage, false)
  assert.equal(report.electron.distribution.traceable, true)
  assert.equal(report.releaseAcceptance, 'not_closed')
  assert.ok(report.measurement.electronDistributionFiles > 50)
  const binary = report.electron.distribution.binary
  assert.equal(binary.path, 'electron')
  assert.equal(binary.sha256, createHash('sha256').update(await readFile(path.join(dist, 'electron'))).digest('hex'))
  const license = report.electron.distribution.notices.find(item => item.path === 'LICENSE')
  assert.equal(license.sha256, createHash('sha256').update(await readFile(path.join(dist, 'LICENSE'))).digest('hex'))
  assert.equal(report.electron.distribution.chromiumFfmpeg.path, 'libffmpeg.so')
  assert.notEqual(report.electron.distribution.chromiumFfmpeg.sha256, report.ffmpeg.sha256)
  if (process.env.FUTUREOX_ELECTRON_ZIP) {
    const zip = createHash('sha256').update(await readFile(process.env.FUTUREOX_ELECTRON_ZIP)).digest('hex')
    assert.equal(zip, '3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a')
  }
})
