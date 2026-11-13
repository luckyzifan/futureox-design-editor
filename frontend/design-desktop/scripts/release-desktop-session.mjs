// Launch an installed release-profile bundle and record issue #85's desktop flow.
// A source tree, desktop-dev profile, or hashed-but-unopened installer cannot pass.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sidecar } from '../src/sidecar.mjs'
import { describePackage, hashPackageIdentity, hashReadonlyFile } from './release-package-resources.mjs'
import { assessObservedDesktopSession, desktopFlowBaseline, inspectHostSignature, officialPackageBlockers, planReleaseLaunch } from './release-session-report.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..')
const requireClient = createRequire(path.join(core, 'frontend/design-client/package.json'))

function option(name) {
  const prefix = `--${name}=`
  const found = process.argv.find(value => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : null
}

function nodeKey(ids) {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex')
}

function directoryNames(directory) {
  return readdir(directory).then(names => names.sort())
}

function executableName() {
  return process.platform === 'win32' ? 'futureox-desgin.exe' : 'futureox-desgin'
}

function bundleExecutable(bundle) {
  if (process.platform === 'darwin' && existsSync(bundle)) {
    const apps = readdirSync(bundle).filter(name => name.endsWith('.app'))
    if (apps.length === 1) return path.join(bundle, apps[0], 'Contents', 'MacOS', executableName())
  }
  return path.join(bundle, executableName())
}

async function withSidecar(binary, recovery, fn) {
  const sidecar = new Sidecar(binary, recovery)
  try {
    const health = await sidecar.request('health')
    if (health.protocolVersion !== 1) throw new Error(`Backend protocol mismatch: ${health.protocolVersion}`)
    return await fn(sidecar, health)
  } finally {
    if (!(await sidecar.stop())) throw new Error('Packaged sidecar did not stop')
  }
}

function minimalDocument() {
  return {
    schemaVersion: 6,
    id: '10000000-0000-0000-0000-000000000001',
    name: 'Release acceptance original',
    pages: [{ id: '10000000-0000-0000-0000-000000000002', name: 'Page', background: '#ffffff', children: [] }],
    nodes: {},
  }
}

async function prepareOriginal(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const bytes = await readFile(source)
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 })
  return destination
}

function launchEnv(profile) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)) continue
    env[key] = value
  }
  env.FUTUREOX_ACCEPTANCE_PROFILE = profile
  env.ELECTRON_ENABLE_SECURITY_WARNINGS = 'true'
  return env
}

async function closeApp(app) {
  if (!app) return
  const child = app.process()
  let timer
  try {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 12000) }),
    ])
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 1500))
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

async function readCanvas(page) {
  return page.evaluate(async () => {
    const presentation = document.querySelector('.kernel-presentation')
    const shell = document.querySelector('.app-shell')
    const list = await window.coreDesktop.workspace.list()
    if (list.status !== 'ok') throw new Error(list.message || list.code || 'workspace list failed')
    const entry = list.documents.filter(document => !document.deleted).sort((left, right) => right.updatedAt - left.updatedAt)[0]
    let name = document.querySelector('[aria-label="文档名称"]')?.value || null
    let ids = []
    if (entry) {
      const opened = await window.coreDesktop.workspace.open({ id: entry.id })
      if (opened.status !== 'ok') throw new Error(opened.message || opened.code || 'workspace open failed')
      const parsed = JSON.parse(opened.documentJson)
      name = parsed.name
      ids = Object.keys(parsed.nodes || {})
    }
    return {
      ready: shell?.getAttribute('data-desktop-ready') === 'true',
      save: document.querySelector('.save-status')?.textContent || '',
      zoom: presentation?.getAttribute('data-camera-zoom'),
      presentationReady: presentation?.getAttribute('data-presentation-ready') === 'true',
      name,
      ids,
      renderer: document.querySelector('canvas.kernel-surface')?.getAttribute('data-renderer') || null,
    }
  })
}

async function waitFor(read, ready, timeout, label) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (ready(value)) return value
      last = value
    } catch (error) {
      last = error?.message || String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} timed out: ${typeof last === 'string' ? last : JSON.stringify(last)}`)
}

async function hostFacts(app, installRoot) {
  const facts = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('design-app:'))
    if (!window) throw new Error('Packaged design window is absent')
    const preferences = window.webContents.getLastWebPreferences()
    return {
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      argv: process.argv,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      webSecurity: preferences.webSecurity,
    }
  })
  const userData = realpathSync(facts.userData)
  const execPath = realpathSync(facts.execPath)
  const resourcesPath = realpathSync(facts.resourcesPath)
  const sidecar = path.join(resourcesPath, 'sidecar', `futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`)
  return {
    ...facts,
    userData,
    execPath,
    resourcesPath,
    sidecarSha256: hashReadonlyFile(sidecar).sha256,
    profileSource: userData === installRoot || userData.startsWith(installRoot + path.sep) ? 'acceptance-profile' : 'other',
    acceptanceProfile: facts.argv.includes(`--desktop-acceptance-profile=${installRoot}`) || process.env.FUTUREOX_ACCEPTANCE_PROFILE === installRoot,
  }
}

async function launchPackaged(electron, executable, profile, extraArgs, logs) {
  const app = await electron.launch({
    executablePath: executable,
    args: ['--core-cpu-only', ...extraArgs],
    cwd: path.dirname(executable),
    env: launchEnv(profile),
    timeout: 90000,
  })
  app.process().stdout?.on('data', chunk => logs.push(String(chunk)))
  app.process().stderr?.on('data', chunk => logs.push(String(chunk)))
  const page = await app.firstWindow({ timeout: 90000 })
  page.on('pageerror', error => logs.push(`pageerror ${error}\n`))
  return { app, page }
}

async function enterCanvas(page) {
  const canvas = page.locator('[data-testid="canvas"]')
  const visible = await canvas.isVisible().catch(() => false)
  if (!visible) {
    const resume = page.getByRole('button', { name: /继续编辑/ })
    await resume.click()
  }
  await canvas.waitFor({ state: 'visible', timeout: 30000 })
}

async function clickMenu(app, accelerator) {
  await app.evaluate(({ Menu }, accelerator) => {
    const walk = menu => {
      if (!menu) return null
      for (const item of menu.items) {
        if (item.accelerator === accelerator) return item
        const nested = item.submenu ? walk(item.submenu) : null
        if (nested) return nested
      }
      return null
    }
    const item = walk(Menu.getApplicationMenu())
    if (!item) throw new Error(`Menu item ${accelerator} is missing`)
    item.click()
  }, accelerator)
}

async function installSaveDialog(app, paths) {
  await app.evaluate(({ dialog }, queue) => {
    const pending = [...queue]
    globalThis.__futureoxSaveDialogCalls = 0
    const original = dialog.showSaveDialog.bind(dialog)
    dialog.showSaveDialog = async () => {
      globalThis.__futureoxSaveDialogCalls += 1
      const next = pending.shift()
      if (!next) return { canceled: true }
      return { canceled: false, filePath: next }
    }
    globalThis.__futureoxRestoreSaveDialog = () => { dialog.showSaveDialog = original }
  }, paths)
}

async function dialogCalls(app) {
  return app.evaluate(() => globalThis.__futureoxSaveDialogCalls || 0)
}

async function restoreSaveDialog(app) {
  if (!app) return
  await app.evaluate(() => {
    if (typeof globalThis.__futureoxRestoreSaveDialog === 'function') globalThis.__futureoxRestoreSaveDialog()
  }).catch(() => {})
}

async function readVerification(verificationPath, resourcesRoot) {
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'))
  if (verification.status !== 'passed') throw new Error(`package verification status is ${verification.status}`)
  if (verification.platform !== process.platform || verification.arch !== process.arch) throw new Error('package verification platform does not match this host')
  if (verification.build?.profile !== 'release') throw new Error(`package verification profile is ${verification.build?.profile}, not release`)
  const archive = path.join(resourcesRoot, 'app.asar')
  const actual = hashReadonlyFile(archive).sha256
  if (verification.artifacts?.['app.asar'] !== actual) throw new Error('package verification app.asar hash does not match this bundle')
  const sidecarName = `sidecar/futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`
  const sidecar = path.join(resourcesRoot, sidecarName)
  if (verification.artifacts?.[sidecarName] !== hashReadonlyFile(sidecar).sha256) throw new Error('package verification sidecar hash does not match this bundle')
  return { path: verificationPath, status: verification.status, profile: verification.build.profile, appAsar: actual }
}

async function main() {
  const packagePath = option('package')
  if (!packagePath || !path.isAbsolute(packagePath)) {
    console.error('Usage: node scripts/release-desktop-session.mjs --package=/absolute/release-bundle [--original=/absolute/file.fd] [--verification=/absolute/package-verification.json] [--output=/absolute/empty-dir]')
    process.exit(2)
  }
  const output = option('output')
    ? path.resolve(option('output'))
    : await mkdtemp(path.join(tmpdir(), 'futureox-release-session-'))
  await mkdir(output, { recursive: true, mode: 0o700 })
  const logs = []
  const reached = {}
  const errors = {}
  const observation = { install: {}, runtime: {}, open: {}, navigate: {}, edit: {}, undo: {}, autosave: {}, closeReopen: {}, nativeExport: {}, originals: {} }
  let exitCode = 1
  let report
  const described = describePackage(packagePath, { platform: process.platform, arch: process.arch })
  const plan = planReleaseLaunch(described, { platform: process.platform, arch: process.arch })
  const signature = inspectHostSignature({ platform: process.platform, packagePath })
  report = desktopFlowBaseline({ packagePath, platform: process.platform, arch: process.arch, originalPaths: [] })
  report.blockedOfficialSteps = []
  report.plan = plan
  report.signature = signature
  try {
    if (!plan.canLaunch) {
      report.packageFlow = 'not_launched'
      report.releaseAcceptance = 'not_closed'
      report.blockedOfficialSteps = officialPackageBlockers(process.platform, signature)
      report.failure = `release bundle was not launched: ${plan.blockers.join(', ') || 'not a release-profile bundle'}`
      exitCode = 2
      return
    }
    const frozen = hashPackageIdentity(packagePath)
    const installParent = await mkdtemp(path.join(output, 'install-'))
    const installed = path.join(installParent, path.basename(packagePath))
    await cp(packagePath, installed, { recursive: true, verbatimSymlinks: true })
    const installedHash = hashPackageIdentity(installed)
    if (installedHash.sha256 !== frozen.sha256) throw Object.assign(new Error('Installed copy hash does not match the frozen package'), { code: 'INSTALL_MISMATCH' })
    const executable = bundleExecutable(installed)
    const resourcesRoot = path.join(installed, described.resources.installRoot || 'resources')
    const sidecarBinary = path.join(resourcesRoot, 'sidecar', `futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`)
    await chmod(executable, 0o755)
    const verificationPath = option('verification')
      || path.join(path.dirname(packagePath), 'package-verification.json')
    if (!existsSync(verificationPath)) throw Object.assign(new Error('package-verification.json is missing; run verify-package for this bundle first'), { code: 'VERIFICATION_MISSING' })
    observation.verification = await readVerification(verificationPath, resourcesRoot)
    observation.expectedSidecarSha256 = hashReadonlyFile(sidecarBinary).sha256
    const profile = await mkdtemp(path.join(output, 'profile-'))
    await chmod(profile, 0o700)
    const originalSource = option('original')
      ? path.resolve(option('original'))
      : path.join(core, 'docs/branding/futureox-desgin.fd')
    if (!path.isAbsolute(originalSource) || !existsSync(originalSource)) throw new Error('original design file is missing')
    const sourceHashBefore = hashReadonlyFile(originalSource).sha256
    const originalPath = await prepareOriginal(originalSource, path.join(output, 'originals', 'original.fd'))
    const recovery = await mkdtemp(path.join(output, 'sidecar-'))
    let originalOpened
    try {
      originalOpened = await withSidecar(sidecarBinary, recovery, sidecar => sidecar.request('open', { path: originalPath }))
      observation.originalSource = 'copied_file'
    } catch (error) {
      await chmod(originalPath, 0o644)
      await withSidecar(sidecarBinary, recovery, sidecar => sidecar.request('save', { path: originalPath, document: minimalDocument(), expectedHash: null }))
      originalOpened = await withSidecar(sidecarBinary, recovery, sidecar => sidecar.request('open', { path: originalPath }))
      observation.originalSource = 'packaged_sidecar_fixture'
      observation.originalFixtureReason = error.message
    }
    await chmod(originalPath, 0o444)
    const originalDirectory = path.dirname(originalPath)
    const namesBefore = await directoryNames(originalDirectory)
    const originalBefore = hashReadonlyFile(originalPath)
    observation.originals = {
      paths: [originalPath],
      sourcePath: originalSource,
      sourceUnchanged: null,
      sourceHashBefore,
      files: [{ path: originalPath, sha256Before: originalBefore.sha256, sha256After: null }],
      namesBefore,
      unchanged: null,
      directoryUnchanged: null,
    }
    observation.install = {
      sourcePath: packagePath,
      installRoot: installed,
      sourceSha256: frozen.sha256,
      installedSha256: installedHash.sha256,
      afterSha256: null,
      executable,
      executableWithinInstall: realpathSync(executable).startsWith(realpathSync(installed) + path.sep),
      resourcesWithinInstall: realpathSync(resourcesRoot).startsWith(realpathSync(installed) + path.sep),
      launchedFromInstall: true,
    }
    const { _electron: electron } = requireClient('@playwright/test')
    let app
    let page
    try {
      ;({ app, page } = await launchPackaged(electron, executable, profile, [originalPath], logs))
      reached.open = true
      const runtime = await hostFacts(app, profile)
      const profileReal = realpathSync(profile)
      observation.runtime = {
        isPackaged: runtime.isPackaged,
        sandbox: runtime.sandbox,
        contextIsolation: runtime.contextIsolation,
        nodeIntegration: runtime.nodeIntegration,
        webSecurity: runtime.webSecurity,
        userData: runtime.userData,
        profileSource: runtime.userData === profileReal ? 'acceptance-profile' : 'other',
        execPath: runtime.execPath,
        resourcesPath: runtime.resourcesPath,
        appPath: runtime.appPath,
        sidecarSha256: runtime.sidecarSha256,
        versions: runtime.versions,
      }
      if (observation.runtime.profileSource !== 'acceptance-profile') {
        throw new Error(`Packaged process userData ${runtime.userData} did not use acceptance profile ${profileReal}`)
      }
      if (process.platform === 'darwin') {
        await page.locator('.app-shell[data-desktop-ready="true"]').waitFor({ timeout: 60000 })
        await app.evaluate(({ dialog }, file) => {
          const original = dialog.showOpenDialog.bind(dialog)
          dialog.showOpenDialog = async () => {
            dialog.showOpenDialog = original
            return { canceled: false, filePaths: [file] }
          }
        }, originalPath)
        await clickMenu(app, 'CmdOrCtrl+O')
      }
      const opened = await waitFor(async () => readCanvas(page), value => value.ready && value.name === originalOpened.document.name, 90000, 'open document')
      await enterCanvas(page)
      observation.open = { ready: opened.ready, documentName: opened.name, renderer: (await readCanvas(page)).renderer }
      reached.navigate = true
      await page.locator('[data-testid="canvas"]').click()
      const zoomReady = await waitFor(
        async () => readCanvas(page),
        value => Number.isFinite(Number(value.zoom)) && Number(value.zoom) > 0,
        20000,
        'initial zoom',
      )
      const zoomBefore = Number(zoomReady.zoom)
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.press(`${modifier}+Equal`)
      let zoomAfter = Number((await waitFor(async () => readCanvas(page), value => Number(value.zoom) > zoomBefore, 10000, 'zoom').catch(() => ({ zoom: zoomBefore }))).zoom)
      if (!(zoomAfter > zoomBefore)) {
        await page.keyboard.press(`${modifier}+Plus`)
        zoomAfter = Number((await waitFor(async () => readCanvas(page), value => Number(value.zoom) > zoomBefore, 10000, 'zoom plus')).zoom)
      }
      observation.navigate = { zoomBefore, zoomAfter }
      await page.waitForFunction(() => document.querySelector('.app-shell')?.getAttribute('data-history-backend') === 'graph-api', null, { timeout: 20000 })
      const beforeEdit = await readCanvas(page)
      const editedName = `${beforeEdit.name} acceptance`
      reached.edit = true
      const title = page.getByLabel('文档名称', { exact: true })
      await title.fill(editedName)
      await title.press('Enter')
      const afterEdit = await waitFor(async () => readCanvas(page), value => value.name === editedName, 20000, 'edit name')
      observation.edit = {
        beforeName: beforeEdit.name,
        afterName: afterEdit.name,
        nodeCountBefore: beforeEdit.ids.length,
        nodeCountAfter: afterEdit.ids.length,
        nodeKeyBefore: nodeKey(beforeEdit.ids),
        nodeKeyAfter: nodeKey(afterEdit.ids),
      }
      reached.undo = true
      const canvas = page.locator('[data-testid="canvas"]')
      await canvas.focus()
      await page.keyboard.press(`${modifier}+z`)
      const undone = await waitFor(
        async () => readCanvas(page),
        value => value.name === beforeEdit.name && nodeKey(value.ids) === observation.edit.nodeKeyBefore,
        20000,
        'undo',
      )
      observation.undo = { nodeCount: undone.ids.length, nodeKey: nodeKey(undone.ids), name: undone.name }
      reached.autosave = true
      const saved = await waitFor(
        async () => readCanvas(page),
        value => value.save.includes('已自动保存') && !value.save.includes('失败') && nodeKey(value.ids) === observation.undo.nodeKey,
        30000,
        'autosave',
      )
      observation.autosave = { text: saved.save }
      await closeApp(app)
      app = undefined
      ;({ app, page } = await launchPackaged(electron, executable, profile, [], logs))
      reached.close_reopen = true
      const reopened = await waitFor(
        async () => readCanvas(page),
        value => value.ready && value.name === observation.open.documentName && nodeKey(value.ids) === observation.undo.nodeKey,
        90000,
        'reopen',
      )
      observation.closeReopen = { name: reopened.name, nodeCount: reopened.ids.length, nodeKey: nodeKey(reopened.ids) }
      await enterCanvas(page)
      const exportPath = path.join(output, 'export', 'acceptance-export.fd')
      await mkdir(path.dirname(exportPath), { recursive: true, mode: 0o700 })
      reached.native_export = true
      await installSaveDialog(app, [originalPath, exportPath])
      await clickMenu(app, 'CmdOrCtrl+Shift+S')
      await waitFor(async () => dialogCalls(app), value => value >= 1, 20000, 'rejected original export dialog')
      const duringReject = hashReadonlyFile(originalPath)
      if (duringReject.sha256 !== originalBefore.sha256) throw new Error('Original design file changed while export to that path was rejected')
      if (existsSync(exportPath)) throw new Error('Export file appeared before the independent destination was chosen')
      // The first save handler still owns the desktop operation until it returns.
      // A menu click during that window is ignored, so pause and try again.
      await new Promise(resolve => setTimeout(resolve, 600))
      for (let attempt = 0; attempt < 3 && await dialogCalls(app) < 2; attempt += 1) {
        await clickMenu(app, 'CmdOrCtrl+Shift+S')
        await new Promise(resolve => setTimeout(resolve, 700))
      }
      await waitFor(async () => dialogCalls(app), value => value >= 2, 20000, 'independent export dialog')
      await waitFor(async () => existsSync(exportPath), value => value === true, 20000, 'export file')
      const exportedBytes = await readFile(exportPath)
      if (exportedBytes.subarray(0, 4).toString('ascii') !== 'FXDK') throw new Error('Native export is not an FXDK file')
      await restoreSaveDialog(app)
      await closeApp(app)
      app = undefined
      const exportedOpened = await withSidecar(sidecarBinary, recovery, sidecar => sidecar.request('open', { path: exportPath }))
      const exportedIds = Object.keys(exportedOpened.document?.nodes || {})
      observation.nativeExport = {
        magic: 'FXDK',
        sha256: hashReadonlyFile(exportPath).sha256,
        path: exportPath,
        independent: exportPath !== originalPath,
        dialog: 'electron_dialog_boundary',
        writer: 'sidecar.save',
        sidecarOpened: true,
        nodeKey: nodeKey(exportedIds),
        nodeCount: exportedIds.length,
        name: exportedOpened.document?.name,
      }
      if (observation.nativeExport.nodeKey !== observation.undo.nodeKey) throw new Error('Exported document nodes do not match the undone editor state')
    } finally {
      await restoreSaveDialog(app)
      await closeApp(app)
    }
    const namesAfter = await directoryNames(originalDirectory)
    const originalAfter = hashReadonlyFile(originalPath)
    const sourceHashAfter = hashReadonlyFile(originalSource).sha256
    observation.originals.files[0].sha256After = originalAfter.sha256
    observation.originals.unchanged = originalAfter.sha256 === originalBefore.sha256
    observation.originals.directoryUnchanged = namesBefore.join('\n') === namesAfter.join('\n')
    observation.originals.sourceUnchanged = sourceHashAfter === observation.originals.sourceHashBefore
    observation.originals.namesAfter = namesAfter
    if (!observation.originals.sourceUnchanged) throw new Error('The source design file given to the runner changed')
    observation.install.afterSha256 = hashPackageIdentity(installed).sha256
    reached.freeze_release_package = true
    reached.record_package_hash_and_platform = true
    reached.install = true
    reached.original_design_sha_unchanged = true
    reached.distinguish_dev_package_from_release = true
  } catch (error) {
    errors[Object.keys(reached).at(-1) || 'launch'] = error.message
    report.error = error.message
    if (error.code === 'VERIFICATION_MISSING' || error.code === 'INSTALL_MISMATCH') exitCode = 2
  } finally {
    const failure = report.error || report.failure
    const session = {
      launched: plan.canLaunch && exitCode !== 2,
      packageSha256: report.package.sha256,
      platform: process.platform,
      arch: process.arch,
      reached,
      errors,
      signature,
      observation,
    }
    if (plan.canLaunch && session.launched) {
      report = assessObservedDesktopSession(desktopFlowBaseline({
        packagePath,
        platform: process.platform,
        arch: process.arch,
        originalPaths: observation.originals.paths || [],
      }), session)
      if (failure) report.error = failure
    } else {
      report.packageFlow = 'not_launched'
      report.releaseAcceptance = 'not_closed'
      report.confirmedRuntimeFault = false
      report.blockedOfficialSteps = officialPackageBlockers(process.platform, signature)
      if (failure) report.failure = failure
    }
    report.output = output
    await writeFile(path.join(output, 'host.log'), logs.join(''))
    await writeFile(path.join(output, 'session.json'), JSON.stringify(report, null, 2))
    if (plan.canLaunch && session.launched) exitCode = report.exitCode
    console.log(JSON.stringify({
      output,
      exitCode,
      packageFlow: report.packageFlow,
      releaseAcceptance: report.releaseAcceptance,
      confirmedRuntimeFault: report.confirmedRuntimeFault,
      packageSha256: report.package?.sha256,
      signature: report.signature?.status || signature.status,
      steps: report.steps?.map(step => ({ id: step.id, status: step.status })),
      error: report.error || errors[Object.keys(errors).at(-1)] || null,
    }, null, 2))
    process.exitCode = exitCode
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
