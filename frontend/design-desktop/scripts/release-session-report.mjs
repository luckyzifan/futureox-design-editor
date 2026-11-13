// Turn a packaged desktop session's measurements into the issue #85 report.
// Missing measurements stay not_run. A development bundle cannot become a pass.
import path from 'node:path'
import { DESKTOP_FLOW, buildDesktopFlowReport } from './release-desktop-flow.mjs'

const HEX64 = /^[0-9a-f]{64}$/

export function parseCodesignDisplay(stdout) {
  if (typeof stdout !== 'string') return null
  const identifier = stdout.match(/^Identifier=(.+)$/m)?.[1]?.trim() || ''
  const authority = stdout.match(/^Authority=(.+)$/m)?.[1]?.trim() || ''
  const team = stdout.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
  if (!identifier || !authority || authority === 'not set' || !team || team === 'not set') return null
  return { identifier, authority, team }
}

export function inspectHostSignature({ platform, packagePath, run } = {}) {
  if (platform !== 'darwin') {
    return {
      status: 'not_run',
      tool: platform === 'win32' ? 'signtool' : null,
      notarization: 'not_run',
      verifyStatus: null,
      assessStatus: null,
      reason: platform === 'win32'
        ? 'Windows Authenticode was not executed on this host.'
        : `macOS codesign/notarization and Windows Authenticode are not executed on ${platform}.`,
    }
  }
  if (typeof run !== 'function') throw new Error('signature inspection needs a command runner')
  const display = run('codesign', ['-dv', '--verbose=4', packagePath])
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', packagePath])
  const assess = run('spctl', ['--assess', '--type', 'execute', '--verbose', packagePath])
  const parsed = display?.status === 0 ? parseCodesignDisplay(display.stdout) : null
  if (display?.status !== 0 || verify?.status !== 0 || !parsed) {
    return {
      status: 'failed',
      tool: 'codesign',
      notarization: 'not_run',
      verifyStatus: verify?.status ?? null,
      assessStatus: assess?.status ?? null,
      reason: 'codesign did not verify a Developer ID signature',
    }
  }
  if (assess?.status !== 0) {
    return {
      status: 'signed_unnotarized',
      tool: 'codesign',
      notarization: 'rejected',
      verifyStatus: 0,
      assessStatus: assess?.status ?? null,
      ...parsed,
      reason: 'The signature verified and notarization assessment did not pass.',
    }
  }
  return {
    status: 'verified',
    tool: 'codesign',
    notarization: 'accepted',
    verifyStatus: 0,
    assessStatus: 0,
    ...parsed,
    reason: 'codesign and notarization assessment passed',
  }
}

export function officialPackageBlockers(platform, signature = { status: 'not_run' }) {
  const macStatus = signature.status === 'verified'
    ? 'passed'
    : platform === 'darwin'
      ? (signature.status === 'failed' || signature.status === 'signed_unnotarized' ? signature.status : 'not_run')
      : 'blocked'
  return [
    {
      id: 'macos_signed_notarized_package',
      status: macStatus,
      reason: platform === 'darwin'
        ? signature.reason || 'codesign and notarization have not been recorded'
        : 'This host cannot produce or assess a signed, notarized macOS release package.',
    },
    {
      id: 'windows_authenticode_package',
      status: platform === 'win32' ? 'not_run' : 'blocked',
      reason: 'Windows Authenticode signing was not executed.',
    },
    {
      id: 'disk_image_or_system_installer',
      status: 'not_run',
      reason: 'No .dmg, .pkg, .msi, .exe installer, .deb, or .rpm was mounted. Copying an electron-packager directory into an install prefix is not a signed installer.',
    },
  ]
}

export function planReleaseLaunch(described, { platform, arch } = {}) {
  const blockers = []
  if (!described?.identity?.present || !described.identity.sha256) blockers.push('missing_package')
  if (described?.evidence?.kind === 'development_runtime') blockers.push('development_runtime')
  if (described?.evidence?.kind === 'unsigned_development_bundle' || described?.evidence?.profile === 'desktop-dev' || described?.evidence?.profile === 'debug') blockers.push('development_profile')
  if (described?.evidence?.kind === 'unopened_installer' || described?.evidence?.kind === 'opaque_file') blockers.push('installer_not_opened')
  if (described?.evidence?.kind === 'rejected' || described?.evidence?.kind === 'rejected_symlink') blockers.push('rejected_package')
  if (described?.resources?.status === 'rejected') blockers.push('rejected_resources')
  if (described?.resources?.declaredVersusBytes?.status === 'mismatch') blockers.push('resource_mismatch')
  if (described?.evidence?.packagePlatform && described.evidence.packagePlatform !== platform) blockers.push('platform_mismatch')
  if (described?.evidence?.packageArch && described.evidence.packageArch !== arch) blockers.push('arch_mismatch')
  const canLaunch = blockers.length === 0
    && described?.evidence?.profile === 'release'
    && described?.evidence?.kind === 'unsigned_release_profile_bundle'
  return { canLaunch, blockers }
}

function developmentPackage(evidence) {
  return evidence?.kind === 'development_runtime'
    || evidence?.kind === 'unsigned_development_bundle'
    || evidence?.profile === 'desktop-dev'
    || evidence?.profile === 'debug'
}

function inside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(target)) return false
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function hex(value) {
  return typeof value === 'string' && HEX64.test(value)
}

function signatureCloses(signature) {
  return signature?.status === 'verified'
    && signature.tool === 'codesign'
    && signature.notarization === 'accepted'
    && signature.verifyStatus === 0
    && signature.assessStatus === 0
    && typeof signature.identifier === 'string' && signature.identifier.length > 0
    && typeof signature.authority === 'string' && signature.authority.length > 0 && signature.authority !== 'not set'
    && typeof signature.team === 'string' && signature.team.length > 0 && signature.team !== 'not set'
}

function measured(session, id) {
  return session?.reached?.[id] === true
}

function stepResult(report, status, reason) {
  return {
    status,
    reason,
    packageSha256: report.package.sha256,
    platform: report.platform,
    arch: report.arch,
    packagePlatform: report.evidence.packagePlatform,
    packageArch: report.evidence.packageArch,
    evidenceKind: report.evidence.kind,
  }
}

function checks(report, session) {
  const observation = session.observation || {}
  const runtime = observation.runtime || {}
  const install = observation.install || {}
  const open = observation.open || {}
  const navigate = observation.navigate || {}
  const edit = observation.edit || {}
  const undo = observation.undo || {}
  const autosave = observation.autosave || {}
  const reopened = observation.closeReopen || {}
  const exported = observation.nativeExport || {}
  const originals = observation.originals || {}
  const samePackage = session.packageSha256 === report.package.sha256 && hex(session.packageSha256)
  const sameHost = session.platform === report.platform && session.arch === report.arch
  const packagedRuntime = runtime.isPackaged === true
    && runtime.sandbox === true
    && runtime.contextIsolation === true
    && runtime.nodeIntegration === false
    && runtime.webSecurity === true
    && runtime.profileSource === 'acceptance-profile'
    && inside(install.installRoot, runtime.execPath)
    && inside(install.installRoot, runtime.resourcesPath)
    && hex(runtime.sidecarSha256)
    && runtime.sidecarSha256 === observation.expectedSidecarSha256
  return {
    samePackage,
    sameHost,
    packagedRuntime,
    freeze_release_package: samePackage && sameHost && install.sourceSha256 === report.package.sha256 && hex(install.sourceSha256),
    record_package_hash_and_platform: samePackage && sameHost && typeof report.platform === 'string' && typeof report.arch === 'string',
    install: samePackage && install.installedSha256 === install.sourceSha256 && install.afterSha256 === install.sourceSha256
      && install.executableWithinInstall === true && install.resourcesWithinInstall === true && install.launchedFromInstall === true
      && inside(install.installRoot, install.executable),
    open: packagedRuntime && open.ready === true && typeof open.documentName === 'string' && open.documentName.length > 0,
    navigate: Number.isFinite(navigate.zoomBefore) && Number.isFinite(navigate.zoomAfter) && navigate.zoomAfter > navigate.zoomBefore,
    edit: typeof edit.beforeName === 'string' && edit.beforeName.length > 0 && edit.afterName !== edit.beforeName
      && hex(edit.nodeKeyBefore) && edit.nodeKeyAfter === edit.nodeKeyBefore && edit.nodeCountAfter === edit.nodeCountBefore,
    undo: undo.name === edit.beforeName && undo.nodeKey === edit.nodeKeyBefore && undo.nodeCount === edit.nodeCountBefore && hex(undo.nodeKey),
    autosave: typeof autosave.text === 'string' && autosave.text.includes('已自动保存') && !autosave.text.includes('失败'),
    close_reopen: reopened.name === undo.name && reopened.nodeKey === undo.nodeKey && reopened.nodeCount === undo.nodeCount && typeof reopened.name === 'string' && reopened.name.length > 0,
    native_export: exported.magic === 'FXDK' && hex(exported.sha256) && exported.independent === true
      && exported.dialog === 'electron_dialog_boundary' && exported.writer === 'sidecar.save' && exported.sidecarOpened === true
      && exported.nodeKey === undo.nodeKey && exported.name === undo.name && typeof exported.path === 'string' && path.isAbsolute(exported.path)
      && Array.isArray(originals.paths) && originals.paths.length > 0 && originals.paths.every(file => file !== exported.path),
    original_design_sha_unchanged: originals.unchanged === true && originals.directoryUnchanged === true
      && Array.isArray(originals.files) && originals.files.length > 0
      && originals.files.every(file => hex(file.sha256Before) && file.sha256Before === file.sha256After),
    distinguish_dev_package_from_release: report.evidence.profile === 'release'
      && (report.evidence.kind === 'unsigned_release_profile_bundle' || report.evidence.kind === 'signed_release_bundle')
      && report.evidence.formalRelease === false,
  }
}

const FAILURE = {
  freeze_release_package: 'frozen package hash or host platform was not bound',
  record_package_hash_and_platform: 'package hash and platform were not both recorded',
  install: 'the installed copy does not match the frozen package or was not the process that launched',
  open: 'the packaged acceptance profile did not open the document with a sandboxed runtime',
  navigate: 'canvas zoom did not increase',
  edit: 'the document name edit did not change the authored name while keeping the same nodes',
  undo: 'undo did not restore the authored name and nodes',
  autosave: 'the workspace did not report a completed autosave',
  close_reopen: 'reopen did not restore the undone document',
  native_export: 'native export did not write an independent FXDK file through the packaged sidecar',
  original_design_sha_unchanged: 'an original design file or its directory changed',
  distinguish_dev_package_from_release: 'the package is not an unsigned or signed release-profile bundle',
}

export function assessObservedDesktopSession(report, session = {}) {
  const next = structuredClone(report)
  next.schema = 3
  const gate = checks(next, session)
  const development = developmentPackage(next.evidence)
  const signature = session.signature || { status: 'not_run', notarization: 'not_run', reason: 'signature was not inspected' }
  next.signature = signature
  next.blockedOfficialSteps = officialPackageBlockers(next.platform, signature)
  next.observation = session.observation || null
  next.steps = DESKTOP_FLOW.map(id => {
    if (session.launched !== true) return { id, ...stepResult(next, 'not_run', 'the packaged session was not launched') }
    if (!gate.samePackage || !gate.sameHost) return { id, ...stepResult(next, 'failed', 'session package hash or platform does not match the frozen package') }
    if (!measured(session, id)) return { id, ...stepResult(next, 'not_run', session.errors?.[id] || 'this step was not measured') }
    if (session.errors?.[id]) return { id, ...stepResult(next, 'failed', session.errors[id]) }
    if (!gate[id]) return { id, ...stepResult(next, 'failed', FAILURE[id]) }
    if (development || next.evidence.kind !== 'unsigned_release_profile_bundle') {
      return { id, ...stepResult(next, 'observed_on_development_package', 'The step was measured, but this package is not an unsigned release-profile bundle and cannot close official release acceptance.') }
    }
    if (!gate.packagedRuntime) return { id, ...stepResult(next, 'observed_unpackaged', 'The measurement did not come from the sandboxed packaged acceptance runtime.') }
    return { id, ...stepResult(next, 'passed', 'measured on the installed release-profile bundle') }
  })
  const flowPassed = next.steps.every(step => step.status === 'passed')
  const signed = signatureCloses(signature)
  if (signed && flowPassed && next.evidence.profile === 'release') {
    next.evidence = {
      ...next.evidence,
      kind: 'signed_release_bundle',
      formalRelease: true,
      signature: 'verified',
      note: 'Host codesign and notarization assessment passed for this installed bundle. Disk-image mounting stays a separate not_run record.',
    }
    next.steps = next.steps.map(step => step.id === 'distinguish_dev_package_from_release'
      ? { ...step, evidenceKind: 'signed_release_bundle', reason: 'signed release bundle, distinct from desktop-dev and from an unsigned bundle' }
      : { ...step, evidenceKind: 'signed_release_bundle' })
  }
  next.packageFlow = !session.launched ? 'not_launched'
    : development ? 'development_bundle'
      : signed && flowPassed ? 'closed'
        : flowPassed ? 'executed_unsigned_release'
          : 'incomplete'
  next.releaseAcceptance = next.packageFlow === 'closed' ? 'closed' : 'not_closed'
  next.confirmedRuntimeFault = gate.packagedRuntime === true && next.steps.some(step =>
    ['navigate', 'edit', 'undo', 'autosave', 'close_reopen', 'native_export', 'original_design_sha_unchanged'].includes(step.id) && step.status === 'failed')
  const originalsChanged = session.observation?.originals?.unchanged === false || session.observation?.originals?.directoryUnchanged === false
  if (session.observation?.originals) {
    next.originals = {
      ...next.originals,
      appSession: originalsChanged ? 'changed' : session.observation.originals.unchanged === true && session.observation.originals.directoryUnchanged === true ? 'unchanged' : 'not_run',
      files: session.observation.originals.files || next.originals.files,
    }
  }
  next.failed = next.failed === true || next.steps.some(step => step.status === 'failed') || next.originals.appSession === 'changed'
  next.exitCode = next.failed ? 1 : next.steps.every(step => step.status === 'passed') ? 0 : 1
  return next
}

export function desktopFlowBaseline(options) {
  return buildDesktopFlowReport(options)
}
