'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('nomiPet', Object.freeze({
  ready: () => ipcRenderer.send('design-pet:ready'),
  onState(callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected callback')
    const listener = (_event, value) => {
      if (value && ['off', 'quiet', 'active'].includes(value.mode) &&
          ['idle', 'work', 'nod', 'celebrate', 'puzzled', 'wave'].includes(value.action) &&
          typeof value.paused === 'boolean' && Number.isSafeInteger(value.sequence)) callback(value)
    }
    ipcRenderer.on('design-pet:state', listener)
    return () => ipcRenderer.removeListener('design-pet:state', listener)
  },
}))
