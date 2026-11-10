import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { ffmpegProvenance } from '../scripts/ffmpeg-provenance.mjs'
import { DESKTOP_FLOW, buildDesktopFlowReport, inspectReleasePackage } from '../scripts/release-desktop-flow.mjs'
import { asarFromFiles, buildComponentInventory, readAsarEntries } from '../scripts/release-component-inventory.mjs'
import { hashPackageIdentity, verifyDeclaredResourceList, writeAsarArchive, writeUnsignedResourceList } from '../scripts/release-package-resources.mjs'

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
  assert.equal(report.steps.every(step => step.packageSha256 === null && step.platform === 'linux' && step.arch === 'x64'), true)
  assert.equal(report.evidence.formalRelease, false)
  assert.equal(report.resources.status, 'not_run')
  assert.equal(report.originals.status, 'not_run')
  assert.equal(report.originals.appSession, 'not_run')
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-'))
  try {
    const file = path.join(root, 'Futureox.dmg')
    const bytes = Buffer.from('not-a-real-installer')
    await writeFile(file, bytes)
    const hashed = inspectReleasePackage(file)
    assert.equal(hashed.present, true)
    assert.equal(hashed.files, 1)
    assert.equal(hashed.sha256, createHash('sha256').update(bytes).digest('hex'))
    const withPackage = buildDesktopFlowReport({ packagePath: file, platform: 'linux', arch: 'x64' })
    assert.equal(withPackage.package.status, 'hashed_not_installed')
    assert.equal(withPackage.package.sha256, hashed.sha256)
    assert.equal(withPackage.evidence.kind, 'unopened_installer')
    assert.equal(withPackage.evidence.formalRelease, false)
    assert.equal(withPackage.evidence.signature, 'not_run')
    assert.equal(withPackage.resources.status, 'not_inspected')
    assert.equal(withPackage.resources.counts.js, 0)
    assert.equal(withPackage.resources.counts.wasm, 0)
    assert.equal(withPackage.resources.counts.native, 0)
    assert.equal(withPackage.releaseAcceptance, 'not_closed')
    assert.equal(withPackage.failed, false)
    assert.equal(withPackage.steps.every(step => step.status === 'not_run' && step.packageSha256 === hashed.sha256 && step.evidenceKind === 'unopened_installer'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function legacyConcatHash(name, contents) {
  return createHash('sha256').update(name).update(contents).digest('hex')
}

test('directory package identity no longer concatenates path and bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-hash-'))
  try {
    const left = path.join(root, 'tree-a')
    const right = path.join(root, 'tree-b')
    await mkdir(left)
    await mkdir(right)
    await writeFile(path.join(left, 'a'), 'bc')
    await writeFile(path.join(right, 'ab'), 'c')
    const legacyLeft = legacyConcatHash('a', 'bc')
    const legacyRight = legacyConcatHash('ab', 'c')
    assert.equal(legacyLeft, legacyRight)
    assert.equal(legacyLeft, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const nextLeft = hashPackageIdentity(left)
    const nextRight = hashPackageIdentity(right)
    assert.equal(nextLeft.status, 'hashed')
    assert.equal(nextRight.status, 'hashed')
    assert.notEqual(nextLeft.sha256, nextRight.sha256)
    assert.notEqual(nextLeft.sha256, legacyLeft)
    await writeFile(path.join(left, 'a'), 'bd')
    assert.notEqual(hashPackageIdentity(left).sha256, nextLeft.sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop-dev bundle lists JS WASM and native bytes without closing release acceptance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-bundle-'))
  try {
    const bundle = path.join(root, 'unsigned-bundle')
    const resources = path.join(bundle, 'resources')
    const runtime = path.join(root, 'runtime')
    const js = 'export const editor = 1\n'
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    const native = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])
    await mkdir(path.join(resources, 'app/src'), { recursive: true })
    await mkdir(path.join(resources, 'app/renderer'), { recursive: true })
    await mkdir(path.join(resources, 'sidecar'), { recursive: true })
    await mkdir(path.join(resources, 'bin'), { recursive: true })
    await writeFile(path.join(resources, 'app/src/main.mjs'), js)
    await writeFile(path.join(resources, 'app/renderer/kernel.wasm'), wasm)
    await writeFile(path.join(resources, 'sidecar/futureox-design-desktop-backend'), native)
    await writeFile(path.join(resources, 'bin/design-render'), native)
    await mkdir(path.join(runtime, 'src'), { recursive: true })
    await mkdir(path.join(runtime, 'renderer'), { recursive: true })
    await mkdir(path.join(runtime, 'sidecar'), { recursive: true })
    await mkdir(path.join(runtime, 'bin'), { recursive: true })
    await writeFile(path.join(runtime, 'src/main.mjs'), js)
    await writeFile(path.join(runtime, 'renderer/kernel.wasm'), wasm)
    await writeFile(path.join(runtime, 'sidecar/futureox-design-desktop-backend'), native)
    await writeFile(path.join(runtime, 'bin/design-render'), native)
    await writeFile(path.join(resources, 'build-manifest.json'), JSON.stringify({ profile: 'desktop-dev', platform: 'linux', arch: 'x64' }))
    const original = path.join(root, 'original.fd')
    const originalBytes = Buffer.from('synthetic-readonly-bytes')
    await writeFile(original, originalBytes)
    const before = await readFile(original)
    const report = buildDesktopFlowReport({
      packagePath: bundle,
      platform: 'linux',
      arch: 'x64',
      runtimeRoot: runtime,
      originalPaths: [original],
    })
    assert.equal(report.evidence.kind, 'unsigned_development_bundle')
    assert.equal(report.evidence.profile, 'desktop-dev')
    assert.equal(report.evidence.formalRelease, false)
    assert.equal(report.evidence.signature, 'not_run')
    assert.equal(report.releaseAcceptance, 'not_closed')
    assert.equal(report.confirmedRuntimeFault, false)
    assert.equal(report.resources.status, 'listed')
    assert.equal(report.resources.installRoot, 'resources')
    assert.equal(report.resources.counts.js, 1)
    assert.equal(report.resources.counts.wasm, 1)
    assert.equal(report.resources.counts.native, 2)
    const wasmEntry = report.resources.entries.find(entry => entry.installPath === 'app/renderer/kernel.wasm')
    assert.equal(wasmEntry.sha256, createHash('sha256').update(wasm).digest('hex'))
    assert.equal(report.resources.comparison.status, 'byte_match')
    assert.equal(report.resources.comparison.byteMatches.length, 4)
    assert.equal(report.resources.comparison.byteMismatches.length, 0)
    assert.equal(report.resources.declaredVersusBytes.status, 'not_run')
    assert.equal(report.steps.every(step => step.status === 'not_run'), true)
    assert.equal(report.steps.every(step => step.packageSha256 === report.package.sha256 && step.platform === 'linux'), true)
    assert.equal(report.originals.status, 'script_readonly')
    assert.equal(report.originals.appSession, 'not_run')
    assert.equal(report.originals.files[0].unchanged, true)
    assert.equal(report.originals.files[0].sha256Before, createHash('sha256').update(originalBytes).digest('hex'))
    assert.equal(report.originals.files[0].sha256Before, report.originals.files[0].sha256After)
    assert.deepEqual(await readFile(original), before)
    assert.equal(report.failed, false)
    const step = report.steps.find(item => item.id === 'original_design_sha_unchanged')
    assert.equal(step.status, 'not_run')

    await writeFile(path.join(runtime, 'renderer/kernel.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x01]))
    const mismatch = buildDesktopFlowReport({ packagePath: bundle, platform: 'linux', arch: 'x64', runtimeRoot: runtime })
    assert.equal(mismatch.resources.comparison.status, 'byte_mismatch')
    assert.equal(mismatch.resources.comparison.byteMismatches.length, 1)
    assert.equal(mismatch.resources.comparison.byteMismatches[0].path, 'renderer/kernel.wasm')
    assert.notEqual(mismatch.resources.comparison.byteMismatches[0].packageSha256, mismatch.resources.comparison.byteMismatches[0].runtimeSha256)
    assert.equal(mismatch.steps.every(item => item.status === 'not_run'), true)
    assert.equal(mismatch.releaseAcceptance, 'not_closed')
    assert.equal(mismatch.failed, true)
    assert.deepEqual(await readFile(original), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('asar resources are hashed from archive bytes and a lied list fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-asar-'))
  try {
    const bundle = path.join(root, 'bundle')
    const resources = path.join(bundle, 'resources')
    await mkdir(resources, { recursive: true })
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x02])
    const js = Buffer.from('export const packaged = true\n')
    await writeAsarArchive(path.join(resources, 'app.asar'), [
      { path: 'renderer/kernel.wasm', data: wasm },
      { path: 'src/main.mjs', data: js },
    ])
    await writeFile(path.join(resources, 'build-manifest.json'), JSON.stringify({ profile: 'release', platform: 'darwin', arch: 'arm64' }))
    const report = buildDesktopFlowReport({ packagePath: bundle, platform: 'linux', arch: 'x64' })
    assert.equal(report.evidence.kind, 'unsigned_release_profile_bundle')
    assert.equal(report.evidence.formalRelease, false)
    assert.equal(report.evidence.signature, 'not_run')
    assert.equal(report.evidence.packagePlatform, 'darwin')
    assert.match(report.evidence.note, /not the recorded package platform/)
    assert.equal(report.resources.counts.wasm, 1)
    assert.equal(report.resources.entries.find(entry => entry.installPath === 'app.asar/renderer/kernel.wasm').sha256, createHash('sha256').update(wasm).digest('hex'))
    assert.equal(report.steps.every(step => step.status === 'not_run'), true)
    assert.equal(report.releaseAcceptance, 'not_closed')

    const entries = report.resources.entries.map(entry => ({ ...entry }))
    const list = {
      schema: 1,
      role: 'unsigned_development_bundle_inputs',
      formalRelease: false,
      signature: 'not_run',
      profile: 'release',
      platform: 'darwin',
      arch: 'arm64',
      entries,
    }
    await writeFile(path.join(resources, 'resource-list.json'), JSON.stringify(list))
    const agreed = buildDesktopFlowReport({ packagePath: bundle, platform: 'linux', arch: 'x64' })
    assert.equal(agreed.resources.declaredVersusBytes.status, 'match')
    list.entries.find(entry => entry.installPath === 'app.asar/renderer/kernel.wasm').sha256 = '0'.repeat(64)
    await writeFile(path.join(resources, 'resource-list.json'), JSON.stringify(list))
    const lied = buildDesktopFlowReport({ packagePath: bundle, platform: 'linux', arch: 'x64' })
    assert.equal(lied.resources.declaredVersusBytes.status, 'mismatch')
    assert.equal(lied.failed, true)
    assert.equal(lied.releaseAcceptance, 'not_closed')
    assert.equal(lied.steps.every(step => step.status === 'not_run'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resource list writer and verifier reject a formal claim and a stale WASM hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-list-'))
  try {
    const desktop = path.join(root, 'desktop')
    const staging = path.join(desktop, 'dist/package-app')
    await mkdir(path.join(staging, 'src'), { recursive: true })
    await mkdir(path.join(desktop, 'dist/bin'), { recursive: true })
    await mkdir(path.join(desktop, 'dist/sidecar'), { recursive: true })
    const js = 'export const host = 1\n'
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d])
    const native = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
    await writeFile(path.join(staging, 'src/main.mjs'), js)
    await writeFile(path.join(staging, 'renderer.wasm'), wasm)
    await writeFile(path.join(desktop, 'dist/sidecar/futureox-design-desktop-backend'), native)
    await writeFile(path.join(desktop, 'dist/build-manifest.json'), JSON.stringify({ profile: 'release', platform: 'linux', arch: 'x64' }))
    const list = writeUnsignedResourceList({ staging, desktop, platform: 'linux', arch: 'x64' })
    assert.equal(list.formalRelease, false)
    assert.equal(list.signature, 'not_run')
    assert.equal(list.profile, 'release')
    const resources = path.join(root, 'resources')
    await mkdir(path.join(resources, 'bin'), { recursive: true })
    await mkdir(path.join(resources, 'sidecar'), { recursive: true })
    await writeFile(path.join(resources, 'sidecar/futureox-design-desktop-backend'), native)
    const check = () => verifyDeclaredResourceList(JSON.parse(JSON.stringify(list)), {
      appRoot: staging,
      resourcesRoot: resources,
      profile: 'release',
      platform: 'linux',
      arch: 'x64',
    })
    assert.equal(check().formalRelease, false)
    list.formalRelease = true
    assert.throws(() => verifyDeclaredResourceList(list, { appRoot: staging, resourcesRoot: resources, profile: 'release', platform: 'linux', arch: 'x64' }), /formalRelease/)
    list.formalRelease = false
    list.entries.find(entry => entry.installPath === 'app.asar/renderer.wasm').sha256 = 'f'.repeat(64)
    assert.throws(() => verifyDeclaredResourceList(list, { appRoot: staging, resourcesRoot: resources, profile: 'release', platform: 'linux', arch: 'x64' }), /does not match packaged bytes/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package identity does not follow a symlink to an original file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-link-'))
  try {
    const bundle = path.join(root, 'bundle')
    await mkdir(bundle)
    const original = path.join(root, 'original.fd')
    await writeFile(original, 'do-not-follow')
    await symlink(original, path.join(bundle, 'alias.fd'))
    const first = hashPackageIdentity(bundle)
    await writeFile(original, 'changed-outside')
    const second = hashPackageIdentity(bundle)
    assert.equal(first.sha256, second.sha256)
    assert.equal(await readFile(original, 'utf8'), 'changed-outside')
    const report = buildDesktopFlowReport({ packagePath: path.join(root, 'alias-top'), platform: 'linux', arch: 'x64' })
    await symlink(bundle, path.join(root, 'alias-top'))
    const linked = buildDesktopFlowReport({ packagePath: path.join(root, 'alias-top'), platform: 'linux', arch: 'x64' })
    assert.equal(report.package.status, 'missing_environment')
    assert.equal(linked.evidence.kind, 'rejected_symlink')
    assert.equal(linked.package.sha256, null)
    assert.equal(linked.failed, true)
    assert.equal(linked.steps.every(step => step.status === 'not_run'), true)
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
  assert.equal(report.packageResources.status, 'not_run')
  assert.equal(report.packageResources.formalRelease, false)
  assert.equal(report.unmappedReleaseFiles, 'no release bundle to map')
  assert.equal(report.electron.version, '44.7.0')
  assert.equal(report.electron.chromiumBinaryHashed, false)
  assert.equal(report.electron.npmPackageDistributed, false)
  assert.equal(report.measurement.electronDistributionFiles, 0)
  const distRoot = path.resolve(import.meta.dirname, '../dist')
  let built = 0
  for (const relative of ['sidecar/futureox-design-desktop-backend', 'bin/design-render', 'bin/design-prepare', 'bin/futureox-design-agent']) {
    const file = path.join(distRoot, relative)
    const row = report.nativeBinaries.find(item => item.path === relative)
    if (existsSync(file)) {
      built++
      assert.equal(row.status, 'hashed_build_output')
      assert.equal(row.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'))
    } else assert.equal(row.status, 'not_built')
  }
  assert.equal(report.measurement.nativeBinariesHashed, built)
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
  assert.equal(report.javascript.generatedBindingsStatus,
    existsSync(path.resolve(import.meta.dirname, '../../design-client/src/generated/design-kernel/design_kernel.js')) ? 'present' : 'not_in_checkout')
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
  const moxcms08 = report.rust.crates.find(crate => crate.id === 'moxcms@0.8.1')
  const moxcms09 = report.rust.crates.find(crate => crate.id === 'moxcms@0.9.1')
  assert.deepEqual(moxcms08.notices.map(item => item.sha256).sort(), moxcms09.notices.map(item => item.sha256).sort())
  const cargoSrc = path.join(process.env.CARGO_HOME || path.join(homedir(), '.cargo'), 'registry/src')
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
  assert.ok(['electron', 'electron.exe', 'Electron.app/Contents/MacOS/Electron'].includes(binary.path))
  assert.equal(binary.sha256, createHash('sha256').update(await readFile(path.join(dist, binary.path))).digest('hex'))
  const license = report.electron.distribution.notices.find(item => item.path === 'LICENSE')
  assert.equal(license.sha256, createHash('sha256').update(await readFile(path.join(dist, 'LICENSE'))).digest('hex'))
  assert.match(report.electron.distribution.chromiumFfmpeg.path, /(?:libffmpeg\.so|libffmpeg\.dylib|ffmpeg\.dll)$/)
  assert.notEqual(report.electron.distribution.chromiumFfmpeg.sha256, report.ffmpeg.sha256)
  if (process.env.FUTUREOX_ELECTRON_ZIP) {
    const zip = createHash('sha256').update(await readFile(process.env.FUTUREOX_ELECTRON_ZIP)).digest('hex')
    assert.equal(zip, '3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a')
  }
})


test('component inventory lists bundle JS and WASM without calling them a closed SBOM', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-release-inventory-'))
  try {
    const resources = path.join(root, 'resources/app/renderer')
    await mkdir(resources, { recursive: true })
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01])
    await writeFile(path.join(resources, 'kernel.wasm'), wasm)
    const report = buildComponentInventory({ releaseDir: root, electronDist: null })
    assert.equal(report.scope, 'release_directory_hashed_not_a_signed_installer')
    assert.equal(report.packageResources.formalRelease, false)
    assert.equal(report.packageResources.status, 'listed')
    assert.equal(report.packageResources.counts.wasm, 1)
    assert.equal(report.packageResources.entries.find(entry => entry.installPath === 'app/renderer/kernel.wasm').sha256, createHash('sha256').update(wasm).digest('hex'))
    assert.equal(report.notDistribution.note.includes('not the files inside a release package'), true)
    assert.equal(report.electron.chromiumBinaryHashed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
