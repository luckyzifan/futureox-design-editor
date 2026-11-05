import net from 'node:net'
import path from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { WorkspaceAutomationHost, isWorkspaceAutomationMethod, permitsAutomationMethod, validAutomationGrants } from './workspace-automation.mjs'
import { attachFigmaMcp, codexMcpToml } from './figma-mcp-host.mjs'

export const AUTOMATION_PROTOCOL_VERSION = 1
export const MAX_AUTOMATION_FRAME_BYTES = 32 * 1024 * 1024
export const STANDARD_AUTOMATION_FRAME_BYTES = 8 * 1024 * 1024
const MAX_RETAINED_REQUEST_BYTES = 48 * 1024 * 1024
const LARGE_INPUT_METHODS = new Set(['workspace.importCopy', 'font.import', 'document.import', 'sketch.import', 'clipboard.paste', 'clipboard.pasteProperties'])
const LARGE_OUTPUT_METHODS = new Set(['document.export', 'sketch.export', 'clipboard.export'])
const REQUEST_TIMEOUT_MS = 15_000
const MAX_PENDING = 8
const MAX_CONNECTIONS = 4
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const ownKeys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key))
const fail = (code, message) => Object.assign(new Error(message), { code })
const wireError = error => ({ code: typeof error?.code === 'string' ? error.code : 'BRIDGE_ERROR', message: error?.message || 'Local automation failed' })
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const validMethod = value => typeof value === 'string' && /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(value) && value.length <= 100
function allowsLargeInput(request) {
  if (LARGE_INPUT_METHODS.has(request?.method)) return true
  const operations = request?.params?.operations
  return request?.method === 'batch.apply' && Array.isArray(operations) && operations.length > 0 && operations.length <= 500 &&
    operations.every(operation => ownKeys(operation, ['method', 'params']) && operation.method !== 'batch.apply') &&
    operations.some(operation => operation.method !== 'workspace.importCopy' && LARGE_INPUT_METHODS.has(operation.method))
}

function validateEditor(value) {
  if (!ownKeys(value, ['documentId', 'session', 'name', 'methods']) || typeof value.documentId !== 'string' || !value.documentId || value.documentId.length > 256 || !Number.isSafeInteger(value.session) || value.session < 0 || typeof value.name !== 'string' || value.name.length > 256 || !Array.isArray(value.methods) || value.methods.length > 256) throw fail('INVALID_EDITOR', 'Invalid editor registration')
  const names = new Set()
  for (const method of value.methods) {
    if (!plain(method) || !validMethod(method.name) || typeof method.mutates !== 'boolean' || method.grant !== undefined || names.has(method.name)) throw fail('INVALID_EDITOR', 'Invalid automation method')
    names.add(method.name)
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_AUTOMATION_FRAME_BYTES) throw fail('FRAME_TOO_LARGE', 'Editor registration exceeds the limit')
  return structuredClone(value)
}

/** Ephemeral, explicitly enabled local endpoint. No TCP, discovery file, or durable credential. */
export class LocalAutomationBridge {
  constructor({ dispatch, workspaceHost, onChange = () => {}, onAudit = () => {}, timeoutMs = REQUEST_TIMEOUT_MS, frameBytes = MAX_AUTOMATION_FRAME_BYTES, temporaryRoot = tmpdir() }) {
    this.dispatch = dispatch
    this.workspaceHost = workspaceHost
    this.onChange = onChange
    this.onAudit = onAudit
    this.journal = []
    this.timeoutMs = timeoutMs
    this.frameBytes = frameBytes
    this.temporaryRoot = temporaryRoot
    this.editor = null
    this.active = null
    this.closing = Promise.resolve()
    this.generation = 0
  }

  setEditor(value) {
    const next = value == null ? null : validateEditor(value)
    const same = next && this.editor && next.documentId === this.editor.documentId && next.session === this.editor.session
    if (same) return
    void this.close()
    this.editor = next
    this.onChange()
  }

  status() {
    const state = this.active
    return {
      enabled: Boolean(state), ...(state ? { scope: state.scope, grants: state.grants ?? {}, sessionId: state.sessionId, documentId: state.editor.documentId, session: state.editor.session } : {}),
      ...(this.editor ? { editor: { documentId: this.editor.documentId, session: this.editor.session, name: this.editor.name } } : {}),
      connectedClients: state?.sockets.size ?? 0, pendingRequests: state?.pending.size ?? 0, journal: this.journal.map(entry => ({ ...entry })),
    }
  }

  audit(state, entry) {
    const event = { id: randomUUID(), at: new Date().toISOString(), scope: state.scope, documentId: state.editor.documentId, session: state.editor.session, ...entry }
    this.journal.push(event)
    if (this.journal.length > 50) this.journal.shift()
    try { this.onAudit(event) } catch {}
    this.onChange()
  }

  connection() {
    const state = this.active
    if (!state) return null
    return { protocolVersion: AUTOMATION_PROTOCOL_VERSION, endpoint: state.endpoint, token: state.token, sessionId: state.sessionId, scope: state.scope, grants: state.grants ?? {}, documentId: state.editor.documentId, session: state.editor.session }
  }

  async enable(scope, expectedEditor = this.editor, grants = {}) {
    if (!validAutomationGrants(grants) || (Object.keys(grants).length && !this.workspaceHost)) throw fail('INVALID_SCOPE', 'Workspace/settings automation is unavailable')
    if (!['read', 'write'].includes(scope)) throw fail('INVALID_SCOPE', 'Choose read or write access')
    if (!expectedEditor || expectedEditor !== this.editor) throw fail('NO_EDITOR', 'Select a live editor first')
    await this.close()
    if (expectedEditor !== this.editor) throw fail('STALE_SESSION', 'The editor changed while enabling automation')
    const generation = this.generation
    const sessionId = randomUUID(), token = randomBytes(32).toString('hex')
    let directory
    let endpoint
    if (process.platform === 'win32') endpoint = `\\\\.\\pipe\\futureox-design-${sessionId}`
    else {
      directory = await mkdtemp(path.join(await realpath(this.temporaryRoot), 'design-automation-'))
      await chmod(directory, 0o700)
      endpoint = path.join(directory, 'bridge.sock')
    }
    const state = { sessionId, token, scope, grants: { ...grants }, endpoint, directory, editor: expectedEditor, sockets: new Set(), pending: new Set(), server: null }
    state.server = net.createServer(socket => this.accept(state, socket))
    try {
      if (Object.keys(grants).length) await this.workspaceHost.grant(sessionId, grants)
      await new Promise((resolve, reject) => {
        state.server.once('error', reject)
        state.server.listen(endpoint, () => { state.server.removeListener('error', reject); resolve() })
      })
      state.server.on('error', () => { if (this.active === state) void this.close() })
      if (directory) await chmod(endpoint, 0o600)
      if (generation !== this.generation || expectedEditor !== this.editor) throw fail('STALE_SESSION', 'The editor changed while enabling automation')
      this.active = state
      this.audit(state, { method: 'bridge.enable', status: 'ok', summary: `Document: ${scope}; workspace: ${grants.workspace ?? 'none'}; settings: ${grants.settings ?? 'none'}` })
      return { protocolVersion: AUTOMATION_PROTOCOL_VERSION, endpoint, sessionId, token, scope, grants: { ...grants }, documentId: expectedEditor.documentId, session: expectedEditor.session }
    } catch (error) {
      this.workspaceHost?.revoke(sessionId)
      for (const socket of state.sockets) socket.destroy()
      await new Promise(resolve => state.server.close(resolve))
      if (directory) await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  close() {
    this.generation++
    const state = this.active
    this.active = null // revoke synchronously before any awaited cleanup
    if (state) {
      this.workspaceHost?.revoke(state.sessionId)
      this.audit(state, { method: 'bridge.disable', status: 'ok' })
      for (const pending of state.pending) pending.abort(fail('SESSION_CLOSED', 'Local automation was disabled'))
      for (const socket of state.sockets) socket.destroy()
      this.closing = this.closing.then(async () => {
        await new Promise(resolve => state.server.close(resolve))
        if (state.directory) await rm(state.directory, { recursive: true, force: true })
      })
    }
    return this.closing
  }

  accept(state, socket) {
    if (state.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    state.sockets.add(socket)
    state.pendingBytes ??= 0; state.bufferedBytes ??= 0
    this.onChange()
    socket.on('error', () => {})
    // Auth has a deadline below; an authorized tool client may be idle between turns.
    const authTimer = setTimeout(() => { if (!authenticated) socket.destroy() }, 5_000)
    let buffer = Buffer.alloc(0), authenticated = false, authenticating = false, heavyPending = 0
    const pending = new Map()
    const standardBytes = Math.min(this.frameBytes, STANDARD_AUTOMATION_FRAME_BYTES)
    const send = (message, allowLarge = false) => {
      if (socket.destroyed) return
      let json = JSON.stringify(message)
      if (Buffer.byteLength(json) > (allowLarge ? this.frameBytes : standardBytes)) json = JSON.stringify({ id: message.id, error: wireError(fail('FRAME_TOO_LARGE', 'Automation result exceeds the transport limit; request a smaller selection')) })
      if (socket.writableLength + Buffer.byteLength(json) > 40 * 1024 * 1024) { socket.destroy(); return }
      socket.write(`${json}\n`)
    }
    const dispatch = async (id, kind, request, bytes = 0) => {
      if (pending.size >= MAX_PENDING || state.pending.size >= MAX_PENDING * MAX_CONNECTIONS) throw fail('BUSY', 'Too many pending automation requests')
      const heavy = bytes > standardBytes
      if ((heavy && heavyPending >= 1) || state.pendingBytes + state.bufferedBytes + bytes > MAX_RETAINED_REQUEST_BYTES) throw fail('BUSY', 'Automation request memory budget is full')
      state.pendingBytes += bytes
      if (heavy) heavyPending++
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(fail('TIMEOUT', 'Automation request timed out; inspect the revision before retrying a write')), this.timeoutMs)
      pending.set(id, controller); state.pending.add(controller)
      this.onChange()
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; const payload = { kind, request, scope: state.scope, sessionId: state.sessionId, documentId: state.editor.documentId, session: state.editor.session, deadline: Date.now() + this.timeoutMs }; return kind === 'execute' && isWorkspaceAutomationMethod(request?.method) ? this.workspaceHost.execute(payload, controller.signal) : this.dispatch(payload, controller.signal) }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        ])
        if (this.active !== state) throw fail('SESSION_CLOSED', 'Local automation was disabled')
        return result
      } finally {
        clearTimeout(timer); pending.delete(id); state.pending.delete(controller)
        state.pendingBytes -= bytes
        if (heavy) heavyPending--
        this.onChange()
      }
    }
    const handle = async (message, frameBytes) => {
      let id = message?.id
      const started = Date.now()
      let audited = false
      try {
        if (frameBytes > standardBytes && (message?.method !== 'execute' || !allowsLargeInput(message.params))) throw fail('FRAME_TOO_LARGE', 'Only native document/bundled font imports and explicit clipboard pastes may exceed the ordinary request limit')
        if (!ownKeys(message, ['id', 'method', 'params'])) throw fail('INVALID_REQUEST', 'Invalid bridge request')
        if (message.method === 'cancel') {
          if (!authenticated || !ownKeys(message.params, ['requestId']) || !validId(message.params.requestId) || id !== undefined) throw fail('INVALID_REQUEST', 'Invalid cancellation')
          pending.get(message.params.requestId)?.abort(fail('CANCELLED', 'Request cancelled; a completed atomic edit is not rolled back'))
          return
        }
        if (!validId(id)) { id = null; throw fail('INVALID_REQUEST', 'A bounded string request id is required') }
        if (pending.has(id)) throw fail('DUPLICATE_REQUEST', 'Request id is already pending')
        if (this.active !== state || state.editor !== this.editor) throw fail('SESSION_CLOSED', 'The selected editor session is no longer active')
        if (!authenticated) {
          if (authenticating) throw fail('AUTH_REQUIRED', 'Wait for the capability handshake')
          if (message.method !== 'capabilities' || !ownKeys(message.params, ['protocolVersion', 'sessionId', 'token'])) throw fail('AUTH_REQUIRED', 'An authenticated capability handshake is required')
          const { token, sessionId, protocolVersion } = message.params
          if (protocolVersion !== AUTOMATION_PROTOCOL_VERSION || sessionId !== state.sessionId || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(state.token))) throw fail('AUTH_FAILED', 'Invalid local automation capability')
          authenticating = true
          const result = await dispatch(id, 'capabilities')
          authenticated = true; clearTimeout(authTimer)
          send({ id, result: { ...result, ...(result?.capabilities ? { capabilities: { ...result.capabilities, methods: [...result.capabilities.methods.filter(method => !isWorkspaceAutomationMethod(method.name) && permitsAutomationMethod(method, state.scope)), ...(this.workspaceHost?.methods(state.sessionId) ?? [])] } } : {}), protocolVersion: AUTOMATION_PROTOCOL_VERSION, sessionId: state.sessionId, scope: state.scope, grants: state.grants ?? {} } })
          return
        }
        if (message.method === 'capabilities') {
          if (message.params !== undefined && !ownKeys(message.params, [])) throw fail('INVALID_REQUEST', 'Capabilities takes no arguments after authentication')
          const result = await dispatch(id, 'capabilities')
          send({ id, result: { ...result, ...(result?.capabilities ? { capabilities: { ...result.capabilities, methods: [...result.capabilities.methods.filter(method => !isWorkspaceAutomationMethod(method.name) && permitsAutomationMethod(method, state.scope)), ...(this.workspaceHost?.methods(state.sessionId) ?? [])] } } : {}), protocolVersion: AUTOMATION_PROTOCOL_VERSION, sessionId: state.sessionId, scope: state.scope, grants: state.grants ?? {} } })
          return
        }
        if (message.method !== 'execute') throw fail('METHOD_NOT_FOUND', 'Unknown bridge method')
        const request = message.params
        if (!ownKeys(request, ['id', 'method', 'params', 'expectedRevision', 'documentId', 'session']) || !validMethod(request.method)) throw fail('INVALID_REQUEST', 'Invalid automation request')
        const method = [...state.editor.methods.filter(entry => !isWorkspaceAutomationMethod(entry.name)), ...(this.workspaceHost?.methods(state.sessionId) ?? [])].find(entry => entry.name === request.method)
        if (!method) throw fail('METHOD_NOT_FOUND', 'Unknown design automation method')
        if (!permitsAutomationMethod(method, state.scope, state.grants)) throw fail('PERMISSION_DENIED', 'This connection only permits reading')
        if (request.documentId !== state.editor.documentId || request.session !== state.editor.session) throw fail('STALE_SESSION', 'Every request must target the explicitly selected document and session')
        if (method.mutates && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) throw fail('REVISION_REQUIRED', 'Writes require the observed expectedRevision')
        const result = await dispatch(id, 'execute', request, frameBytes)
        this.audit(state, { method: request.method, scope: method.grant ? state.grants[method.grant] : state.scope, requestId: id, status: result?.ok === false ? 'error' : 'ok', ...(result?.ok === false ? { code: result.error?.code || 'API_ERROR' } : {}), ...(Number.isSafeInteger(result?.revision) ? { revision: result.revision } : {}), durationMs: Date.now() - started })
        audited = true
        send({ id, result }, LARGE_OUTPUT_METHODS.has(request.method))
      } catch (error) {
        if (authenticated && !audited && message?.method === 'execute') this.audit(state, { method: validMethod(message.params?.method) ? message.params.method : 'bridge.execute', requestId: validId(id) ? id : undefined, status: 'error', code: wireError(error).code, durationMs: Date.now() - started })
        send({ id: validId(id) ? id : null, error: wireError(error) })
        if (!authenticated) socket.end()
      }
    }
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > this.frameBytes * 2 || state.pendingBytes + state.bufferedBytes + chunk.length > MAX_RETAINED_REQUEST_BYTES) { socket.destroy(); return }
      state.bufferedBytes += chunk.length
      buffer = Buffer.concat([buffer, chunk])
      let newline, frames = 0
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (++frames > 64) { socket.destroy(); return }
        if (newline > this.frameBytes) { socket.destroy(); return }
        const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1)
        state.bufferedBytes -= newline + 1
        if (!frame.length) continue
        let message
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) } catch { send({ id: null, error: wireError(fail('PARSE_ERROR', 'Expected a valid UTF-8 JSON frame')) }); socket.destroy(); return }
        void handle(message, frame.length)
      }
      if (buffer.length > this.frameBytes) socket.destroy()
    })
    socket.once('close', () => {
      clearTimeout(authTimer); state.sockets.delete(socket)
      state.bufferedBytes -= buffer.length; buffer = Buffer.alloc(0)
      this.onChange()
      for (const controller of pending.values()) controller.abort(fail('DISCONNECTED', 'Automation client disconnected'))
    })
  }
}

/** Only trusted main-frame IPC can bind the live editor or answer a host request. */
export function registerAutomationBridge({ ipcMain, getWindow, assertSender, dialog, clipboard, audit, storage, workspace, figmaMcp, openPermissions, clientConfig }) {
  const requests = new Map()
  let dialogOpen = false
  let auditError, statusTimer
  const auditQueue = []
  let auditDrain = Promise.resolve(), drainingAudit = false
  const getStatus = () => ({ ...bridge.status(), ...(auditError ? { auditError } : {}) })
  const changed = () => {
    if (statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = undefined
      const window = getWindow()
      if (window && !window.isDestroyed()) { try { window.webContents.send('design-desktop:automation-status', getStatus()) } catch {} }
    }, 50)
    statusTimer.unref?.()
  }
  const enqueueAudit = entry => {
    if (!audit) return false
    if (auditQueue.length >= 64) { auditError = 'Automation audit queue is full; some metadata was not saved.'; changed(); return false }
    auditQueue.push(entry)
    if (drainingAudit) return true
    drainingAudit = true
    auditDrain = (async () => {
      try {
        while (auditQueue.length) {
          const next = auditQueue.shift()
          try { await audit(next) }
          catch { auditError = 'The local automation audit could not be saved.'; changed() }
        }
      } finally { drainingAudit = false }
    })()
    return true
  }
  const dispatchRenderer = (payload, signal) => new Promise((resolve, reject) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || signal.aborted) { reject(fail('NO_EDITOR', 'No live editor is available')); return }
      const requestId = randomUUID()
      const abort = () => {
        requests.delete(requestId)
        if (!window.isDestroyed()) window.webContents.send('design-desktop:automation-cancel', { requestId })
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      requests.set(requestId, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
      window.webContents.send('design-desktop:automation-request', { ...payload, requestId })
    })
  const workspaceHost = workspace ? new WorkspaceAutomationHost({ ...workspace, storage, dispatch: dispatchRenderer,
    confirm: async (_action, detail) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return false
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Local workspace automation', message: detail.message,
        buttons: ['Cancel', 'Allow this action'], defaultId: 0, cancelId: 0, noLink: true })
      return answer.response === 1
    },
  }) : undefined
  const bridge = new LocalAutomationBridge({ dispatch: dispatchRenderer, workspaceHost, onChange: changed, onAudit: enqueueAudit })
  const figma = typeof figmaMcp === 'function' ? attachFigmaMcp(bridge, figmaMcp) : null
  let editIdentity = '', editRevision = 0
  ipcMain.handle('design-desktop:automation-register', (event, value) => {
    assertSender(event, getWindow())
    bridge.setEditor(value)
    const nextIdentity = value ? `${value.documentId}:${value.session}` : ''
    if (nextIdentity !== editIdentity) { editIdentity = nextIdentity; editRevision = 0 }
    return { status: 'ok' }
  })
  ipcMain.handle('design-desktop:automation-response', (event, value) => {
    assertSender(event, getWindow())
    if (!ownKeys(value, ['requestId', 'result', 'error']) || !validId(value.requestId) ||
        Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error') ||
        (Object.hasOwn(value, 'error') && (!ownKeys(value.error, ['code', 'message']) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) ||
        Buffer.byteLength(JSON.stringify(value)) > MAX_AUTOMATION_FRAME_BYTES) throw fail('INVALID_RESPONSE', 'Invalid automation response')
    const pending = requests.get(value.requestId)
    if (!pending) return { accepted: false }
    requests.delete(value.requestId); pending.cleanup()
    if (value.error) pending.reject(fail(typeof value.error.code === 'string' ? value.error.code : 'EDITOR_ERROR', typeof value.error.message === 'string' ? value.error.message : 'Editor request failed'))
    else pending.resolve(value.result)
    return { accepted: true }
  })
  const close = async () => {
    bridge.setEditor(null)
    await bridge.close()
    for (const pending of requests.values()) { pending.cleanup(); pending.reject(fail('SESSION_CLOSED', 'Editor session closed')) }
    requests.clear()
    let timer
    try { await Promise.race([auditDrain, new Promise(resolve => { timer = setTimeout(resolve, 2_000) })]) } finally { clearTimeout(timer) }
  }
  const enable = async (scope, grants = {}) => {
    if (dialogOpen) return
    dialogOpen = true
    try {
      const editor = bridge.editor, window = getWindow()
      if (!editor || !window || window.isDestroyed()) throw fail('NO_EDITOR', 'Open a design before enabling local automation.')
      const rootAtPrompt = Object.keys(grants).length ? workspace?.getRoot() : undefined
      const rootInfo = rootAtPrompt ? await workspace.status() : undefined
      const confirmation = await dialog.showMessageBox(window, {
        type: 'question', title: 'Local design automation', message: `Allow ${scope === 'write' ? 'read and edit' : 'read-only'} access to “${editor.name || editor.documentId}”?`,
        detail: `${Object.keys(grants).length ? `Additional explicitly selected access for workspace “${String(rootInfo?.displayName ?? 'current workspace').slice(0, 256)}”: ${Object.entries(grants).map(([area, level]) => `${area}: ${level}`).join(', ')}. Workspace access is bound to the current root; workspace changes and history restoration require separate confirmations. ` : ''}Only local clients with the temporary connection details can connect. Access ends when disabled, the design changes, or this window closes. Edit access can change the open document through undoable design commands. No arbitrary file-system, shell, or network commands are exposed.`,
        buttons: ['Cancel', 'Enable for this design'], defaultId: 0, cancelId: 0,
      })
      if (confirmation.response !== 1) return
      if (rootAtPrompt && workspace.getRoot() !== rootAtPrompt) throw fail('WRONG_ROOT', 'The workspace changed during confirmation; review and enable again')
      const config = await bridge.enable(scope, editor, grants)
      const shown = figma ? await figma.afterEnable(config) : config
      const copy = await dialog.showMessageBox(window, {
        type: 'info', title: 'Local automation enabled', message: `${scope === 'write' ? 'Read and edit' : 'Read-only'} access is enabled for this design.`,
        detail: `Keep these temporary connection details private. The stdio adapter uses endpoint, sessionId and token. figmaMcp.url is the loopback Figma-shaped HTTP server; send the same token as Authorization: Bearer. Configure either client with this JSON:\n\n${JSON.stringify(shown, null, 2)}`,
        buttons: ['Done', 'Copy connection details', ...(clientConfig ? ['Copy stdio MCP client config'] : [])], defaultId: 0, cancelId: 0,
      })
      if (bridge.active?.sessionId === config.sessionId && [1, 2].includes(copy.response)) {
        const connection = bridge.connection()
        if (connection) clipboard.writeText(JSON.stringify(copy.response === 2 && clientConfig ? clientConfig(connection) : connection, null, 2))
      }
    } catch (error) {
      const window = getWindow()
      if (window && !window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', message: 'Could not enable local automation', detail: error.message })
    } finally { dialogOpen = false }
  }
  const persisted = async (method, value) => {
    if (!storage) throw fail('STORAGE_UNAVAILABLE', 'Automation storage is unavailable')
    return storage(method, value)
  }
  for (const [name, handler] of Object.entries({
    config: value => { if (value !== undefined) throw fail('INVALID_REQUEST', 'Unexpected config arguments'); return persisted('automation.config.get', {}) },
    configure: value => {
      if (!ownKeys(value, ['auditEnabled', 'retentionDays', 'maxAuditEntries', 'preferredScope']) ||
          (value.auditEnabled !== undefined && typeof value.auditEnabled !== 'boolean') ||
          (value.retentionDays !== undefined && (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 90)) ||
          (value.maxAuditEntries !== undefined && (!Number.isInteger(value.maxAuditEntries) || value.maxAuditEntries < 100 || value.maxAuditEntries > 10000)) ||
          (value.preferredScope !== undefined && !['read', 'write'].includes(value.preferredScope))) throw fail('INVALID_REQUEST', 'Invalid automation preferences')
      return persisted('automation.config.set', value)
    },
    'record-edit': value => {
      if (!ownKeys(value, ['documentId', 'session', 'revision', 'source', 'kind', 'summary']) ||
          !bridge.editor || value.documentId !== bridge.editor.documentId || value.session !== bridge.editor.session ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 || !['user', 'automation'].includes(value.source) ||
          !['edit', 'undo', 'redo'].includes(value.kind) || typeof value.summary !== 'string' || value.summary.length > 400) throw fail('INVALID_REQUEST', 'Invalid committed edit metadata')
      if (value.revision <= editRevision) return { accepted: false }
      editRevision = value.revision
      const summary = Array.from(value.summary.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 200).join('')
      return { accepted: enqueueAudit({ event: 'edit', method: `editor.${value.kind}`, documentId: value.documentId, session: value.session, revision: value.revision, source: value.source, summary, status: 'ok' }) }
    },
    'audit-history': value => {
      const params = value ?? {}
      if (!ownKeys(params, ['limit', 'beforeId', 'documentId', 'source']) || (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) || (params.beforeId !== undefined && (!Number.isSafeInteger(params.beforeId) || params.beforeId < 1)) || (params.documentId !== undefined && (typeof params.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(params.documentId))) || (params.source !== undefined && !['user', 'automation'].includes(params.source))) throw fail('INVALID_REQUEST', 'Invalid audit history request')
      return persisted('automation.audit.list', params)
    },
    'storage-status': value => { if (value !== undefined) throw fail('INVALID_REQUEST', 'Unexpected storage status arguments'); return persisted('automation.status', {}) },
    status: value => { if (value !== undefined) throw fail('INVALID_REQUEST', 'Unexpected status arguments'); return getStatus() },
    enable: async value => {
      if (!ownKeys(value, ['scope', 'workspaceScope', 'settingsScope']) || !['read', 'write'].includes(value.scope) ||
        [value.workspaceScope, value.settingsScope].some(scope => scope !== undefined && !['read', 'write'].includes(scope))) throw fail('INVALID_REQUEST', 'Choose explicit read or write scopes')
      const grants = { ...(value.workspaceScope ? { workspace: value.workspaceScope } : {}), ...(value.settingsScope ? { settings: value.settingsScope } : {}) }
      if (Object.keys(grants).length && !workspaceHost) throw fail('UNAVAILABLE', 'Workspace/settings automation is unavailable')
      await enable(value.scope, grants); return getStatus()
    },
    disable: async value => { if (value !== undefined) throw fail('INVALID_REQUEST', 'Unexpected disable arguments'); await bridge.close(); return getStatus() },
    'copy-connection': value => {
      if (value !== undefined && !(['stdio', 'codex'].includes(value) && clientConfig)) throw fail('INVALID_REQUEST', 'Unexpected connection arguments')
      const connection = bridge.connection()
      if (!connection) return { copied: false }
      clipboard.writeText(value === 'codex' ? codexMcpToml(clientConfig(connection)) : JSON.stringify(value === 'stdio' ? clientConfig(connection) : connection, null, 2))
      return { copied: true }
    },
  })) ipcMain.handle(`design-desktop:automation-${name}`, (event, value) => { assertSender(event, getWindow()); return handler(value) })
  return {
    close,
    menu: {
      label: 'Automation', submenu: [
        ...(openPermissions ? [{ label: 'MCP connection and permissions…', click: openPermissions }, { type: 'separator' }] : []),
        { label: 'Enable local automation (read-only)…', click: () => { void enable('read') } },
        { label: 'Enable local automation (read and edit)…', click: () => { void enable('write') } },
        { label: 'Disable local automation', click: () => { void bridge.close() } },
      ],
    },
  }
}
