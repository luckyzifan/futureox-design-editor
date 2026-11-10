import { assertDocumentJson } from './document-capacity'
import { ResidentDocumentEncoder } from './resident-document-encoder'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { cancelPendingOperations, commitPendingEdits, hasPendingEdits, subscribePendingEdits } from './pending-edits'
import type { Editor } from './engine'
import type { WorkspaceAutomationGuard } from './automation/workspace-bridge'
import { prepareDocument, prepareDocumentJson, prepareDocumentJsonInWorker, takePreparedDocument, forkPreparedDocument, ensurePreparedDocument, preparedDocumentAdoptionOwner, preparedDocumentEncoding, type PreparedDocument } from './prepared-document'
import { documentStage, documentStageAsync, DocumentStage } from './document-lifecycle-diagnostics'
import { nativeDesignJson } from './native-design-json'
import { unwrapSourceError } from './source-error-text'
import { interfacePreference } from './interface-preference'
import { blank, type DesignDocument } from './model'
import { consumeDocumentJsonSyntaxFailure } from './document-admission'
import { consumeDocumentPreparationSourceFailure } from './document-preparation-worker-client'
import { documentPreparationRuntime } from './document-preparation-identity'
import type { DesktopBridge, DesktopFile, DesktopResult, WorkspaceDocument, WorkspaceOpened } from './desktop'

export type LeaveDecision = 'save' | 'discard' | 'cancel'
export type LeaveReason = 'open' | 'new' | 'recover' | 'close'
export type DesktopStatus = {
  dirty: boolean
  busy: boolean
  transitioning: boolean
  operation: 'idle' | 'save' | 'open' | 'new' | 'recover' | 'close'
  displayName?: string
  error?: string
  warning?: string
  recoveryWarning?: string
  conflict: boolean
  storage?: 'sqlite' | 'file'
  revision?: number
}
type SessionEditor = Pick<Editor, 'state' | 'subscribe' | 'load' | 'notify'> & Partial<Pick<Editor, 'interactionActive' | 'sessionGeneration' | 'authoredDocument' | 'propertyPreviewActive' | 'settleOwnedPropertyPreview'>>
// These backend responses prove this request was rejected, rather than leaving
// an uncertain write. INVALID_REQUEST validation precedes commit/transaction
// completion. A reported full disk or failed upgrade rolled back. Timeout,
// transport loss and invalid acknowledgements stay pending.
const rejectedWorkspaceWrite = (result: DesktopResult<unknown>) => result.status !== 'ok' && result.status !== 'cancelled' &&
  (result.status === 'conflict' || ['INVALID_REQUEST', 'WORKSPACE_CONFLICT', 'WORKSPACE_MUTATION_CONFLICT', 'WORKSPACE_STORAGE_FULL', 'WORKSPACE_MIGRATION'].includes(result.code))

/** Disk acknowledgements are scoped to immutable snapshots, never to the latest edit. */
export type WorkspaceTab = { id: string; name: string; persisted: boolean }
type WorkspaceCacheEntry = { revision: number; name: string; hash: string; updatedAt: number; documentJson: string }

/** Tab switches during an open/import must not surface the host file lock as
 * a hard failure. A cached snapshot can replace the canvas immediately; a
 * busy editor only queues the switch until that operation releases the document. */
export function workspaceTabSwitchPlan(input: { sessionBusy: boolean; hostBusy: boolean; cached: boolean; sameDocument: boolean }) {
  if (input.sameDocument) return 'ignore' as const
  if (input.sessionBusy) return 'queue' as const
  if (input.hostBusy) return input.cached ? 'adopt-cache' as const : 'queue' as const
  return 'read' as const
}
export class DesktopSession {
  private readonly tabListeners = new Set<() => void>()
  private tabsValue: WorkspaceTab[] = []
  private readonly workspaceCache = new Map<string, WorkspaceCacheEntry>()
  private pendingTabId?: string
  private tabWaitAttempts = 0
  private tabWaitNotified = false
  subscribeTabs = (listener: () => void) => { this.tabListeners.add(listener); return () => { this.tabListeners.delete(listener) } }
  tabsSnapshot = () => this.tabsValue
  /** Switches tabs immediately, or queues one switch when a file operation still owns the editor. */
  requestWorkspaceTab(id: string) {
    if (this.disposed || this.closeSnapshot !== undefined) return Promise.resolve(false)
    if (id === this.currentDocument.id) return Promise.resolve(true)
    if (this.active) { this.pendingTabId = id; return Promise.resolve(false) }
    return this.openWorkspace(id)
  }
  async closeWorkspaceTab(id: string) {
    if (id === this.currentDocument.id) {
      const next = this.tabsValue.find(t => t.id !== id && t.persisted)
      if (!(await (next ? this.openWorkspace(next.id) : this.replace(blank())))) return false
    }
    this.tabsValue = this.tabsValue.filter(t => t.id !== id)
    this.tabListeners.forEach(listener => listener())
    return true
  }
  private readonly workspaceHeads = new Map<string, number>()
  private workspacePending?: { documentJson: string; expectedRevision: number | null; mutationId: string; generation: number; id: string }
  get supportsWorkspace() { return !!this.bridge.workspace }
  get activeDocumentId() { return this.currentDocument.id }
  listWorkspace(includeDeleted = false) {
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    return this.bridge.workspace.list({ includeDeleted })
  }
  listRevisions(id: string, beforeRevision?: number) {
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    return this.bridge.workspace.revisions({ id, beforeRevision })
  }
  async trashWorkspace(document: WorkspaceDocument, deleted = true) {
    const trace = beginEditorAction(this.editor, CanvasAction.delete, ActionSource.menu, deleted ? 330 : 331)
    try {
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    if (document.id === this.currentDocument.id) throw new Error('请先打开其他设计，再移入回收站')
    const result = await this.bridge.workspace.trash({ id: document.id, expectedRevision: document.revision, mutationId: crypto.randomUUID(), deleted })
    trace.result(result.status === 'ok' ? ActionOutcome.observed : result.status === 'cancelled' ? ActionOutcome.cancelled : ActionOutcome.rejected, result.status === 'ok' ? ActionReason.none : ActionReason.validation)
    return result
    } catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { trace.finish() }
  }
  openWorkspace(id: string) {
    return this.run('open', async () => {
      if (!this.bridge.workspace) return false
      const result = { ...await documentStageAsync(DocumentStage.read, () => this.bridge.workspace!.open({ id })) }
      if (result.status !== 'ok') return result.status === 'cancelled' ? false : this.workspaceReadBusy(result) ? this.openCachedWorkspace(id) : this.failed(result)
      this.rememberWorkspace(result)
      const prepared = await this.parse(result.documentJson)
      this.assertWorkspace(prepared, result, id)
      const approved = await documentStageAsync(DocumentStage.leave, () => this.leave('open'))
      if (!this.authorized(approved)) return false
      // A Save decision can advance this very document while the first read
      // waits for the leave dialog. Adopt a fresh immutable head, never that stale read.
      const latest = { ...await documentStageAsync(DocumentStage.freshRead, () => this.bridge.workspace!.open({ id })) }
      if (!this.authorized(approved)) return false
      if (latest.status !== 'ok') {
        if (latest.status === 'cancelled') return false
        if (this.workspaceReadBusy(latest)) return this.adoptBusyWorkspace(id, approved, prepared, result.documentJson)
        return this.failed(latest)
      }
      // Revision/hash labels alone are not proof. Exact immutable source bytes
      // retain schema/admission ownership across the leave/save await.
      const document = latest.documentJson === result.documentJson
        ? documentStage(DocumentStage.reuse, () => prepared, latest.documentJson.length)
        : await this.parse(latest.documentJson)
      this.assertWorkspace(document, latest, id)
      return this.authorized(approved) && this.adoptWorkspace(document, latest)
    })
  }
  restoreWorkspace(id: string, revision: number, expectedRevision: number): Promise<false | { document: DesignDocument; revision: number }> {
    return this.run('open', async () => {
      if (!this.bridge.workspace) return false
      // A newer save since the history list was viewed must not silently widen
      // the user's restore authorization. A Save choice below may advance it.
      if (expectedRevision > 0 && (this.workspaceHeads.get(id) || 0) > expectedRevision)
        return this.failed({ status: 'conflict', code: 'WORKSPACE_CONFLICT', message: '历史列表已过期，请刷新后再恢复；当前画布已保留' })
      const approved = await this.leave('open')
      if (!this.authorized(approved)) return false
      const result = await this.bridge.workspace.restore({ id, revision, expectedRevision: Math.max(expectedRevision, this.workspaceHeads.get(id) || 0), mutationId: crypto.randomUUID() })
      if (result.status !== 'ok') return result.status === 'cancelled' ? false : this.failed(result)
      if (!this.authorized(approved)) {
        this.editor.notify('历史版本已恢复到本机库；当前画布新修改已保留，请重新打开查看')
        return false
      }
      const document = await this.parse(result.documentJson)
      if (!this.authorized(approved)) return false
      return this.adoptWorkspace(document, result) ? { document: this.editor.state.doc, revision: result.revision } : false
    })
  }
  /** Reads one workspace revision for read-only preview; never adopts it into the editor. */
  async readWorkspaceRevision(id: string, revision: number): Promise<{ document: DesignDocument; updatedAt: number } | null> {
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    const result = await this.bridge.workspace.open({ id, revision })
    if (result.status === 'ok') return { document: takePreparedDocument(await this.parse(result.documentJson))!, updatedAt: result.updatedAt }
    if (result.status === 'cancelled' || result.code === 'WORKSPACE_NOT_FOUND') return null
    const message = result.message
    this.failed(result)
    throw new Error(message)
  }
  async refreshLocalHead(id:string,revision:number){
    if(this.disposed||this.closeSnapshot!==undefined||!this.bridge.workspace||id!==this.currentDocument.id||revision<=(this.workspaceHeads.get(id)||0)||this.dirty||this.operation!=='idle'||(this.editor.interactionActive||this.editor.state.busy)||hasPendingEdits(this.editor))return false
    const generation=this.generation,version=this.editor.state.version
    const result=await this.bridge.workspace.open({id})
    if(this.disposed||this.closeSnapshot!==undefined||id!==this.currentDocument.id||this.generation!==generation||version!==this.editor.state.version||this.dirty||(this.editor.interactionActive||this.editor.state.busy)||hasPendingEdits(this.editor))return false
    if(result.status!=='ok')return result.status==='cancelled'?false:this.failed(result)
    if(result.revision<revision)return false
    const document=await this.parse(result.documentJson)
    if(this.disposed||this.closeSnapshot!==undefined||id!==this.currentDocument.id||this.generation!==generation||version!==this.editor.state.version||this.dirty||(this.editor.interactionActive||this.editor.state.busy)||hasPendingEdits(this.editor))return false
    return this.adoptWorkspace(document,result,true)
  }
  private assertWorkspace(document: DesignDocument | PreparedDocument, result: WorkspaceOpened, requestedId = result.id) {
    if (document.id !== result.id || result.id !== requestedId || result.deleted || !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw new Error('本机文档版本响应无效')
  }
  private workspaceReadBusy(result: { status: string; code?: string }) {
    return result.status === 'error' && (result.code === 'BUSY' || result.code === 'WORKSPACE_BUSY')
  }
  private tabMessage(kind: 'waiting' | 'stopped' | 'cached') {
    const en = interfacePreference.getSnapshot().locale === 'en'
    if (kind === 'cached') return en
      ? 'Opened the cached copy of this tab while a file operation is running. It will refresh when that operation finishes.'
      : '文件操作仍在进行，已从会话缓存切换到此标签，结束后会刷新。'
    if (kind === 'stopped') return en
      ? 'This tab could not open because a file operation is still running. Try again when it finishes.'
      : '文件操作仍在进行，此标签暂时无法打开。请在结束后重试。'
    return en
      ? 'A file operation is still running. This tab will open when it finishes.'
      : '文件操作仍在进行，此标签将在结束后打开。'
  }
  private clearTabWait() { this.tabWaitAttempts = 0; this.tabWaitNotified = false }
  private armTabWait(id: string): false {
    this.tabWaitAttempts += 1
    // A long import can hold the file lock well past a second. Keep the one
    // requested tab queued. Do not surface the host BUSY sentence, and do not
    // give up after a handful of immediate retries.
    if (this.tabWaitAttempts > 120) {
      this.pendingTabId = undefined
      this.clearTabWait()
      this.editor.notify(this.tabMessage('stopped'))
      return false
    }
    this.pendingTabId = id
    if (!this.tabWaitNotified) { this.tabWaitNotified = true; this.editor.notify(this.tabMessage('waiting')) }
    return false
  }
  private rememberWorkspace(opened: WorkspaceOpened) {
    let documentJson = opened.documentJson
    if (typeof documentJson !== 'string') {
      try { documentJson = nativeDesignJson(documentJson) }
      catch { this.workspaceCache.delete(opened.id); return }
    }
    if (opened.deleted || !documentJson) { this.workspaceCache.delete(opened.id); return }
    this.workspaceCache.delete(opened.id)
    this.workspaceCache.set(opened.id, { revision: opened.revision, name: opened.name, hash: opened.hash, updatedAt: opened.updatedAt, documentJson })
    while (this.workspaceCache.size > 8) {
      const victim = [...this.workspaceCache.keys()].find(key => key !== opened.id && key !== this.currentDocument.id)
      if (!victim) break
      this.workspaceCache.delete(victim)
    }
  }
  private compatibleCache(id: string) {
    const cached = this.workspaceCache.get(id)
    if (!cached) return undefined
    const head = this.workspaceHeads.get(id)
    if (head !== undefined && head !== cached.revision) return undefined
    return cached
  }
  private openedFromCache(id: string, cached: WorkspaceCacheEntry): WorkspaceOpened {
    return { id, name: cached.name, revision: cached.revision, hash: cached.hash, updatedAt: cached.updatedAt, deleted: false, documentJson: cached.documentJson }
  }
  private async openCachedWorkspace(id: string) {
    const cached = this.compatibleCache(id)
    if (!cached) return this.armTabWait(id)
    const prepared = await this.parse(cached.documentJson)
    const approved = await this.leave('open')
    if (!this.authorized(approved)) return false
    const latest = { ...await this.bridge.workspace!.open({ id }) }
    if (latest.status === 'ok') {
      this.rememberWorkspace(latest)
      const document = latest.documentJson === cached.documentJson ? prepared : await this.parse(latest.documentJson)
      this.assertWorkspace(document, latest, id)
      const adopted = this.authorized(approved) && this.adoptWorkspace(document, latest)
      if (adopted) this.clearTabWait()
      return adopted
    }
    if (latest.status === 'cancelled') return false
    if (!this.workspaceReadBusy(latest)) return this.failed(latest)
    return this.adoptCacheSnapshot(id, approved, prepared, cached)
  }
  private async adoptBusyWorkspace(id: string, approved: number, prepared: DesignDocument | PreparedDocument, firstJson: string) {
    const cached = this.compatibleCache(id)
    if (cached && cached.documentJson !== firstJson) {
      const document = await this.parse(cached.documentJson)
      const opened = this.openedFromCache(id, cached)
      this.assertWorkspace(document, opened, id)
      const adopted = this.authorized(approved) && this.adoptWorkspace(document, opened)
      if (adopted) { this.clearTabWait(); this.editor.notify(this.tabMessage('cached')); this.scheduleCacheRefresh(id, cached.revision) }
      return adopted
    }
    if (!cached) return this.armTabWait(id)
    return this.adoptCacheSnapshot(id, approved, prepared, cached)
  }
  private adoptCacheSnapshot(id: string, approved: number, prepared: DesignDocument | PreparedDocument, cached: WorkspaceCacheEntry) {
    const opened = this.openedFromCache(id, cached)
    this.assertWorkspace(prepared, opened, id)
    const adopted = this.authorized(approved) && this.adoptWorkspace(prepared, opened)
    if (!adopted) return false
    this.clearTabWait()
    this.editor.notify(this.tabMessage('cached'))
    this.scheduleCacheRefresh(id, cached.revision)
    return true
  }
  private scheduleCacheRefresh(id: string, revision: number) {
    setTimeout(() => { void this.refreshCachedTab(id, revision) }, 400)
  }
  private async refreshCachedTab(id: string, revision: number) {
    try {
      if (!this.bridge.workspace || this.disposed || this.active || this.operation !== 'idle' || this.closeSnapshot !== undefined) return
      if (this.currentDocument.id !== id || this.dirty || (this.editor.interactionActive || this.editor.state.busy) || hasPendingEdits(this.editor)) return
      const result = await this.bridge.workspace.open({ id })
      if (this.disposed || this.currentDocument.id !== id || this.dirty || this.operation !== 'idle') return
      if (result.status !== 'ok' || (result.revision === revision && result.documentJson === this.workspaceCache.get(id)?.documentJson)) return
      const document = await this.parse(result.documentJson)
      if (this.disposed || this.currentDocument.id !== id || this.dirty || this.operation !== 'idle' || (this.editor.interactionActive || this.editor.state.busy) || hasPendingEdits(this.editor)) return
      this.rememberWorkspace(result)
      this.adoptWorkspace(document, result, true, false)
    } catch { /* A late refresh must not surface a file-lock error over the cached tab. */ }
  }
  private adoptWorkspace(document: DesignDocument | PreparedDocument, result: WorkspaceOpened, preserveView = false, announce = true) {
    this.assertWorkspace(document, result)
    if (typeof result.documentJson === 'string') this.rememberWorkspace(result)
    if (!this.load(document, true, undefined, result.name,preserveView)) return false
    this.workspaceHeads.set(result.id, result.revision)
    this.publish()
    if (announce) this.editor.notify(`已打开本机设计 · 版本 ${result.revision}`)
    this.clearTabWait()
    return true
  }
  private baselineGeneration: number | null = null
  private baselineJson: string | null = null
  private baselineDocument?: DesignDocument
  private generation = 0
  private currentVersion: number
  private handle?: string
  private displayName?: string
  private currentDocument: DesignDocument
  private serializedGeneration = -1
  private serializedJson = ''
  private serializing?: { generation: number; document: DesignDocument; promise: Promise<string> }
  private active: Promise<unknown> | null = null
  private operation: DesktopStatus['operation'] = 'idle'
  private error?: string
  private warning?: string
  private conflict = false
  private started = false
  private disposed = false
  private readonly documentPreparations = new Set<AbortController>()
  private suppressObservation = false
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recoveryQueue: Promise<void> = Promise.resolve()
  private recoveryError?: string
  private recoveryWarning?: string
  private recoveryPaused = false
  private workspaceBusyRetries = 0
  private readonly recoveryHandles = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeDrafts: () => void
  private lastDirty?: boolean
  private publishedStatus?: DesktopStatus
  private hadPending = false
  private hadPropertyPreview = false
  private closeSnapshot?: number
  private pristineBlankGeneration: number | null

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly editor: SessionEditor,
    private readonly confirmLeave: (reason: LeaveReason) => Promise<LeaveDecision>,
    private readonly onStatus: (status: DesktopStatus) => void = () => {},
  ) {
    this.currentDocument = editor.authoredDocument ?? editor.state.doc
    this.currentVersion = editor.state.version
    this.pristineBlankGeneration = this.isDefaultBlank(this.currentDocument) ? 0 : null
    this.unsubscribe = editor.subscribe(() => this.observe())
    this.hadPending = hasPendingEdits(editor)
    this.unsubscribeDrafts = subscribePendingEdits(editor, () => {
      const pending = hasPendingEdits(editor)
      const propertyEnded = this.hadPropertyPreview && !editor.propertyPreviewActive
      this.hadPropertyPreview = !!editor.propertyPreviewActive
      if (pending || this.hadPending) this.advanceGeneration()
      this.hadPending = pending
      this.publish()
      // Cancellation may restore the exact saved object without a new revision.
      // Reconcile its dirty badge/recovery state without ever saving draft pixels.
      if (propertyEnded && this.started && !this.recoveryPaused && this.operation === 'idle') this.scheduleRecovery()
    })
  }

  // Candidate dirtiness is O(1) even during drag previews. At lifecycle/recovery boundaries,
  // lazy byte equality recognizes undo-to-saved without serializing in the render hot path.
  get dirty() {
    return hasPendingEdits(this.editor) || this.baselineGeneration !== this.generation ||
      (!!this.editor.interactionActive && (this.editor.authoredDocument ?? this.editor.state.doc) !== this.currentDocument)
  }
  private residentEncoder?: ResidentDocumentEncoder
  private encode(document: DesignDocument) {
    const codec = this.bridge.documentCodec
    if (codec?.encoding === 'json-stringify-v1' && codec.encodeIncremental) {
      this.residentEncoder ??= new ResidentDocumentEncoder(request => codec.encodeIncremental!(request))
      return documentStageAsync(DocumentStage.encode, () => this.residentEncoder!.encode(document))
    }
    return documentStageAsync(DocumentStage.encode, () => codec?.encode(document) ?? Promise.resolve(JSON.stringify(document)))
  }
  private advanceGeneration() {
    this.generation++
    for (const controller of this.documentPreparations) controller.abort()
    // The cache can only serve its exact generation. Release stale full JSON
    // immediately, including navigation to a custom-codec document with no
    // replacement certificate. Baselines and uncertain idempotent writes own
    // their separate references and must survive this cache invalidation.
    this.serializedGeneration = -1
    this.serializedJson = ''
  }
  private async captureSnapshot() {
    const generation=this.generation, document=this.currentDocument
    if(this.serializedGeneration===generation)return {json:this.serializedJson,generation,document}
    let pending=this.serializing
    if(pending?.generation!==generation||pending.document!==document){pending={generation,document,promise:this.encode(document)};this.serializing=pending}
    let json:string
    try{json=await pending.promise}finally{if(this.serializing===pending)this.serializing=undefined}
    if(this.generation===generation && this.currentDocument===document){this.serializedJson=json;this.serializedGeneration=generation}
    return {json,generation,document}
  }
  private async reconcileBaseline() {
    if(hasPendingEdits(this.editor)||!this.dirty||this.baselineJson===null&&!this.baselineDocument)return
    const generation=this.baselineGeneration, document=this.baselineDocument
    const baseline=this.baselineJson ?? await this.encode(document!)
    const snapshot=await this.captureSnapshot()
    if (!this.disposed && !hasPendingEdits(this.editor) && this.generation===snapshot.generation &&
        this.baselineGeneration===generation && this.baselineDocument===document && snapshot.json===baseline) {
      this.baselineJson=baseline;this.baselineDocument=undefined
      this.baselineGeneration = snapshot.generation
      this.publish()
    }
  }
  get status(): DesktopStatus {
    return {
      dirty: this.dirty,
      busy: this.operation !== 'idle',
      transitioning: this.operation !== 'idle' && this.operation !== 'save',
      operation: this.operation,
      displayName: this.displayName,
      error: this.error,
      warning: this.warning,
      recoveryWarning: this.recoveryWarning,
      conflict: this.conflict,
      storage: this.supportsWorkspace ? 'sqlite' : 'file',
      revision: this.workspaceHeads.get(this.currentDocument.id),
    }
  }

  /** Called only after the existing Rust/WASM editing kernel has initialized. */
  async start() {
    this.publish()
    const result = await this.run('recover', async () => {
      if(this.bridge.live){
        const initial=await this.bridge.live.initial()
        if(initial.status!=='ok')return initial.status==='cancelled'?true:this.failed(initial)
        if(initial.documentId&&this.bridge.workspace){const result=await this.bridge.workspace.open({id:initial.documentId});if(result.status!=='ok')return result.status==='cancelled'?false:this.failed(result);const document=await this.parse(result.documentJson);return this.generation===0&&!this.disposed?this.adoptWorkspace(document,result):true}
      }
      const recovery = await this.bridge.readRecovery()
      if (recovery.status === 'cancelled') {
        if (this.bridge.workspace && this.generation === 0 && this.isDefaultBlank(this.currentDocument)) {
          const listed = await this.bridge.workspace.list()
          if (listed.status !== 'ok') return listed.status === 'cancelled' ? true : this.failed(listed)
          const latest = listed.documents.filter((d) => !d.deleted).sort((a, b) => b.updatedAt - a.updatedAt)[0]
          if (latest && this.generation === 0) {
            const opened = await this.bridge.workspace.open({ id: latest.id })
            if (opened.status !== 'ok') return opened.status === 'cancelled' ? true : this.failed(opened)
            const document = await this.parse(opened.documentJson)
            if (this.generation === 0 && !this.disposed) return this.adoptWorkspace(document, opened)
          }
        }
        return true
      }
      if (recovery.status !== 'ok') return this.failed(recovery)
      const document = await this.parse(recovery.documentJson)
      // Startup is still interactive; an edit made while the native prompt was open must survive.
      const approved = await this.leave('recover')
      if (!this.authorized(approved)) return false
      if (!(await this.restore(document, recovery, approved))) return false
      this.editor.notify(this.supportsWorkspace ? '已恢复独立设计副本，将保存到本机文档库' : '已恢复未保存的设计副本；请保存到设计文件')
      return true
    })
    this.started = true
    if (this.bridge.openPendingDocument) await this.openPending()
    if (this.editor.state.version !== 0 && this.dirty) await this.updateRecovery()
    return result
  }

  save(saveAs = false) { return this.run('save', async () => { const saved = await this.saveCurrent(saveAs); if (saved) desktopPet.event('save'); return saved }) }

  /** Native-confirmed MCP operations never commit/discard a pending input. Each
   * await and the final store/adoption boundary retain the original live fence. */
  automationWorkspace(method: 'workspace.open' | 'workspace.save' | 'workspace.restore', params: Record<string, unknown>, guard: WorkspaceAutomationGuard, signal: AbortSignal): Promise<WorkspaceDocument> {
    const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
    const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    const validMutation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
    const expected = params.expectedStorageRevision
    if (!['workspace.open', 'workspace.save', 'workspace.restore'].includes(method) ||
      (method !== 'workspace.save' && !validId(params.id)) ||
      (method !== 'workspace.open' && (!validMutation(params.mutationId) || !(validRevision(expected) || method === 'workspace.save' && expected === null))) ||
      (method === 'workspace.restore' && !validRevision(params.revision))) return Promise.reject(Object.assign(new Error('Invalid workspace automation arguments'), { code: 'INVALID_PARAMS' }))
    if (this.active || this.operation !== 'idle' || this.workspacePending) return Promise.reject(Object.assign(new Error('Another save or unresolved write is pending'), { code: 'BUSY' }))
    const store = this.bridge.workspace
    if (!store) return Promise.reject(Object.assign(new Error('Local workspace storage is unavailable'), { code: 'WORKSPACE_UNAVAILABLE' }))
    const generation = this.generation
    const check = () => {
      if (signal.aborted) throw signal.reason ?? Object.assign(new Error('Request cancelled'), { code: 'CANCELLED' })
      if (this.disposed || this.closeSnapshot !== undefined || this.currentDocument.id !== guard.documentId || this.editor.sessionGeneration !== guard.session) fail('STALE_SESSION', 'The editor session changed')
      if (!Number.isSafeInteger(guard.expectedRevision) || this.editor.state.version !== guard.expectedRevision || this.generation !== generation) fail('REVISION_CONFLICT', 'The editor or a draft changed; current content is preserved')
      if (this.editor.state.busy) fail('BUSY', 'The editor is busy')
      if (hasPendingEdits(this.editor)) fail('PENDING_EDITS', 'Finish pending input first; the draft is preserved')
      if (this.editor.interactionActive) fail('INTERACTION_ACTIVE', 'Finish or cancel the current gesture')
      if (method !== 'workspace.save' && this.dirty) fail('DIRTY_DOCUMENT', 'Save the current document before navigation or restoration')
    }
    try { check() } catch (error) { return Promise.reject(error) }
    clearTimeout(this.recoveryTimer)
    this.operation = method === 'workspace.save' ? 'save' : 'open'
    this.publish()
    const unwrap = <T extends WorkspaceDocument>(result: DesktopResult<T>): T => {
      if (result.status === 'ok') return result
      if (result.status === 'cancelled') return fail('CANCELLED', 'The workspace operation was cancelled')
      return fail(result.code, result.message)
    }
    const metadata = ({ id, name, revision, hash, updatedAt, deleted }: WorkspaceDocument): WorkspaceDocument => ({ id, name, revision, hash, updatedAt, deleted })
    const task = Promise.resolve().then(async () => {
      await this.recoveryQueue
      check()
      if (this.workspacePending) fail('BUSY', 'An earlier save outcome is unresolved; settle it before another automation write')
      if (method === 'workspace.save') {
        if ((this.workspaceHeads.get(guard.documentId) ?? null) !== expected) fail('STORAGE_REVISION_CONFLICT', 'The saved revision changed')
        const snapshot = await this.captureSnapshot()
        check()
        const submitted = { documentJson: snapshot.json, expectedRevision: expected as number | null, mutationId: params.mutationId as string, generation: snapshot.generation, id: snapshot.document.id }
        this.workspacePending = submitted
        const response = await store.commit({ documentJson: submitted.documentJson, expectedRevision: submitted.expectedRevision, mutationId: submitted.mutationId })
        if (rejectedWorkspaceWrite(response)) this.workspacePending = undefined
        const saved = unwrap(response)
        if (saved.id !== submitted.id || !validRevision(saved.revision)) fail('INVALID_RESPONSE', 'The saved snapshot acknowledgement is invalid')
        this.workspacePending = undefined
        this.workspaceHeads.set(saved.id, saved.revision)
        // Acknowledging exact older bytes never marks a newer edit as saved.
        if (!this.disposed && this.currentDocument.id === submitted.id) {
          this.baselineGeneration = submitted.generation; this.baselineJson = submitted.documentJson; this.baselineDocument = undefined
          this.displayName = saved.name; this.error = undefined; this.conflict = false; this.publish()
        }
        check()
        return metadata(saved)
      }
      const id = params.id as string
      if (method === 'workspace.open') {
        const opened = unwrap(await store.open({ id }))
        check()
        const document = await this.parse(opened.documentJson)
        check()
        if (!this.adoptWorkspace(document, opened)) fail('EDITOR_REJECTED', 'The editor could not adopt the saved document')
        return metadata(opened)
      }
      // Validate the historical design before requesting the durable restore.
      const historical = unwrap(await store.open({ id, revision: params.revision as number }))
      check(); await this.parse(historical.documentJson); check()
      const restored = unwrap(await store.restore({ id, revision: params.revision as number, expectedRevision: expected as number, mutationId: params.mutationId as string }))
      try { check() } catch (error) { this.editor.notify('历史版本已恢复到本机库；当前画布已保留，请重新打开查看'); throw error }
      const document = await this.parse(restored.documentJson)
      check()
      if (!this.adoptWorkspace(document, restored)) fail('EDITOR_REJECTED', 'The restored design could not be adopted; the current editor is preserved')
      return metadata(restored)
    }).finally(() => {
      this.active = null; this.operation = 'idle'; this.publish()
      if (this.started && this.dirty) this.scheduleRecovery()
    })
    this.active = task
    return task
  }


  saveCopy() {
    return this.run('save', async () => {
      if (!this.bridge.workspace || this.editor.settleOwnedPropertyPreview?.('save') === false || this.editor.interactionActive || !commitPendingEdits(this.editor)) return false
      const generation = this.generation
      const document = { ...this.currentDocument, id: crypto.randomUUID(), name: `${this.currentDocument.name} 副本`.slice(0, 200) }
      const documentJson = await this.encode(document)
      const result = await this.bridge.workspace.commit({ documentJson, expectedRevision: null, mutationId: crypto.randomUUID() })
      if (result.status !== 'ok') {
        if (rejectedWorkspaceWrite(result)) this.workspacePending = undefined
        return result.status === 'cancelled' ? false : this.failed(result)
      }
      desktopPet.event('save')
      this.workspaceHeads.set(result.id, result.revision)
      if (this.generation !== generation || this.disposed) { this.editor.notify('本机副本已保存；当前新修改已保留'); return true }
      this.workspacePending = undefined
      return this.adoptWorkspace(document, { ...result, documentJson })
    })
  }


  open() { return this.openFile(() => this.bridge.openDocument()) }
  openPending() {
    if (!this.bridge.openPendingDocument) return Promise.resolve(false)
    let remaining = 0
    return this.openFile(async () => {
      const result = await this.bridge.openPendingDocument!()
      if (result.status === 'ok') remaining = result.pendingCount || 0
      return result
    }).then(opened => {
      if (opened && remaining > 0 && !this.disposed) void this.openPending()
      return opened
    })
  }

  openCatalogFile(request: { directoryHandle: string; fileId: string }) {
    // A catalog row is metadata only. The host resolves a currently granted root and file.
    return this.openFile(() => this.bridge.openCatalogFile(request))
  }

  private openFile(read: () => Promise<DesktopResult<DesktopFile>>) {
    return this.run('open', async () => {
      const result = await read()
      if (this.disposed) return false
      if (result.status === 'cancelled') return false
      if (result.status !== 'ok') return this.failed(result)
      // Validate everything before asking to discard, or touching the active editing session.
      this.assertFile(result)
      const decodingGeneration = this.generation
      let document = await this.parse(result.documentJson)
      if(this.disposed||this.generation!==decodingGeneration){this.editor.notify('读取期间设计有新修改，当前画布已保留；请重试');return false}
      const approved = await this.leave('open')
      if (!this.authorized(approved)) return false
      let importedCopy = false
      if (this.bridge.workspace) {
        const existing = await this.bridge.workspace.open({ id: document.id })
        if (!this.authorized(approved)) return false
        if (existing.status === 'ok') {
          // Opening a portable file is an import. Never replace an existing
          // local document merely because its external copy shares an ID.
          document = forkPreparedDocument(document)
          importedCopy = true
        } else if (existing.status !== 'error' || existing.code !== 'WORKSPACE_NOT_FOUND') {
          return existing.status === 'cancelled' ? false : this.failed(existing)
        }
      }
      if (!this.load(document, !this.supportsWorkspace, result.handle, result.displayName)) return false
      // Publish the validated canvas synchronously before pinning its grant. No awaited gap
      // can authorize discarding a newer edit, and later IPC commands cannot overtake this one.
      const accepted = await this.bridge.acceptDocument({ handle: result.handle })
      if (accepted.status !== 'ok') {
        this.handle = undefined
        this.baselineGeneration = null
        this.baselineJson = null
        this.baselineDocument = undefined
        this.publish()
        this.editor.notify('设计内容已打开，但文件句柄确认失败；请另存为设计文件')
        return false
      }
      await this.updateRecovery()
      if (this.supportsWorkspace && this.error) return false
      this.editor.notify(importedCopy ? '已导入独立本机副本；原文件与已有文档均已保留' : '已打开本机设计文件')
      return true
    })
  }

  replace(document: DesignDocument, canAdopt: () => boolean = () => true) {
    return this.run('new', async () => {
      if (!canAdopt()) return false
      const prepared = documentStage(DocumentStage.prepare, () => prepareDocument(document))
      const approved = await this.leave('new')
      if (!this.authorized(approved) || !canAdopt()) return false
      if (!this.load(prepared, false)) return false
      const adoptedGeneration = this.generation
      await this.updateRecovery()
      if (!this.disposed && this.generation === adoptedGeneration)
        this.editor.notify(this.supportsWorkspace ? (this.dirty ? '编辑后将自动保存到本机文档库' : '新设计已保存到本机文档库') : '新设计尚未保存到文件')
      return true
    })
  }

  recover() {
    return this.run('recover', async () => {
      const result = await this.bridge.readRecovery()
      if (result.status === 'cancelled') return false
      if (result.status !== 'ok') return this.failed(result)
      const document = await this.parse(result.documentJson)
      const approved = await this.leave('recover')
      if (!this.authorized(approved)) return false
      if (!(await this.restore(document, result, approved))) return false
      await this.updateRecovery()
      this.editor.notify('已恢复未保存的设计副本；原文件未改动')
      return true
    })
  }

  get closeReady() {
    return this.closeSnapshot !== undefined && this.closeSnapshot === this.generation && !this.editor.state.busy && !hasPendingEdits(this.editor)
  }

  cancelClose() {
    if (this.closeSnapshot === undefined) return
    this.closeSnapshot = undefined
    this.operation = 'idle'
    this.publish()
    if (this.started && this.dirty) this.scheduleRecovery()
  }

  requestClose() {
    return this.run('close', async () => {
      if (this.editor.state.busy) {
        this.editor.notify('设计计算尚未完成，暂未关闭窗口；请稍后重试')
        return false
      }
      const confirmedSnapshot = await this.leave('close')
      if (!this.authorized(confirmedSnapshot)) return false
      // A final fence covers edits arriving during asynchronous journal cleanup too.
      await this.updateRecovery(confirmedSnapshot)
      if (this.generation !== confirmedSnapshot || this.editor.state.busy) {
        await this.updateRecovery()
        this.editor.notify('关闭期间设计有新修改，窗口已保留')
        return false
      }
      this.closeSnapshot = confirmedSnapshot
      return true
    })
  }

  dispose() {
    this.disposed = true
    this.pendingTabId = undefined
    this.clearTabWait()
    for (const controller of this.documentPreparations) controller.abort()
    this.documentPreparations.clear()
    cancelPendingOperations(this.editor)
    clearTimeout(this.recoveryTimer)
    this.unsubscribe()
    this.unsubscribeDrafts()
  }

  private observe() {
    const authored = this.editor.authoredDocument ?? this.editor.state.doc
    if (this.suppressObservation) return
    // Pointer previews publish a replacement root at the existing revision.
    // Storage owns the last committed root until commit or cancel. Otherwise
    // committing that same preview looks like an in-place authored mutation
    // and discards the acknowledged incremental encoder.
    if (this.editor.state.version === this.currentVersion &&
        (authored === this.currentDocument || (this.editor.interactionActive && authored.id === this.currentDocument.id))) {
      if ((authored !== this.currentDocument || this.lastDirty !== undefined) && this.lastDirty !== this.dirty) this.publish()
      return
    }
    // A versioned in-place replacement has no immutable delta baseline.
    if (authored === this.currentDocument) this.residentEncoder = undefined
    this.currentDocument = authored
    this.currentVersion = this.editor.state.version
    this.advanceGeneration()
    this.publish()
    if (this.started && !this.recoveryPaused && this.operation === 'idle') this.scheduleRecovery()
  }

  private publish() {
    if (this.disposed) return
    if (this.lastDirty !== this.dirty) {
      this.lastDirty = this.dirty
      void this.bridge.setDirty(this.dirty).catch((error) => {
        this.editor.notify(`桌面关闭保护同步失败：${String(error)}`)
      })
    }
    const currentTab = { id: this.currentDocument.id, name: this.currentDocument.name, persisted: this.workspaceHeads.has(this.currentDocument.id) }
    const existing = this.tabsValue.find(t => t.id === currentTab.id)
    if (!existing || existing.name !== currentTab.name || existing.persisted !== currentTab.persisted) {
      this.tabsValue = existing ? this.tabsValue.map(t => t.id === currentTab.id ? currentTab : t) : [...this.tabsValue, currentTab]
      this.tabListeners.forEach(listener => listener())
    }
    // Property preview pixels never become recovery snapshots. Identical status
    // must not force App and its entire panel tree through every sample.
    const status = this.status
    if (!this.publishedStatus || (Object.keys(status) as (keyof DesktopStatus)[])
      .some(key => status[key] !== this.publishedStatus![key])) {
      this.publishedStatus = status
      this.onStatus(status)
    }
  }

  private run<T = boolean>(operation: DesktopStatus['operation'], action: () => Promise<T>): Promise<T | false> {
    const trace = beginEditorAction(this.editor, operation === 'save' ? CanvasAction.save : operation === 'new' ? CanvasAction.newDocument : CanvasAction.import, ActionSource.lifecycle, 300 + ['save','new','open','recover','close'].indexOf(operation))
    if (this.active || this.disposed || this.closeSnapshot !== undefined) { trace.result(ActionOutcome.blocked, ActionReason.busy); trace.finish(); return Promise.resolve(false) }
    if (operation !== 'save') cancelPendingOperations(this.editor)
    clearTimeout(this.recoveryTimer)
    this.operation = operation
    this.error = undefined
    this.conflict = false
    this.publish()
    // Enter the gate synchronously so repeated clicks cannot open multiple dialogs/writes.
    let completed = false
    const task = Promise.resolve().then(async () => {
      // A native dialog must not race an older journal write through the host's exclusive gate.
      await documentStageAsync(DocumentStage.recoveryWait, () => this.recoveryQueue)
      return action()
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return false
      trace.result(ActionOutcome.rejected, ActionReason.validation)
      return this.failed({ status: 'error', code: 'RENDERER_ERROR', message: String(error) })
    }).then((result) => { completed = !!result; trace.result(result ? ActionOutcome.observed : this.error ? ActionOutcome.rejected : ActionOutcome.cancelled, result ? ActionReason.none : this.error ? ActionReason.validation : ActionReason.unobserved); return result }).finally(() => {
      trace.finish()
      this.active = null
      this.operation = operation === 'close' && completed ? 'close' : 'idle'
      this.publish()
      const queued = this.pendingTabId
      this.pendingTabId = undefined
      if (queued && this.operation === 'idle' && !this.disposed && this.closeSnapshot === undefined) {
        const delay = Math.min(2000, 200 * Math.max(1, this.tabWaitAttempts))
        setTimeout(() => { if (!this.disposed && !this.active && this.closeSnapshot === undefined) void this.openWorkspace(queued) }, delay)
      }
      // Cancelled dialogs and failed saves still need the latest recovery snapshot.
      if (this.started && this.dirty && !(operation === 'close' && completed)) this.scheduleRecovery()
    })
    this.active = task
    return task
  }

  private async parse(input: unknown) {
    const json = nativeDesignJson(input)
    const codec = Object.getOwnPropertyDescriptor(this.bridge, 'documentCodec')?.value as DesktopBridge['documentCodec']
    // Only this installed, frozen version1 preload declares exact JSON.parse.
    // Unknown/custom/foreign codec owners retain their original decode contract.
    if (codec && Object.isFrozen(this.bridge) && Object.isFrozen(codec) &&
        typeof window !== 'undefined' && window.coreDesktop === this.bridge &&
        Object.getOwnPropertyDescriptor(this.bridge, 'version')?.value === 1 &&
        Object.getOwnPropertyDescriptor(codec, 'decoding')?.value === 'json-parse-v1' &&
        typeof Object.getOwnPropertyDescriptor(codec, 'decode')?.value === 'function') {
      // Production browser workers own the full admission/layout/validation,
      // not merely JSON.decode. Preserve altered host-prototype semantics and
      // non-browser hosts on the previous synchronous path. Unknown/dev build
      // identity, custom assets or absent runtime digests also stay on that path.
      if (typeof Worker !== 'undefined' && documentPreparationRuntime() && !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype) &&
          Object.getPrototypeOf(Array.prototype) === Object.prototype) {
        const generation = this.generation, version = this.editor.state.version
        const document = this.currentDocument, session = this.editor.sessionGeneration
        const controller = new AbortController()
        const current = () => !this.disposed && this.generation === generation && this.currentDocument === document &&
          this.editor.state.version === version && this.editor.sessionGeneration === session
        this.documentPreparations.add(controller)
        try {
          return await documentStageAsync(DocumentStage.prepare, () =>
            documentStageAsync(DocumentStage.rawJsonPrepare, () => prepareDocumentJsonInWorker(json,
              { documentId: document.id, version, generation, session: session ?? null }, controller.signal, current), json.length), json.length)
        } catch (error) {
          // Only this controlled worker's attempt-local source failure permits
          // the installed codec's original error transport. Never admit its graph.
          if (!controller.signal.aborted && current() && consumeDocumentPreparationSourceFailure(error))
            await documentStageAsync(DocumentStage.decode, () => codec.decode(json), json.length)
          throw error
        } finally { this.documentPreparations.delete(controller) }
      }
      // Match document-codec-worker's raw UTF-8 bound/error before parsing; the
      // shared admission also checks its canonical serialized byte bound.
      const syntaxFailureAttempt = {}
      let rawSizeFailure = false
      try {
        return documentStage(DocumentStage.prepare, () =>
          documentStage(DocumentStage.rawJsonPrepare, () => {
            try { assertDocumentJson(json) } catch (error) { rawSizeFailure = true; throw error }
            return prepareDocumentJson(json, syntaxFailureAttempt)
          }, json.length), json.length)
      } catch (error) {
        // Preserve the installed codec's transport error class/message on bad
        // JSON or raw size. Never admit its returned object on this path. Only
        // the private JSON.parse failure witness can authorize this retry;
        // kernel, validation, allocation and unrelated SyntaxErrors fail once.
        if (rawSizeFailure || consumeDocumentJsonSyntaxFailure(error, syntaxFailureAttempt))
          await documentStageAsync(DocumentStage.decode, () => codec.decode(json), json.length)
        throw error
      }
    }
    const decoded = await documentStageAsync(DocumentStage.decode, async () => {
      if (this.bridge.documentCodec) return this.bridge.documentCodec.decode(json)
      assertDocumentJson(json)
      return JSON.parse(json)
    }, json.length)
    return documentStage(DocumentStage.prepare, () => prepareDocument(decoded), json.length)
  }

  private isDefaultBlank(document: DesignDocument) {
    return document.name === '未命名设计' && document.pages.length === 1 &&
      document.pages[0].children.length === 0 && Object.keys(document.nodes).length === 0
  }

  private assertFile(file: { handle: string; displayName: string }) {
    if (!file.handle || typeof file.handle !== 'string' || typeof file.displayName !== 'string')
      throw new Error('原生文件响应无效；当前设计已保留')
  }

  private load(document: DesignDocument | PreparedDocument, persisted: boolean, handle?: string, name?: string,preserveView=false) {
    // Plain-object callers (including saveCopy) need the same private owner
    // proof as pre-prepared paths. Editor.load consumes this token without a
    // second preparation or serialization.
    document = ensurePreparedDocument(document)
    const adoptedOwner = preparedDocumentAdoptionOwner(document)
    // Only the installed JSON.stringify codec (or the exact local fallback) can
    // use this certificate. Unknown/custom encoders keep the existing encode path.
    const encoding = !this.bridge.documentCodec || this.bridge.documentCodec.encoding === 'json-stringify-v1'
      ? preparedDocumentEncoding(document) : undefined
    const previousVersion = this.editor.state.version, previousSession = this.editor.sessionGeneration
    const previousGeneration = this.generation
    this.suppressObservation = true
    try { if (!documentStage(DocumentStage.adoption, () => this.editor.load(document,preserveView))) return false } finally { this.suppressObservation = false }
    // Editor.load publishes synchronously. A listener may edit even the same
    // root object or start another load while normal observation is suppressed.
    // Ownership alone cannot prove that the adopted bytes are still current.
    const unchangedAdoption = this.editor.state.version === previousVersion + 1 &&
      (previousSession === undefined ? this.editor.sessionGeneration === undefined
        : this.editor.sessionGeneration === previousSession + 1) &&
      this.generation === previousGeneration &&
      !!adoptedOwner?.(this.editor.state.doc)
    const previousId = this.currentDocument.id
    if (previousId !== this.editor.state.doc.id && !this.workspaceHeads.has(previousId))
      this.tabsValue = this.tabsValue.filter(t => t.id !== previousId)
    this.currentDocument = this.editor.authoredDocument ?? this.editor.state.doc
    this.currentVersion = this.editor.state.version
    this.advanceGeneration()
    // An imported document is still dirty until storage acknowledges it, but
    // its exact post-layout bytes already exist. Reuse them for the first save
    // instead of cloning the whole object through the desktop codec again.
    // The same adoption fences protect this current-snapshot cache; future
    // versioned edits advance generation and must obtain their own encoding.
    if (unchangedAdoption && encoding) {
      this.serializedJson = documentStage(DocumentStage.snapshotReuse, () => encoding.json, encoding.json.length)
      this.serializedGeneration = this.generation
      const codec = this.bridge.documentCodec
      if (codec?.encoding === 'json-stringify-v1' && codec.encodeIncremental) {
        // Keep the certified base for the first edit's incremental save. A new
        // owner also isolates outstanding encodes from the preceding document.
        this.residentEncoder = new ResidentDocumentEncoder(request => codec.encodeIncremental!(request),
          { document: this.currentDocument, json: encoding.json })
      }
    }
    this.pristineBlankGeneration = !persisted && unchangedAdoption && this.isDefaultBlank(this.currentDocument)
      ? this.generation : null
    // The kernel may canonicalize an already validated document when it opens it.
    const persistedUnchanged = persisted && unchangedAdoption
    this.baselineGeneration = persistedUnchanged ? this.generation : null
    const certifiedJson = persistedUnchanged && encoding
      ? documentStage(DocumentStage.baselineReuse, () => encoding.json, encoding.json.length) : undefined
    this.baselineJson = certifiedJson ?? null
    this.baselineDocument = persistedUnchanged && certifiedJson === undefined ? this.currentDocument : undefined
    this.handle = handle
    this.displayName = name
    this.warning = undefined
    this.error = undefined
    this.conflict = false
    this.publish()
    return true
  }

  private async saveCurrent(saveAs = false) {
    if (this.editor.settleOwnedPropertyPreview?.('save') === false) return false
    if (this.editor.interactionActive) { this.editor.notify('请先完成拖动，或按 Esc 取消后保存'); return false }
    if (!commitPendingEdits(this.editor)) return false
    const {json:snapshot,generation:snapshotGeneration,document} = await this.captureSnapshot()
    if(this.disposed)return false
    if (this.bridge.workspace && !saveAs) {
      const persisted = await this.persistWorkspace(snapshot, snapshotGeneration, document.id)
      if (persisted) {
        await this.updateRecovery()
        this.editor.notify(this.dirty ? '先前版本已保存；当前修改正在保存' : '已保存到本机文档库')
      }
      return persisted
    }
    const result = await this.bridge.saveDocument({
      handle: this.handle,
      documentJson: snapshot,
      saveAs,
    })
    if (result.status === 'cancelled') return false
    if (result.status !== 'ok') return this.failed(result)
    this.assertFile(result)
    // Only the exact submitted bytes were acknowledged. A newer edit remains dirty.
    this.handle = result.handle
    this.displayName = result.displayName
    if (!this.supportsWorkspace) {
      this.baselineGeneration = snapshotGeneration
      this.baselineJson = snapshot
      this.baselineDocument = undefined
    }
    this.warning = result.warning
    this.publish()
    await this.updateRecovery()
    this.editor.notify(result.warning
      ? `设计已写入，但持久化确认有警告：${result.warning}`
      : this.dirty
        ? `已保存「${document.name}」的先前版本；当前还有未保存的修改`
        : this.supportsWorkspace ? '已导出便携设计文件' : '已保存到本机设计文件')
    return true
  }

  private async persistWorkspace(snapshot: string, generation: number, id: string): Promise<boolean> {
    const store = this.bridge.workspace
    if (!store || this.disposed) return false
    // Retain the same request identity until an uncertain write is acknowledged.
    // A newer edit first settles the older idempotent request, then submits its own revision.
    if (this.workspacePending) {
      const older = this.workspacePending
      const result = await documentStageAsync(DocumentStage.save, () => store.commit({ documentJson: older.documentJson, expectedRevision: older.expectedRevision, mutationId: older.mutationId }), older.documentJson.length)
      if (result.status !== 'ok') {
        if (rejectedWorkspaceWrite(result)) this.workspacePending = undefined
        this.retryWorkspaceBusy(result)
        return result.status === 'cancelled' ? false : this.failed(result)
      }
      if (result.id !== older.id || !Number.isSafeInteger(result.revision) || result.revision < 1)
        throw new Error('本机库保存响应无效')
      this.workspaceBusyRetries = 0
      desktopPet.event('save')
      this.workspaceHeads.set(result.id, result.revision)
      this.rememberWorkspace({ id: result.id, name: result.name, revision: result.revision, hash: result.hash, updatedAt: result.updatedAt, deleted: result.deleted, documentJson: older.documentJson })
      this.workspacePending = undefined
      if (this.currentDocument.id === older.id) {
        this.baselineGeneration = older.generation
        this.baselineJson = older.documentJson
        this.baselineDocument = undefined
        this.displayName = result.name
        this.error = undefined
        this.conflict = false
      }
      if (snapshot === older.documentJson && this.currentDocument.id === older.id) {
        // A draft may have ended without changing authored bytes. The same
        // acknowledged payload also covers the exact newer captured generation,
        // never an edit that arrived after that capture.
        this.baselineGeneration = generation
        this.publish(); return true
      }
    }
    const submitted = { documentJson: snapshot, expectedRevision: this.workspaceHeads.get(id) ?? null, mutationId: crypto.randomUUID(), generation, id }
    this.workspacePending = submitted
    const result = await documentStageAsync(DocumentStage.save, () => store.commit({ documentJson: submitted.documentJson, expectedRevision: submitted.expectedRevision, mutationId: submitted.mutationId }), submitted.documentJson.length)
    if (result.status !== 'ok') {
      if (rejectedWorkspaceWrite(result)) this.workspacePending = undefined
      this.retryWorkspaceBusy(result)
      return result.status === 'cancelled' ? false : this.failed(result)
    }
    if (result.id !== id || !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw new Error('本机库保存响应无效')
    this.workspacePending = undefined
    this.workspaceBusyRetries = 0
    desktopPet.event('save')
    this.workspaceHeads.set(result.id, result.revision)
    this.rememberWorkspace({ id: result.id, name: result.name, revision: result.revision, hash: result.hash, updatedAt: result.updatedAt, deleted: result.deleted, documentJson: snapshot })
    if (!this.disposed && this.currentDocument.id === id) {
      this.baselineGeneration = generation
      this.baselineJson = snapshot
      this.baselineDocument = undefined
      this.displayName = result.name
      this.error = undefined
      this.conflict = false
      this.publish()
    }
    return true
  }

  private async leave(reason: LeaveReason): Promise<number | null> {
    if (this.editor.settleOwnedPropertyPreview?.('navigation') === false) return null
    if (this.editor.interactionActive) { this.editor.notify('请先完成拖动，或按 Esc 取消后切换文档'); return null }
    if (!commitPendingEdits(this.editor)) return null
    const reconcilingGeneration = this.generation
    await this.reconcileBaseline()
    if(this.disposed||this.generation!==reconcilingGeneration)return null
    if (!this.dirty) return this.generation
    if (this.pristineBlankGeneration === this.generation && !hasPendingEdits(this.editor))
      return this.generation
    // A brand-new, untouched blank during startup has no prior editing session to discard.
    if (!this.started && this.generation === 0) return this.generation
    // The local library is the working copy. Navigation/close flush it
    // automatically; a failed or superseded write keeps this editor open.
    if (this.supportsWorkspace) {
      if (!(await this.saveCurrent()) || this.dirty) return null
      return this.generation
    }
    const confirmedSnapshot = this.generation
    const decision = await this.confirmLeave(reason)
    if (decision === 'cancel') return null
    if (this.generation !== confirmedSnapshot) {
      this.editor.notify('确认期间设计有新修改，已保留当前画布；请重试')
      return null
    }
    if (decision === 'discard') this.workspacePending = undefined
    if (decision === 'save') {
      if (!(await this.saveCurrent())) return null
      if (this.dirty) {
        this.editor.notify('保存期间设计有新修改，当前画布已保留；请再次保存')
        return null
      }
    }
    return this.generation
  }

  private authorized(generation: number | null): generation is number {
    if (this.disposed || generation === null) return false
    if (generation !== this.generation) {
      this.editor.notify('确认后设计有新修改，当前画布已保留；请重试')
      return false
    }
    return true
  }

  private async restore(document: PreparedDocument, recovery: { displayName: string; recoveryHandle: string }, confirmedSnapshot: number) {
    if (!recovery.recoveryHandle) throw new Error('恢复副本响应无效')
    this.recoveryPaused = true
    clearTimeout(this.recoveryTimer)
    try {
      await this.recoveryQueue
      if (this.generation !== confirmedSnapshot) return false
      const accepted = await this.bridge.acceptRecovery({ recoveryHandle: recovery.recoveryHandle })
      if (accepted.status !== 'ok') return accepted.status === 'cancelled' ? false : this.failed(accepted)
      if (this.generation !== confirmedSnapshot) {
        this.editor.notify('恢复期间设计有新修改，当前画布与原恢复副本已保留')
        return false
      }
      // A recovery journal has no trusted SQLite base revision. Adopt an
      // independent document so saving cannot overwrite a later durable head
      // or become stuck in create-only conflicts after a process restart.
      const restored = this.supportsWorkspace ? forkPreparedDocument(document) : document
      if (!this.load(restored, false, undefined, recovery.displayName)) return false
      this.recoveryHandles.add(recovery.recoveryHandle)
      return true
    } finally {
      this.recoveryPaused = false
    }
  }

  private failed(result: Exclude<DesktopResult, { status: 'ok' } | { status: 'cancelled' }>): false {
    desktopPet.event('error')
    const message = unwrapSourceError(result.message)
    this.error = message
    this.conflict = result.status === 'conflict' || result.code === 'CONFLICT' || result.code === 'WORKSPACE_CONFLICT'
    this.publish()
    this.editor.notify(this.conflict
      ? `文件已被外部修改。当前画布已保留，请另存为，或重新打开磁盘文件：${message}`
      : `操作失败，当前画布已保留：${message}`)
    return false
  }

  private retryWorkspaceBusy(result: DesktopResult<unknown>) {
    // Large workspace reads can temporarily own the native IPC/SQLite gate.
    // An autosave has no run() finally to reschedule its still-dirty snapshot.
    // Retain workspacePending: every retry settles the exact original receipt
    // before a newer edit can submit its own CAS. Unknown outcomes do not loop.
    if (result.status !== 'ok' && result.status !== 'cancelled' &&
        (result.code === 'BUSY' || result.code === 'WORKSPACE_BUSY')) {
      this.workspaceBusyRetries = Math.max(1, this.workspaceBusyRetries)
    } else this.workspaceBusyRetries = 0
  }

  private scheduleWorkspaceBusyRetry() {
    if (!this.dirty) { this.workspaceBusyRetries = 0; return }
    if (!this.workspaceBusyRetries || !this.started || this.disposed || this.recoveryPaused ||
        this.closeSnapshot !== undefined || this.operation !== 'idle') return
    const delay = Math.min(5000, 600 * 2 ** (this.workspaceBusyRetries - 1))
    this.workspaceBusyRetries = Math.min(5, this.workspaceBusyRetries + 1)
    this.scheduleRecovery(delay)
  }

  private scheduleRecovery(delay = 600) {
    clearTimeout(this.recoveryTimer)
    if (this.pristineBlankGeneration === this.generation) return
    this.recoveryTimer = setTimeout(() => { void this.updateRecovery() }, delay)
  }

  private updateRecovery(discardSnapshot?: number) {
    clearTimeout(this.recoveryTimer)
    // Compute the snapshot when this queued operation starts, not before an older write finishes.
    const next = this.recoveryQueue.then(() => documentStageAsync(DocumentStage.recovery, async () => {
      if (this.disposed || this.recoveryPaused) return
      await this.reconcileBaseline()
      if (this.bridge.workspace && this.dirty && discardSnapshot !== this.generation &&
          this.pristineBlankGeneration !== this.generation && !this.editor.state.busy && !this.editor.interactionActive && !hasPendingEdits(this.editor)) {
        const snapshot=await this.captureSnapshot()
        if(this.disposed||this.recoveryPaused||this.generation!==snapshot.generation||hasPendingEdits(this.editor))return
        await this.persistWorkspace(snapshot.json, snapshot.generation, snapshot.document.id)
      }
      let result: DesktopResult
      if (this.dirty && discardSnapshot !== this.generation) {
        const snapshot=await this.captureSnapshot()
        if(this.disposed||this.recoveryPaused||this.generation!==snapshot.generation)return
        result = await this.bridge.writeRecovery({
          documentJson: snapshot.json,
          displayName: this.displayName || this.currentDocument.name,
          handle: this.handle,
        })
      } else {
        result = await this.bridge.clearRecovery()
        if (result.status === 'ok') {
          for (const recoveryHandle of this.recoveryHandles) {
            result = await this.bridge.clearRecovery({ recoveryHandle })
            if (result.status !== 'ok') break
            this.recoveryHandles.delete(recoveryHandle)
          }
        }
      }
      if (result.status !== 'ok' && result.status !== 'cancelled') {
        if (this.recoveryError !== result.message)
          this.editor.notify(`自动保存失败，当前修改已保留：${result.message}`)
        this.recoveryError = result.message
      } else {
        this.recoveryError = undefined
        const warning = result.status === 'ok' ? result.warning : undefined
        if (warning && this.recoveryWarning !== warning)
          this.editor.notify(`工作副本已写入，但持久化确认有警告：${warning}`)
        this.recoveryWarning = warning
        this.publish()
      }
    })).catch((error: unknown) => {
      this.workspaceBusyRetries = 0
      this.editor.notify(`自动保存失败，当前修改已保留：${String(error)}`)
    }).finally(() => {
      // A known-busy retry may meet a draft/gesture/busy gate without writing.
      // Keep its bounded retry alive; cancel-only gestures need not emit a new
      // authored revision. Disposal, close, paused recovery and clean state stop it.
      this.scheduleWorkspaceBusyRetry()
    })
    this.recoveryQueue = next
    return next
  }
}
