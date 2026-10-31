import { admitSessionPreview } from './sketch-preview-contract.mjs'
import { sameSketchOwner as equalOwner, admitSketchSession as admit, admitSketchLeafFrame, validSketchFrame, validSketchTextOverride, admitSketchTextTargets, admitSketchTextValue } from './sketch-session-contract.mjs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { formatForNativePath } from './kernel-admission.mjs'
const fields = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Invalid Sketch session arguments'); return v }
/** One process/window-scoped native session. No futureox-desgin handle or write API. */
export class SketchSessionHost {
  #active; #epoch = 0; #busy = false
  constructor(request, dialog, currentWindow) { this.request = request; this.dialog = dialog; this.currentWindow = currentWindow }
  async #exclusive(action) {
    if (this.#busy) throw new Error('Sketch session operation is busy')
    this.#busy = true
    try { return await action() } finally { this.#busy = false }
  }
  #check(value, keys) {
    fields(value, keys); fields(value.owner, ['kernel_id', 'document_schema', 'document_id', 'session_epoch'])
    const active = this.#active
    if (!active || active.window !== this.currentWindow() || !equalOwner(value.owner, active.status.owner) || value.expectedRevision !== active.status.revision)
      throw new Error('Inactive, foreign or stale Sketch session')
    return active
  }
  async open(value) { return this.#exclusive(async () => {
    if (value !== undefined) throw new Error('Unexpected arguments')
    if (this.#active) {
      const active = this.#active
      if (active.window !== this.currentWindow()) throw new Error('Sketch session belongs to another window')
      let status
      try { status = admit(await this.request('sketch.session.status', { owner: active.status.owner }), active.status.owner) }
      catch { throw Object.assign(new Error('Retained Sketch open outcome is still uncertain'), { code: 'SKETCH_OPEN_UNCERTAIN' }) }
      if (!status.active) { this.#active = undefined; return { status: 'cancelled' } }
      active.status = status
      return { status: 'ok', ...status, displayName: active.displayName }
    }
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Sketch session epoch exhausted')
    const window = this.currentWindow(), epoch = ++this.#epoch
    const selected = await this.dialog.showOpenDialog(window, { title: 'Open native Sketch session (save as a new file only)', properties: ['openFile'], filters: [{ name: 'Sketch', extensions: ['sketch'] }] })
    if (selected.canceled || selected.filePaths.length !== 1 || window !== this.currentWindow() || window.isDestroyed()) return { status: 'cancelled' }
    const file = selected.filePaths[0]
    if (formatForNativePath(file) !== 'sketch') throw new Error('Choose a .sketch file')
    const owner = { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: randomUUID(), session_epoch: epoch }
    // Retain identity even when a reply is lost; do not retry or overwrite the native slot.
    this.#active = { window, displayName: path.basename(file), status: { owner, active: true, revision: 0, savedRevision: 0, saveUncertain: false, undoCount: 0, redoCount: 0, layers: [], layersTruncated: false, dirty: false, persistence: 'memory-only-unsaved' } }
    let status
    try { status = admit(await this.request('sketch.session.open', { path: file, documentId: owner.document_id, sessionEpoch: epoch }), owner) }
    catch (error) {
      if ((['SKETCH_SESSION_FAILED', 'UNKNOWN_METHOD', 'INVALID_REQUEST'].includes(error?.code) && error.outcomeUnknown !== true) || error?.outcomeUnknown === false) { this.#active = undefined; throw error }
      try { status = admit(await this.request('sketch.session.status', { owner }), owner) }
      catch { throw Object.assign(new Error('Sketch open outcome is uncertain; reopen this dialog to reconcile the retained session, not replay open'), { code: 'SKETCH_OPEN_UNCERTAIN' }) }
    }
    this.#active.status = status
    if (window !== this.currentWindow() || window.isDestroyed()) {
      await this.request('sketch.session.close', { owner, expectedRevision: 0, discard: false })
      this.#active = undefined
      return { status: 'cancelled' }
    }
    return { status: 'ok', ...status, displayName: path.basename(file) }
  }) }
  async rename(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision', 'layerId', 'name'])
    if (typeof value.layerId !== 'string' || !value.layerId || value.layerId.length > 128 || typeof value.name !== 'string' || new TextEncoder().encode(value.name).length > 4096)
      throw new Error('Invalid Sketch rename')
    const result = await this.request('sketch.session.rename', { ...value, requestId: randomUUID() })
    active.status = admit(result, active.status.owner)
    return { status: 'ok', ...active.status }
  }) }
  async textTargets(value) {
    const keys = ['owner', 'expectedRevision', 'instanceId']
    const active = this.#check(value, keys)
    if (!validSketchTextOverride({ instanceId: value.instanceId, targetPath: 'T', text: '' })) throw new Error('Invalid native instance ID')
    const owner = active.status.owner, revision = value.expectedRevision
    const result = admitSketchTextTargets(await this.request('sketch.session.textTargets', value), owner, revision, value.instanceId)
    this.#check(value, keys)
    return { status: 'ok', ...result }
  }
  async textValue(value) {
    const keys = ['owner', 'expectedRevision', 'instanceId', 'targetPath']
    const active = this.#check(value, keys)
    if (!validSketchTextOverride({ instanceId: value.instanceId, targetPath: value.targetPath, text: '' })) throw new Error('Invalid native target path')
    const owner = active.status.owner, revision = value.expectedRevision
    const result = admitSketchTextValue(await this.request('sketch.session.textValue', value), owner, revision, value.instanceId, value.targetPath)
    this.#check(value, keys)
    return { status: 'ok', ...result }
  }
  async resizeLegacyContainer(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision', 'layerId', 'width', 'height'])
    if (typeof value.layerId !== 'string' || !value.layerId || new TextEncoder().encode(value.layerId).length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.layerId) ||
        ![value.width, value.height].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 1e9)) throw new Error('Invalid native legacy container resize')
    active.status = admit(await this.request('sketch.session.resizeLegacyContainer', { ...value, requestId: randomUUID() }), active.status.owner)
    return { status: 'ok', ...active.status }
  }) }
  async setTextOverride(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision', 'instanceId', 'targetPath', 'text'])
    const { instanceId, targetPath, text } = value
    if (!validSketchTextOverride({ instanceId, targetPath, text })) throw new Error('Invalid native text override: use a layer-ID path and at most 100000 UTF-16 units')
    active.status = admit(await this.request('sketch.session.setTextOverride', { ...value, requestId: randomUUID() }), active.status.owner)
    return { status: 'ok', ...active.status }
  }) }
  async leafFrame(value) {
    const active = this.#check(value, ['owner', 'expectedRevision', 'layerId'])
    if (typeof value.layerId !== 'string' || !value.layerId || value.layerId.length > 128) throw new Error('Invalid native layer identity')
    const owner = active.status.owner, revision = value.expectedRevision
    return { status: 'ok', ...admitSketchLeafFrame(await this.request('sketch.session.leafFrame', value), owner, revision, value.layerId) }
  }
  async setLeafFrame(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision', 'layerId', 'x', 'y', 'width', 'height'])
    const { x, y, width, height } = value
    if (typeof value.layerId !== 'string' || !value.layerId || value.layerId.length > 128 || !validSketchFrame({ x, y, width, height })) throw new Error('Invalid native parent-coordinate frame')
    active.status = admit(await this.request('sketch.session.setLeafFrame', { ...value, requestId: randomUUID() }), active.status.owner)
    return { status: 'ok', ...active.status }
  }) }
  async preview(value) {
    const active = this.#check(value, ['owner', 'expectedRevision', 'pageId'])
    if (typeof value.pageId !== 'string' || !value.pageId || value.pageId.length > 128) throw new Error('Invalid native page identity')
    const owner = active.status.owner, revision = value.expectedRevision
    const result = await this.request('sketch.session.preview', value)
    return { status: 'ok', ...admitSessionPreview(result, owner, revision, value.pageId) }
  }
  async status(value) { return this.#exclusive(async () => {
    fields(value, ['owner'])
    const active = this.#active
    if (!active || active.window !== this.currentWindow() || !equalOwner(value.owner, active.status.owner)) throw new Error('Inactive Sketch session')
    active.status = admit(await this.request('sketch.session.status', { owner: active.status.owner }), active.status.owner)
    if (!active.status.active) this.#active = undefined
    return { status: 'ok', ...active.status }
  }) }
  async undo(value) { return this.#history(value, false) }
  async redo(value) { return this.#history(value, true) }
  async #history(value, redo) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision'])
    active.status = admit(await this.request(redo ? 'sketch.session.redo' : 'sketch.session.undo', { ...value, requestId: randomUUID() }), active.status.owner)
    return { status: 'ok', ...active.status }
  }) }
  async saveAs(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision'])
    const selected = await this.dialog.showSaveDialog(active.window, { title: 'Save Sketch as a new file (existing files are never overwritten)', defaultPath: active.displayName, filters: [{ name: 'Sketch', extensions: ['sketch'] }] })
    if (selected.canceled || !selected.filePath) return { status: 'cancelled' }
    if (active.window !== this.currentWindow() || active.window.isDestroyed()) return { status: 'cancelled' }
    if (formatForNativePath(selected.filePath) !== 'sketch') throw new Error('Choose a new .sketch filename')
    const result = await this.request('sketch.session.saveAs', { owner: active.status.owner, expectedRevision: active.status.revision, path: selected.filePath })
    active.status = admit(result, active.status.owner)
    if (result.saveWarning !== null && result.saveWarning !== undefined && (typeof result.saveWarning !== 'string' || result.saveWarning.length > 4096)) throw new Error('Invalid save outcome')
    active.displayName = path.basename(selected.filePath)
    return { status: 'ok', ...active.status, displayName: active.displayName, saveWarning: result.saveWarning || undefined }
  }) }
  async close(value) { return this.#exclusive(async () => {
    const active = this.#check(value, ['owner', 'expectedRevision', 'discard'])
    if (typeof value.discard !== 'boolean') throw new Error('Explicit discard choice required')
    // Reconcile a potentially committed operation whose response was lost, without replaying it.
    const latest = admit(await this.request('sketch.session.status', { owner: active.status.owner }), active.status.owner)
    if (!latest.active) { this.#active = undefined; return { status: 'ok' } }
    if (latest.dirty) {
      if (!value.discard) throw new Error('Unconfirmed Sketch changes retained; save or verify a new copy before closing')
      const answer = await this.dialog.showMessageBox(active.window, { type: 'warning', title: 'Discard native Sketch changes?', message: 'This session has unsaved changes or a save result whose durability is unconfirmed.', detail: 'Keep open to save or verify a copy. Discarding closes this independent session; it does not write a file or change the futureox-desgin canvas.', buttons: ['Keep open', 'Discard Sketch changes'], defaultId: 0, cancelId: 0, noLink: true })
      if (answer.response !== 1) return { status: 'cancelled' }
    }
    if (active.window !== this.currentWindow() || active.window.isDestroyed()) throw new Error('Sketch window changed before close')
    try { await this.request('sketch.session.close', { owner: active.status.owner, expectedRevision: latest.revision, discard: value.discard }) }
    catch (error) {
      const known = admit(await this.request('sketch.session.status', { owner: active.status.owner }), active.status.owner)
      if (known.active) throw error
    }
    this.#active = undefined
    return { status: 'ok' }
  }) }
  async beforeWindowClose() {
    if (!this.#active) return true
    const s = this.#active.status
    try { return (await this.close({ owner: s.owner, expectedRevision: s.revision, discard: true })).status === 'ok' }
    catch { return false } // An uncertain or busy session never silently permits window close.
  }
}
