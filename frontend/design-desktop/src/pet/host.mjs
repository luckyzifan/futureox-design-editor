import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, realpath } from 'node:fs/promises'
import { createPetController } from './controller.mjs'

export const PET_URL = 'design-pet://pet/index.html'
export const PET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
export async function petResource(root, request) {
  try {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.protocol !== 'design-pet:' || url.hostname !== 'pet' || url.username || url.password || url.port || url.search) return new Response('Forbidden', { status: 403 })
    const name = decodeURIComponent(url.pathname)
    if (name.includes('\\') || name.includes('\0') || name.split('/').includes('..')) return new Response('Forbidden', { status: 403 })
    const base = await realpath(root), candidate = await realpath(path.resolve(base, `.${name}`))
    const relative = path.relative(base, candidate)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !mime[path.extname(candidate)]) return new Response('Forbidden', { status: 403 })
    return new Response(await readFile(candidate), { headers: { 'Content-Type': mime[path.extname(candidate)], 'Content-Security-Policy': PET_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
  } catch { return new Response('Not found', { status: 404 }) }
}

// Separate sandboxed renderer execution; Chromium GPU service and hardware remain shared.
// No editor pixels, documents, filenames, credentials, or arbitrary commands enter this host.
export function createPetHost({ BrowserWindow, session, ipcMain, screen, powerMonitor, app, timers = {} }) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let pet = null, editor = null, isolated = null, ready = false, disposed = false, systemSuspended = false, locked = false, failed = false
  const editorListeners = [], globalListeners = []
  const setTimer = timers.setTimer || setTimeout, clearTimer = timers.clearTimer || clearTimeout
  let loadTimer = null, statusRevision = 0
  function cancelLoadTimer() { if (loadTimer !== null) clearTimer(loadTimer); loadTimer = null }
  const listen = (target, event, callback, list) => { target.on(event, callback); list.push(() => target.removeListener(event, callback)) }
  const sleeping = () => systemSuspended || locked
  const isEditorVisible = () => editor && !editor.isDestroyed() && editor.isVisible() && !editor.isMinimized()
  function syncVisibility() {
    if (!pet || pet.isDestroyed()) return
    // State changes during image loading must never reveal an unready renderer.
    const visible = ready && !disposed && controller.state().mode !== 'off' && isEditorVisible() && !sleeping()
    if (visible) { if (!pet.isVisible()) pet.showInactive() }
    else if (pet.isVisible()) pet.hide()
  }
  function closePet() {
    cancelLoadTimer()
    const previous = pet; pet = null; ready = false
    if (previous && !previous.isDestroyed()) previous.destroy()
  }
  const controller = createPetController({ ...timers, publish(state) {
    if (state.mode === 'off') { closePet(); return }
    if (pet && !pet.isDestroyed()) {
      if (ready) pet.webContents.send('design-pet:state', state)
      syncVisibility()
    }
  } })
  function sync() { controller.suspend(sleeping() || !isEditorVisible()) }
  function status() { return { mode: controller.state().mode, phase: failed ? 'unavailable' : controller.state().mode === 'off' ? 'off' : ready ? 'ready' : 'starting', revision: statusRevision } }
  function publishStatus() {
    statusRevision++
    if (editor && !editor.isDestroyed()) editor.webContents.send('design-desktop:pet-status', status())
    return status()
  }
  function trip() { if (disposed || !pet) return; failed = true; controller.configure('off'); closePet(); publishStatus() }
  function ensureWindow() {
    if (pet || disposed || failed) return
    if (!isolated) {
      isolated = session.fromPartition('futureox-pet-v1')
      isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('design-pet://pet/') }))
      isolated.protocol.handle('design-pet', request => petResource(path.join(here, 'renderer'), request))
    }
    const area = screen.getPrimaryDisplay().workArea
    const owned = new BrowserWindow({ width: 240, height: 280, x: area.x + Math.max(0, area.width - 256), y: area.y + Math.max(0, area.height - 296),
      show: false, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      webPreferences: { preload: path.join(here, 'preload.cjs'), session: isolated, sandbox: true, contextIsolation: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: true, spellcheck: false, devTools: false },
    })
    pet = owned; ready = false
    owned.setIgnoreMouseEvents(true) // No global pointer polling or alpha readbacks; editor always owns input.
    owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) owned.webContents.on(event, event => event.preventDefault())
    const failOwnedWindow = () => { if (pet === owned) trip() }
    owned.webContents.on('render-process-gone', failOwnedWindow)
    owned.webContents.on('did-fail-load', failOwnedWindow)
    owned.on('closed', () => { if (pet === owned) { pet = null; ready = false; controller.configure('off'); publishStatus() } })
    loadTimer = setTimer(() => { loadTimer = null; failOwnedWindow() }, 10000)
    void owned.loadURL(PET_URL).catch(failOwnedWindow)
    sync()
  }
  function onReady(event) {
    if (ready || !pet || pet.isDestroyed() || event.sender !== pet.webContents || event.senderFrame !== pet.webContents.mainFrame || event.senderFrame?.url !== PET_URL) return
    cancelLoadTimer(); ready = true; sync(); publishStatus(); pet.webContents.send('design-pet:state', controller.state())
    syncVisibility()
  }
  ipcMain.on('design-pet:ready', onReady)
  if (powerMonitor) {
    listen(powerMonitor, 'suspend', () => { systemSuspended = true; sync(); pet?.hide() }, globalListeners)
    listen(powerMonitor, 'resume', () => { systemSuspended = false; sync() }, globalListeners)
    listen(powerMonitor, 'lock-screen', () => { locked = true; sync(); pet?.hide() }, globalListeners)
    listen(powerMonitor, 'unlock-screen', () => { locked = false; sync() }, globalListeners)
  }
  if (app) listen(app, 'child-process-gone', (_event, details) => { if (details.type === 'GPU') trip() }, globalListeners)
  return {
    configure(mode) {
      // Explicit off → on permits retry after a crash, never an automatic restart loop.
      if (mode === 'off') failed = false
      if (failed && mode !== 'off') return { ok: false, ...status(), failed: true, backend: 'canvas2d-sprite-lite' }
      controller.configure(mode)
      if (mode !== 'off') { ensureWindow(); sync() }
      return { ok: true, ...publishStatus(), failed, backend: 'canvas2d-sprite-lite' }
    },
    event(value) { return { ok: true, accepted: controller.event(value) } },
    attachEditor(value) {
      for (const remove of editorListeners.splice(0)) remove()
      editor = value
      for (const event of ['show', 'hide', 'minimize', 'restore']) listen(editor, event, sync, editorListeners)
      listen(editor, 'closed', () => { editor = null; controller.configure('off'); closePet() }, editorListeners)
      listen(editor.webContents, 'did-start-loading', () => { controller.event('navigation-end'); controller.configure('off') }, editorListeners)
      sync()
    },
    dispose() {
      if (disposed) return
      disposed = true; controller.dispose(); closePet()
      for (const remove of [...editorListeners.splice(0), ...globalListeners.splice(0)]) remove()
      ipcMain.removeListener('design-pet:ready', onReady)
      isolated?.protocol.unhandle('design-pet')
      isolated?.webRequest.onBeforeRequest(null)
    },
  }
}
