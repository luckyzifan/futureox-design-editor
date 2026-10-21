'use strict'
// Sandboxed preloads can require Electron, but must not expose it or ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed preload cannot import local host modules. Accept only the host's
// canonical numeric argument, with the same launch bounds as the pure parser.
const gpuBudgetPrefix = '--core-gpu-working-budget-mib='
const gpuBudgetArguments = process.argv.filter(value => value === '--core-gpu-working-budget-mib' || value.startsWith(gpuBudgetPrefix))
let gpuWorkingBudgetMiB
if (gpuBudgetArguments.length) {
  const raw = gpuBudgetArguments[0].slice(gpuBudgetPrefix.length)
  const invalid = () => new TypeError('--core-gpu-working-budget-mib must occur once with a decimal integer from 256 to 4096 MiB')
  if (gpuBudgetArguments.length !== 1 || !/^[1-9][0-9]*$/.test(raw)) throw invalid()
  gpuWorkingBudgetMiB = Number(raw)
  if (!Number.isSafeInteger(gpuWorkingBudgetMiB) || String(gpuWorkingBudgetMiB) !== raw || gpuWorkingBudgetMiB < 256 || gpuWorkingBudgetMiB > 4096) throw invalid()
}
const diagnosticListeners = new Set()
const reportDiagnostic = code => { for (const listener of diagnosticListeners) { try { listener({code}) } catch {} } }
const invoke = (name, value) => ipcRenderer.invoke(`design-desktop:${name}`, value).then(result => {
  if (!name.startsWith('diagnostics-') && result?.status === 'error') reportDiagnostic(result.code)
  return result
}, error => {
  if (!name.startsWith('diagnostics-')) reportDiagnostic('OPERATION_FAILED')
  throw error
})
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
    renderDiagnostics: process.argv.includes('--core-render-diagnostics'),
    renderDiagnosticsDetail: process.argv.includes('--core-render-diagnostics-detail'),
    petConfigure: mode => invoke('pet-configure', mode),
    petEvent: event => invoke('pet-event', event),
    onPetStatus: callback => subscribe('design-desktop:pet-status', callback, value => value &&
      ['off', 'quiet', 'active'].includes(value.mode) && ['off', 'starting', 'ready', 'unavailable'].includes(value.phase) &&
      Number.isSafeInteger(value.revision) && value.revision >= 0),
    diagnostics: Object.freeze({ read: () => invoke('diagnostics-read'), write: value => invoke('diagnostics-write', value),
      onError: callback => { if (typeof callback !== 'function') throw new TypeError('Expected a callback'); diagnosticListeners.add(callback); return () => diagnosticListeners.delete(callback) },
    }),
    // Enabling always requires native confirmation; renderer requests cannot
    // grant external access without that per-document approval.
    automation: Object.freeze({
      status: () => invoke('automation-status'),
      config: () => invoke('automation-config'),
      configure: value => invoke('automation-configure', value),
      auditHistory: value => invoke('automation-audit-history', value),
      storageStatus: () => invoke('automation-storage-status'),
      enable: value => invoke('automation-enable', value),
      disable: () => invoke('automation-disable'),
      copyConnection: () => invoke('automation-copy-connection'),
      onStatus: callback => subscribe('design-desktop:automation-status', callback,
        value => value && typeof value.enabled === 'boolean'),
      register: value => invoke('automation-register', value),
      recordEdit: value => invoke('automation-record-edit', value),
      respond: value => invoke('automation-response', value),
      onRequest: callback => subscribe('design-desktop:automation-request', callback,
        value => value && typeof value.requestId === 'string' && ['capabilities', 'execute', 'host'].includes(value.kind)),
      onCancel: callback => subscribe('design-desktop:automation-cancel', callback,
        value => value && typeof value.requestId === 'string'),
    }),
    rendererReady: () => invoke('renderer-ready'),
    performTextCommand: (value) => invoke('text-command', value),
    fonts: Object.freeze({ list: () => invoke('fonts-list'), read: (value) => invoke('fonts-read', value) }),
    workspaceRoot: Object.freeze({
      status: () => invoke('workspace-root-status'),
      select: () => invoke('workspace-root-select'),
      useDefault: () => invoke('workspace-root-default'),
      activate: value => invoke('workspace-root-activate', value),
    }),
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
    renderPolicy: Object.freeze({ cpuOnly: process.argv.includes('--core-cpu-only'), ...(gpuWorkingBudgetMiB === undefined ? {} : { gpuWorkingBudgetMiB }) }),
    preparation: Object.freeze({
      open: () => ipcRenderer.invoke('native-preparation:open'),
      request: (session, request) => ipcRenderer.invoke('native-preparation:request', session, request),
      close: session => ipcRenderer.invoke('native-preparation:close', session),
    }),
    documentCodec: Object.freeze({
      // The persistent codec worker serializes plain admitted objects with JSON.stringify.
      encoding: 'json-stringify-v1',
      // Versioned exact JSON.parse contract, including the native32MiB input bound.
      decoding: 'json-parse-v1',
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
        ['settings', 'new', 'new-page', 'open', 'openPending', 'save', 'saveAs', 'recover', 'zoomIn', 'zoomOut', 'zoom100', 'undo', 'redo', 'cut', 'copy', 'paste', 'copy-properties','paste-properties','select-matching','select-inverse', 'copy-as-png', 'copy-as-svg', 'paste-to-replace', 'paste-over-selection', 'paste-in-place', 'select-all', 'duplicate', 'group', 'ungroup', 'delete', 'zoom-fit', 'zoom-selection', 'center-selection'].includes(value),
      ),
  }),
)
