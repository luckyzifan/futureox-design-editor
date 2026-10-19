import { forwardNativeEditorShortcut } from './keyboard-shortcuts.mjs'
import { registerAutomationBridge } from './automation-bridge.mjs'
import { SketchSessionHost } from './sketch-session.mjs'
import { readDesignClipboard, writeDesignClipboard } from './clipboard.mjs'
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, clipboard, screen, nativeImage, ClipboardItem } from 'electron'
import path from 'node:path'
import { mkdtempSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  APP_URL,
  CSP,
  MAX_DOCUMENT_BYTES,
  assertSender,
  documentFromString,
  isAppResource,
  record,
  resourcePath,
  resultError,
  validHandle,
} from './security.mjs'
import { Sidecar } from './sidecar.mjs'
import { registerNativeRender } from './native-render.mjs'
import { registerNativePreparation } from './preparation.mjs'
import { formatForNativePath, sketchInspection } from './kernel-admission.mjs'
import { DirectoryGrants } from './directory-grants.mjs'
import { fitWindowState, readWindowState, writeWindowState } from './window-state.mjs'
import { planLegacyUserDataMigration, runLegacyUserDataMigration } from './legacy-user-data.mjs'
import { renderCheckConfig, renderCheckHandler } from './render-check.mjs'
import { WorkspaceRoots, workspaceRootError } from './workspace-roots.mjs'

const smoke = process.argv.includes('--desktop-smoke')
const cpuOnly = process.argv.includes('--core-cpu-only') || smoke
const guiTest = process.argv.includes('--desktop-gui-test')
// Manual/native UI validation uses its own catalog/recovery without running
// the scripted GUI test menu or touching a developer's regular profile.
const isolatedProfile = process.argv.includes('--desktop-isolated-profile')
const renderCheck = renderCheckConfig(process.argv, app.isPackaged)
if (cpuOnly) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}
const applicationName = app.isPackaged ? app.getName() : 'futureox-desgin'
app.setName(applicationName)
app.enableSandbox()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'design-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])
// GUI checks never touch a developer's real recovery/profile or running application.
if (smoke || guiTest || isolatedProfile) {
  const profile = mkdtempSync(path.join(realpathSync(tmpdir()), isolatedProfile ? `forma-desktop-manual-${randomUUID()}-` : 'forma-desktop-smoke-'))
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  console.log(`DESKTOP_SMOKE_PROFILE ${profile}`)
}
const peerWindowId=process.argv.find(value=>value.startsWith('--local-peer='))?.slice('--local-peer='.length)
const localSessionId=randomUUID()
let workspaceRoot=app.getPath('userData')
let initialWorkspaceId
if(peerWindowId!==undefined){
  if(!/^[0-9a-f-]{36}$/.test(peerWindowId)||!process.env.FORMA_LOCAL_WORKSPACE_ROOT||!path.isAbsolute(process.env.FORMA_LOCAL_WORKSPACE_ROOT))throw new Error('Invalid local window launch')
  workspaceRoot=realpathSync(process.env.FORMA_LOCAL_WORKSPACE_ROOT)
  const profile=mkdtempSync(path.join(workspaceRoot,'local-window-'))
  app.setPath('userData',profile);app.setPath('sessionData',profile)
  initialWorkspaceId=process.env.FORMA_LOCAL_DOCUMENT_ID
  if(!/^[0-9a-f-]{36}$/.test(initialWorkspaceId||''))throw new Error('Invalid local document launch')
}
const localChildren=new Set()
let pendingPeerLaunches = 0
if (!smoke && !guiTest && !isolatedProfile && peerWindowId === undefined) {
  // 3917bba91 renamed the app (Forma* → futureox-desgin*), which re-homes every
  // durable store under the new productName. Carry the old profile's catalog,
  // workspace, recovery and window state forward once — before the sidecar
  // opens the databases — so a rename never looks like lost work.
  try {
    const migrated = runLegacyUserDataMigration(planLegacyUserDataMigration({
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
    }))
    if (migrated) console.log(`LEGACY_USER_DATA_MIGRATED ${migrated.source} ${migrated.copied.length}`)
  } catch (error) {
    console.warn(`Legacy user data migration skipped: ${error}`)
  }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const assets = app.isPackaged ? app.getAppPath() : path.resolve(here, '../dist')
const rendererRoot = renderCheck?.rendererRoot || path.join(assets, 'renderer')
const renderCheckOutput = path.join(app.getPath('userData'), 'render-check')
const serveRenderCheck = renderCheckHandler(renderCheck, renderCheckOutput, () => ({
  host: 'electron', electron: process.versions.electron, chromium: process.versions.chrome,
  platform: process.platform, arch: process.arch, cpuOnly,
  gpuFeatureStatus: app.getGPUFeatureStatus(),
  windowVisible: window?.isVisible(), windowFocused: window?.isFocused(),
}))
if (renderCheck) console.log(`DESKTOP_RENDER_CHECK_OUTPUT ${renderCheckOutput}`)
const executable = path.join(
  app.isPackaged ? process.resourcesPath : assets,
  'sidecar',
  `futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`,
)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}
let window
let backend
let pendingWorkspaceRoot
const workspaceRoots = new WorkspaceRoots({
  profileRoot: app.getPath('userData'), dialog, getWindow: () => window,
  canSwitch: () => peerWindowId === undefined && localChildren.size === 0 && pendingPeerLaunches === 0,
  probe: async ({ recoveryDir, catalogDb, workspaceDb }) => {
    const candidate = new Sidecar(executable, recoveryDir, { catalogDb, workspaceDb })
    try {
      const health = await candidate.request('health')
      if (health.protocolVersion !== 1 || health.maxDocumentBytes !== MAX_DOCUMENT_BYTES) throw new Error('Backend protocol mismatch')
      // Health alone succeeds when either SQLite store failed to open.
      await candidate.request('workspace.list', {})
      await candidate.request('catalog.list', {})
    } finally {
      if (!(await candidate.stop())) throw Object.assign(new Error('Candidate backend did not stop'), { code: 'WORKSPACE_ROOT_BUSY' })
    }
  },
})
const automationBridge = registerAutomationBridge({
  workspace: {
    getRoot: () => workspaceRoots.current,
    verifyRoot: root => workspaceRoots.verify(root),
    status: () => workspaceRoots.status(),
    select: useDefault => stageWorkspaceRoot(useDefault),
    activate: selectionId => activateWorkspaceRoot(selectionId),
  },
  ipcMain, getWindow: () => window, assertSender, dialog, clipboard,
  storage: (method, params) => backend.request(method, params),
  audit: entry => backend.request('automation.audit.append', {
    event: entry.event === 'edit' ? 'edit' : entry.method === 'bridge.enable' ? 'grant' : entry.method === 'bridge.disable' ? 'revoke' : 'execute',
    source: entry.source ?? 'automation', ...(entry.summary ? { summary: entry.summary } : {}),
    method: entry.method, documentId: entry.documentId, session: entry.session, scope: entry.scope,
    status: entry.status === 'ok' ? 'succeeded' : entry.code === 'CANCELLED' ? 'cancelled' : ['TIMEOUT', 'DISCONNECTED', 'SESSION_CLOSED'].includes(entry.code) ? 'unknown' : 'failed',
    ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.code ? { code: entry.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
  }),
})
const sketchSessions = new SketchSessionHost((method, params) => backend.request(method, params), dialog, () => window)
let dirty = true
let permitClose = false
let closePending = false
let closeFinalizing = false
let closeRequestId
let closeTimer
let operationActive = false
let recoveryId = randomUUID()
let shutdownPromise
let shutdownComplete = false
let quitRequested = false
let hostReady = false
let windowOpening
let sessionConfigured = false
let windowStateTimer
let windowStateWrites = Promise.resolve()
let windowCleanup = Promise.resolve()
const pendingFiles = []
const pendingCommands = []
let rendererReady = false
let pendingOverflow = false
let fontListing
let fontListedAt = 0
const grants = new Map()
const directoryGrants = new DirectoryGrants()
let activeHandle
const recoveryGrants = new Map()
const recoveredSources = new Map()
const fileFilters = [{ name: 'futureox-desgin design', extensions: ['fd'] }]
let sketchInspectionEpoch = 0

function grant(filePath, hash, directoryHandle, pendingPath) {
  const handle = randomUUID()
  // Bound retained grants; old renderer capabilities are not accepted forever.
  if (grants.size >= 9) {
    const unused = [...grants.keys()].find((key) => key !== activeHandle)
    if (unused) grants.delete(unused)
  }
  grants.set(handle, { path: filePath, hash, directoryHandle, pendingPath })
  return handle
}
async function lookup(handle, metadataOnly = false) {
  if (!validHandle(handle) || !grants.has(handle)) throw new Error('Unknown file handle')
  const target = grants.get(handle)
  if (target.directoryHandle && !metadataOnly) await directoryGrants.lookup(target.directoryHandle)
  return target
}
function cancelled() {
  return { status: 'cancelled' }
}
function requireFd(filePath) {
  if (formatForNativePath(filePath) !== 'fd') {
    throw new Error('Choose a .fd file')
  }
  return filePath
}
function noteRecent(filePath) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try { app.addRecentDocument(filePath) } catch (error) { console.warn('Could not update recent documents:', error.message) }
  }
}
function enqueueNativeFile(filePath) {
  try { requireFd(filePath) } catch { return false }
  if (pendingFiles.includes(filePath)) return true
  if (pendingFiles.length >= 16) {
    pendingOverflow = true
    if (hostReady) reportPendingOverflow()
    return false
  }
  pendingFiles.push(filePath)
  if (hostReady && !quitRequested) void createWindow().then(() => sendCommand('openPending')).catch(reportWindowError)
  return true
}
function reportPendingOverflow() {
  if (!pendingOverflow) return
  pendingOverflow = false
  void dialog.showMessageBox({ type: 'warning', message: '最多同时等待打开 16 个设计文件，请先处理当前文件后再打开。' })
}
// Finder can deliver files before Electron readiness. Only OS/main paths enter
// this queue; the renderer cannot submit paths or consume one before accepting it.
app.on('open-file', (event, filePath) => { event.preventDefault(); enqueueNativeFile(filePath) })
function reportWindowError(error) { console.error('Could not open desktop window:', error.message) }
function currentWindowState(target) {
  return { version: 1, bounds: target.getNormalBounds(), maximized: target.isMaximized(), fullscreen: target.isFullScreen() }
}
function saveWindowState(target) {
  clearTimeout(windowStateTimer)
  if (!target || target.isDestroyed()) return windowStateWrites
  const state = currentWindowState(target)
  windowStateWrites = windowStateWrites.then(() => writeWindowState(path.join(app.getPath('userData'), 'window-state-v1.json'), state))
    .catch(error => { console.warn('Could not save window preferences:', error.message) })
  return windowStateWrites
}
async function exclusive(action) {
  if (operationActive) return resultError({ code: 'BUSY' })
  operationActive = true
  try {
    return await action()
  } catch (error) {
    return resultError(error)
  } finally {
    operationActive = false
  }
}
function register(name, action, exclusiveOperation = true) {
  ipcMain.handle(`design-desktop:${name}`, async (event, value) => {
    assertSender(event, window)
    if (exclusiveOperation) return exclusive(() => action(value))
    try { return await action(value) } catch (error) { return resultError(error) }
  })
}
function sendCommand(command) {
  if (closePending || quitRequested || shutdownComplete) return
  if (!window || window.isDestroyed() || !rendererReady) {
    if (pendingCommands.length < 32) pendingCommands.push(command)
    else console.warn('Desktop command queue is full; wait for the editor to finish loading')
    if ((!window || window.isDestroyed()) && hostReady) void createWindow().catch(reportWindowError)
    return
  }
  window.webContents.send('design-desktop:command', command)
}
register('renderer-ready', (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  rendererReady = true
  for (const command of pendingCommands.splice(0)) sendCommand(command)
  return { status: 'ok' }
}, false)

// Native design-render (Metal/wgpu) serve-mode bridge: opt-in renderer path
// for real GPU frames and the E6 four-bucket memory ledger. The renderer's
// default WASM worker path is unaffected.
const closeNativeRender = registerNativeRender(ipcMain, {
  resourcesRoot: app.isPackaged ? process.resourcesPath : assets,
  cpuOnly,
  assertSender: (event) => assertSender(event, window),
})
const closeNativePreparation = registerNativePreparation(ipcMain, {
  resourcesRoot: app.isPackaged ? process.resourcesPath : assets,
  assertSender: event => assertSender(event, window),
})

async function nativeOpenMenu() {
  if (window && !window.isDestroyed()) { sendCommand('open'); return }
  if (!hostReady || quitRequested) return
  const selected = await dialog.showOpenDialog({ title: 'Open futureox-desgin design', properties: ['openFile'], filters: fileFilters })
  if (!selected.canceled && selected.filePaths.length === 1) enqueueNativeFile(selected.filePaths[0])
}

function publicDirectory(entry, directory) {
  return { id: directory.id, projectId: directory.projectId, updatedAt: directory.updatedAt,
    displayName: path.basename(directory.path), directoryHandle: entry?.handle,
    requiresReselection: !entry }
}
// Workspace IDs are logical identities; native paths never cross this API.
function workspaceIdentity(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid workspace identity')
  return value
}
function workspaceRevision(value, nullable = false) {
  if (nullable && value === null) return value
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid workspace revision')
  return value
}
function workspacePublic(result) {
  const { document, ...metadata } = result
  return { status: 'ok', ...metadata, ...(document ? { documentJson: JSON.stringify(document) } : {}) }
}
// Selection is an opaque native capability. A complete process restart is the
// storage boundary; no live renderer or callback ever sees a swapped backend.
const rootAction = action => async value => {
  try { return await action(value) } catch (error) { return workspaceRootError(error) }
}
register('workspace-root-status', rootAction(value => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  return workspaceRoots.status()
}), false)
function stageWorkspaceRoot(useDefault = false) {
  if (closePending || quitRequested || pendingWorkspaceRoot) throw Object.assign(new Error('Closing'), { code: 'BUSY' })
  return workspaceRoots.stage(useDefault)
}
register('workspace-root-select', rootAction(value => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  return stageWorkspaceRoot()
}))
register('workspace-root-default', rootAction(value => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  return stageWorkspaceRoot(true)
}))
async function activateWorkspaceRoot(selectionId) {
  if (closePending || quitRequested || pendingWorkspaceRoot) throw Object.assign(new Error('Closing'), { code: 'BUSY' })
  const root = await workspaceRoots.take(selectionId)
  if (root.storagePath === workspaceRoots.current.storagePath) return { status: 'ok', restarting: false }
  pendingWorkspaceRoot = root
  window.close() // Existing renderer close handshake drains/asks about dirty edits.
  return { status: 'ok', restarting: true }
}
register('workspace-root-activate', rootAction(async value => {
  const request = record(value, ['selectionId'])
  return activateWorkspaceRoot(request.selectionId)
}))
register('live-initial',()=>({status:'ok',documentId:initialWorkspaceId||null,sessionId:localSessionId}),false)
register('live-observe',async value=>{
  const request=record(value,['documentId','pageId','view','cursor','selection','viewHash'])
  if(request.viewHash!==undefined&&(typeof request.viewHash!=='string'||request.viewHash.length>128))throw new Error('Invalid local view version')
  const result=await backend.request('workspace.observe',{
    control:{messageType:'subscribe',view_name:'workspace',view_hash:typeof request.viewHash==='string'?request.viewHash:''},
    presence:{id:localSessionId,name:`本机窗口 ${localSessionId.slice(0,4)}`,documentId:request.documentId,pageId:request.pageId,view:request.view,cursor:request.cursor??null,selection:request.selection},
  })
  return {status:'ok',...result}
},false)
register('live-new-window',async value=>{
  const request=record(value,['id']);workspaceIdentity(request.id)
  // All peer processes are direct children of the main host, so its close gate
  // accounts for every launch it owns. A peer cannot create hidden descendants.
  if (peerWindowId !== undefined || closePending || closeFinalizing || pendingWorkspaceRoot || quitRequested)
    throw Object.assign(new Error('Window launch unavailable during workspace transition'), { code: 'BUSY' })
  if(localChildren.size>=8)throw new Error('请先关闭不再使用的本机窗口')
  pendingPeerLaunches++
  try {
    await backend.request('workspace.open',{id:request.id})
    if (closePending || closeFinalizing || pendingWorkspaceRoot || quitRequested) throw Object.assign(new Error('Closing'), { code: 'BUSY' })
    const id=randomUUID(),child=spawn(process.execPath,[...(app.isPackaged?[]:[app.getAppPath()]),`--local-peer=${id}`],{
      detached:true,stdio:'ignore',env:{...process.env,FORMA_LOCAL_WORKSPACE_ROOT:workspaceRoot,FORMA_LOCAL_DOCUMENT_ID:request.id},
    })
    // Track before waiting for spawn; a simultaneous native close cannot overlook it.
    localChildren.add(child);child.once('exit',()=>localChildren.delete(child));child.once('error',()=>localChildren.delete(child))
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
    child.unref()
    return {status:'ok',windowId:id}
  } finally { pendingPeerLaunches-- }
})
register('workspace-list', async (value) => {
  const r = value === undefined ? {} : record(value, ['includeDeleted'])
  if (r.includeDeleted !== undefined && typeof r.includeDeleted !== 'boolean') throw new Error('Invalid workspace filter')
  return { status: 'ok', ...await backend.request('workspace.list', r) }
}, false)
register('workspace-open', async (value) => {
  const r = record(value, ['id', 'revision'])
  workspaceIdentity(r.id)
  if (r.revision !== undefined) workspaceRevision(r.revision)
  return workspacePublic(await backend.request('workspace.open', r))
})
register('workspace-commit', async (value) => {
  const r = record(value, ['documentJson', 'expectedRevision', 'mutationId'])
  workspaceRevision(r.expectedRevision, true); workspaceIdentity(r.mutationId)
  return workspacePublic(await backend.request('workspace.commit', {
    document: documentFromString(r.documentJson), expectedRevision: r.expectedRevision, mutationId: r.mutationId,
  }))
})
register('workspace-trash', async (value) => {
  const r = record(value, ['id', 'expectedRevision', 'mutationId', 'deleted'])
  workspaceIdentity(r.id); workspaceIdentity(r.mutationId); workspaceRevision(r.expectedRevision)
  if (r.deleted !== undefined && typeof r.deleted !== 'boolean') throw new Error('Invalid trash state')
  return workspacePublic(await backend.request('workspace.trash', r))
})
register('workspace-revisions', async (value) => {
  const r = record(value, ['id', 'beforeRevision'])
  workspaceIdentity(r.id)
  if (r.beforeRevision !== undefined) workspaceRevision(r.beforeRevision)
  return { status: 'ok', ...await backend.request('workspace.revisions', r) }
}, false)
register('workspace-restore', async (value) => {
  const r = record(value, ['id', 'revision', 'expectedRevision', 'mutationId'])
  workspaceIdentity(r.id); workspaceIdentity(r.mutationId); workspaceRevision(r.revision); workspaceRevision(r.expectedRevision)
  return workspacePublic(await backend.request('workspace.restore', r))
})
register('fonts-list', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  // Reuse the first bounded enumeration across document/window changes. Reads
  // still validate the actual font hash; expiration or stale reads trigger a rescan.
  if (!fontListing || Date.now() - fontListedAt > 5 * 60_000) {
    fontListedAt = Date.now()
    fontListing = backend.request('fonts.list').catch(error => { fontListing = undefined; throw error })
  }
  return { status: 'ok', ...await fontListing }
}, false)
register('fonts-read', async (value) => {
  const r = record(value, ['id']); workspaceIdentity(r.id)
  try { return { status: 'ok', ...await backend.request('fonts.read', r) } }
  catch (error) { if (['FONT_CHANGED', 'FONT_NOT_FOUND'].includes(error.code)) fontListing = undefined; throw error }
}, false)
register('text-command', async (value) => {
  if (!['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(value)) throw new Error('Invalid text command')
  window.webContents[value]()
  return { status: 'ok' }
}, false)
register('clipboard-read', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  return {status:'ok',...await readDesignClipboard(clipboard,MAX_DOCUMENT_BYTES)}
}, false)
register('clipboard-write', async (value) => {
  const r=record(value,['forma','text','svg','image'])
  await writeDesignClipboard(clipboard,ClipboardItem,nativeImage,r,MAX_DOCUMENT_BYTES)
  return {status:'ok'}
}, false)

register('catalog-list', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  const catalog = await backend.request('catalog.list')
  const directories = []
  for (const directory of catalog.directories) {
    let entry = [...directoryGrants.entries.values()].find((item) => item.directoryId === directory.id)
    if (entry) { try { await directoryGrants.lookup(entry.handle) } catch { entry = undefined } }
    directories.push(publicDirectory(entry, directory))
  }
  return { status: 'ok', projects: catalog.projects, directories, files: catalog.files }
}, false)
register('catalog-select', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  const selection = await dialog.showOpenDialog(window, {
    title: 'Choose a local futureox-desgin project folder', properties: ['openDirectory'],
  })
  if (selection.canceled || selection.filePaths.length !== 1) return cancelled()
  // Keep the accepted document's root alive, just as file-grant eviction preserves activeHandle.
  const entry = await directoryGrants.create(selection.filePaths[0], grants.get(activeHandle)?.directoryHandle)
  try {
    const registered = await backend.request('catalog.register', { path: entry.path })
    await directoryGrants.lookup(entry.handle)
    entry.directoryId = registered.directory.id
    return { status: 'ok', project: registered.project, directory: publicDirectory(entry, registered.directory) }
  } catch (error) { await directoryGrants.revoke(entry.handle); throw error }
})
register('catalog-scan', async (value) => {
  const params = record(value, ['directoryHandle'])
  const entry = await directoryGrants.lookup(params.directoryHandle)
  const scanned = await backend.request('catalog.scan', { directoryId: entry.directoryId, path: entry.path })
  await directoryGrants.lookup(entry.handle)
  entry.files = new Map(scanned.files.map((file) => [file.id, file.relativePath]))
  return { status: 'ok', ...scanned }
}, false)
register('catalog-open', async (value) => {
  const params = record(value, ['directoryHandle', 'fileId'])
  const selected = await directoryGrants.file(params.directoryHandle, params.fileId)
  const opened = await backend.request('open', { path: selected.path, directoryId: selected.entry.directoryId })
  await directoryGrants.lookup(selected.entry.handle)
  return { status: 'ok', handle: grant(opened.path, opened.hash, selected.entry.handle),
    displayName: path.basename(opened.path), documentJson: JSON.stringify(opened.document) }
})

register('sketch-session-open', value => sketchSessions.open(value))
register('sketch-session-rename', value => sketchSessions.rename(value))
register('sketch-session-text-targets', value => sketchSessions.textTargets(value), false)
register('sketch-session-text-value', value => sketchSessions.textValue(value), false)
register('sketch-session-resize-legacy-container', value => sketchSessions.resizeLegacyContainer(value))
register('sketch-session-set-text-override', value => sketchSessions.setTextOverride(value))
register('sketch-session-save-as', value => sketchSessions.saveAs(value))
register('sketch-session-leaf-frame', value => sketchSessions.leafFrame(value), false)
register('sketch-session-set-leaf-frame', value => sketchSessions.setLeafFrame(value))
register('sketch-session-preview', value => sketchSessions.preview(value), false)
register('sketch-session-status', value => sketchSessions.status(value))
register('sketch-session-undo', value => sketchSessions.undo(value))
register('sketch-session-redo', value => sketchSessions.redo(value))
register('sketch-session-close', value => sketchSessions.close(value))

// A separate, read-only native admission lane. It never grants a futureox-desgin save handle.
register('sketch-inspect', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  if (sketchInspectionEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Sketch inspection epoch exhausted')
  const epoch = ++sketchInspectionEpoch, requester = window
  const selection = await dialog.showOpenDialog(requester, {
    title: 'Inspect native Sketch document (editing unavailable)',
    properties: ['openFile'], filters: [{ name: 'Sketch native document', extensions: ['sketch'] }],
  })
  if (selection.canceled || selection.filePaths.length !== 1 || window !== requester || requester.isDestroyed()) return cancelled()
  const selected = selection.filePaths[0]
  if (formatForNativePath(selected) !== 'sketch') throw new Error('Choose a .sketch file')
  const documentId = randomUUID()
  // Extension is routing only. Rust reads bounded bytes and validates the actual archive.
  const result = await backend.request('sketch.inspect', { path: selected, documentId, sessionEpoch: epoch })
  if (window !== requester || requester.isDestroyed() || sketchInspectionEpoch !== epoch) return cancelled()
  return { status: 'ok', ...sketchInspection(result, documentId, epoch, path.basename(selected)) }
})

register('open', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  const selection = await dialog.showOpenDialog(window, {
    title: 'Open futureox-desgin design',
    properties: ['openFile'],
    filters: fileFilters,
  })
  if (selection.canceled || selection.filePaths.length !== 1) return cancelled()
  const selected = requireFd(selection.filePaths[0])
  const opened = await backend.request('open', { path: selected })
  return {
    status: 'ok',
    handle: grant(opened.path, opened.hash),
    displayName: path.basename(opened.path),
    documentJson: JSON.stringify(opened.document),
  }
})
register('open-pending', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  const selected = pendingFiles[0]
  if (!selected) return cancelled()
  let opened
  try { opened = await backend.request('open', { path: selected }) }
  catch (error) {
    // A permanently invalid Finder item is reported once and cannot block later
    // valid items. Transient backend/IO failure retains it for explicit retry.
    if (['NOT_FOUND', 'INVALID_PATH', 'INVALID_DOCUMENT', 'DOCUMENT_TOO_LARGE'].includes(error.code) && pendingFiles[0] === selected) pendingFiles.shift()
    throw error
  }
  return { status: 'ok', handle: grant(opened.path, opened.hash, undefined, selected),
    displayName: path.basename(opened.path), documentJson: JSON.stringify(opened.document), pendingCount: pendingFiles.length - 1 }
})
register('document-accept', async (value) => {
  const params = record(value, ['handle'])
  const target = await lookup(params.handle)
  activeHandle = params.handle
  if (target.pendingPath) {
    const index = pendingFiles.indexOf(target.pendingPath)
    if (index >= 0) pendingFiles.splice(index, 1)
    delete target.pendingPath
  }
  noteRecent(target.path)
  return { status: 'ok' }
})
register('save', async (value) => {
  const params = record(value, ['handle', 'documentJson', 'saveAs'])
  if (params.saveAs !== undefined && typeof params.saveAs !== 'boolean')
    throw new Error('Invalid save mode')
  if (params.handle !== undefined && !validHandle(params.handle))
    throw new Error('Invalid file handle')
  const document = documentFromString(params.documentJson)
  let target = params.handle ? await lookup(params.handle, params.saveAs === true) : null
  let handle = params.handle
  if (params.saveAs || !target) {
    const selection = await dialog.showSaveDialog(window, {
      title: 'Save futureox-desgin design',
      defaultPath: target?.path || 'Untitled.fd',
      filters: fileFilters,
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePath) return cancelled()
    let selected = selection.filePath
    if (!path.extname(selected)) selected += '.fd'
    requireFd(selected)
    const current = await backend.request('stat', { path: selected })
    if (selected !== selection.filePath && current.hash !== null) {
      const overwrite = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Replace existing futureox-desgin file?',
        message: `Replace “${path.basename(selected)}”?`,
        detail: `The .fd extension was added. The existing file at ${selected} will be replaced.`,
        buttons: ['Cancel', 'Replace'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (overwrite.response !== 1) return cancelled()
    }
    // Dialog owns overwrite consent; stat supplies a precise CAS baseline for the sidecar.
    target = { path: current.path, hash: current.hash }
    handle = undefined
  }
  const saved = await backend.request('save', {
    path: target.path,
    document,
    expectedHash: target.hash,
    ...(target.directoryHandle ? { directoryId: (await directoryGrants.lookup(target.directoryHandle)).directoryId } : {}),
  })
  if (handle) grants.set(handle, { ...target, path: saved.path, hash: saved.hash })
  else handle = grant(saved.path, saved.hash)
  activeHandle = handle
  noteRecent(saved.path)
  return {
    status: 'ok',
    handle,
    displayName: path.basename(saved.path),
    ...(saved.warning ? { warning: saved.warning } : {}),
  }
})
register('recovery-write', async (value) => {
  const params = record(value, ['handle', 'documentJson', 'displayName'])
  if (
    params.displayName !== undefined &&
    (typeof params.displayName !== 'string' || params.displayName.length > 256)
  ) {
    throw new Error('Invalid display name')
  }
  const document = documentFromString(params.documentJson)
  const source = params.handle === undefined ? null : await lookup(params.handle, true)
  const saved = await backend.request('recovery.write', {
    recoveryId,
    document,
    sourcePath: source?.path ?? null,
    sourceHash: source?.hash ?? null,
  })
  return { status: 'ok', ...(saved.warning ? { warning: saved.warning } : {}) }
})
register('recovery-clear', async (value) => {
  const params = value === undefined ? {} : record(value, ['recoveryHandle'])
  if (
    params.recoveryHandle !== undefined &&
    (!validHandle(params.recoveryHandle) || !recoveredSources.has(params.recoveryHandle))
  )
    throw new Error('Unknown adopted recovery handle')
  await backend.request('recovery.remove', { recoveryId })
  if (params.recoveryHandle) {
    await backend.request('recovery.remove', {
      recoveryId: recoveredSources.get(params.recoveryHandle),
    })
    recoveredSources.delete(params.recoveryHandle)
  }
  recoveryId = randomUUID()
  return { status: 'ok' }
})
register('recovery-read', async (value) => {
  if (value !== undefined) throw new Error('Unexpected arguments')
  const found = await backend.request('recovery.list')
  const entries = [...found.entries].sort((a, b) => b.updatedAt - a.updatedAt)
  if (!entries.length) {
    if (found.issues.length)
      return {
        status: 'error',
        code: 'RECOVERY_INVALID',
        message: 'Recovery files were found but could not be read. They have been preserved.',
      }
    return cancelled()
  }
  const recoveryWarning = found.issues.length
    ? `${found.issues.length} recovery file(s) could not be read and have been preserved. Other snapshots are still available.\n\n`
    : ''
  // Read-only recovery selection. Never reattach an original writable capability.
  for (const candidate of entries) {
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Recover unsaved design?',
      message: `Recover “${String(candidate.name).slice(0, 160)}” as an unsaved copy?`,
      detail:
        recoveryWarning +
        'The original file will not be overwritten. Use Save As to choose where to keep the recovered design.',
      buttons: ['Recover copy', 'Next snapshot', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (answer.response === 2) return cancelled()
    if (answer.response === 1) continue
    const restored = await backend.request('recovery.read', { recoveryId: candidate.recoveryId })
    const recoveryHandle = randomUUID()
    if (recoveryGrants.size >= 16) recoveryGrants.delete(recoveryGrants.keys().next().value)
    recoveryGrants.set(recoveryHandle, { recoveryId: candidate.recoveryId, hash: restored.hash })
    return {
      status: 'ok',
      recoveryHandle,
      displayName: `${String(restored.name).slice(0, 160)} (Recovered)`,
      documentJson: JSON.stringify(restored.document),
    }
  }
  return cancelled()
})
register('recovery-accept', async (value) => {
  const params = record(value, ['recoveryHandle'])
  if (!validHandle(params.recoveryHandle) || !recoveryGrants.has(params.recoveryHandle))
    throw new Error('Unknown recovery handle')
  const source = recoveryGrants.get(params.recoveryHandle)
  const sourceId = source.recoveryId
  const restored = await backend.request('recovery.read', { recoveryId: sourceId })
  if (restored.hash !== source.hash)
    throw Object.assign(new Error('Recovery changed'), { code: 'CONFLICT' })
  const nextId = randomUUID()
  // Fork the writable identity without consuming a snapshot slot yet. The source remains
  // durable and immutable, including when all recovery slots are full. A user can restore
  // and save that source to free a slot; later edits report quota errors rather than evicting.
  recoveryId = nextId
  recoveredSources.set(params.recoveryHandle, sourceId)
  recoveryGrants.delete(params.recoveryHandle)
  return { status: 'ok' }
})
register(
  'dirty',
  (value) => {
    if (typeof value !== 'boolean') throw new Error('Invalid dirty state')
    dirty = value
    window.setDocumentEdited(dirty)
  },
  false,
)
register(
  'close-response',
  async (value) => {
    const answer = record(value, ['allow', 'requestId'])
    if (typeof answer.allow !== 'boolean') throw new Error('Invalid close response')
    if (!closePending || closeFinalizing || answer.requestId !== closeRequestId) return { accepted: false }
    clearTimeout(closeTimer)
    closeFinalizing = true
    try {
      if (answer.allow && await sketchSessions.beforeWindowClose()) {
        if (!(await commitWorkspaceSwitch())) return { accepted: false }
        permitClose = true
        window.close()
      } else {
        pendingWorkspaceRoot = undefined
        quitRequested = false
        // A rejected Sketch/native approval must also thaw the renderer close fence.
        return { accepted: !answer.allow }
      }
      return { accepted: true }
    } finally { closePending = false; closeFinalizing = false }
  },
  false,
)

async function commitWorkspaceSwitch() {
  if (!pendingWorkspaceRoot) return true
  const target = pendingWorkspaceRoot
  pendingWorkspaceRoot = undefined
  try {
    if (!workspaceRoots.canSwitch()) throw Object.assign(new Error('Other windows are open'), { code: 'WORKSPACE_ROOT_PEERS' })
    await workspaceRoots.verify(target)
    await workspaceRoots.probe(workspaceRoots.config(target))
    await workspaceRoots.persist(target)
    try { app.relaunch() }
    catch {
      await workspaceRoots.persist(workspaceRoots.current)
      throw Object.assign(new Error('Relaunch unavailable'), { code: 'WORKSPACE_ROOT_RESTART' })
    }
    quitRequested = true
    return true
  } catch (error) {
    quitRequested = false
    await dialog.showMessageBox(window, { type: 'error', title: '工作区未切换', message: workspaceRootError(error).message, buttons: ['保留当前工作区'], noLink: true })
    return false
  }
}

async function closeFallback() {
  if (!closePending || !window || window.isDestroyed()) return
  const requestId = closeRequestId
  const requestWindow = window
  // A renderer that failed to load/crashed cannot approve discarding work implicitly.
  const answer = await dialog.showMessageBox(requestWindow, {
    type: 'warning',
    title: 'Editor is not responding',
    message: 'Close without saving the current canvas?',
    detail: 'The last recovery snapshot is kept, but changes after that snapshot may be lost.',
    buttons: ['Keep open', 'Close without saving'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (
    !closePending || closeFinalizing ||
    closeRequestId !== requestId ||
    window !== requestWindow ||
    requestWindow.isDestroyed()
  )
    return
  closeFinalizing = true
  try {
    if (answer.response === 1 && await sketchSessions.beforeWindowClose()) {
      if (!(await commitWorkspaceSwitch())) return
      permitClose = true
      window.close()
    } else { pendingWorkspaceRoot = undefined; quitRequested = false }
  } finally { closePending = false; closeFinalizing = false }
}

async function createWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.focus()
    return window
  }
  if (windowOpening) return windowOpening
  if (quitRequested || shutdownComplete) return
  windowOpening = buildWindow().finally(() => { windowOpening = undefined })
  return windowOpening
}
async function buildWindow() {
  await windowCleanup
  await windowStateWrites
  let saved
  try { saved = await readWindowState(path.join(app.getPath('userData'), 'window-state-v1.json')) }
  catch (error) { console.warn('Could not restore window preferences:', error.message) }
  const placement = fitWindowState(saved, screen.getAllDisplays(), screen.getPrimaryDisplay())
  permitClose = !!renderCheck; closePending = false; closeRequestId = undefined; dirty = !renderCheck; rendererReady = false
  const isolated = session.fromPartition('persist:forma-desktop')
  if (!sessionConfigured) {
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.setDevicePermissionHandler(() => false)
  isolated.on('will-download', (event, item, contents) => {
    const name = Array.from(path.basename(item.getFilename()))
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '/\\'.includes(character)
          ? '_'
          : character,
      )
      .join('')
      .slice(0, 200)
      const allowed = ['.png', '.svg', '.jpg', '.jpeg', '.webp', '.pdf', '.json', '.fdlib', '.sketch'].includes(
      path.extname(name).toLowerCase(),
    )
    if (
      !window ||
      contents !== window.webContents ||
      contents.mainFrame.url !== APP_URL ||
      item.getInitiatorOrigin() !== 'design-app://app' ||
      !/^blob:design-app:\/\/app\/[0-9a-f-]+$/.test(item.getURL())
    ) {
      event.preventDefault()
      return
    }
    if (!allowed) {
      event.preventDefault()
      void dialog.showMessageBox(window, {
        type: 'error',
        message:
          'This export format is not supported here. Use Save or Save As for .fd documents.',
      })
      return
    }
    const total = item.getTotalBytes()
    if (!Number.isSafeInteger(total) || total <= 0 || total > 64 * 1024 * 1024) {
      event.preventDefault()
      void dialog.showMessageBox(window, {
        type: 'error',
        message: 'The export has an unknown size or exceeds the 64 MiB desktop limit.',
      })
      return
    }
    // Existing React export buttons use Blob downloads. Retain them behind a native Save
    // dialog, without exposing paths, arbitrary MIME writes, network downloads or shell APIs.
    item.setSaveDialogOptions({
      title: 'Export design',
      defaultPath: name,
      filters: [{ name: 'Design export', extensions: [path.extname(name).slice(1)] }],
      properties: ['showOverwriteConfirmation'],
    })
    let sizeFailed = false
    item.once('done', (_event, state) => {
      if (state === 'interrupted' && window && !window.isDestroyed())
        void dialog.showMessageBox(window, {
          type: 'error',
          message: 'The export was interrupted and was not completed. Please export again.',
        })
    })
    item.on('updated', () => {
      if (
        !sizeFailed &&
        (item.getReceivedBytes() > 64 * 1024 * 1024 || item.getTotalBytes() > 64 * 1024 * 1024)
      ) {
        sizeFailed = true
        item.cancel()
        void dialog.showMessageBox(window, {
          type: 'error',
          message: 'The export exceeds the 64 MiB desktop limit.',
        })
      }
    })
  })
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel:
        !isAppResource(details.url) &&
        !details.url.startsWith('blob:design-app://app/') &&
        !details.url.startsWith('data:'),
    })
  })
  await isolated.protocol.handle('design-app', async (request) => {
    try {
      if (renderCheck && isAppResource(request.url)) {
        const response = await serveRenderCheck(request)
        if (response) return response
      }
      if (request.method !== 'GET' || !isAppResource(request.url))
        return new Response('Forbidden', { status: 403 })
      const resource = await resourcePath(rendererRoot, request.url)
      const mime = MIME[path.extname(resource)]
      if (!mime) return new Response('Not found', { status: 404 })
      return new Response(await readFile(resource), {
        headers: {
          'Content-Type': mime,
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  sessionConfigured = true
  }
  window = new BrowserWindow({
    ...placement.bounds,
    minWidth: placement.minWidth,
    minHeight: placement.minHeight,
    title: applicationName,
    show: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      additionalArguments: cpuOnly ? ['--core-cpu-only'] : [],
      session: isolated,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      // Isolated validation must not inherit occlusion-based timer throttling
      // when the operator reads the report in another app. Product policy stays unchanged.
      backgroundThrottling: !renderCheck,
      spellcheck: false,
    },
  })
  const ownedWindow = window
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'])
    window.on(event, () => { clearTimeout(windowStateTimer); windowStateTimer = setTimeout(() => void saveWindowState(ownedWindow), 200) })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Forward renderer console logs to terminal (for debugging)
  window.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (message.includes('[imageLevel]') || message.includes('[Image Pixel Check]') || message.includes('GPU')) {
      const levelName = ['', 'INFO', 'WARN', 'ERROR'][level] || 'LOG'
      console.log(`[RENDERER ${levelName}] ${message}`)
    }
  })

  window.webContents.on('before-input-event', (event, input) => {
    forwardNativeEditorShortcut(event, input, {
      platform: process.platform, sendCommand,
      setIgnoreMenuShortcuts: (ignore) => ownedWindow.webContents.setIgnoreMenuShortcuts(ignore),
    })
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void automationBridge.close()
  })
  window.webContents.on('render-process-gone', () => {
    void automationBridge.close()
    dirty = true
  })
  window.once('ready-to-show', () => {
    if (placement.maximized) ownedWindow.maximize()
    if (placement.fullscreen) ownedWindow.setFullScreen(true)
    ownedWindow.show()
  })
  window.on('close', (event) => {
    void saveWindowState(ownedWindow)
    if (permitClose) return
    // Always let the renderer drain recovery/save work, even if the last dirty flag was false.
    event.preventDefault()
    if (closePending) return
    closePending = true
    closeRequestId = randomUUID()
    window.webContents.send('design-desktop:close-request', { requestId: closeRequestId })
    closeTimer = setTimeout(() => void closeFallback(), 20_000)
  })
  window.on('closed', () => {
    clearTimeout(closeTimer)
    clearTimeout(windowStateTimer)
    window = undefined
    rendererReady = false
    pendingCommands.length = 0
    activeHandle = undefined
    grants.clear(); recoveryGrants.clear(); recoveredSources.clear()
    recoveryId = randomUUID()
    windowCleanup = Promise.all([directoryGrants.clear(), closeNativeRender(), closeNativePreparation(), automationBridge.close()])
    if (process.platform !== 'darwin' || quitRequested) void shutdown()
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
          { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => { void nativeOpenMenu().catch(reportWindowError) } },
          { label: 'Open Pending Finder File', click: () => sendCommand('openPending') },
          ...(process.platform === 'darwin' ? [{ role: 'recentDocuments', submenu: [
            { label: 'Clear Recent', role: 'clearRecentDocuments' },
          ] }] : []),
          { type: 'separator' },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
          {
            label: 'Save As…',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => sendCommand('saveAs'),
          },
          { label: 'Recover unsaved design…', click: () => sendCommand('recover') },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { label: 'Edit', submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendCommand('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => sendCommand('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendCommand('copy') },
        { label: 'Copy as PNG', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendCommand('copy-as-png') },
        { label: 'Copy Properties', accelerator:'CmdOrCtrl+Alt+C',click:()=>sendCommand('copy-properties') },
        { label: 'Paste Properties', accelerator:'CmdOrCtrl+Alt+V',click:()=>sendCommand('paste-properties') },
        { label: 'Copy as SVG', click: () => sendCommand('copy-as-svg') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendCommand('paste') },
        { label: 'Paste to Replace', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendCommand('paste-to-replace') },
        { label: 'Paste Over Selection', accelerator: 'CmdOrCtrl+Shift+V', click: () => sendCommand('paste-over-selection') },
        { label: 'Paste in Place', click: () => sendCommand('paste-in-place') },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => sendCommand('duplicate') },
        { type: 'separator' },
        { label:'Select Matching',accelerator:'CmdOrCtrl+Alt+A',click:()=>sendCommand('select-matching') },
        { label:'Select Inverse',accelerator:'CmdOrCtrl+Shift+A',click:()=>sendCommand('select-inverse') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendCommand('select-all') },
      ] },
      { label: 'Object', submenu: [
        { label: 'Group', accelerator: 'CmdOrCtrl+G', click: () => sendCommand('group') },
        { label: 'Ungroup', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendCommand('ungroup') },
      ] },
      {
        label: 'View',
        submenu: [
          ...(guiTest ? [{
            label: 'Capture GUI test screenshot',
            accelerator: 'CmdOrCtrl+Shift+9',
            click: async () => {
              const screenshot = path.join(app.getPath('userData'), 'desktop-gui-test.png')
              try {
                await writeFile(screenshot, (await window.webContents.capturePage()).toPNG())
                console.log(`DESKTOP_GUI_SCREENSHOT ${screenshot}`)
              } catch (error) {
                console.error('Desktop GUI screenshot failed:', error)
              }
            },
          }, { type: 'separator' }] : []),
          { label: 'Center Selection', click: () => sendCommand('center-selection') },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('zoom100') },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => sendCommand('zoomIn') },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendCommand('zoomOut') },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      automationBridge.menu,
      ...(process.platform === 'darwin' ? [{ role: 'windowMenu' }] : []),
    ]),
  )
  await window.loadURL(renderCheck?.url || APP_URL)
  window.webContents.setZoomFactor(1)
  return window
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv = []) => {
    if (process.platform !== 'darwin') for (const value of argv) enqueueNativeFile(value)
    if (hostReady) void createWindow().catch(reportWindowError)
  })
  app.on('activate', () => { if (hostReady && !quitRequested) void createWindow().catch(reportWindowError) })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || quitRequested) void shutdown() })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    quitRequested = true
    if (window && !window.isDestroyed()) window.close()
    else if (windowOpening) void windowOpening.then(() => window ? window.close() : shutdown())
    else void shutdown()
  })
  app
    .whenReady()
    .then(async () => {
      if (peerWindowId === undefined) {
        const selected = await workspaceRoots.startup({ isolated: smoke || guiTest || isolatedProfile || !!renderCheck })
        if (!selected) { shutdownComplete = true; app.quit(); return }
        workspaceRoot = selected.storagePath
      } else {
        // The spawning native host supplied this root. Peers cannot change it or
        // persist the main profile's selection, and keep their own Electron profile.
        workspaceRoots.current = { kind: 'peer', rootPath: path.basename(workspaceRoot) === '.futureox-workspace' ? path.dirname(workspaceRoot) : workspaceRoot, storagePath: workspaceRoot }
      }
      const { recoveryDir, catalogDb, workspaceDb } = workspaceRoots.config(workspaceRoots.current)
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 })
      backend = new Sidecar(executable, recoveryDir, { catalogDb, workspaceDb })
      let startupError
      try {
        const health = await backend.request('health')
        if (health.protocolVersion !== 1 || health.maxDocumentBytes !== MAX_DOCUMENT_BYTES)
          throw new Error('Backend protocol mismatch')
      } catch (error) {
        startupError = error
      }
      hostReady = true
      const constrainWindow = () => {
        if (!window || window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
        const fitted = fitWindowState(currentWindowState(window), screen.getAllDisplays(), screen.getPrimaryDisplay())
        if (JSON.stringify(window.getNormalBounds()) !== JSON.stringify(fitted.bounds)) window.setBounds(fitted.bounds)
      }
      screen.on('display-removed', constrainWindow)
      screen.on('display-metrics-changed', constrainWindow)
      await createWindow()
      reportPendingOverflow()
      if (startupError)
        await dialog.showMessageBox(window, {
          type: 'error',
          title: 'Local backend unavailable',
          message:
            'The local Rust backend could not start. File operations and recovery are unavailable.',
          detail: 'Build or reinstall the desktop bundle before editing important work.',
        })
      if (smoke) await runSmoke()
    })
    .catch(async (error) => {
      console.error('Desktop startup failed:', error.message)
      await backend?.stop()
      app.exit(1)
    })
}

async function shutdown() {
  if (!shutdownPromise)
    shutdownPromise = (async () => {
      await automationBridge.close()
      await windowStateWrites
      await windowCleanup
      await closeNativeRender()
      await closeNativePreparation()
      let leaseTimer
      if(backend)try{await Promise.race([backend.request('workspace.leave',{id:localSessionId}),new Promise((_,reject)=>{leaseTimer=setTimeout(()=>reject(new Error('Local lease cleanup timed out')),3000)})])}catch(error){console.warn('Local presence lease will expire:',error.message)}finally{clearTimeout(leaseTimer)}
      if (backend && !(await backend.stop()))
        console.error('Backend termination did not complete within the timeout')
      await directoryGrants.clear()
      grants.clear()
      recoveryGrants.clear()
      recoveredSources.clear()
      shutdownComplete = true
      app.quit()
    })()
  return shutdownPromise
}

async function runSmoke() {
  // Owned local smoke mode; no remote debugger, renderer IPC testing hooks or sandbox override.
  const report = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 30000;
    const surface = () => document.querySelector('canvas.kernel-surface[data-renderer="cpu"]');
    while ((!document.querySelector('.app-shell[data-desktop-ready="true"]') || !surface()) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const frame = surface();
    return { url: location.href, bridge: window.coreDesktop?.version,
      node: typeof window.require, process: typeof window.process,
      ready: !!document.querySelector('.app-shell[data-desktop-ready="true"]'),
      text: document.body.innerText.slice(0, 1000), canvas: document.querySelectorAll('canvas').length,
      renderBackend: frame?.dataset.renderer, renderMs: Number(frame?.dataset.renderMs) };
  })()`)
  const preferences = window.webContents.getLastWebPreferences()
  const health = await backend.request('health')
  report.preferences = {
    sandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation,
    nodeIntegration: preferences.nodeIntegration,
    webSecurity: preferences.webSecurity,
  }
  report.backendProtocol = health.protocolVersion
  if (
    report.bridge !== 1 ||
    report.node !== 'undefined' ||
    report.process !== 'undefined' ||
    !report.ready ||
    report.canvas < 1 ||
    report.renderBackend !== 'cpu' ||
    !Number.isFinite(report.renderMs) ||
    !preferences.sandbox ||
    !preferences.contextIsolation ||
    preferences.nodeIntegration ||
    !preferences.webSecurity ||
    health.protocolVersion !== 1
  ) {
    console.error(`DESKTOP_SMOKE_FAILED ${JSON.stringify(report)}`)
    throw new Error('Desktop smoke editor readiness or isolation failed')
  }
  const screenshot = path.join(app.getPath('userData'), 'desktop-smoke.png')
  await writeFile(screenshot, (await window.webContents.capturePage()).toPNG())
  report.screenshot = screenshot
  console.log(`DESKTOP_SMOKE ${JSON.stringify(report)}`)
  quitRequested = true
  permitClose = true
  window.close()
}
