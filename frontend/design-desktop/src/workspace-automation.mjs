import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'

const fail = (code, message) => Object.assign(new Error(message), { code })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const boundedId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const validMutation = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min
const string = { type: 'string', minLength: 1, maxLength: 128 }
const number = { type: 'integer', minimum: 1 }
const IMPORT_COPY_BYTES = 32 * 1024 * 1024 - 128 * 1024
const root = { rootHandle: string }
const mutation = { mutationId: { ...string, pattern: '^[A-Za-z0-9_-]{1,128}$' } }
const settingKeys = ['snap', 'snapPixels', 'pixelGrid', 'rulers', 'checkerboard', 'grid', 'scrollWheelZoom']
const settings = Object.fromEntries(settingKeys.map(key => [key, { type: 'boolean' }]))
settings.shortcutProfile = { type: 'string', enum: ['figma-like', 'sketch-like'] }
const method = (name, description, grant, mutates, properties, required = Object.keys(properties)) => Object.freeze({ name, description, grant, mutates,
  inputSchema: { type: 'object', additionalProperties: false, properties, required } })
export const WORKSPACE_AUTOMATION_METHODS = Object.freeze([
  method('workspace.root.status', 'Read the explicitly granted workspace identity and current saved revision. Returns opaque handles; no local paths.', 'workspace', false, {}),
  method('workspace.list', 'List a bounded page of saved designs in the granted local workspace.', 'workspace', false, { ...root, includeDeleted: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: string }, ['rootHandle']),
  method('workspace.revisions', 'List bounded saved revisions for an issued document handle.', 'workspace', false, { ...root, documentHandle: string, beforeRevision: number }, ['rootHandle', 'documentHandle']),
  method('workspace.open', 'Request a native-confirmed saved-document switch. Requires a clean editor. A successful switch revokes this connection; obtain fresh native approval.', 'workspace', true, { ...root, documentHandle: string, ...mutation }),
  method('workspace.importCopy', 'Save an independent FD/native-json/Sketch/FIG compatibility copy without switching the editor. No file paths, URLs or PDF. Returns a grant-bound document handle. Retry only identical mutationId and arguments; an unknown outcome must be reconciled, never retried with a new ID.', 'workspace', true, { ...root, format: { type: 'string', enum: ['fd', 'native-json', 'sketch', 'fig'] }, content: { type: 'string', minLength: 1, maxLength: IMPORT_COPY_BYTES }, base64: { type: 'string', minLength: 1, maxLength: IMPORT_COPY_BYTES }, ...mutation }, ['rootHandle', 'format', 'mutationId']),
  method('workspace.save', 'Save the current editor snapshot through SQLite CAS. The storage revision is separate from the editor revision. Retry only the same mutationId and arguments.', 'workspace', true, { ...root, expectedStorageRevision: { anyOf: [number, { type: 'null' }] }, ...mutation }),
  method('workspace.restore', 'Request native-confirmed history restoration using an issued revision handle and exact storage CAS. Requires a clean editor; switching revokes the connection.', 'workspace', true, { ...root, revisionHandle: string, expectedStorageRevision: number, ...mutation }),
  method('workspace.root.select', 'Ask the user to choose a workspace using the native picker, or confirm the original default workspace. No filesystem path input is accepted.', 'workspace', true, { ...root, useDefault: { type: 'boolean' }, ...mutation }, ['rootHandle', 'mutationId']),
  method('workspace.root.activate', 'Request a native-confirmed restart into a previously selected workspace. Requires a clean editor; normal close protection remains active. Reconnect after restart.', 'workspace', true, { ...root, selectionHandle: string, ...mutation }),
  method('settings.get', 'Read only allowlisted canvas and keyboard preferences with their settings revision. Does not expose credentials, networking, permissions or automation grants.', 'settings', false, {}),
  method('settings.update', 'Update only allowlisted canvas and keyboard preferences with settings CAS. Storage failures are reported as session-only.', 'settings', true, { ...root, patch: { type: 'object', additionalProperties: false, minProperties: 1, properties: settings }, expectedSettingsRevision: { type: 'integer', minimum: 0 }, ...mutation }),
])
const byName = new Map(WORKSPACE_AUTOMATION_METHODS.map(value => [value.name, value]))
export const isWorkspaceAutomationMethod = name => byName.has(name)
export function validAutomationGrants(value = {}) {
  return plain(value) && Object.keys(value).every(key => ['workspace', 'settings'].includes(key)) && Object.values(value).every(scope => ['read', 'write'].includes(scope))
}
export function permitsAutomationMethod(method, scope, grants = {}) {
  if (method.grant !== undefined && !['workspace', 'settings'].includes(method.grant)) return false
  const granted = method.grant ? grants[method.grant] : scope
  return !!granted && (!method.mutates || granted === 'write')
}
const preferenceMetadata = result => {
  if (!plain(result) || !integer(result.settingsRevision) || !plain(result.values) ||
    Object.entries(result.values).some(([key, value]) => settingKeys.includes(key) ? typeof value !== 'boolean' : key !== 'shortcutProfile' || !['figma-like', 'sketch-like'].includes(value)) ||
    !['available', 'session-only'].includes(result.persistence)) throw fail('INVALID_RESPONSE', 'Invalid allowlisted settings response')
  const groups = result.persistenceByGroup
  if (groups !== undefined && (!plain(groups) || Object.keys(groups).some(key => !['canvas', 'keyboard', 'wheel'].includes(key)) || Object.values(groups).some(value => !['available', 'session-only'].includes(value)))) throw fail('INVALID_RESPONSE', 'Invalid preference persistence response')
  return { settingsRevision: result.settingsRevision, values: structuredClone(result.values), persistence: result.persistence,
    ...(groups ? { persistenceByGroup: { ...groups } } : {}), atomicDurability: false }
}
const metadata = (entry, handle) => ({ documentHandle: handle, name: String(entry.name ?? '').slice(0, 256), storageRevision: entry.revision,
  ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}), updatedAt: entry.updatedAt, deleted: !!entry.deleted })

/** Capability facade shared by the real native bridge and its in-memory MCP tests.
 * Paths and raw database IDs never cross the external automation boundary. */
export class WorkspaceAutomationHost {
  constructor({ getRoot, verifyRoot = async () => {}, status, select, activate, storage, dispatch, confirm }) {
    Object.assign(this, { getRoot, verifyRoot, rootStatus: status, select, activate, storage, dispatch, confirm })
    this.grants = new Map()
  }
  async grant(owner, scopes) {
    if (!boundedId(owner) || !validAutomationGrants(scopes)) throw fail('INVALID_SCOPE', 'Invalid workspace/settings grant')
    const boundRoot = this.getRoot()
    if (!boundRoot) throw fail('WORKSPACE_UNAVAILABLE', 'No active local workspace')
    try { await this.verifyRoot(boundRoot) } catch { throw fail('WORKSPACE_ROOT_STALE', 'The workspace identity or storage is unavailable; select it again') }
    const grant = { owner, scopes: { ...scopes }, root: boundRoot, rootHandle: randomUUID(), handles: new Map(), keys: new Map(), names: new Map(), receipts: new Map(), active: true }
    this.grants.set(owner, grant)
    return grant
  }
  revoke(owner) { const grant = this.grants.get(owner); if (grant) { grant.active = false; grant.handles.clear(); grant.keys.clear(); grant.names.clear() }; this.grants.delete(owner) }
  methods(owner) { return WORKSPACE_AUTOMATION_METHODS.filter(method => permitsAutomationMethod(method, undefined, this.grants.get(owner)?.scopes)) }
  issue(grant, kind, value, key) {
    if (key && grant.keys.has(`${kind}:${key}`)) return grant.keys.get(`${kind}:${key}`)
    if (grant.handles.size >= 4096) throw fail('HANDLE_LIMIT', 'Too many workspace handles; reconnect to start a new bounded session')
    const handle = randomUUID(); grant.handles.set(handle, { kind, value })
    if (key) grant.keys.set(`${kind}:${key}`, handle)
    return handle
  }
  resolve(grant, handle, kind) {
    const found = boundedId(handle) ? grant.handles.get(handle) : undefined
    if (!found || found.kind !== kind) throw fail('UNKNOWN_HANDLE', 'The handle is unknown, expired, or belongs to a different grant')
    return found.value
  }
  validate(method, params) {
    const schema = method.inputSchema
    if (!plain(params) || Object.keys(params).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(params, key))) throw fail('INVALID_PARAMS', 'Use the advertised workspace/settings schema')
    if (method.name === 'workspace.importCopy') {
      const source = params.format !== 'native-json' ? params.base64 : params.content
      if (!['fd', 'native-json', 'sketch', 'fig'].includes(params.format) || typeof source !== 'string' || !source.length || Buffer.byteLength(source) > IMPORT_COPY_BYTES ||
          (params.format !== 'native-json' ? Object.hasOwn(params, 'content') : Object.hasOwn(params, 'base64')) ||
          Buffer.byteLength(JSON.stringify(params)) > IMPORT_COPY_BYTES) throw fail('INVALID_PARAMS', 'Supply bounded native-json content or FD/Sketch/FIG base64, never both')
    }
    for (const [key, value] of Object.entries(params)) {
      if (['rootHandle', 'documentHandle', 'revisionHandle', 'selectionHandle', 'cursor'].includes(key) && !boundedId(value)) throw fail('INVALID_PARAMS', `Invalid ${key}`)
      if (key === 'mutationId' && !validMutation(value)) throw fail('INVALID_PARAMS', 'mutationId must contain 1–128 ASCII letters, digits, hyphens or underscores')
      if (['includeDeleted', 'useDefault'].includes(key) && typeof value !== 'boolean') throw fail('INVALID_PARAMS', `Invalid ${key}`)
      if (['beforeRevision', 'expectedStorageRevision'].includes(key) && !(key === 'expectedStorageRevision' && method.name === 'workspace.save' && value === null) && !integer(value, 1)) throw fail('INVALID_PARAMS', `Invalid ${key}`)
      if (key === 'expectedSettingsRevision' && !integer(value)) throw fail('INVALID_PARAMS', 'Invalid settings revision')
      if (key === 'limit' && (!integer(value, 1) || value > 100)) throw fail('INVALID_PARAMS', 'limit must be between 1 and 100')
      if (key === 'patch' && (!plain(value) || !Object.keys(value).length || Object.entries(value).some(([setting, entry]) => settingKeys.includes(setting) ? typeof entry !== 'boolean' : setting !== 'shortcutProfile' || !['figma-like', 'sketch-like'].includes(entry)))) throw fail('INVALID_PARAMS', 'Only canvas and keyboard settings are supported')
    }
  }
  async execute(payload, signal) {
    const request = payload.request, method = byName.get(request?.method), grant = this.grants.get(payload.sessionId)
    if (!method) throw fail('METHOD_NOT_FOUND', 'Unknown workspace automation method')
    const checkGrantNow = () => {
      if (signal?.aborted) throw signal.reason ?? fail('CANCELLED', 'Request cancelled')
      if (!grant?.active || this.grants.get(payload.sessionId) !== grant) throw fail('SESSION_CLOSED', 'Workspace access was revoked')
      if (this.getRoot() !== grant.root) throw fail('WRONG_ROOT', 'The granted workspace changed; reconnect with fresh approval')
      if (!permitsAutomationMethod(method, undefined, grant.scopes)) throw fail('PERMISSION_DENIED', 'The requested workspace/settings scope was not granted')
      if (!Number.isFinite(payload.deadline) || Date.now() >= payload.deadline) throw fail('TIMEOUT', 'The request expired')
    }
    const checkGrant = async () => {
      checkGrantNow()
      try { await this.verifyRoot(grant.root) } catch { throw fail('WORKSPACE_ROOT_STALE', 'The granted workspace identity or storage changed; reconnect after checking it') }
      checkGrantNow()
    }
    await checkGrant()
    const params = structuredClone(request.params ?? {})
    this.validate(method, params)
    if ('rootHandle' in params && params.rootHandle !== grant.rootHandle) throw fail('WRONG_ROOT', 'This root handle belongs to another workspace grant')
    if (request.documentId !== payload.documentId || request.session !== payload.session) throw fail('STALE_SESSION', 'The selected editor session changed')
    if (method.mutates && !integer(request.expectedRevision)) throw fail('REVISION_REQUIRED', 'The observed editor revision is required')
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: method.name, params, documentId: request.documentId, session: request.session, expectedRevision: request.expectedRevision })).digest('hex')
    if (method.mutates && grant.receipts.has(params.mutationId)) {
      const receipt = grant.receipts.get(params.mutationId)
      if (receipt.fingerprint !== fingerprint) throw fail('MUTATION_CONFLICT', 'mutationId was already used with different arguments')
      return receipt.promise
    }
    const work = async () => {
      const call = (name, value = {}) => this.dispatch({ ...payload, kind: 'host', hostOperation: { method: name, params: value } }, signal)
      const inspect = async () => {
        await checkGrant()
        const state = await call('inspect')
        if (!plain(state) || state.documentId !== payload.documentId || state.session !== payload.session || !integer(state.revision) ||
          !['dirty', 'busy', 'pendingEdits', 'interactionActive'].every(key => typeof state[key] === 'boolean') || !(state.storageRevision === null || integer(state.storageRevision, 1))) throw fail('STALE_SESSION', 'The live editor inspection is invalid or stale')
        if (method.mutates) {
          if (state.revision !== request.expectedRevision) throw fail('REVISION_CONFLICT', 'The editor revision changed')
          if (state.busy) throw fail('BUSY', 'Finish the current editor operation first')
          if (state.pendingEdits) throw fail('PENDING_EDITS', 'Finish pending input first; the draft is preserved')
          if (state.interactionActive) throw fail('INTERACTION_ACTIVE', 'Finish or cancel the current editor gesture')
          if (['workspace.open', 'workspace.restore', 'workspace.root.activate'].includes(method.name) && state.dirty) throw fail('DIRTY_DOCUMENT', 'Save the current document before switching or restoring')
        }
        checkGrantNow()
        return state
      }
      let state = await inspect()
      const envelope = result => ({ ...(request.id === undefined ? {} : { id: request.id }), method: method.name,
        documentId: state.documentId, session: state.session, revision: state.revision, ok: true, result })
      const approval = async (action, detail) => {
        if (typeof this.confirm !== 'function' || !(await this.confirm(action, detail))) throw fail('CANCELLED', 'The native confirmation was declined')
        state = await inspect()
      }
      if (method.name === 'workspace.root.status') {
        const value = await this.rootStatus(); await checkGrant()
        return envelope({ rootHandle: grant.rootHandle, displayName: value.displayName, isDefault: !!value.isDefault, canSwitch: !!value.canSwitch,
          activeDocumentHandle: this.issue(grant, 'document', state.documentId, state.documentId), storageRevision: state.storageRevision, dirty: state.dirty })
      }
      if (method.name === 'workspace.list') {
        let offset = 0, cursor
        if (params.cursor) { cursor = this.resolve(grant, params.cursor, 'cursor'); if (cursor.includeDeleted !== !!params.includeDeleted) throw fail('INVALID_PARAMS', 'Cursor filters changed'); offset = cursor.offset }
        const value = await this.storage('workspace.list', { includeDeleted: !!params.includeDeleted }); await checkGrant()
        const rows = value.documents, limit = params.limit ?? 50
        if (!Array.isArray(rows)) throw fail('INVALID_RESPONSE', 'Invalid workspace listing')
        const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id)), page = sorted.slice(offset, offset + limit)
        const stamp = createHash('sha256').update(JSON.stringify(sorted.map(row => [row.id, row.revision, row.deleted]))).digest('hex')
        if (cursor && cursor.stamp !== stamp) throw fail('STALE_CURSOR', 'The workspace listing changed; restart pagination')
        for (const row of page) grant.names.set(row.id, String(row.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256))
        return envelope({ rootHandle: grant.rootHandle, documents: page.map(row => metadata(row, this.issue(grant, 'document', row.id, row.id))),
          nextCursor: offset + limit < sorted.length ? this.issue(grant, 'cursor', { offset: offset + limit, includeDeleted: !!params.includeDeleted, stamp }) : null })
      }
      if (method.name === 'workspace.revisions') {
        const id = this.resolve(grant, params.documentHandle, 'document')
        const value = await this.storage('workspace.revisions', { id, ...(params.beforeRevision === undefined ? {} : { beforeRevision: params.beforeRevision }) }); await checkGrant()
        // v5 storage returns up to 1000 rows; expose only 100 and derive the
        // next exclusive boundary from the rows actually returned to the caller.
        const rows = value.revisions
        if (!Array.isArray(rows) || rows.length > 1000 || rows.some((row, index) => !plain(row) || row.id !== id || !integer(row.revision, 1) ||
          (params.beforeRevision !== undefined && row.revision >= params.beforeRevision) || (index > 0 && row.revision >= rows[index - 1].revision))) throw fail('INVALID_RESPONSE', 'Invalid bounded revision listing')
        const page = rows.slice(0, 100), hasMore = rows.length > page.length || !!value.hasMore
        if (hasMore && !page.length) throw fail('INVALID_RESPONSE', 'Invalid empty revision continuation')
        return envelope({ rootHandle: grant.rootHandle, documentHandle: params.documentHandle, revisions: page.map(row => ({ ...metadata(row, params.documentHandle),
          revisionHandle: this.issue(grant, 'revision', { id, revision: row.revision }, `${id}:${row.revision}`) })), hasMore, nextBeforeRevision: hasMore ? page.at(-1).revision : null })
      }
      if (method.name === 'workspace.open') {
        const id = this.resolve(grant, params.documentHandle, 'document')
        await approval('workspace.open', { message: `Open “${grant.names.get(id) || 'the selected saved design'}”? Current-document automation access will end.`, documentHandle: params.documentHandle })
        const opened = await call('workspace.open', { id })
        return envelope({ opened: true, documentHandle: params.documentHandle, ...(integer(opened?.revision, 1) ? { storageRevision: opened.revision } : {}), requiresFreshApproval: true })
      }
      if (method.name === 'workspace.importCopy') {
        const receipt = grant.receipts.get(params.mutationId)
        // Reserve one host-generated identity before preparation. Neither file
        // contents nor the external caller can choose the storage destination.
        receipt.newDocumentId = randomUUID()
        receipt.completion = { status: 'preparing' }
        if (grant.handles.size >= 4096) throw fail('HANDLE_LIMIT', 'Reconnect before importing another copy')
        const prepared = await call('workspace.importCopy', { newDocumentId: receipt.newDocumentId, format: params.format,
          ...(params.format !== 'native-json' ? { base64: params.base64 } : { content: params.content }) })
        if (!plain(prepared) || prepared.format !== 'native-json' || prepared.id !== receipt.newDocumentId || typeof prepared.documentJson !== 'string' ||
            Buffer.byteLength(JSON.stringify(prepared)) > IMPORT_COPY_BYTES) throw fail('INVALID_RESPONSE', 'Invalid prepared import copy; nothing was saved')
        let importReport = {}
        if (params.format === 'sketch') {
          const codes = ['SKETCH_COMPATIBILITY', 'SKETCH_CODEC_NOTICE', 'SKETCH_SOURCE_FONTS', 'SKETCH_FONT_RESOURCES']
          if (prepared.sourceFormat !== 'sketch' || prepared.fidelity !== 'compatibility' || prepared.lossless !== false ||
              !Array.isArray(prepared.warnings) || !prepared.warnings.length || prepared.warnings.length > 256 ||
              prepared.warnings.some(warning => !plain(warning) || Object.keys(warning).some(key => !['code', 'message'].includes(key)) ||
                !codes.includes(warning.code) || typeof warning.message !== 'string' || !warning.message.length || warning.message.length > 16384) ||
              prepared.warnings[0].code !== 'SKETCH_COMPATIBILITY' || Buffer.byteLength(JSON.stringify(prepared.warnings)) > 65536)
            throw fail('INVALID_RESPONSE', 'Invalid or oversized Sketch compatibility warnings; nothing was saved')
          importReport = structuredClone({ sourceFormat: 'sketch', fidelity: 'compatibility', lossless: false, warnings: prepared.warnings })
        }
        if (params.format === 'fig') {
          const truncation = 'FIG compatibility warnings truncated; see droppedOccurrences.'
          const dropped = prepared.droppedOccurrences
          if (prepared.sourceFormat !== 'fig' || prepared.fidelity !== 'compatibility' || prepared.lossless !== false ||
              !Array.isArray(prepared.warnings) || !prepared.warnings.length || prepared.warnings.length > 129 ||
              prepared.warnings.some((warning, index) => !plain(warning) || Object.keys(warning).some(key => !['code', 'message'].includes(key)) ||
                warning.code !== (index === 0 ? 'FIG_COMPATIBILITY' : 'FIG_CODEC_NOTICE') ||
                typeof warning.message !== 'string' || !warning.message.length || Buffer.byteLength(warning.message) > 1024) ||
              prepared.warnings.slice(1).reduce((total, warning) => total + Buffer.byteLength(warning.message), 0) > 32768 ||
              Buffer.byteLength(JSON.stringify(prepared.warnings)) > 40960 ||
              (dropped !== undefined && (!integer(dropped, 1))) ||
              prepared.warnings.slice(1).filter(warning => warning.message === truncation).length !== (dropped === undefined ? 0 : 1))
            throw fail('INVALID_RESPONSE', 'Invalid or oversized FIG compatibility warnings; nothing was saved')
          importReport = structuredClone({ sourceFormat: 'fig', fidelity: 'compatibility', lossless: false, warnings: prepared.warnings,
            ...(dropped === undefined ? {} : { droppedOccurrences: dropped }) })
        }
        receipt.importReport = importReport
        let document
        try { document = JSON.parse(prepared.documentJson) } catch { throw fail('INVALID_RESPONSE', 'Invalid prepared import JSON; nothing was saved') }
        if (!plain(document) || document.id !== receipt.newDocumentId) throw fail('INVALID_RESPONSE', 'Prepared copy identity mismatch; nothing was saved')
        receipt.contentHash = createHash('sha256').update(prepared.documentJson).digest('hex')
        // Recheck both live editor and grant/root after preparation. The backend
        // performs its existing authoritative model admission and create-only CAS.
        state = await inspect()
        receipt.completion = { status: 'committing', retry: 'reconcile-before-retry' }
        let saved
        try {
          saved = await this.storage('workspace.commit', { document, expectedRevision: null, mutationId: params.mutationId })
          if (!plain(saved) || saved.id !== receipt.newDocumentId || saved.revision !== 1 || typeof saved.name !== 'string' ||
              typeof saved.hash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.hash) || !Number.isFinite(saved.updatedAt) || saved.deleted !== false) throw fail('INVALID_RESPONSE', 'Invalid import-copy acknowledgement')
        } catch (error) {
          const rejected = ['INVALID_REQUEST', 'WORKSPACE_CONFLICT', 'WORKSPACE_MUTATION_CONFLICT'].includes(error?.code)
          receipt.completion = { status: rejected ? 'rejected' : 'unknown', retry: rejected ? 'correct-request' : 'reconcile-before-retry' }
          if (!rejected) grant.importCopyUncertain = params.mutationId
          throw fail(rejected ? error.code : 'IMPORT_COPY_OUTCOME_UNKNOWN', rejected ? error.message : 'The copy may already be saved. This mutation is reserved; reconcile the workspace before a new import. Do not retry with a new mutationId.')
        }
        receipt.completion = { status: 'committed', retry: 'do-not-retry', storageRevision: saved.revision, hash: saved.hash, verifiedReadback: false }
        // Keep the grant-local completion receipt while this call settles. Never
        // issue a handle or bypass terminal transport rejection after revocation.
        try { await checkGrant() } catch (error) {
          throw fail('IMPORT_COPY_COMMITTED_ACCESS_ENDED', 'The independent copy was saved, but access ended before its handle could be returned. Do not import it again; reconcile after fresh approval.')
        }
        try {
          const opened = await this.storage('workspace.open', { id: receipt.newDocumentId, revision: 1 })
          // Native storage checks its canonical snapshot hash. Compare the
          // returned value tree too: JS byte hashes are not Rust canonical hashes.
          if (!plain(opened) || opened.id !== receipt.newDocumentId || opened.revision !== 1 || opened.hash !== saved.hash ||
              opened.name !== saved.name || opened.deleted !== false || !isDeepStrictEqual(opened.document, document)) throw fail('INVALID_RESPONSE', 'Stored copy differs from the submitted snapshot')
          receipt.completion.verifiedReadback = true
        } catch {
          grant.importCopyUncertain = params.mutationId
          throw fail('IMPORT_COPY_COMMITTED_UNVERIFIED', 'Storage acknowledged the copy, but exact saved readback could not be verified. Do not import it again; reconcile the workspace before another write.')
        }
        try { await checkGrant() } catch (error) {
          throw fail('IMPORT_COPY_COMMITTED_ACCESS_ENDED', 'The independent copy was saved, but access ended before its handle could be returned. Do not import it again; reconcile after fresh approval.')
        }
        const handle = this.issue(grant, 'document', saved.id, saved.id)
        grant.names.set(saved.id, saved.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256))
        return envelope({ ...metadata(saved, handle), ...importReport, activated: false, completion: { ...receipt.completion } })
      }
      if (method.name === 'workspace.save') {
        if (state.storageRevision !== params.expectedStorageRevision) throw fail('STORAGE_REVISION_CONFLICT', 'The current saved revision changed')
        const value = await call('workspace.save', { expectedStorageRevision: params.expectedStorageRevision, mutationId: params.mutationId })
        await checkGrant()
        return envelope(metadata(value, this.issue(grant, 'document', value.id, value.id)))
      }
      if (method.name === 'workspace.restore') {
        const value = this.resolve(grant, params.revisionHandle, 'revision')
        await approval('workspace.restore', { message: `Restore “${grant.names.get(value.id) || 'the selected saved design'}” to saved revision ${value.revision}? This creates a new saved revision and ends current-document automation access.`, revision: value.revision })
        const result = await call('workspace.restore', { ...value, expectedStorageRevision: params.expectedStorageRevision, mutationId: params.mutationId })
        return envelope(metadata(result, this.issue(grant, 'document', value.id, value.id)))
      }
      if (method.name === 'workspace.root.select') {
        await approval('workspace.root.select', { message: params.useDefault ? 'Prepare the original default workspace for a later confirmed restart?' : 'Choose a local workspace using the native picker?' })
        let value
        try { value = await this.select(!!params.useDefault) } catch (error) { throw fail(error?.code === 'WORKSPACE_ROOT_PEERS' ? error.code : 'WORKSPACE_ROOT_INVALID', 'The selected workspace could not be prepared; the active workspace is unchanged') }
        await checkGrant()
        if (value.status === 'cancelled') throw fail('CANCELLED', 'No workspace was selected')
        if (value.status !== 'ok' || !boundedId(value.selectionId)) throw fail('WORKSPACE_ROOT_INVALID', 'The selected workspace was not accepted')
        return envelope({ rootHandle: grant.rootHandle, selectionHandle: this.issue(grant, 'selection', value.selectionId), displayName: value.displayName, isDefault: !!value.isDefault })
      }
      if (method.name === 'workspace.root.activate') {
        const selectionId = this.resolve(grant, params.selectionHandle, 'selection')
        await approval('workspace.root.activate', { message: 'Restart into the selected workspace? The normal close checks still apply and automation must be approved again.' })
        let value
        try { value = await this.activate(selectionId) } catch (error) { throw fail(error?.code === 'WORKSPACE_ROOT_PEERS' ? error.code : 'WORKSPACE_ROOT_INVALID', 'The workspace restart was not accepted') }
        if (value?.status && value.status !== 'ok') throw fail('WORKSPACE_ROOT_INVALID', 'The workspace restart was not accepted')
        return envelope({ restarting: !!value.restarting, requiresFreshApproval: true })
      }
      if (method.name === 'settings.get') {
        const result = await call('settings.get'); await checkGrant()
        return envelope({ rootHandle: grant.rootHandle, ...preferenceMetadata(result) })
      }
      const result = await call('settings.update', { patch: params.patch, expectedSettingsRevision: params.expectedSettingsRevision, mutationId: params.mutationId })
      await checkGrant()
      return envelope({ rootHandle: grant.rootHandle, ...preferenceMetadata(result) })
    }
    if (!method.mutates) return work()
    if (grant.importCopyUncertain) throw fail('IMPORT_COPY_OUTCOME_UNKNOWN', 'An earlier import copy has an unresolved durable outcome. Reconcile the workspace before another write; do not retry it with a new mutationId.')
    if (grant.mutationActive) throw fail('BUSY', 'Another workspace/settings action is still awaiting completion')
    if (grant.receipts.size >= 128) throw fail('RECEIPT_LIMIT', 'The bounded mutation receipt store is full; reconnect before new writes')
    // Reserve before the first await. Identical in-flight retries share the same
    // operation; uncertain failures are retained, never blindly repeated.
    const receipt = { fingerprint, promise: null }
    grant.receipts.set(params.mutationId, receipt)
    grant.mutationActive = params.mutationId
    receipt.promise = work().finally(() => { if (grant.mutationActive === params.mutationId) grant.mutationActive = undefined })
    return receipt.promise
  }
}
