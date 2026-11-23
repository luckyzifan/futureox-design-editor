import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildDesktopFlowReport, DESKTOP_FLOW } from '../scripts/release-desktop-flow.mjs'
import { bundleExecutable, retainDisplayAuthority } from '../scripts/release-desktop-session.mjs'
import {
  assessObservedDesktopSession,
  bindInstalledDeb,
  bindInstalledDmg,
  inspectHostSignature,
  officialPackageBlockers,
  parseCodesignDisplay,
  planReleaseLaunch,
} from '../scripts/release-session-report.mjs'
import { describePackage, hashReadonlyFile } from '../scripts/release-package-resources.mjs'

const HASH_A = 'a'.repeat(64)
const SHA = 'c'.repeat(64)

test('a private home keeps the current X11 display authority outside that home', () => {
  const privateHome = '/tmp/futureox-release-home'
  const cookie = '/home/operator/.Xauthority'
  const retained = retainDisplayAuthority({
    DISPLAY: ':1',
    HOME: '/home/operator',
    FUTUREOX_ACCEPTANCE_PROFILE: '/tmp/profile',
  }, privateHome, cookie, 'linux')
  assert.equal(retained.HOME, privateHome)
  assert.equal(retained.XAUTHORITY, cookie)
  assert.equal(retained.XDG_CONFIG_HOME, path.join(privateHome, '.config'))
  assert.equal(retained.DISPLAY, ':1')
  assert.equal(retained.FUTUREOX_ACCEPTANCE_PROFILE, undefined)

  const preset = retainDisplayAuthority({
    DISPLAY: ':1',
    XAUTHORITY: 'cookies',
    HOME: '/home/operator',
  }, privateHome, cookie, 'linux')
  assert.equal(preset.XAUTHORITY, path.resolve('cookies'))
  assert.notEqual(preset.XAUTHORITY, cookie)

  const headless = retainDisplayAuthority({ HOME: '/home/operator' }, privateHome, cookie, 'linux')
  assert.equal(headless.XAUTHORITY, undefined)
  assert.equal(headless.HOME, privateHome)

  const mac = retainDisplayAuthority({ HOME: '/Users/operator', DISPLAY: ':1' }, privateHome, cookie, 'darwin')
  assert.equal(mac.HOME, '/Users/operator')
  assert.equal(mac.CFFIXED_USER_HOME, privateHome)
  assert.equal(mac.XAUTHORITY, undefined)
})

test('a mounted macOS app and its containing directory resolve the same executable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-macos-app-'))
  try {
    const app = path.join(root, 'futureox-desgin.app')
    const executable = path.join(app, 'Contents', 'MacOS', 'futureox-desgin')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, 'fixture')
    assert.equal(bundleExecutable(app, 'darwin'), executable)
    assert.equal(bundleExecutable(root, 'darwin'), executable)
    assert.equal(bundleExecutable(root, 'linux'), path.join(root, 'futureox-desgin'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function bundle(profile) {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-session-plan-'))
  const directory = path.join(root, 'bundle')
  const resources = path.join(directory, 'resources', 'app')
  await mkdir(resources, { recursive: true })
  await writeFile(path.join(resources, 'main.mjs'), 'export const packaged = true\n')
  await writeFile(path.join(directory, 'resources', 'build-manifest.json'), JSON.stringify({
    profile,
    platform: process.platform,
    arch: process.arch,
  }))
  return { root, directory }
}

function measuredSession(report) {
  const installRoot = '/tmp/futureox-release-install/bundle'
  return {
    launched: true,
    packageSha256: report.package.sha256,
    platform: report.platform,
    arch: report.arch,
    reached: Object.fromEntries(DESKTOP_FLOW.map(id => [id, true])),
    signature: { status: 'not_run', notarization: 'not_run', tool: null, reason: 'not inspected' },
    observation: {
      expectedSidecarSha256: SHA,
      runtime: {
        isPackaged: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        profileSource: 'acceptance-profile',
        execPath: `${installRoot}/futureox-desgin`,
        resourcesPath: `${installRoot}/resources`,
        sidecarSha256: SHA,
      },
      install: {
        installRoot,
        sourceSha256: report.package.sha256,
        installedSha256: report.package.sha256,
        afterSha256: report.package.sha256,
        executable: `${installRoot}/futureox-desgin`,
        executableWithinInstall: true,
        resourcesWithinInstall: true,
        launchedFromInstall: true,
      },
      open: { ready: true, documentName: 'Original' },
      navigate: { zoomBefore: 1, zoomAfter: 2 },
      edit: { beforeName: 'Original', afterName: 'Original 验收', nodeCountBefore: 1, nodeCountAfter: 1, nodeKeyBefore: HASH_A, nodeKeyAfter: HASH_A },
      undo: { name: 'Original', nodeCount: 1, nodeKey: HASH_A },
      autosave: { text: '已自动保存到工作副本' },
      closeReopen: { name: 'Original', nodeCount: 1, nodeKey: HASH_A },
      nativeExport: {
        magic: 'FXDK',
        sha256: SHA,
        path: '/tmp/futureox-release-install/export/copy.fd',
        independent: true,
        dialog: 'electron_dialog_boundary',
        writer: 'sidecar.save',
        sidecarOpened: true,
        nodeKey: HASH_A,
        name: 'Original',
      },
      originals: {
        unchanged: true,
        directoryUnchanged: true,
        paths: ['/tmp/futureox-release-install/originals/original.fd'],
        files: [{ sha256Before: SHA, sha256After: SHA }],
      },
    },
  }
}

test('a release-profile bundle can launch and a development bundle cannot', async () => {
  const release = await bundle('release')
  const dev = await bundle('desktop-dev')
  try {
    const described = describePackage(release.directory, { platform: process.platform, arch: process.arch })
    assert.equal(described.evidence.kind, 'unsigned_release_profile_bundle')
    assert.equal(planReleaseLaunch(described, { platform: process.platform, arch: process.arch }).canLaunch, true)
    const devPlan = planReleaseLaunch(describePackage(dev.directory, { platform: process.platform, arch: process.arch }), { platform: process.platform, arch: process.arch })
    assert.equal(devPlan.canLaunch, false)
    assert.equal(devPlan.blockers.includes('development_profile'), true)
    const installer = path.join(release.root, 'Futureox.dmg')
    await writeFile(installer, 'not-an-installer')
    const hashed = planReleaseLaunch(describePackage(installer, { platform: process.platform, arch: process.arch }), { platform: process.platform, arch: process.arch })
    assert.equal(hashed.canLaunch, false)
    assert.equal(hashed.blockers.includes('installer_not_opened'), true)
    const runtime = path.join(release.root, 'dist')
    await mkdir(path.join(runtime, 'renderer'), { recursive: true })
    await writeFile(path.join(runtime, 'renderer', 'app.js'), 'export {}\n')
    const tree = planReleaseLaunch(describePackage(runtime, { platform: process.platform, arch: process.arch }), { platform: process.platform, arch: process.arch })
    assert.equal(tree.canLaunch, false)
    assert.equal(tree.blockers.includes('development_runtime'), true)
  } finally {
    await rm(release.root, { recursive: true, force: true })
    await rm(dev.root, { recursive: true, force: true })
  }
})

test('measured release steps stay open without a signature and reject an edit that did not happen', async () => {
  const release = await bundle('release')
  try {
    const baseline = buildDesktopFlowReport({ packagePath: release.directory, platform: process.platform, arch: process.arch })
    assert.equal(baseline.steps.every(step => step.status === 'not_run'), true)
    const passed = assessObservedDesktopSession(baseline, measuredSession(baseline))
    assert.equal(passed.packageFlow, 'executed_unsigned_release')
    assert.equal(passed.releaseAcceptance, 'not_closed')
    assert.equal(passed.evidence.formalRelease, false)
    assert.equal(passed.steps.every(step => step.status === 'passed'), true)
    assert.equal(passed.steps.every(step => step.packageSha256 === baseline.package.sha256), true)
    assert.equal(passed.originals.appSession, 'unchanged')
    assert.equal(passed.confirmedRuntimeFault, false)
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'macos_signed_notarized_package').status, process.platform === 'darwin' ? 'not_run' : 'blocked')
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'disk_image_or_system_installer').status, 'not_run')

    const unchanged = measuredSession(baseline)
    unchanged.observation.edit.afterName = unchanged.observation.edit.beforeName
    const rejected = assessObservedDesktopSession(baseline, unchanged)
    assert.equal(rejected.steps.find(step => step.id === 'edit').status, 'failed')
    assert.equal(rejected.releaseAcceptance, 'not_closed')
    assert.equal(rejected.packageFlow, 'incomplete')
    assert.equal(rejected.confirmedRuntimeFault, true)
    assert.equal(rejected.exitCode, 1)
  } finally {
    await rm(release.root, { recursive: true, force: true })
  }
})

test('a development bundle measurement cannot close or pass official steps', async () => {
  const dev = await bundle('desktop-dev')
  try {
    const baseline = buildDesktopFlowReport({ packagePath: dev.directory, platform: process.platform, arch: process.arch })
    const result = assessObservedDesktopSession(baseline, measuredSession(baseline))
    assert.equal(result.steps.some(step => step.status === 'passed'), false)
    assert.equal(result.releaseAcceptance, 'not_closed')
    assert.equal(result.packageFlow, 'development_bundle')
    assert.equal(result.evidence.formalRelease, false)
  } finally {
    await rm(dev.root, { recursive: true, force: true })
  }
})

test('only a verified notarized signature can close the release gate', async () => {
  const release = await bundle('release')
  try {
    const baseline = buildDesktopFlowReport({ packagePath: release.directory, platform: process.platform, arch: process.arch })
    const session = measuredSession(baseline)
    session.signature = {
      status: 'signed_unnotarized',
      tool: 'codesign',
      notarization: 'rejected',
      verifyStatus: 0,
      assessStatus: 1,
      identifier: 'com.futureox.desgin',
      authority: 'Developer ID Application: Example (TEAMID)',
      team: 'TEAMID',
    }
    const unsigned = assessObservedDesktopSession(baseline, session)
    assert.equal(unsigned.releaseAcceptance, 'not_closed')
    session.signature = {
      status: 'verified',
      tool: 'codesign',
      notarization: 'accepted',
      verifyStatus: 0,
      assessStatus: 0,
      identifier: 'com.futureox.desgin',
      authority: 'Developer ID Application: Example (TEAMID)',
      team: 'TEAMID',
    }
    const closed = assessObservedDesktopSession(baseline, session)
    assert.equal(closed.releaseAcceptance, 'closed')
    assert.equal(closed.packageFlow, 'closed')
    assert.equal(closed.evidence.formalRelease, true)
    assert.equal(closed.evidence.kind, 'signed_release_bundle')
    assert.equal(closed.evidence.signature, 'verified')
    assert.equal(closed.blockedOfficialSteps.find(step => step.id === 'disk_image_or_system_installer').status, 'not_run')
  } finally {
    await rm(release.root, { recursive: true, force: true })
  }
})

test('an installed linux deb can pass the desktop steps without closing signed acceptance', async () => {
  const release = await bundle('release')
  const debSha = 'd'.repeat(64)
  try {
    const baseline = bindInstalledDeb(
      buildDesktopFlowReport({ packagePath: release.directory, platform: process.platform, arch: process.arch }),
      { debPath: '/tmp/futureox-design.deb', debSha256: debSha },
    )
    const session = measuredSession(baseline)
    session.packageSha256 = debSha
    session.installer = { linuxDeb: 'installed' }
    const payload = baseline.package.payloadSha256
    session.observation.install.method = 'dpkg'
    session.observation.install.installer = 'deb'
    session.observation.install.debSha256 = debSha
    session.observation.install.sourceSha256 = debSha
    session.observation.install.installedSha256 = payload
    session.observation.install.afterSha256 = payload
    session.observation.runtime.acceptanceHook = false
    session.observation.runtime.profileSource = 'private-home'
    session.observation.runtime.privateHome = '/tmp/fx-private-home'
    session.observation.runtime.userData = '/tmp/fx-private-home/.config/futureox-desgin'
    session.observation.runtime.realHome = '/home/ubuntu'
    const passed = assessObservedDesktopSession(baseline, session)
    assert.equal(passed.package.sha256, debSha)
    assert.notEqual(passed.package.payloadSha256, debSha)
    assert.equal(passed.steps.every(step => step.status === 'passed' && step.packageSha256 === debSha), true)
    assert.equal(passed.packageFlow, 'executed_unsigned_release')
    assert.equal(passed.releaseAcceptance, 'not_closed')
    assert.equal(passed.evidence.formalRelease, false)
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'disk_image_or_system_installer').status, 'linux_deb_installed')
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'macos_signed_notarized_package').status, process.platform === 'darwin' ? 'not_run' : 'blocked')
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'windows_authenticode_package').status, process.platform === 'win32' ? 'not_run' : 'blocked')

    const copied = measuredSession(baseline)
    copied.packageSha256 = debSha
    copied.observation.install.method = 'dpkg'
    copied.observation.install.installer = 'deb'
    copied.observation.install.debSha256 = debSha
    copied.observation.install.sourceSha256 = debSha
    copied.observation.install.installedSha256 = debSha
    copied.observation.install.afterSha256 = debSha
    copied.observation.runtime.acceptanceHook = false
    copied.observation.runtime.profileSource = 'private-home'
    copied.observation.runtime.privateHome = '/home/ubuntu'
    copied.observation.runtime.userData = '/home/ubuntu/.config/futureox-desgin'
    copied.observation.runtime.realHome = '/home/ubuntu'
    const rejected = assessObservedDesktopSession(baseline, copied)
    assert.equal(rejected.steps.find(step => step.id === 'install').status, 'failed')
    assert.equal(rejected.steps.find(step => step.id === 'open').status, 'failed')
    assert.equal(rejected.releaseAcceptance, 'not_closed')
  } finally {
    await rm(release.root, { recursive: true, force: true })
  }
})

test('a mounted DMG keeps the installer digest and the copied app digest distinct', async () => {
  const release = await bundle('release')
  try {
    const baseline = bindInstalledDmg(buildDesktopFlowReport({ packagePath: release.directory }), {
      dmgPath: '/tmp/Futureox.dmg', dmgSha256: SHA,
    })
    const session = measuredSession(baseline)
    session.installer = { macDmg: 'copied' }
    const payload = baseline.package.payloadSha256
    Object.assign(session.observation.install, {
      method: 'hdiutil', installer: 'dmg', dmgSha256: SHA, payloadSha256: payload,
      installedSha256: payload, afterSha256: payload,
    })
    const passed = assessObservedDesktopSession(baseline, session)
    assert.equal(passed.packagePath, '/tmp/Futureox.dmg')
    assert.equal(passed.releaseAcceptance, 'not_closed')
    assert.equal(passed.steps.every(step => step.status === 'passed' && step.packageSha256 === SHA), true)
    assert.equal(passed.blockedOfficialSteps.find(step => step.id === 'disk_image_or_system_installer').status, 'macos_dmg_copied')
    session.observation.install.afterSha256 = HASH_A
    assert.equal(assessObservedDesktopSession(baseline, session).steps.find(step => step.id === 'install').status, 'failed')
  } finally {
    await rm(release.root, { recursive: true, force: true })
  }
})

test('a historical published app verifies each declared file with its recorded native set', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-historical-macos-'))
  try {
    const app = path.join(root, 'Futureox.app')
    const resources = path.join(app, 'Contents/Resources')
    const publishedNativePaths = ['sidecar/futureox-design-desktop-backend',
      'bin/design-render', 'bin/design-prepare', 'bin/futureox-design-agent']
    const entries = []
    for (const installPath of publishedNativePaths) {
      const file = path.join(resources, installPath)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, installPath)
      const { sha256, size } = hashReadonlyFile(file)
      entries.push({ kind: 'native', installPath, sha256, size, present: true })
    }
    entries.push({ kind: 'native', installPath: 'bin/ffmpeg', sha256: null, size: null, present: false })
    await writeFile(path.join(resources, 'resource-list.json'), JSON.stringify({
      schema: 1, profile: 'release', platform: 'darwin', arch: 'arm64', entries,
    }))
    const host = { platform: 'darwin', arch: 'arm64' }
    assert.equal(describePackage(app, host).resources.declaredVersusBytes.status, 'mismatch')
    const described = () => describePackage(app, { ...host, publishedNativePaths })
    assert.equal(described().resources.declaredVersusBytes.status, 'match')
    assert.equal(planReleaseLaunch(described(), host).canLaunch, true)
    await writeFile(path.join(resources, 'bin/design-render'), 'different bytes')
    assert.deepEqual(planReleaseLaunch(described(), host).blockers, ['resource_mismatch'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('linux does not invent a codesign result', () => {
  let called = false
  const signature = inspectHostSignature({
    platform: 'linux',
    packagePath: '/tmp/futureox-bundle',
    run() { called = true; return { status: 0, stdout: '', stderr: '' } },
  })
  assert.equal(called, false)
  assert.equal(signature.status, 'not_run')
  assert.equal(signature.notarization, 'not_run')
  assert.equal(officialPackageBlockers('linux', signature).find(step => step.id === 'macos_signed_notarized_package').status, 'blocked')
  const display = [
    'Identifier=com.futureox.desgin',
    'Authority=Developer ID Application: Example (TEAMID)',
    'TeamIdentifier=TEAMID',
  ].join('\n')
  assert.deepEqual(parseCodesignDisplay(display), {
    identifier: 'com.futureox.desgin',
    authority: 'Developer ID Application: Example (TEAMID)',
    team: 'TEAMID',
  })
  assert.equal(parseCodesignDisplay('Identifier=com.futureox.desgin\nAuthority=not set\nTeamIdentifier=not set'), null)
  const verified = inspectHostSignature({
    platform: 'darwin',
    packagePath: '/tmp/Futureox.app',
    run(command, args) {
      if (args[0] === '-dv') return { status: 0, stdout: display, stderr: '' }
      return { status: 0, stdout: 'accepted', stderr: '' }
    },
  })
  assert.equal(verified.status, 'verified')
  assert.equal(verified.notarization, 'accepted')
  const unnotarized = inspectHostSignature({
    platform: 'darwin',
    packagePath: '/tmp/Futureox.app',
    run(command, args) {
      if (command === 'spctl') return { status: 3, stdout: '', stderr: 'rejected' }
      if (args[0] === '-dv') return { status: 0, stdout: display, stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(unnotarized.status, 'signed_unnotarized')
  assert.equal(unnotarized.notarization, 'rejected')
})
