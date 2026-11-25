'use strict'
const { contextBridge, ipcRenderer } = require('electron')
window.addEventListener('message', event => {
  if (event.source !== window) return
  const data = event.data
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'pluginMessage') || data.fromHost === true) return
  ipcRenderer.send('design-desktop:plugin-ui-message', { pluginMessage: data.pluginMessage })
})
ipcRenderer.on('design-desktop:plugin-ui-deliver', (_event, value) => {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'pluginMessage')) return
  window.postMessage({ pluginMessage: value.pluginMessage, fromHost: true }, '*')
})
contextBridge.exposeInMainWorld('__futureoxPluginFetch', (url, method, accept) =>
  ipcRenderer.invoke('design-desktop:plugin-ui-fetch', { url, method, accept }))
contextBridge.executeInMainWorld({
  func: () => {
    const ask = window.__futureoxPluginFetch
    const browserFetch = window.fetch.bind(window)
    window.fetch = async function (input, init) {
      const request = new Request(input, init)
      if (new URL(request.url).protocol === 'data:') return browserFetch(input, init)
      request.signal.throwIfAborted()
      if (request.credentials === 'include' || request.mode !== 'cors' ||
          [...request.headers.keys()].some(name => name !== 'accept'))
        throw new TypeError('Plugin UI fetch supports public CORS requests without credentials')
      const result = await ask(request.url, request.method, request.headers.get('accept') ?? '*/*')
      request.signal.throwIfAborted()
      if (!result.ok) throw new TypeError(result.error)
      const { status, headers, url, base64 } = result.response
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      const empty = request.method === 'HEAD' || status === 204 || status === 205
      const response = new Response(empty ? null : bytes, { status, headers })
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
  },
})
