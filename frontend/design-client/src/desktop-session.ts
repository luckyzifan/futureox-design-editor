import { cancelPendingOperations, commitPendingEdits, hasPendingEdits, subscribePendingEdits } from './pending-edits'
import type { Editor } from './engine'
import { prepareDocumentForEditing } from './kernel/picking'
import { prepareDocument, type PreparedDocument } from './prepared-document'
import { blank, type DesignDocument } from './model'
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
type SessionEditor = Pick<Editor, 'state' | 'subscribe' | 'load' | 'notify'> & Partial<Pick<Editor, 'interactionActive'>>
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

/** Disk acknowledgements are scoped to immutable snapshots, never to the latest edit. */
export type WorkspaceTab = { id: string; name: string; persisted: boolean }
export class DesktopSession {
  private readonly tabListeners = new Set<() => void>()
  private tabsValue: WorkspaceTab[] = []
  subscribeTabs = (listener: () => void) => { this.tabListeners.add(listener); return () => { this.tabListeners.delete(listener) } }
  tabsSnapshot = () => this.tabsValue
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
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    if (document.id === this.currentDocument.id) throw new Error('请先打开其他设计，再移入回收站')
    return this.bridge.workspace.trash({ id: document.id, expectedRevision: document.revision, mutationId: crypto.randomUUID(), deleted })
  }
  openWorkspace(id: string) {
    return this.run('open', async () => {
      if (!this.bridge.workspace) return false
      const result = await this.bridge.workspace.open({ id })
      if (result.status !== 'ok') return result.status === 'cancelled' ? false : this.failed(result)
      await this.parse(result.documentJson)
      const approved = await this.leave('open')
      if (!this.authorized(approved)) return false
      // A Save decision can advance this very document while the first read
      // waits for the leave dialog. Adopt a fresh immutable head, never that stale read.
      const latest = await this.bridge.workspace.open({ id })
      if (!this.authorized(approved)) return false
      if (latest.status !== 'ok') return latest.status === 'cancelled' ? false : this.failed(latest)
      const document = await this.parse(latest.documentJson)
      return this.authorized(approved) && this.adoptWorkspace(document, latest)
    })
  }
  restoreWorkspace(id: string, revision: number, expectedRevision: number): Promise<false | { document: DesignDocument; revision: number }> {
    return this.run('open', async () => {
      if (!this.bridge.workspace) return false
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
      return this.adoptWorkspace(document, result) ? { document, revision: result.revision } : false
    })
  }
  /** Reads one workspace revision for read-only preview; never adopts it into the editor. */
  async readWorkspaceRevision(id: string, revision: number): Promise<{ document: DesignDocument; updatedAt: number } | null> {
    if (!this.bridge.workspace) throw new Error('本机文档库不可用')
    const result = await this.bridge.workspace.open({ id, revision })
    if (result.status === 'ok') return { document: await this.parse(result.documentJson), updatedAt: result.updatedAt }
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
  private adoptWorkspace(document: DesignDocument, result: WorkspaceOpened,preserveView=false) {
    if (document.id !== result.id || !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw new Error('本机文档版本响应无效')
    if (!this.load(document, true, undefined, result.name,preserveView)) return false
    this.workspaceHeads.set(result.id, result.revision)
    this.publish()
    this.editor.notify(`已打开本机设计 · 版本 ${result.revision}`)
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
  private suppressObservation = false
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recoveryQueue: Promise<void> = Promise.resolve()
  private recoveryError?: string
  private recoveryWarning?: string
  private recoveryPaused = false
  private readonly recoveryHandles = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeDrafts: () => void
  private lastDirty?: boolean
  private publishedStatus?: DesktopStatus
  private hadPending = false
  private closeSnapshot?: number
  private pristineBlankGeneration: number | null

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly editor: SessionEditor,
    private readonly confirmLeave: (reason: LeaveReason) => Promise<LeaveDecision>,
    private readonly onStatus: (status: DesktopStatus) => void = () => {},
  ) {
    this.currentDocument = editor.state.doc
    this.currentVersion = editor.state.version
    this.pristineBlankGeneration = this.isDefaultBlank(this.currentDocument) ? 0 : null
    this.unsubscribe = editor.subscribe(() => this.observe())
    this.hadPending = hasPendingEdits(editor)
    this.unsubscribeDrafts = subscribePendingEdits(editor, () => {
      const pending = hasPendingEdits(editor)
      if (pending || this.hadPending) this.generation++
      this.hadPending = pending
      this.publish()
    })
  }

  // Candidate dirtiness is O(1) even during drag previews. At lifecycle/recovery boundaries,
  // lazy byte equality recognizes undo-to-saved without serializing in the render hot path.
  get dirty() { return hasPendingEdits(this.editor) || this.baselineGeneration !== this.generation }
  private encode(document: DesignDocument) {
    return this.bridge.documentCodec?.encode(document) ?? Promise.resolve(JSON.stringify(document))
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

  save(saveAs = false) { return this.run('save', () => this.saveCurrent(saveAs)) }

  saveCopy() {
    return this.run('save', async () => {
      if (!this.bridge.workspace || this.editor.interactionActive || !commitPendingEdits(this.editor)) return false
      const generation = this.generation
      const document = { ...this.currentDocument, id: crypto.randomUUID(), name: `${this.currentDocument.name} 副本`.slice(0, 200) }
      const documentJson = await this.encode(document)
      const result = await this.bridge.workspace.commit({ documentJson, expectedRevision: null, mutationId: crypto.randomUUID() })
      if (result.status !== 'ok') {
        if (result.status !== 'cancelled' && (result.status === 'conflict' || result.code === 'WORKSPACE_CONFLICT' || result.code === 'WORKSPACE_MUTATION_CONFLICT')) this.workspacePending = undefined
        return result.status === 'cancelled' ? false : this.failed(result)
      }
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
          document = { ...document, id: crypto.randomUUID() }
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
      const prepared = prepareDocument(document)
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
    cancelPendingOperations(this.editor)
    clearTimeout(this.recoveryTimer)
    this.unsubscribe()
    this.unsubscribeDrafts()
  }

  private observe() {
    if (this.suppressObservation || (this.editor.state.doc === this.currentDocument && this.editor.state.version === this.currentVersion)) return
    this.currentDocument = this.editor.state.doc
    this.currentVersion = this.editor.state.version
    this.generation++
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
    // Preview documents still advance generation/recovery above, but identical
    // status must not force App and its entire panel tree through every sample.
    const status = this.status
    if (!this.publishedStatus || (Object.keys(status) as (keyof DesktopStatus)[])
      .some(key => status[key] !== this.publishedStatus![key])) {
      this.publishedStatus = status
      this.onStatus(status)
    }
  }

  private run<T = boolean>(operation: DesktopStatus['operation'], action: () => Promise<T>): Promise<T | false> {
    if (this.active || this.disposed || this.closeSnapshot !== undefined) return Promise.resolve(false)
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
      await this.recoveryQueue
      return action()
    }).catch((error: unknown) => {
      return this.failed({ status: 'error', code: 'RENDERER_ERROR', message: String(error) })
    }).then((result) => { completed = !!result; return result }).finally(() => {
      this.active = null
      this.operation = operation === 'close' && completed ? 'close' : 'idle'
      this.publish()
      // Cancelled dialogs and failed saves still need the latest recovery snapshot.
      if (this.started && this.dirty && !(operation === 'close' && completed)) this.scheduleRecovery()
    })
    this.active = task
    return task
  }

  private async parse(json: unknown) {
    if (typeof json !== 'string') throw new Error('原生文件响应缺少设计内容')
    if (this.bridge.documentCodec) return prepareDocumentForEditing(await this.bridge.documentCodec.decode(json))
    if (new TextEncoder().encode(json).byteLength > MAX_DOCUMENT_BYTES)
      throw new Error('文件超过 32 MiB')
    return prepareDocumentForEditing(JSON.parse(json))
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
    this.suppressObservation = true
    try { if (!this.editor.load(document,preserveView)) return false } finally { this.suppressObservation = false }
    const previousId = this.currentDocument.id
    if (previousId !== this.editor.state.doc.id && !this.workspaceHeads.has(previousId))
      this.tabsValue = this.tabsValue.filter(t => t.id !== previousId)
    this.currentDocument = this.editor.state.doc
    this.currentVersion = this.editor.state.version
    this.generation++
    this.pristineBlankGeneration = !persisted && this.isDefaultBlank(this.currentDocument)
      ? this.generation : null
    // The kernel may canonicalize an already validated document when it opens it.
    this.baselineGeneration = persisted ? this.generation : null
    this.baselineJson = null
    this.baselineDocument = persisted ? this.currentDocument : undefined
    this.handle = handle
    this.displayName = name
    this.warning = undefined
    this.error = undefined
    this.conflict = false
    this.publish()
    return true
  }

  private async saveCurrent(saveAs = false) {
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
      const result = await store.commit({ documentJson: older.documentJson, expectedRevision: older.expectedRevision, mutationId: older.mutationId })
      if (result.status !== 'ok') {
        if (result.status !== 'cancelled' && (result.status === 'conflict' || result.code === 'WORKSPACE_CONFLICT' || result.code === 'WORKSPACE_MUTATION_CONFLICT')) this.workspacePending = undefined
        return result.status === 'cancelled' ? false : this.failed(result)
      }
      this.workspaceHeads.set(result.id, result.revision)
      this.workspacePending = undefined
      if (this.currentDocument.id === older.id) {
        this.baselineGeneration = older.generation
        this.baselineJson = older.documentJson
        this.baselineDocument = undefined
      }
      if (snapshot === older.documentJson && this.currentDocument.id === older.id) { this.publish(); return true }
    }
    const submitted = { documentJson: snapshot, expectedRevision: this.workspaceHeads.get(id) ?? null, mutationId: crypto.randomUUID(), generation, id }
    this.workspacePending = submitted
    const result = await store.commit({ documentJson: submitted.documentJson, expectedRevision: submitted.expectedRevision, mutationId: submitted.mutationId })
    if (result.status !== 'ok') {
      if (result.status !== 'cancelled' && (result.status === 'conflict' || result.code === 'WORKSPACE_CONFLICT')) this.workspacePending = undefined
      return result.status === 'cancelled' ? false : this.failed(result)
    }
    if (result.id !== id || !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw new Error('本机库保存响应无效')
    this.workspacePending = undefined
    this.workspaceHeads.set(result.id, result.revision)
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

  private async restore(document: DesignDocument, recovery: { displayName: string; recoveryHandle: string }, confirmedSnapshot: number) {
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
      const restored = this.supportsWorkspace ? { ...document, id: crypto.randomUUID() } : document
      if (!this.load(restored, false, undefined, recovery.displayName)) return false
      this.recoveryHandles.add(recovery.recoveryHandle)
      return true
    } finally {
      this.recoveryPaused = false
    }
  }

  private failed(result: Exclude<DesktopResult, { status: 'ok' } | { status: 'cancelled' }>): false {
    this.error = result.message
    this.conflict = result.status === 'conflict' || result.code === 'CONFLICT' || result.code === 'WORKSPACE_CONFLICT'
    this.publish()
    this.editor.notify(this.conflict
      ? `文件已被外部修改。当前画布已保留，请另存为，或重新打开磁盘文件：${result.message}`
      : `操作失败，当前画布已保留：${result.message}`)
    return false
  }

  private scheduleRecovery() {
    clearTimeout(this.recoveryTimer)
    if (this.pristineBlankGeneration === this.generation) return
    this.recoveryTimer = setTimeout(() => { void this.updateRecovery() }, 600)
  }

  private updateRecovery(discardSnapshot?: number) {
    clearTimeout(this.recoveryTimer)
    // Compute the snapshot when this queued operation starts, not before an older write finishes.
    const next = this.recoveryQueue.then(async () => {
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
          this.editor.notify(`恢复副本写入失败；请手动保存设计：${result.message}`)
        this.recoveryError = result.message
      } else {
        this.recoveryError = undefined
        const warning = result.status === 'ok' ? result.warning : undefined
        if (warning && this.recoveryWarning !== warning)
          this.editor.notify(`恢复副本已写入，但持久化确认有警告：${warning}；请手动保存设计`)
        this.recoveryWarning = warning
        this.publish()
      }
    }).catch((error: unknown) => {
      this.editor.notify(`恢复副本写入失败；请手动保存设计：${String(error)}`)
    })
    this.recoveryQueue = next
    return next
  }
}
