'use strict'
// Sandboxed preloads can require Electron, but must not expose it or ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, value) => ipcRenderer.invoke(`design-desktop:${name}`, value)
function subscribe(channel, callback, validate) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback')
  const listener = (_event, value) => {
    if (validate(value)) callback(value)
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
contextBridge.exposeInMainWorld(
  'coreDesktop',
  Object.freeze({
    version: 1,
    rendererReady: () => invoke('renderer-ready'),
    performTextCommand: (value) => invoke('text-command', value),
    fonts: Object.freeze({ list: () => invoke('fonts-list'), read: (value) => invoke('fonts-read', value) }),
    workspace: Object.freeze({
      list: (value) => invoke('workspace-list', value),
      open: (value) => invoke('workspace-open', value),
      commit: (value) => invoke('workspace-commit', value),
      trash: (value) => invoke('workspace-trash', value),
      revisions: (value) => invoke('workspace-revisions', value),
      restore: (value) => invoke('workspace-restore', value),
    }),
    live: Object.freeze({initial:()=>invoke('live-initial'),observe:value=>invoke('live-observe',value),openWindow:value=>invoke('live-new-window',value)}),
    clipboard: Object.freeze({
      read: () => invoke('clipboard-read'),
      write: (value) => invoke('clipboard-write', value),
    }),
    renderPolicy: Object.freeze({ cpuOnly: process.argv.includes('--core-cpu-only') }),
    preparation: Object.freeze({
      open: () => ipcRenderer.invoke('native-preparation:open'),
      request: (session, request) => ipcRenderer.invoke('native-preparation:request', session, request),
      close: session => ipcRenderer.invoke('native-preparation:close', session),
    }),
    documentCodec: Object.freeze({
      encode: value => ipcRenderer.invoke('native-document:encode', value),
      decode: value => ipcRenderer.invoke('native-document:decode', value),
    }),
    nativeRender: Object.freeze({
      load: (value) => ipcRenderer.invoke('native-render:load', value),
      frame: (options, pan) => ipcRenderer.invoke('native-render:frame', options, pan),
      stop: () => ipcRenderer.invoke('native-render:stop'),
      stats: () => ipcRenderer.invoke('native-render:stats'),
    }),
    // Latest E6 four-bucket GPU memory breakdown as a JSON string, or null
    // when no native frame has rendered yet (GpuMemoryPanel consumes this).
    nativeRenderStats: async () => {
      try {
        const result = await ipcRenderer.invoke('native-render:stats')
        const memory = result && result.ok ? result.stats?.gpu_memory : undefined
        return memory ? JSON.stringify(memory) : null
      } catch {
        return null
      }
    },
    listCatalog: () => invoke('catalog-list'),
    selectCatalogDirectory: () => invoke('catalog-select'),
    scanCatalogDirectory: (value) => invoke('catalog-scan', value),
    openCatalogFile: (value) => invoke('catalog-open', value),
    openDocument: () => invoke('open'),
    inspectSketch: () => invoke('sketch-inspect'),
    sketchSession: Object.freeze({
      open: () => invoke('sketch-session-open'),
      rename: value => invoke('sketch-session-rename', value),
      textTargets: value => invoke('sketch-session-text-targets', value),
      textValue: value => invoke('sketch-session-text-value', value),
      resizeLegacyContainer: value => invoke('sketch-session-resize-legacy-container', value),
      setTextOverride: value => invoke('sketch-session-set-text-override', value),
      undo: value => invoke('sketch-session-undo', value),
      redo: value => invoke('sketch-session-redo', value),
      status: value => invoke('sketch-session-status', value),
      preview: value => invoke('sketch-session-preview', value),
      leafFrame: value => invoke('sketch-session-leaf-frame', value),
      setLeafFrame: value => invoke('sketch-session-set-leaf-frame', value),
      saveAs: value => invoke('sketch-session-save-as', value),
      close: value => invoke('sketch-session-close', value),
    }),
    openPendingDocument: () => invoke('open-pending'),
    acceptDocument: (value) => invoke('document-accept', value),
    saveDocument: (value) => invoke('save', value),
    readRecovery: () => invoke('recovery-read'),
    acceptRecovery: (value) => invoke('recovery-accept', value),
    writeRecovery: (value) => invoke('recovery-write', value),
    clearRecovery: (value) => invoke('recovery-clear', value),
    setDirty: (value) => invoke('dirty', value),
    respondToClose: (value) => invoke('close-response', value),
    onCloseRequested: (callback) =>
      subscribe(
        'design-desktop:close-request',
        callback,
        (value) => value && typeof value.requestId === 'string',
      ),
    onCommand: (callback) =>
      subscribe('design-desktop:command', callback, (value) =>
        ['new', 'open', 'openPending', 'save', 'saveAs', 'recover', 'zoomIn', 'zoomOut', 'zoom100', 'undo', 'redo', 'cut', 'copy', 'paste', 'copy-properties','paste-properties','select-matching','select-inverse', 'copy-as-png', 'copy-as-svg', 'paste-to-replace', 'paste-in-place', 'select-all', 'duplicate', 'group', 'ungroup', 'delete', 'zoom-fit', 'zoom-selection'].includes(value),
      ),
  }),
)
