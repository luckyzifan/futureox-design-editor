export function jsonPluginMessage(value) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || text.length > 65536) throw new Error('Plugin message must be JSON up to 64 KiB')
  return JSON.parse(text)
}

export function pluginUiSize(width, height) {
  const number = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
  return { width: number(width, 300, 200, 800), height: number(height, 240, 140, 800) }
}

export function wrapPluginUiDocument(html) {
  if (typeof html !== 'string') throw new TypeError('Plugin UI must be a string')
  if (html.length > 200_000) throw new Error('Plugin UI exceeds 200000 characters')
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'">`
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`)
  return `<!doctype html><html><head>${csp}</head><body>${html}</body></html>`
}

export function createPluginUiHost({ BrowserWindow, session, ipcMain, preloadPath, send }) {
  let child = null
  let pluginSession = null
  let listening = false
  const silent = new WeakSet()
  function ensure() {
    if (listening) return
    listening = true
    pluginSession = session.fromPartition('futureox-plugin-ui', { cache: false })
    pluginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    pluginSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url
      callback(url.startsWith('data:') || url === 'about:blank' ? { cancel: false } : { cancel: true })
    })
    ipcMain.on('design-desktop:plugin-ui-message', (event, value) => {
      if (!child || child.isDestroyed() || event.sender !== child.webContents) return
      try { send('design-desktop:plugin-ui-message', { pluginMessage: jsonPluginMessage(value?.pluginMessage) }) } catch { /* Drop malformed UI messages. */ }
    })
  }
  return {
    open({ html, width, height, title, parent }) {
      ensure()
      this.close()
      const size = pluginUiSize(width, height)
      const document = wrapPluginUiDocument(html)
      const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
      if (url.length > 1_500_000) throw new Error('Plugin UI is too large to open')
      const opened = new BrowserWindow({
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        width: size.width,
        height: size.height,
        show: true,
        title: typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Plugin' : 'Plugin',
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: preloadPath,
          session: pluginSession,
        },
      })
      child = opened
      opened.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      opened.webContents.on('will-navigate', (event, next) => { if (!String(next).startsWith('data:')) event.preventDefault() })
      opened.on('closed', () => {
        if (child === opened) child = null
        if (!silent.has(opened)) send('design-desktop:plugin-ui-closed', { closed: true })
      })
      return opened.loadURL(url)
    },
    post(pluginMessage) {
      if (!child || child.isDestroyed()) return
      child.webContents.send('design-desktop:plugin-ui-deliver', { pluginMessage: jsonPluginMessage(pluginMessage) })
    },
    close() {
      if (!child || child.isDestroyed()) { child = null; return }
      silent.add(child)
      const closing = child
      child = null
      closing.close()
    },
  }
}
