/** Capability-only bridge. Native paths, Node and raw IPC never enter the renderer. */
export type DesktopResult<T = Record<never, never>> =
  | ({ status: 'ok'; warning?: string } & T)
  | { status: 'cancelled' }
  | { status: 'error' | 'conflict'; code: string; message: string }
export type DesktopFile = { pendingCount?: number; handle: string; displayName: string; documentJson?: string; warning?: string }
export type DesktopFont = { id: string; family: string; style: string; postscript: string; index: number; sourceIndex?: number }
export type DesktopFontData = { font: DesktopFont; data: string; index: number; sourceIndex: number; extracted: boolean }
export type DesktopCommand = 'settings' | 'copy-properties'|'paste-properties'|'select-matching'|'select-inverse'| 'open' | 'openPending' | 'save' | 'saveAs' | 'new' | 'new-page' | 'recover' | 'zoomIn' | 'zoomOut' | 'zoom100' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'copy-as-png' | 'copy-as-svg' | 'paste-to-replace' | 'paste-in-place' | 'paste-over-selection' | 'select-all' | 'duplicate' | 'group' | 'ungroup' | 'delete' | 'zoom-fit' | 'zoom-selection' | 'center-selection'
export type CatalogProject = { id: string; name: string; updatedAt: number }
export type CatalogDirectory = { id: string; projectId: string; displayName: string; updatedAt: number; directoryHandle?: string; requiresReselection: boolean }
export type CatalogFile = { id: string; directoryId: string; relativePath: string; size: number; modifiedAt: number; indexedAt: number }
export type WorkspaceDocument = {
  id: string; name: string; revision: number; hash: string; updatedAt: number; deleted: boolean
}
export type WorkspaceOpened = WorkspaceDocument & { documentJson: string }
export type WorkspaceRootSelection = { selectionId: string; displayName: string; isDefault: boolean }
export interface WorkspaceRootBridge {
  status(): Promise<DesktopResult<{ displayName: string; isDefault: boolean; canSwitch: boolean }>>
  select(): Promise<DesktopResult<WorkspaceRootSelection>>
  useDefault(): Promise<DesktopResult<WorkspaceRootSelection>>
  /** Requests the existing native close handshake; activation occurs only after approval. */
  activate(request: { selectionId: string }): Promise<DesktopResult<{ restarting: boolean }>>
}
export interface WorkspaceBridge {
  list(request?: { includeDeleted?: boolean }): Promise<DesktopResult<{ documents: WorkspaceDocument[] }>>
  open(request: { id: string; revision?: number }): Promise<DesktopResult<WorkspaceOpened>>
  commit(request: { documentJson: string; expectedRevision: number | null; mutationId: string }): Promise<DesktopResult<WorkspaceDocument>>
  trash(request: { id: string; expectedRevision: number; mutationId: string; deleted?: boolean }): Promise<DesktopResult<WorkspaceDocument>>
  revisions(request: { id: string; beforeRevision?: number }): Promise<DesktopResult<{ revisions: WorkspaceDocument[]; hasMore?: boolean; nextBeforeRevision?: number }>>
  restore(request: { id: string; revision: number; expectedRevision: number; mutationId: string }): Promise<DesktopResult<WorkspaceOpened>>
}
export type DesktopClipboard = { forma?: string; text?: string; svg?: string; image?: string }
export type SketchSessionOwner = Readonly<{ kernel_id: 'sketch'; document_schema: 'sketch-native-v1'; document_id: string; session_epoch: number }>
export type SketchSessionStatus = Readonly<{ owner: SketchSessionOwner; active: boolean; revision: number; savedRevision: number; saveUncertain: boolean; dirty: boolean; undoCount: number; redoCount: number; layers: { id: string; name: string; pageId: string; depth: number }[]; layersTruncated: boolean; persistence: 'memory-only-unsaved' | 'native-file-saved' }>
export type SketchNativeFrame = { x: number; y: number; width: number; height: number }
export type SketchTextTargets = { owner: SketchSessionOwner; revision: number; instanceId: string; targets: { targetPath: string; layerId: string }[] }
export type SketchTextValue = { owner: SketchSessionOwner; revision: number; instanceId: string; targetPath: string; explicitText: string | null; masterText: string | null }
export type SketchTextOverride = { instanceId: string; targetPath: string; text: string }
export type SketchLeafFrameStatus = { owner: SketchSessionOwner; revision: number; layerId: string; frame: SketchNativeFrame | null; reason: string | null }
export interface SketchSessionBridge {
  textTargets(request: { owner: SketchSessionOwner; expectedRevision: number; instanceId: string }): Promise<DesktopResult<SketchTextTargets>>
  textValue(request: { owner: SketchSessionOwner; expectedRevision: number; instanceId: string; targetPath: string }): Promise<DesktopResult<SketchTextValue>>
  resizeLegacyContainer(request: { owner: SketchSessionOwner; expectedRevision: number; layerId: string; width: number; height: number }): Promise<DesktopResult<SketchSessionStatus>>
  setTextOverride(request: { owner: SketchSessionOwner; expectedRevision: number } & SketchTextOverride): Promise<DesktopResult<SketchSessionStatus>>
  leafFrame(request: { owner: SketchSessionOwner; expectedRevision: number; layerId: string }): Promise<DesktopResult<SketchLeafFrameStatus>>
  setLeafFrame(request: { owner: SketchSessionOwner; expectedRevision: number; layerId: string } & SketchNativeFrame): Promise<DesktopResult<SketchSessionStatus>>
  preview(request: { owner: SketchSessionOwner; expectedRevision: number; pageId: string }): Promise<DesktopResult<import('../../design-desktop/src/sketch-preview-contract.mjs').SessionPreview>>
  saveAs(request: { owner: SketchSessionOwner; expectedRevision: number }): Promise<DesktopResult<SketchSessionStatus & { displayName: string; saveWarning?: string }>>
  status(request: { owner: SketchSessionOwner }): Promise<DesktopResult<SketchSessionStatus>>
  undo(request: { owner: SketchSessionOwner; expectedRevision: number }): Promise<DesktopResult<SketchSessionStatus>>
  redo(request: { owner: SketchSessionOwner; expectedRevision: number }): Promise<DesktopResult<SketchSessionStatus>>
  open(): Promise<DesktopResult<SketchSessionStatus & { displayName: string }>>
  rename(request: { owner: SketchSessionOwner; expectedRevision: number; layerId: string; name: string }): Promise<DesktopResult<SketchSessionStatus>>
  close(request: { owner: SketchSessionOwner; expectedRevision: number; discard: boolean }): Promise<DesktopResult>
}
export type LargeDocumentOwner = Readonly<{documentId:string;sessionEpoch:number}>
export type LargeDocumentStatus = Readonly<{owner:LargeDocumentOwner;revision:number;name:string;format:'json'|'sketch';expandedBytes:number;maxExpandedBytes:number;indexedObjects:number;dirty:boolean;undoCount:number;redoCount:number;saveWarning?:string}>
export type LargeDocumentRequest = {owner:LargeDocumentOwner;expectedRevision:number}
export type LargeDocumentRow = {key:string;id:string;name:string;kind:string;bytes:number;part:string;hasChildren:boolean}
export interface LargeDocumentBridge {
  progress():Promise<DesktopResult<{phase:string;processedBytes:number;totalBytes:number}>>
  cancel():Promise<DesktopResult<{requested:number;running:boolean;cancelled:boolean}>>
  open():Promise<DesktopResult<LargeDocumentStatus>>
  openFile(file:File):Promise<DesktopResult<LargeDocumentStatus>>
  children(request:LargeDocumentRequest&{key?:string;offset?:number;limit?:number;query?:string}):Promise<DesktopResult<{items:LargeDocumentRow[];total:number;hasMore:boolean}>>
  read(request:LargeDocumentRequest&{key:string}):Promise<DesktopResult<{key:string;json:string;hash:string;omittedFields:string[]}>>
  apply(request:LargeDocumentRequest&{key:string;json:string;expectedHash:string}):Promise<DesktopResult<LargeDocumentStatus>>
  project(request:LargeDocumentRequest&{key:string}):Promise<DesktopResult<{key:string;json:string;warnings:string[]}>>
  scene(request:LargeDocumentRequest&{key:string}):Promise<DesktopResult<{key:string;json:string;warnings:string[];nodes:number;bytes:number}>>
  sceneCommit(request:LargeDocumentRequest&{key:string;json:string}):Promise<DesktopResult<LargeDocumentStatus>>
  commitCanvas(request:LargeDocumentRequest&{key:string;json:string}):Promise<DesktopResult<LargeDocumentStatus>>
  undo(request:LargeDocumentRequest):Promise<DesktopResult<LargeDocumentStatus>>
  redo(request:LargeDocumentRequest):Promise<DesktopResult<LargeDocumentStatus>>
  export(request:LargeDocumentRequest):Promise<DesktopResult<LargeDocumentStatus&{exported:true;displayName:string}>>
  close(request:LargeDocumentRequest):Promise<DesktopResult>
}
export type LocalPeer={id:string;name:string;documentId:string;pageId:string;view:[number,number,number];cursor:[number,number]|null;selection:string[]}
export type NativeRenderReply<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
/** design-kernel `GpuMemoryBreakdown` serde camelCase 导出(E6 四桶台账)。 */
export type NativeGpuMemoryBreakdown = {
  textureBytes: number; bufferBytes: number; fixedArrayBytes: number; blobBytes: number
  peakTextureBytes: number; peakBufferBytes: number; peakFixedArrayBytes: number; peakBlobBytes: number
  peakTotalBytes: number; totalBytes: number; limitBytes: number
  needsFree: boolean; freeEvents: number; rejections: number
}
export type NativeRenderFrameOptions = {
  pageId: string; width: number; height: number
  view: { x: number; y: number; zoom: number }
  transparent?: boolean; rasterProfile?: string
}
export type NativeRenderFrameStats = {
  frames: number; unchanged_frames: number; tiles_rasterised: number; tiles_cached: number
  full_frames: number; render_ms: number
  backend?: string; last_render_ms?: number; draw_calls?: number; submissions?: number
  peak_texture_bytes?: number; gpu_memory?: NativeGpuMemoryBreakdown
}
export type NativeRenderFramePayload =
  | { rgba: string; encoding?: undefined }
  | { rgba: Uint8Array; encoding: 'rgba8' }
export interface NativeRenderBridgeApi {
  load(documentJson: string): Promise<NativeRenderReply>
  frame(options: NativeRenderFrameOptions, pan?: number): Promise<NativeRenderReply<{ width: number; height: number; stats: NativeRenderFrameStats } & NativeRenderFramePayload>>
  stop(): Promise<NativeRenderReply>
  stats(): Promise<NativeRenderReply<{ stats: { gpu_memory?: NativeGpuMemoryBreakdown } }>>
}
export interface DesktopBridge {
  onPetStatus?(callback: (status: import('./desktop-pet').PetStatus) => void): () => void
  petConfigure?(mode: import('./desktop-pet').PetMode): Promise<unknown>
  petEvent?(event: import('./desktop-pet').PetEvent): Promise<unknown>
  readonly automation?: import('./automation/bridge').DesktopAutomationTransport
  readonly documentCodec?: { readonly decoding?: 'json-parse-v1'; readonly encoding?: 'json-stringify-v1'; encode(document: unknown): Promise<string>; decode(json: string): Promise<unknown> }
  readonly preparation?: {
    open(): Promise<string>
    request(session: string, request: { lane: string; method: string; args: unknown[]; diagnostics?: { originChannelId: number; requestId: number; preparationId: number } }): Promise<import('./kernel/preparation-channel').PreparationReply>
    close(session: string): Promise<void>
  }
  readonly sketchSession?: SketchSessionBridge
  readonly largeDocument?: LargeDocumentBridge
  readonly live?: {
    initial():Promise<DesktopResult<{documentId:string|null;sessionId:string}>>
    observe(value:{documentId:string;pageId:string;view:[number,number,number];cursor:[number,number]|null;selection:string[];viewHash:string}):Promise<DesktopResult<{viewHash:string;changed:boolean;peers:LocalPeer[];documents:WorkspaceDocument[]|null}>>
    openWindow(value:{id:string}):Promise<DesktopResult<{windowId:string}>>
  }
  setInterfaceLocale?(locale: 'zh-CN' | 'en'): Promise<DesktopResult>
  rendererReady?(): Promise<DesktopResult>
  performTextCommand?(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<DesktopResult>
  readonly fonts?: {
    list(): Promise<DesktopResult<{ fonts: DesktopFont[]; truncated: boolean; skippedCollections: number }>>
    read(request: { id: string }): Promise<DesktopResult<DesktopFontData>>
  }
  readonly workspaceRoot?: WorkspaceRootBridge
  readonly workspace?: WorkspaceBridge
  readonly clipboard?: { read(): Promise<DesktopResult<DesktopClipboard>>; write(value: DesktopClipboard): Promise<DesktopResult> }
  readonly version: 1
  readonly documentCapacity?: Readonly<{ memoryBytes: number }>
  readonly renderPolicy: Readonly<{ cpuOnly: boolean; gpuWorkingBudgetMiB?: number }>
  readonly nativeRender?: NativeRenderBridgeApi
  nativeRenderStats?(): Promise<string | null>
  listCatalog(): Promise<DesktopResult<{ projects: CatalogProject[]; directories: CatalogDirectory[]; files: CatalogFile[] }>>
  selectCatalogDirectory(): Promise<DesktopResult<{ project: CatalogProject; directory: CatalogDirectory }>>
  scanCatalogDirectory(request: { directoryHandle: string }): Promise<DesktopResult<{ directoryId: string; files: CatalogFile[]; truncated: boolean }>>
  openCatalogFile(request: { directoryHandle: string; fileId: string }): Promise<DesktopResult<DesktopFile>>
  openPendingDocument?(): Promise<DesktopResult<DesktopFile>>
  openDocument(): Promise<DesktopResult<DesktopFile>>
  inspectSketch?(): Promise<DesktopResult<import('./sketch-inspection').SketchInspection>>
  acceptDocument(request: { handle: string }): Promise<DesktopResult>
  saveDocument(request: {
    handle?: string
    documentJson: string
    saveAs?: boolean
  }): Promise<DesktopResult<DesktopFile>>
  readRecovery(): Promise<DesktopResult<{ documentJson: string; displayName: string; recoveryHandle: string }>>
  acceptRecovery(request: { recoveryHandle: string }): Promise<DesktopResult>
  writeRecovery(request: {
    documentJson: string
    displayName?: string
    handle?: string
  }): Promise<DesktopResult>
  clearRecovery(request?: { recoveryHandle?: string }): Promise<DesktopResult>
  setDirty(dirty: boolean): Promise<void>
  onCommand(callback: (command: DesktopCommand) => void): () => void
  onCloseRequested(callback: (request: { requestId: string }) => void): () => void
  respondToClose(response: { allow: boolean; requestId: string }): Promise<{ accepted: boolean }>
}
declare global {
  interface Window {
    readonly coreDesktop?: DesktopBridge
  }
}
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' && window.coreDesktop?.version === 1
    ? window.coreDesktop
    : undefined
}
// Desktop-only opt-in native render session (design-render serve mode over
// the bridge above). Imported for its side effect: it registers the dev probe
// entry and runs it only when explicitly enabled; web/test hosts without
// coreDesktop.nativeRender evaluate to a no-op. It consumes only this
// capability bridge — no native paths, Node or raw IPC enter the renderer.
import './kernel/native-render-session'
