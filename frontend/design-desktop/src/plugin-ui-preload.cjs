'use strict'
const { ipcRenderer } = require('electron')
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
