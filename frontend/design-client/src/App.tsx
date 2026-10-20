import { FramePresetPanel } from './FramePresetPanel'
import { LocalHome, HomeCanvasGate } from './LocalHome'
import { localHomeSource, admitHomeDocumentCommand } from './local-home-source'
import { ownedPropertyPreviewTarget } from './property-preview'
import { hasCanvasColorPicker } from './canvas-color-picker'
import { appendImageFiles, captureImageImportAnchor, StaleImageImport } from './append-image-files'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { ShapeBuilderDialog } from './ShapeBuilderDialog'
import { recordLocalError } from './local-diagnostics'
import { keyboardNudgeActive, keyboardNudgeOwnsKey } from './keyboard-nudge-gesture'
import { BatchRenameDialog } from './BatchRenameDialog'
import { NativeSketchDialog } from './NativeSketchDialog'
import { nativeSketchCapabilities } from './native-sketch-capabilities'
import { alignmentAvailability, alignSelection } from './alignment-availability'
import { SettingsDialog } from './SettingsDialog'
import { PanelResizeHandle, useAdaptivePanels } from './AdaptivePanels'
import { interfaceText, interfacePreference } from './interface-preference'
import { bindEditorSettings } from './settings-preference'
import { WorkspaceRootControls, chooseWorkspaceRoot } from './WorkspaceRootControls'
import { useShortcutProfile } from './shortcut-preference'
import { shortcutPlatform, toolShortcutLabel, shortcutLabel, formatShortcutCombo } from './shortcut-profiles'
import { shortcutTargetOwnsKeyboard } from './editor-shortcuts'
import { AutomationPanel } from './AutomationPanelLauncher'
import { attachDesktopAutomation } from './automation/bridge'
import { createWorkspaceAutomationRenderer } from './automation/workspace-bridge'
import { createAutomationSettingsAdapter } from './automation/settings-adapter'
import {activateTool} from './tool-activation'
import { readStartupPreview, writeStartupPreview, type StartupPreview, type PreviewPixels } from './startup-preview'
import {useLocalWindows,LocalWindowControl} from './LocalWindows'
import {boardToolNames,type BoardTool} from './board-tools'
import { ReviewsPanel } from './ReviewsPanel'
import { utilityToolNames } from './utility-tools'
import { WorkspaceTabs } from './WorkspaceTabs'
import { PendingEditContext } from './pending-edit-context'
import { cancelPendingOperations, commitPendingEdits, hasPendingEdits, pendingEditsChanged, registerPendingEdit } from './pending-edits'
import { modalOwnsKeyboard } from './modal-keyboard'
import { DesignTools } from './DesignTools'
import { WorkspaceRail, DesignToolbar, ToolPopover, type WorkspaceSection } from './EditorChrome'
import { PrototypePlayer } from './PrototypePlayer'
import { WorkspaceLibrary } from './WorkspaceLibrary'
import { DocumentHistoryDialog } from './DocumentHistoryDialog'
import { ImportNotice } from './ImportNotice'
import { dispatchEditorCommand, editorCommands, type EditorCommand } from './editor-commands'
import { TOOL_COMMANDS, unavailableReason } from './tool-registry'
import { canvasMenuItems } from './canvas-menu-model'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import {
  Settings as SettingsIcon,
  MousePointer2,
  Scaling,
  Hand,
  ZoomIn,
  Frame,
  Square,
  Circle,
  Triangle,
  Star,
  Minus,
  ArrowUpRight,
  PenTool,
  Pencil,
  Brush,
  Type,
  Eraser,
  Pipette,
  PaintBucket,
  Ruler,
  Slice,
  Crop,
  MessageSquare,
  Undo2,
  Redo2,
  ChevronDown,
  Download,
  Save,
  FolderOpen,
  Plus,
  ArrowUpToLine,
  ArrowDownToLine,
  AlignLeft,
  AlignCenterHorizontal,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Scan,
  Layers as LayersIcon,
  Combine,
  Scissors,
  Diamond,
  VectorSquare,
  Check,
  HelpCircle,
  Play,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { Editor, type Tool } from './engine'
import { desktopBridge, type DesktopCommand } from './desktop'
import { DesktopCatalog } from './DesktopCatalog'
import { DesktopLeaveDialog } from './DesktopLeaveDialog'
import { DesktopSession, type DesktopStatus, type LeaveDecision, type LeaveReason } from './desktop-session'
import { blank, demo, uid, copyName, type DesignDocument } from './model'
import {
  localOpen,
  localList,
  localSelect,
  localTrash,
  localSave,
  SaveCoordinator,
  type LocalRecord,
  type LocalEntry,
} from './local-store'
import { initializePicking } from './kernel/picking'
import { prepareDocument } from './prepared-document'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { AnimationPanel } from './AnimationPanel'
import { ColorPanel } from './ColorPanel'
import { ExportPanel } from './ExportPanel'
import { download, exportDocument, readDesignFile } from './persistence'
import { createImportedCopy } from './import-identity'
import { exportSketchInWorker } from './import-file-worker'
import { ImportOwner, importStep, type ImportRequest } from './import-ownership'
import { ExportOwner, commitExportEdits, type ExportRequest } from './export-ownership'
const toolItems: { id: Tool; label: string; icon: typeof Square }[] = [
  { id: 'select', label: '选择', icon: MousePointer2 },
  { id: 'hand', label: '平移', icon: Hand },
  { id: 'zoom', label: '区域缩放', icon: ZoomIn },
  { id: 'scale', label: '缩放', icon: Scaling },
  { id: 'slice', label: '切片', icon: Scan },
  { id: 'frame', label: '画板', icon: Frame },
  { id: 'section', label: '分区', icon: Scan },
  { id: 'rectangle', label: '矩形', icon: Square },
  { id: 'ellipse', label: '椭圆', icon: Circle },
  { id: 'polygon', label: '多边形', icon: Triangle },
  { id: 'star', label: '星形', icon: Star },
  { id: 'line', label: '直线', icon: Minus },
  { id: 'arrow', label: '箭头', icon: ArrowUpRight },
  { id: 'pen', label: '钢笔', icon: PenTool },
  { id: 'pencil', label: '铅笔', icon: Pencil },
  { id:'marker',label:'马克笔',icon:Brush },
  { id:'washi-tape',label:'和纸胶带',icon:Brush },
  { id: 'brush', label: '画笔', icon: Brush },
  { id: 'text', label: '文字', icon: Type },
]
const utilityToolItems: { id: Tool; label: string; icon: typeof Square }[] = [
  { id: 'eraser', label: '橡皮', icon: Eraser },
  { id: 'eyedropper', label: '吸管', icon: Pipette },
  { id: 'paint-bucket', label: '油漆桶', icon: PaintBucket },
  { id: 'measure', label: '测量', icon: Ruler },
  { id: 'slice', label: '切片', icon: Slice },
  { id: 'crop', label: '裁切', icon: Crop },
  { id: 'comments', label: '评论', icon: MessageSquare },
]
export default function App() {
  const shortcutProfile = useShortcutProfile()
  const shortcutContext = useMemo(() => ({ profile: shortcutProfile, platform: shortcutPlatform(), desktop: !!desktopBridge() }), [shortcutProfile])
  const tools = useMemo(() => toolItems.map(tool => ({ ...tool, key: toolShortcutLabel(tool.id, shortcutContext) })), [shortcutContext])
  const utilityTools = useMemo(() => utilityToolItems.map(tool => ({ ...tool, key: toolShortcutLabel(tool.id, shortcutContext) })), [shortcutContext])
  const [importReport, setImportReport] = useState<{ documentId: string; warnings: string[] } | null>(null)
  const [showHome, setShowHome] = useState(true)
  const [startupError, setStartupError] = useState('')
  const homeSettingsFocus = useRef<HTMLElement | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [showWorkspaceLibrary, setShowWorkspaceLibrary] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sketchMode, setSketchMode] = useState<'inspect' | 'edit' | null>(null)
  const sketchCapabilities = nativeSketchCapabilities(desktopBridge())
  const [workspaceRootBusy, setWorkspaceRootBusy] = useState(false)
  const workspaceRootPending = useRef(false)
  const fileMenuTrigger = useRef<HTMLButtonElement>(null)
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('layers')
  const [zoomHost, setZoomHost] = useState<HTMLDivElement | null>(null)
  const workspaceActions = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: Event) => { if (workspaceActions.current && !workspaceActions.current.contains(event.target as Node)) workspaceActions.current.open = false }
    const blur = () => { if (workspaceActions.current) workspaceActions.current.open = false }
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur) }
  }, [])
  const [propertiesTab, setPropertiesTab] = useState<'design' | 'prototype'>('design')
  const [showPrototype, setShowPrototype] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const [showShapeBuilder, setShowShapeBuilder] = useState(false)
  const [showMove, setShowMove] = useState(false)
  const [showShapes, setShowShapes] = useState(false)
  const [showRegions, setShowRegions] = useState(false)
  const [showFramePresets, setShowFramePresets] = useState(false)
  const [showDrawing, setShowDrawing] = useState(false)
  const [showUtility, setShowUtility] = useState(false)
  const [lastShapeTool, setLastShapeTool] = useState<Tool>('rectangle')
  const [lastMoveTool, setLastMoveTool] = useState<Tool>('select')
  const [lastRegionTool, setLastRegionTool] = useState<Tool>('frame')
  const [lastDrawingTool, setLastDrawingTool] = useState<Tool>('pen')
  const [lastUtilityTool, setLastUtilityTool] = useState<Tool>('eraser')
  const [showColor, setShowColor] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showAnimation, setShowAnimation] = useState(false)
  const adaptivePanels = useAdaptivePanels()
  const showLayers = adaptivePanels.leftOpen
  const setShowLayers = adaptivePanels.setLeftOpen
  const panelText = interfaceText[adaptivePanels.preferences.locale]
  const [uiMinimized, setUiMinimized] = useState(false)
  const showInspector = adaptivePanels.rightOpen
  const setShowInspector = adaptivePanels.setRightOpen
  const [desktop] = useState(desktopBridge)
  const [editor] = useState(() => new Editor(blank()))
  useEffect(() => desktopPet.bind(editor), [editor])
  useEffect(() => bindEditorSettings(editor), [editor])
  const [exports] = useState(() => new ExportOwner())
  const exportAsset = useSyncExternalStore(exports.subscribe, exports.getSnapshot)
  useLayoutEffect(() => {
    exports.activate(editor)
    return () => exports.dispose()
  }, [editor, exports])
  async function generateExport(format: 'svg' | 'png' | 'visual-svg') {
    const trace = beginEditorAction(editor, CanvasAction.export, ActionSource.menu, 310)
    try {
    let request: ExportRequest | null = null
    try {
      if (!commitExportEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
      request = exports.begin(editor, `menu:${format}`)
      if (!request) { trace.result(ActionOutcome.blocked, ActionReason.busy); return }
      editor.notify('正在生成导出预览…')
      const module = await import('./export')
      if (!request.isCurrent()) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
      const result = format === 'visual-svg'
        ? await module.exportVisualSvg(request.document, request.page)
        : await module.exportImage(request.document, request.page, format, format === 'svg' ? 1 : 2, undefined, request.signal)
      if (exports.publish(request, result)) { trace.result(ActionOutcome.observed); editor.notify('导出文件已生成') } else trace.result(ActionOutcome.cancelled, ActionReason.superseded)
    } catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation);
      if (!request || request.isCurrent()) { desktopPet.event('error'); editor.notify(String(error)) }
    } finally { if (request) exports.finish(request) }
    } finally { trace.finish() }
  }
  async function generateSketchExport() {
    const trace = beginEditorAction(editor, CanvasAction.export, ActionSource.menu, 311)
    try {
    if (!commitExportEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
    const request = exports.begin(editor, 'menu:sketch')
    if (!request) { trace.result(ActionOutcome.blocked, ActionReason.busy); return }
    setMenu(false)
    try {
      editor.notify('正在生成 Sketch 兼容文件…')
      const bytes = await exportSketchInWorker(request.document, request.signal)
      if (!request.isCurrent()) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
      download(`${request.document.name}.sketch`, new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }))
      trace.result(ActionOutcome.observed)
      desktopPet.event('export')
      editor.notify('Sketch 兼容文件已生成；完整编辑信息请同时保留 .fd 文件')
    } catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation); if (request.isCurrent()) { desktopPet.event('error'); editor.notify(String(error)) } }
    finally { exports.finish(request) }
    } finally { trace.finish() }
  }
  const [fileImports] = useState(() => new ImportOwner())
  const importMode = useRef<'open' | 'append'>('open')
  async function importDesignFile(f: File, mode: 'open' | 'append' = 'open') {
    const trace = beginEditorAction(editor, CanvasAction.import, ActionSource.menu, 312)
    trace.result(ActionOutcome.cancelled, ActionReason.unobserved)
    try {
    if(!ready || switching || desktopStatus.busy || editor.interactionActive){trace.result(ActionOutcome.blocked, ActionReason.busy);editor.notify('请结束当前操作后打开文件');return}
    const request = fileImports.begin(editor)
    try {
      const imported = await importStep(request, () => readDesignFile(f, request.signal))
      request.assertCurrent()
      const document = createImportedCopy(imported.document)
      if (mode === 'append') {
        if (!commitPendingEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
        request.assertCurrent()
        const revision = editor.state.version
        const roots = editor.appendDocument(document)
        trace.result(editor.state.version !== revision ? ActionOutcome.committed : ActionOutcome.unchanged)
        setImportReport(imported.warnings.length ? { documentId: editor.state.doc.id, warnings: imported.warnings } : null)
        editor.notify(`已追加 ${roots.length} 组内容，可整体拖动；撤销可移除此轮导入`)
        return
      }
      const opened = await switchDocument(document, undefined, true, request)
      if (opened) trace.result(ActionOutcome.observed)
      if (opened && request.isLatest() && editor.state.doc.id === document.id && imported.warnings.length) {
        setImportReport({ documentId: document.id, warnings: imported.warnings }); editor.notify('导入完成，可以继续编辑')
      }
    } catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation); if (request.isCurrent()) { desktopPet.event('error'); editor.notify(String(error)) } }
    finally { request.finish() }
    } finally { trace.finish() }
  }
  async function importImageFiles(files: File[]) {
    const trace = beginEditorAction(editor, CanvasAction.import, ActionSource.menu, 313)
    try {
      if (!ready || editor.interactionActive) { trace.result(ActionOutcome.blocked, ActionReason.notReady); editor.notify('请结束当前操作后导入图片'); return }
      if (!commitPendingEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
      const canvas = document.querySelector<HTMLElement>('[data-testid=canvas]')
      const anchor = captureImageImportAnchor(editor, { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 })
      const result = await appendImageFiles(editor, files, anchor)
      trace.result(result.status === 'committed' ? ActionOutcome.committed : result.status === 'rejected' ? ActionOutcome.rejected : ActionOutcome.unchanged, result.status === 'rejected' ? ActionReason.validation : ActionReason.none)
    } catch (error) {
      trace.result(error instanceof StaleImageImport ? ActionOutcome.cancelled : ActionOutcome.rejected,
        error instanceof StaleImageImport ? ActionReason.superseded : ActionReason.validation)
      editor.notify(error instanceof StaleImageImport ? error.message : `图片导入失败: ${String(error)}`)
    } finally { trace.finish() }
  }
  const switchLifetime = useRef(0)
  useEffect(() => {
    switchLifetime.current++
    fileImports.activate()
    return () => {
      switchLifetime.current++
      switchGate.current = null
      fileImports.dispose()
    }
  }, [fileImports])
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus>({
    dirty: true, busy: false, transitioning: false, operation: 'idle', conflict: false,
  })
  const [desktopPrompt, setDesktopPrompt] = useState<{
    reason: LeaveReason; resolve: (decision: LeaveDecision) => void
  } | null>(null)
  const [desktopSession] = useState(() => desktop ? new DesktopSession(
    desktop, editor,
    (reason) => new Promise<LeaveDecision>((resolve) => setDesktopPrompt({ reason, resolve })),
    setDesktopStatus,
  ) : undefined)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  useEffect(() => { if (s.renamingLayer) { setShowLayers(true); setUiMinimized(false); setWorkspaceSection('layers') } }, [s.renamingLayer])
  useEffect(() => {
    if (['select', 'hand', 'scale', 'zoom'].includes(s.tool)) setLastMoveTool(s.tool)
    if (['frame', 'section', 'slice'].includes(s.tool)) setLastRegionTool(s.tool)
    if (['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star'].includes(s.tool)) setLastShapeTool(s.tool)
    if (['pen', 'pencil', 'brush', 'marker', 'washi-tape'].includes(s.tool)) setLastDrawingTool(s.tool)
    if (utilityTools.some(({ id }) => id === s.tool)) setLastUtilityTool(s.tool)
  }, [s.tool])
  useEffect(() => {
    const minimize = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.keyCode === 229 || (shortcutPlatform() === 'mac' ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) || !event.shiftKey || event.code !== 'Backslash' ||
          event.altKey || event.isComposing || editor.interactionActive || hasPendingEdits(editor) || modalOwnsKeyboard(event.target) ||
          (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable],[role="menu"]')) return
      event.preventDefault()
      setUiMinimized(value => !value)
    }
    window.addEventListener('keydown', minimize)
    return () => window.removeEventListener('keydown', minimize)
  }, [editor])
  const [ready, setReady] = useState(false),
    [saved, setSaved] = useState('载入中'),
    [menu, setMenu] = useState(false)
  const [startupPreview, setStartupPreview] = useState<StartupPreview>()
  const [localFiles, setLocalFiles] = useState<LocalEntry[] | null>(null)
  const [switching, setSwitching] = useState(false)
  const switchGate = useRef<object | null>(null)
  const [saver] = useState(
    () =>
      new SaveCoordinator(undefined, (status) => {
        setSaved(status.error ? '本地保存失败' : status.dirty ? '保存中…' : '已保存到本机')
        if (status.error) editor.notify(`保存失败，当前画布已保留：${status.error}`)
      }),
  )
  const file = useRef<HTMLInputElement>(null)
  const capturePreview = useCallback(async (document: DesignDocument, version: number, pixels: PreviewPixels) => {
    // A property preview may begin while the bitmap/encoding promise is pending.
    // Do not label its pixels as a durable authored revision or startup preview.
    const authored = () => !editor.propertyPreviewActive && editor.authoredDocument === document && editor.state.version === version
    if (!authored()) return
    if (saver.durableRevision(document.id, version) === undefined) await saver.save(document, version)
    const revision = saver.durableRevision(document.id, version)
    if (revision !== undefined && authored()) await writeStartupPreview({ ...pixels, documentId: document.id, revision })
  }, [saver, editor])
  const localWindows=useLocalWindows(editor,desktopSession,ready)
  useEffect(() => {
    const input = file.current
    const onCancel = () => fileImports.invalidate()
    input?.addEventListener('cancel', onCancel)
    return () => input?.removeEventListener('cancel', onCancel)
  })
  const titleComposing = useRef(false)
  useEffect(() => registerPendingEdit(editor, {
    dirty: () => titleComposing.current,
    commit: () => !titleComposing.current,
  }), [editor])
  useEffect(() => {
    let active = true
    if (desktopSession) {
      void initializePicking().then(async () => {
        if (!active) return
        await desktopSession.start()
        if (active) setReady(true)
      }).catch((e) => {
        if (active) { setStartupError(`设计内核载入失败：${String(e)}`); editor.notify(`设计内核载入失败：${String(e)}`) }
      })
      return () => { active = false; desktopSession.dispose() }
    }
    const startup = editor.state.doc
    const startupSession = editor.sessionGeneration
    const preview = readStartupPreview().then(value => {
      if (active) setStartupPreview(value)
      return value
    }).catch(error => { recordLocalError('storage', error, 'STORAGE_ERROR'); console.warn('[startup-preview] 读取预览失败', error); return undefined })
    Promise.all([initializePicking(), localOpen(), preview])
      .then(([, record, preview]) => {
        if (!active) return
        if (record && editor.state.doc === startup && editor.sessionGeneration === startupSession && !hasPendingEdits(editor)) {
          const restoreView = interfacePreference.getSnapshot().rememberViewport && preview?.documentId === record.document.id && preview.revision === record.revision && record.document.pages.some(p => p.id === preview.pageId)
          if (editor.load(record.document)) {
            if (restoreView && !editor.restoredCamera) {
              editor.preservedViewSession = editor.sessionGeneration
              editor.set({ page: preview.pageId, view: preview.view })
            }
            else setStartupPreview(undefined)
            saver.open(record, editor.state.version)
          }
        }
        setReady(true)
      })
      .catch((e) => {
        if (!active) return
        recordLocalError('workspace', e, 'STORAGE_ERROR')
        setSaved('本地恢复失败')
        setStartupError('本地恢复失败，文档操作和自动保存已暂停。')
        editor.notify(`本地恢复失败，自动保存已暂停：${e.message}`)
      })
    return () => {
      active = false
    }
  }, [editor, desktopSession, saver])
  useEffect(() => {
    if (!ready || desktopSession) return
    const snapshot = editor.authoredDocument
    saver.observe(snapshot, s.version)
    if (!saver.dirty) return
    const timer = setTimeout(() => {
      void saver
        .save(snapshot, s.version)
        .then(async () => {
          if (editor.state.doc.id === snapshot.id) await localSelect(snapshot.id)
        })
        .catch((e) => { recordLocalError('workspace', e, 'STORAGE_ERROR'); editor.notify(String(e)) })
    }, 350)
    return () => clearTimeout(timer)
  }, [s.version, ready, desktopSession])
  useEffect(() => {
    if (desktopSession) return
    const unload = (e: BeforeUnloadEvent) => {
      if (saver.dirty || hasPendingEdits(editor)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [saved, desktopSession, saver, editor])
  async function switchDocument(
    document: DesignDocument,
    record?: LocalRecord,
    preserveCurrent = true,
    request?: ImportRequest,
  ) {
    const trace = beginEditorAction(editor, CanvasAction.import, ActionSource.lifecycle, 314)
    trace.result(ActionOutcome.cancelled, ActionReason.unobserved)
    try {
    if (request && !request.isCurrent()) return false
    if (!editor.settleOwnedPropertyPreview('navigation')) return false
    if (desktopSession ? desktopSession.status.busy : (!ready || switchGate.current || !commitPendingEdits(editor))) return false
    const adoption = request || fileImports.begin(editor)
    if (!adoption.isCurrent()) return false
    if (desktopSession) {
      const opened = await desktopSession.replace(document, adoption.isCurrent)
      if (opened && adoption.isLatest()) setMenu(false)
      if (opened) { trace.result(ActionOutcome.observed); setShowHome(false) }
      return opened
    }
    cancelPendingOperations(editor)
    const operation = {}
    const lifetime = switchLifetime.current
    let expectedSession = editor.sessionGeneration
    const ownsSession = () => switchLifetime.current === lifetime &&
      editor.sessionGeneration === expectedSession && adoption.isLatest()
    switchGate.current = operation
    setSwitching(true)
    try {
      await initializePicking()
      if (!adoption.isCurrent()) return false
      const current = editor.state
      const generation = editor.sessionGeneration
      if (ready && preserveCurrent) await saver.save(current.doc, current.version)
      if (!adoption.isCurrent()) return false
      if (editor.state.doc !== current.doc)
        throw new Error('保存期间内容已变化，请再次打开；当前修改已保留')
      const latest = await localOpen(document.id)
      if (!adoption.isCurrent()) return false
      const openingLocal = record && JSON.stringify(record.document) === JSON.stringify(document)
      if (openingLocal && latest) document = latest.document
      const prepared = prepareDocument(document)
      document = prepared.snapshot()
      if (latest && !openingLocal && JSON.stringify(latest.document) !== JSON.stringify(document)) {
        await localSave({
          ...latest.document,
          id: uid(),
          name: copyName(latest.document.name, ' 本机备份'),
        })
      }
      if (!adoption.isCurrent()) return false
      const next =
        latest && JSON.stringify(latest.document) === JSON.stringify(document)
          ? latest
          : await localSave(document, latest?.revision || 0)
      if (editor.state.doc !== current.doc || editor.sessionGeneration !== generation || hasPendingEdits(editor) || !adoption.isCurrent())
        throw new Error('打开期间内容已变化，当前修改已保留；请重试')
      // Only publish a new editing session after validation and durable storage.
      if (!editor.load(prepared)) return false
      expectedSession = editor.sessionGeneration
      saver.open(next, editor.state.version)
      await localSelect(document.id)
      if (!ownsSession()) return false
      setMenu(false)
      setLocalFiles(null)
      setShowHome(false)
      setReady(true)
      trace.result(ActionOutcome.observed)
      return true
    } catch (e) {
      trace.result(ActionOutcome.rejected, ActionReason.validation)
      recordLocalError('workspace', e, 'STORAGE_ERROR')
      if (ownsSession()) editor.notify(String(e))
      return false
    } finally {
      if (switchGate.current === operation) {
        switchGate.current = null
        if (switchLifetime.current === lifetime) setSwitching(false)
      }
    }
    } finally { trace.finish() }
  }
  async function trashLocalFile(id: string, deleted: boolean) {
    const trace = beginEditorAction(editor, CanvasAction.delete, ActionSource.menu, deleted ? 330 : 331)
    try { await localTrash(id, deleted); trace.result(ActionOutcome.observed); await openLocalFiles() }
    catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation); recordLocalError('workspace', error, 'STORAGE_ERROR'); editor.notify(String(error)) }
    finally { trace.finish() }
  }
  async function openLocalFiles() {
    fileImports.invalidate()
    try {
      setLocalFiles(await localList())
      setMenu(false)
    } catch (e) {
      recordLocalError('workspace', e, 'STORAGE_ERROR')
      editor.notify(String(e))
    }
  }
  useEffect(() => {
    if (!ready || !desktop?.automation) return
    const preferences = createAutomationSettingsAdapter(editor)
    const host = createWorkspaceAutomationRenderer(editor, {
      inspect: () => ({ storageRevision: desktopSession?.status.revision ?? null,
        dirty: desktopSession?.dirty ?? true, busy: desktopSession?.status.busy ?? false }),
      execute: (method, params, guard, signal) => {
        if (method === 'settings.get') return preferences.get()
        if (method === 'settings.update') return preferences.update(params, guard, signal)
        if (!desktopSession) throw Object.assign(new Error('Local workspace session is unavailable'), { code: 'WORKSPACE_UNAVAILABLE' })
        return desktopSession.automationWorkspace(method, params, guard, signal)
      },
    })
    const detach = attachDesktopAutomation(editor, desktop.automation, { host })
    return () => { detach(); preferences.dispose() }
  }, [ready, desktop, editor, desktopSession])
  useEffect(() => {
    if (ready && desktop?.rendererReady) void desktop.rendererReady().then(result => {
      if (result.status === 'error' || result.status === 'conflict') editor.notify(result.message)
    }).catch(error => editor.notify(String(error)))
  }, [ready, desktop, editor])
  const openSettings = useCallback(() => {
    if ((!ready && !showHome) || switching || (desktopStatus.transitioning && ready) || editor.interactionActive || modalOwnsKeyboard(document.activeElement)) return
    if (!commitPendingEdits(editor)) return
    setMenu(false)
    setShowSettings(true)
  }, [ready, switching, desktopStatus.transitioning, editor, showHome])
  useEffect(() => {
    const command = (name: DesktopCommand) => {
      if (name === 'settings') { openSettings(); return }
      if (showHome) {
        if (!admitHomeDocumentCommand(name, { ready, switching, busy: desktopStatus.busy,
          transitioning: desktopStatus.transitioning, interactionActive: editor.interactionActive,
          modalOwnsFocus: modalOwnsKeyboard(document.activeElement) })) return
        if (!commitPendingEdits(editor)) return
        if (name === 'new') void switchDocument(blank())
        else if (name === 'open') void openHomeFile().then(result => { if (result === true) resumeEditor() }).catch(error => editor.notify(String(error)))
        else if (name === 'openPending' && desktopSession) void desktopSession.openPending().then(opened => { if (opened) resumeEditor() }).catch(error => editor.notify(String(error)))
        return
      }
      if (!ready || !desktopSession) return
      // Native editor/text commands retain the dispatcher's focused-input routing.
      // File commands must not act on the .fd document behind an independent modal.
      if (['open', 'openPending', 'new', 'recover', 'save', 'saveAs'].includes(name) && modalOwnsKeyboard(document.activeElement) &&
        !ownedPropertyPreviewTarget(editor, document.activeElement)) return
      // Electron can consume the DOM shortcut before Canvas sees it. Complete
      // only our keyboard-owned edit, never another pending pointer gesture.
      if (keyboardNudgeActive(editor) && !commitPendingEdits(editor)) return
      if (name === 'open' || name === 'openPending' || name === 'new' || name === 'recover') fileImports.invalidate()
      setMenu(false)
      if (name === 'open') void desktopSession.open()
      else if (name === 'openPending') void desktopSession.openPending()
      else if (name === 'save') void desktopSession.save()
      else if (name === 'saveAs') void desktopSession.save(true)
      else if (name === 'new') void desktopSession.replace(blank())
      else if (name === 'recover') void desktopSession.recover()
      else if (editorCommands.includes(name as EditorCommand)) void dispatchEditorCommand(editor, name as EditorCommand)
    }
    const shortcut = (e: KeyboardEvent) => {
      const settingsMod = shortcutPlatform() === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (settingsMod && e.key === ',' && !e.shiftKey && !e.altKey && !e.repeat && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault(); openSettings(); return
      }
      const propertySave = e.key.toLowerCase() === 's' && ownedPropertyPreviewTarget(editor, e.target)
      if (!ready || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.altKey || (shortcutTargetOwnsKeyboard(e.target) && !propertySave)) return
      if (shortcutPlatform() === 'mac' ? (!e.metaKey || e.ctrlKey) : (!e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        if (desktopSession) command(e.shiftKey ? 'saveAs' : 'save')
        else if (editor.settleOwnedPropertyPreview('save') && !editor.interactionActive && commitPendingEdits(editor)) exportDocument(editor.authoredDocument)
      } else if (desktopSession && key === 'o') {
        e.preventDefault(); command('open')
      } else if (desktopSession && key === 'n') {
        e.preventDefault(); command('new')
      }
    }
    window.addEventListener('keydown', shortcut)
    const offCommand = desktop?.onCommand(command)
    const offClose = desktop?.onCloseRequested(({ requestId }) => {
      fileImports.invalidate()
      // Release the settings portal's focus/inert ownership before a dirty
      // document confirmation is rendered in the application root.
      flushSync(() => setShowSettings(false))
      void (ready && desktopSession ? desktopSession.requestClose() : Promise.resolve(false))
        .then(async (approved) => {
          const allow = approved && !!desktopSession?.closeReady
          const response = await desktop.respondToClose({ allow, requestId })
          if (!allow || !response.accepted) desktopSession?.cancelClose()
        })
        .catch((error) => {
          desktopSession?.cancelClose()
          editor.notify(`关闭请求失败，设计已保留：${String(error)}`)
        })
    })
    return () => { window.removeEventListener('keydown', shortcut); offCommand?.(); offClose?.() }
  }, [editor, desktopSession, desktop, ready, fileImports, openSettings, showHome, switching, desktopStatus.busy, desktopStatus.transitioning])
  function resumeEditor() {
    if (!ready) return
    setShowHome(false)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({preventScroll:true}))
  }
  function enterHome() {
    if (!ready || switching || desktopStatus.busy || editor.interactionActive || !commitPendingEdits(editor)) return
    setMenu(false); setShowMove(false); setShowRegions(false); setShowShapes(false); setShowDrawing(false); setShowUtility(false)
    setShowHome(true)
  }
  async function openHomeFile(): Promise<boolean | 'pending'> {
    if (!ready || switching || desktopStatus.busy || editor.interactionActive || !commitPendingEdits(editor)) return false
    fileImports.invalidate()
    if (desktopSession) {
      const opened = await desktopSession.open()
      if (!opened && desktopSession.status.error) throw new Error(desktopSession.status.error)
      return opened
    }
    importMode.current = 'open'
    file.current?.click()
    return 'pending'
  }
  const homeSource = localHomeSource(desktopSession, {
    list: localList,
    open: async id => {
      if (!ready || switching || editor.interactionActive || !commitPendingEdits(editor)) return false
      const request = fileImports.begin(editor)
      try {
        const record = await importStep(request, () => localOpen(id))
        if (!record) throw new Error('本机设计已不存在，请刷新列表')
        const opened = await switchDocument(record.document, record, true, request)
        if (!opened && request.isCurrent()) throw new Error('打开未完成，当前设计已保留')
        return opened
      } finally { request.finish() }
    },
  })
  const focusCanvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
  const chooseTool = (tool: Tool) => { void activateTool(editor,tool);focusCanvas() }
  const openToolbarMenu = (name: 'move' | 'regions' | 'shapes' | 'drawing' | 'commands' | 'utility', open: boolean) => {
    setShowMove(open && name === 'move')
    setShowRegions(open && name === 'regions'); setShowShapes(open && name === 'shapes'); setShowDrawing(open && name === 'drawing'); setShowCommands(open && name === 'commands')
    setShowUtility(open && name === 'utility')
  }
  const action = (label: string, Icon: typeof Square, fn: () => void, disabled = false, menuItem = false) => (
    <button type="button" title={menuItem ? label : undefined} data-tooltip={menuItem ? undefined : label === '撤销' ? `撤销 (${shortcutLabel('undo', shortcutContext)})` : label === '重做' ? `重做 (${shortcutLabel('redo', shortcutContext)})` : label}
      aria-label={label} data-property-preview-undo={label === '撤销' ? '' : undefined} role={menuItem ? 'menuitem' : undefined} tabIndex={menuItem ? -1 : undefined} disabled={disabled}
      onClick={() => { focusCanvas(); fn() }}>
      <Icon size={16} />
    </button>
  )
  const shapeTools = ['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star'].map(id => tools.find(tool => tool.id === id)!)
  const moveTool = tools.find(({ id }) => id === s.tool && ['select', 'hand', 'scale', 'zoom'].includes(id)) || tools.find(({ id }) => id === lastMoveTool)!
  const regionTool = tools.find(({ id }) => id === s.tool && ['frame', 'section', 'slice'].includes(id)) || tools.find(({ id }) => id === lastRegionTool)!
  const shapeTool = shapeTools.find(({ id }) => id === s.tool) || tools.find(({ id }) => id === lastShapeTool)!
  const drawingTool = tools.find(({ id }) => id === s.tool && ['pen', 'pencil', 'brush', 'marker', 'washi-tape'].includes(id)) || tools.find(({ id }) => id === lastDrawingTool)!
  const utilityTool = utilityTools.find(({ id }) => id === s.tool) || utilityTools.find(({ id }) => id === lastUtilityTool)!
  const unavailableTools = TOOL_COMMANDS.filter((c) => !c.tool).filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i)
  const MoveIcon = moveTool.icon, RegionIcon = regionTool.icon, ShapeIcon = shapeTool.icon, DrawingIcon = drawingTool.icon
  const UtilityIcon = utilityTool.icon
  const alignment = alignmentAvailability(editor)
  const toolbarCommands = showCommands || showDrawing ? canvasMenuItems(editor) : []
  const commandDisabled = (command: EditorCommand) => {
    const item = toolbarCommands.find(item => item.command === command)
    return !item || !!item.disabled
  }
  return (
    <div
      style={adaptivePanels.style}
      className={`app-shell editor-shell ${showHome ? 'home-route-active' : ''} ${showLayers && !uiMinimized ? '' : 'chrome-hide-layers'} ${(uiMinimized ? !!s.selection.length : showInspector) ? '' : 'chrome-hide-inspector'} ${uiMinimized ? 'chrome-minimized' : ''}`}
      data-history-backend={editor.historyBackend} data-history-operation={editor.historyOperationMode} data-history-frame-bytes={editor.historyFrameBytes}
      data-desktop-ready={desktopSession ? String(ready) : undefined}
      data-editor-ready={String(ready)}
      data-color-picking={s.tool==='eyedropper'}
      aria-busy={switching || desktopStatus.busy}
      onKeyUp={e=>{if(showHome)e.stopPropagation()}}
      onDragOverCapture={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()}}
      onDropCapture={e=>{
        if(showHome){e.preventDefault();e.stopPropagation();return}
        const files=[...e.dataTransfer.files]
        const designFiles=files.filter(f=>/\.(fd|json|svg|svgz|fig|sketch|pdf)$/i.test(f.name))
        const imageFiles=files.filter(f=>/\.(png|jpe?g|webp)$/i.test(f.name))
        if(!designFiles.length&&!imageFiles.length)return
        e.preventDefault();e.stopPropagation()
        if(designFiles.length>0){
          if(designFiles.length!==1){editor.notify('请一次导入一个设计文件');return}
          void importDesignFile(designFiles[0])
        }else if(imageFiles.length>0){
          void importImageFiles(imageFiles)
        }
      }}
      onPointerDownCapture={(e) => {
        const target = e.target as Element
        if (editor.propertyPreviewActive) {
          // The popover owns its fields; its canvas sampler reads pixels only.
          if (target.closest('[data-property-preview], [data-property-preview-undo]') || (hasCanvasColorPicker(editor) && target.closest('[data-testid="canvas"]'))) return
          if (!editor.settleOwnedPropertyPreview('outside')) { e.preventDefault(); e.stopPropagation(); return }
        }
        if (editor.interactionActive && (!target.closest('[data-testid="canvas"]') || target.closest('button,input,select,textarea,.canvas-controls'))) {
          e.preventDefault(); e.stopPropagation(); return
        }
        if (showHome && target.closest('.local-home,.settings-backdrop')) return
        const penCanvas = editor.state.tool === 'pen' && target.closest('[data-testid="canvas"]') && !target.closest('button,input,select,textarea')
        if (!penCanvas && target !== document.activeElement && !target.closest('.rich-text-editor') && !commitPendingEdits(editor)) {
          e.preventDefault(); e.stopPropagation(); return
        }
        if (!ready || switching || (desktopStatus.transitioning && !(e.target as Element).closest('[data-desktop-dialog]'))) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      onKeyDownCapture={(e) => {
        if ((e.target as Element).closest('[data-property-preview]')) return
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
        if (showHome && (e.target as Element).closest('.local-home,.settings-backdrop')) return
        const penCanvas = editor.state.tool === 'pen' && (e.target as Element).closest('[data-testid="canvas"]')
        const nudgeKey = keyboardNudgeOwnsKey(editor, e.nativeEvent) && !shortcutTargetOwnsKeyboard(e.target)
        if (!penCanvas && !nudgeKey && !(e.target as Element).closest('input,textarea,select,.rich-text-editor') && !commitPendingEdits(editor)) {
          e.preventDefault(); e.stopPropagation(); return
        }
        if (!ready || switching || (desktopStatus.transitioning && !(e.target as Element).closest('[data-desktop-dialog]'))) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {!showHome && (!ready || switching || (desktopStatus.transitioning && !desktopPrompt)) && (
        <div className="document-transition" role="status">
          {desktopSession ? '正在处理本机设计文件…' : '正在保存并打开设计…'}
        </div>
      )}
      {showHome && <LocalHome source={homeSource} ready={ready} startupError={startupError} busy={switching || desktopStatus.busy}
        currentName={s.doc.name} onResume={resumeEditor} onNew={() => switchDocument(blank())}
        onOpenFile={openHomeFile} onSettings={() => {
          homeSettingsFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          openSettings()
        }} />}
      <header className="editor-header">
        <button ref={fileMenuTrigger} className="brand" aria-label="文件菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <img className="brand-mark" src="/branding/futureox-desgin.svg" width="28" height="28" alt="" aria-hidden="true" />
          <strong>Futureox Design</strong>
          <ChevronDown size={13} />
        </button>
        <span className="header-divider" />
        <div className="document-title">
          <button type="button" className="document-location" onClick={() => {
            if (desktopSession?.supportsWorkspace) setShowWorkspaceLibrary(true)
            else if (desktopSession) setShowCatalog(true)
            else void openLocalFiles()
          }}>{desktopSession ? '本机设计' : '我的设计'}</button>
          <b>/</b>
          <input
            aria-label="文档名称"
            value={s.doc.name}
            onCompositionStart={() => { titleComposing.current = true; pendingEditsChanged(editor) }}
            onCompositionEnd={() => { titleComposing.current = false; pendingEditsChanged(editor) }}
            onChange={(e) =>
              editor.change('重命名文档', (d) => {
                d.name = e.target.value
              })
            }
          />
          <span className="draft-badge">本地</span>
          <button type="button" aria-label={uiMinimized ? '展开界面' : '收起界面'} title={`收起 / 展开界面 (${formatShortcutCombo('Mod+Shift+\\', shortcutContext.platform)})`}
            aria-pressed={uiMinimized} onClick={() => { if (!hasPendingEdits(editor) && !editor.interactionActive) setUiMinimized(value => !value) }}>
            {uiMinimized ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

        </div>
        <div className="header-right">
          <details ref={workspaceActions} className="workspace-actions" onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Escape' && event.currentTarget.open) {
              event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()
            }
          }}>
            <summary aria-label="更多工作区操作" title="更多工作区操作"><SlidersHorizontal size={16} /></summary>
            <div className="workspace-actions-menu" onClick={event => { if ((event.target as Element).closest('button')) { const menu = event.currentTarget.closest('details'); menu?.removeAttribute('open'); menu?.querySelector('summary')?.focus() } }}>
          <button type="button" aria-pressed={showColor} onClick={() => setShowColor((v) => !v)}>
            色彩与 HDR
          </button>
          <button
            type="button"
            aria-pressed={showAnimation}
            onClick={() => setShowAnimation((v) => !v)}
          >
            动画
          </button>
          <button
            type="button"
            aria-pressed={showHistory}
            disabled={!ready}
            title="查看当前设计的本地历史版本"
            onClick={() => setShowHistory(true)}
          >
            历史版本
          </button>
          <button title={panelText.left} aria-label={panelText.left} aria-expanded={showLayers} onClick={() => { if (!hasPendingEdits(editor) && !editor.interactionActive) setShowLayers((v) => !v) }}>
            <LayersIcon size={16} />
          </button>
          <button
            title={panelText.right}
            aria-label={panelText.right}
            aria-expanded={showInspector} onClick={() => { if (!hasPendingEdits(editor) && !editor.interactionActive) setShowInspector((v) => !v) }}
          >
            <VectorSquare size={16} />
          </button>
            </div>
          </details>
          <span
            className={`save-status ${(desktopSession ? desktopStatus.error || desktopStatus.warning || desktopStatus.recoveryWarning : saved.includes('失败')) ? 'error' : ''}`}
            title={desktopSession ? desktopStatus.warning || desktopStatus.recoveryWarning || desktopStatus.displayName || (desktopSession.supportsWorkspace ? '编辑后自动保存到本机文档库' : '尚未保存到文件') : undefined}
            role="status"
          >
            {desktopSession && desktopStatus.dirty ? <span aria-hidden="true">●</span> : <Check size={13} />}
            {desktopSession ? (!ready ? '载入中' : desktopStatus.operation === 'save' ? '保存中…'
              : desktopStatus.conflict ? (desktopSession.supportsWorkspace ? '本机库存在新版本' : '文件已被外部修改') : desktopStatus.error ? '操作失败，修改已保留'
              : desktopStatus.dirty ? (desktopStatus.recoveryWarning ? '未保存，恢复副本有警告' : desktopSession.supportsWorkspace ? '待保存到本机' : '未保存到文件') : desktopStatus.warning ? '已写入，有持久化警告' : desktopSession.supportsWorkspace ? '已保存到本机' : '已保存到文件') : saved}
          </span>
          {desktopSession&&ready&&<LocalWindowControl editor={editor} session={desktopSession} live={localWindows}/>}
          {desktopSession ? <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => void desktopSession.save()}>
            <Save size={16} />保存
          </button> : <button type="button" disabled={!ready} onClick={() => void openLocalFiles()}>
            <FolderOpen size={16} />本机文件
          </button>}
          <button type="button" className="prototype-preview-button" aria-label="预览原型" title="预览原型"
            disabled={!s.doc.pages.some((page) => page.children.length)} onClick={() => setShowPrototype(true)}><Play size={16} /><span>预览</span></button>
          <button
            className="primary"
            onClick={() => {
              setShowExport(true)
            }}
          >
            <Download size={14} />
            导出
            <ChevronDown size={12} />
          </button>
          <button type="button" className="app-settings-button" aria-label="打开设置"
            disabled={!ready || switching || desktopStatus.transitioning}
            title={!ready || switching || desktopStatus.transitioning ? '正在处理设计文件，完成后可打开设置' : `设置 (${formatShortcutCombo('Mod+,', shortcutContext.platform)})`}
            aria-haspopup="dialog" aria-expanded={showSettings}
            onClick={openSettings}>
            <SettingsIcon size={16} /><span>设置</span>
          </button>
          <span className="avatar">我</span>
        </div>
      </header>
      {desktopSession?.supportsWorkspace && <WorkspaceTabs session={desktopSession} activeId={s.doc.id} />}
      {menu && (
        <>
          <div className="menu-scrim" onClick={() => setMenu(false)} />
          <div className="file-menu">
            <button type="button" onClick={enterHome}><FolderOpen size={15} />本机首页</button>
            <button type="button" onClick={openSettings}><SettingsIcon size={15} />设置</button>
            <button
              onClick={() => {
                void switchDocument(blank())
              }}
            >
              <Plus size={15} />
              新建设计
            </button>
            {desktopSession ? <>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); setShowCatalog(true) }}>
                <FolderOpen size={15} />本机项目目录
              </button>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); void desktopSession.open() }}>
                <FolderOpen size={15} />打开本机设计文件 <kbd>{formatShortcutCombo('Mod+O', shortcutContext.platform)}</kbd>
              </button>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); void desktopSession.recover() }}>
                恢复未保存的设计
              </button>
            </> : <button onClick={() => void openLocalFiles()}>
              <FolderOpen size={15} />本机文件与回收站
            </button>}
            <div className="render-quality" role="group" aria-label="文件渲染质量">
              <span>渲染质量</span>
              <button
                aria-pressed={(s.doc.rasterProfile || 'analytic') === 'analytic'}
                disabled={!!s.doc.colorManagement}
                title={s.doc.colorManagement ? '广色域 / HDR 使用精细覆盖采样' : undefined}
                onClick={() =>
                  editor.change('标准渲染质量', (d) => {
                    d.rasterProfile = 'analytic'
                  })
                }
              >
                标准（更快）
              </button>
              <button
                aria-pressed={s.doc.rasterProfile === 'figma'}
                onClick={() =>
                  editor.change('精细渲染质量', (d) => {
                    d.rasterProfile = 'figma'
                  })
                }
              >
                精细（更耗内存）
              </button>
              <button
                aria-pressed={s.doc.rasterProfile === 'figmaSoftware'}
                title="保留精细采样，使用与当前 Figma 参考导出一致的颜色取整方式；配置随文件保存"
                onClick={() =>
                  editor.change('Figma 导出兼容渲染', (d) => {
                    d.rasterProfile = 'figmaSoftware'
                  })
                }
              >
                Figma 导出兼容
              </button>
            </div>
            <button
              onClick={() => {
                if (desktopSession) { setMenu(false); void desktopSession.save(true) }
                else void switchDocument(
                  { ...structuredClone(s.doc), id: uid(), name: copyName(s.doc.name, ' 副本') },
                  undefined, false,
                )
              }}
            >
              <Plus size={15} />
              {desktopSession ? '另存为设计文件…' : '保存为本机副本'}
            </button>
            <button
              onClick={() => {
                fileImports.invalidate()
                importMode.current = 'open'
                file.current?.click()
                setMenu(false)
              }}
            >
              <FolderOpen size={15} />
              导入 Sketch / FIG / SVG / PDF
            </button>
            {(['inspect', 'edit'] as const).map(mode => <button type="button" key={mode}
              disabled={!ready || switching || desktopStatus.busy || s.busy || editor.interactionActive || !sketchCapabilities[mode]}
              title={sketchCapabilities[mode] ? (mode === 'inspect' ? '原生只读预览，不转换为当前画布，也不修改源文件' : '独立原生会话，仅支持已声明的编辑范围；另存为全新文件') : '当前宿主未提供此原生 Sketch 能力；可使用兼容格式导入'}
              onClick={() => { if (!commitPendingEdits(editor)) return; fileImports.invalidate(); setMenu(false); setSketchMode(mode) }}>
              {mode === 'inspect' ? '预览原生 Sketch（只读）…' : '编辑原生 Sketch（有限支持）…'}
            </button>)}
            <button disabled={!ready || switching || desktopStatus.busy} onClick={() => {
              fileImports.invalidate()
              importMode.current = 'append'
              file.current?.click()
              setMenu(false)
            }}><Plus size={15} />追加到当前画布…</button>
            <button
              onClick={() => {
                if (desktopSession) void desktopSession.save()
                else if (editor.settleOwnedPropertyPreview('save') && !editor.interactionActive && commitPendingEdits(editor)) exportDocument(editor.authoredDocument)
                setMenu(false)
              }}
            >
              <Download size={15} />
              {desktopSession?.supportsWorkspace ? '保存到本机文档库' : '保存设计文件'} <kbd>{formatShortcutCombo('Mod+S', shortcutContext.platform)}</kbd>
            </button>
            <hr />
            <button
              onClick={() => {
                void switchDocument(demo())
              }}
            >
              打开示例画布
            </button>
            <button onClick={() => { void generateExport('visual-svg'); setMenu(false) }}>导出 SVG（保留视觉效果，可包含位图）</button>
            <button type="button" disabled={!ready || exportAsset !== null}
              title="用于 Sketch 交换，部分效果可能降级；完整编辑信息保存在 .fd 文件"
              onClick={() => void generateSketchExport()}>导出 Sketch（兼容格式）</button>
            <button onClick={() => { setShowExport(true); setMenu(false) }}>导出图像 · 1x / 2x / 3x</button>
            {(['svg', 'png'] as const).map((format) => (
              <button
                key={format}
                onClick={() => {
                  void generateExport(format)
                  setMenu(false)
                }}
              >
                导出 {format.toUpperCase()}
                {format === 'png' ? ' @2x' : ''}
              </button>
            ))}
          </div>
        </>
      )}
      <input
        ref={file}
        type="file"
        accept=".fd,.json,.svg,.svgz,.fig,.sketch,.pdf,.png,.jpg,.jpeg,.webp"
        hidden
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (f) await importDesignFile(f, importMode.current)
        }}
      />
      {desktopPrompt && <DesktopLeaveDialog name={s.doc.name} reason={desktopPrompt.reason} onDecision={(decision) => {
        desktopPrompt.resolve(decision)
        setDesktopPrompt(null)
      }} />}
      {desktopStatus.conflict && !desktopPrompt && <div className="desktop-conflict" role="alert">
        <span>{desktopSession?.supportsWorkspace ? '本机库已有新版本，当前画布已保留。可保存副本，或重新从本机库打开。' : '文件已被外部修改，当前画布已保留。请另存为，或打开磁盘上的文件后再编辑。'}</span>
        <button type="button" disabled={desktopStatus.busy} onClick={() => void (desktopSession?.supportsWorkspace ? desktopSession.saveCopy() : desktopSession?.save(true))}>{desktopSession?.supportsWorkspace ? '保存本机副本' : '另存为'}</button>
        <button type="button" disabled={desktopStatus.busy} onClick={() => { fileImports.invalidate(); if (desktopSession?.supportsWorkspace) setShowWorkspaceLibrary(true); else void desktopSession?.open() }}>{desktopSession?.supportsWorkspace ? '打开本机库' : '打开磁盘文件'}</button>
      </div>}
      {showExport && <ExportPanel editor={editor} onClose={() => setShowExport(false)} />}
      {showTools&&<DesignTools editor={editor} onClose={()=>setShowTools(false)}/>}
      {showPrototype && <PrototypePlayer document={s.doc} onClose={() => setShowPrototype(false)} />}
      {showWorkspaceLibrary && desktopSession && <WorkspaceLibrary session={desktopSession} onClose={() => setShowWorkspaceLibrary(false)} />}
      {showFramePresets && <FramePresetPanel editor={editor} onClose={() => setShowFramePresets(false)} />}
      {showHistory && (
        <DocumentHistoryDialog
          key={s.doc.id}
          session={desktopSession}
          documentId={s.doc.id}
          documentName={s.doc.name}
          unsaved={desktopSession ? desktopStatus.dirty : saver.dirty}
          beforeLocalRestore={() => {
            if (hasPendingEdits(editor) || editor.interactionActive || editor.state.busy || switchGate.current)
              throw new Error('请先完成当前输入或操作，再恢复历史版本；当前修改已保留')
            const version = editor.state.version, generation = editor.sessionGeneration
            return () => editor.state.version === version && editor.sessionGeneration === generation &&
              !hasPendingEdits(editor) && !editor.interactionActive && !editor.state.busy && !switchGate.current
          }}
          onLocalAdopt={async (record) => {
            if (desktopSession) return false
            const opened = await switchDocument(record.document, { ...record, updatedAt: Date.now() }, false)
            if (!opened) editor.notify('历史版本已恢复到本机存储；当前画布已保留，可重新打开查看')
            return opened
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
      <main className={`editor-workspace ${showLayers && !uiMinimized ? '' : 'hide-layers'} ${(uiMinimized ? !!s.selection.length : showInspector) ? '' : 'hide-inspector'} ${uiMinimized ? 'ui-minimized' : ''}`} >
        <WorkspaceRail section={workspaceSection} onSection={(section) => {
          if (editor.interactionActive || editor.state.busy || !commitPendingEdits(editor)) return
          setWorkspaceSection(section); setShowLayers(true); setUiMinimized(false)
        }}
          onFiles={() => { if (desktopSession?.supportsWorkspace) setShowWorkspaceLibrary(true); else if (desktopSession) setShowCatalog(true); else void openLocalFiles() }}
          onTools={() => setShowCommands((value) => !value)} toolsOpen={showCommands} onVariables={() => setShowTools(true)} />
        <div className="adaptive-layers-shell"><Layers editor={editor} section={workspaceSection} onSection={setWorkspaceSection} /><PanelResizeHandle side="left" blocked={editor.interactionActive || hasPendingEdits(editor)} canResize={() => !editor.interactionActive && !hasPendingEdits(editor)} /></div>
        <div className="canvas-workspace">
          {importReport?.documentId === s.doc.id && <ImportNotice warnings={importReport.warnings} onClose={() => setImportReport(null)} />}
          <HomeCanvasGate home={showHome}><Canvas editor={editor} peers={localWindows.peers} compactChrome loading={!ready}
            startupPreview={startupPreview} onCapturePreview={desktopSession ? undefined : capturePreview}
            zoomControlsTarget={(uiMinimized ? !!s.selection.length : showInspector) ? zoomHost : null} /></HomeCanvasGate>
          <DesignToolbar disabled={!ready || switching || desktopStatus.transitioning || (editor.interactionActive && !editor.propertyPreviewActive)}>
            <div className="tool-group">
              <ToolPopover label="移动工具" icon={<MoveIcon size={18} />} open={showMove} onOpenChange={open => openToolbarMenu('move', open)}
                primary={{ label: moveTool.label, title: `${moveTool.label}${moveTool.key ? ` (${moveTool.key})` : ''}`, active: s.tool === moveTool.id, onClick: () => chooseTool(moveTool.id) }}>
                {tools.filter(({ id }) => ['select', 'hand', 'scale', 'zoom'].includes(id)).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={moveTool.id === id} onClick={() => { chooseTool(id); setShowMove(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
              </ToolPopover>
              <ToolPopover label="区域工具" icon={<RegionIcon size={18} />} open={showRegions} onOpenChange={open => openToolbarMenu('regions', open)}
                primary={{ label: regionTool.label, title: `${regionTool.label}${regionTool.key ? ` (${regionTool.key})` : ''}`, active: s.tool === regionTool.id, onClick: () => chooseTool(regionTool.id) }}>
                {(['frame', 'section', 'slice'] as const).map(id => tools.find(tool => tool.id === id)!).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={regionTool.id === id} onClick={() => { chooseTool(id); setShowRegions(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
                <button type="button" role="menuitem" tabIndex={-1} onClick={() => { if (!commitPendingEdits(editor)) return; setShowRegions(false); setShowFramePresets(true) }}>设备与尺寸预设…</button>
              </ToolPopover>
              <ToolPopover label="形状工具" icon={<ShapeIcon size={18} />} open={showShapes} onOpenChange={open => openToolbarMenu('shapes', open)}
                primary={{ label: shapeTool.label, title: `${shapeTool.label}${shapeTool.key ? ` (${shapeTool.key})` : ''}`, active: s.tool === shapeTool.id, onClick: () => chooseTool(shapeTool.id) }}>
                {shapeTools.map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={shapeTool.id === id} onClick={() => { chooseTool(id); setShowShapes(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
              </ToolPopover>
              <ToolPopover label="绘图工具" icon={<DrawingIcon size={18} />} open={showDrawing} onOpenChange={open => openToolbarMenu('drawing', open)}
                primary={{ label: drawingTool.label, title: `${drawingTool.label}${drawingTool.key ? ` (${drawingTool.key})` : ''}`, active: s.tool === drawingTool.id, onClick: () => chooseTool(drawingTool.id) }}>
                {tools.filter(({ id }) => ['pen', 'pencil', 'brush', 'marker', 'washi-tape'].includes(id)).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={drawingTool.id === id} onClick={() => { chooseTool(id); setShowDrawing(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
                {(['bend','cut','vector-lasso','eraser','paint-bucket','offset-path','text-path','multiselect'] as const).map(id=><button type="button" role="menuitem" tabIndex={-1} key={id} aria-label={utilityToolNames[id]} onClick={()=>{chooseTool(id);setShowDrawing(false)}}>{utilityToolNames[id]}</button>)}
                <button type="button" role="menuitem" tabIndex={-1} disabled={s.busy || s.selection.length !== 1 || !editor.topSelection().includes(s.selection[0]) || ['frame', 'section', 'group', 'text'].includes(s.doc.nodes[s.selection[0]]?.kind)} onClick={() => { editor.set({ tool: 'vector', editingVertex: null }); setShowDrawing(false) }}>编辑矢量</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('outline-stroke')} onClick={() => { void dispatchEditorCommand(editor, 'outline-stroke'); setShowDrawing(false) }}>轮廓化描边</button>
              </ToolPopover>
              <button type="button" data-tooltip={`评论${toolShortcutLabel('comments', shortcutContext) ? ` (${toolShortcutLabel('comments', shortcutContext)})` : ''}`} aria-label="评论" aria-pressed={s.tool==='comments'} onClick={()=>chooseTool('comments')}>◉</button>
              <button type="button" data-tooltip="文字 (T)" aria-label="文字" aria-pressed={s.tool === 'text'} className={s.tool === 'text' ? 'active' : ''} onClick={() => chooseTool('text')}><Type size={18} /></button>
              <ToolPopover label="实用工具" icon={<UtilityIcon size={18} />} open={showUtility} onOpenChange={open => openToolbarMenu('utility', open)}
                primary={{ label: utilityTool.label, title: `${utilityTool.label}${utilityTool.key ? ` (${utilityTool.key})` : ''}`, active: s.tool === utilityTool.id, onClick: () => chooseTool(utilityTool.id) }}>
                {utilityTools.map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={utilityTool.id === id} onClick={() => { chooseTool(id); setShowUtility(false) }}><Icon size={16} /><span>{label}</span>{key ? <kbd>{key}</kbd> : null}</button>
                ))}
                <strong>已解码但尚未提供</strong>
                {unavailableTools.map((c) => (
                  <button type="button" role="menuitem" tabIndex={-1} key={c.id} disabled title={unavailableReason(c.id) || undefined}>
                    <span>{c.label} · 未提供</span>
                  </button>
                ))}
              </ToolPopover>
            </div>
            <i />
            <div className="tool-group">
              {action('撤销', Undo2, () => { void dispatchEditorCommand(editor, 'undo') }, !editor.canUndo || s.busy)}
              {action('重做', Redo2, () => { void dispatchEditorCommand(editor, 'redo') }, !editor.canRedo || s.busy)}
              <ToolPopover label="排列与编辑" icon={<SlidersHorizontal size={18} />} open={showCommands} onOpenChange={open => openToolbarMenu('commands', open)}>
                {(['eyedropper','measure','comments','annotate'] as const).map(id=><button type="button" role="menuitem" tabIndex={-1} key={id} aria-label={utilityToolNames[id]} onClick={()=>{chooseTool(id);setShowCommands(false)}}>{utilityToolNames[id]}</button>)}
                <strong>白板与响应式</strong>{(Object.entries(boardToolNames) as [BoardTool,string][]).map(([id,label])=><button type="button" role="menuitem" tabIndex={-1} key={id} onClick={()=>{chooseTool(id);setShowCommands(false)}}>{label}</button>)}
                <strong>对齐与分布</strong><div className="arrangement-grid">
                  {action('左对齐', AlignLeft, () => alignSelection(editor, 'x', 'start'), !alignment.align, true)}
                  {action('水平居中', AlignCenterHorizontal, () => alignSelection(editor, 'x', 'center'), !alignment.align, true)}
                  {action('右对齐', AlignRight, () => alignSelection(editor, 'x', 'end'), !alignment.align, true)}
                  {action('顶部对齐', ArrowUpToLine, () => alignSelection(editor, 'y', 'start'), !alignment.align, true)}
                  {action('垂直居中', AlignVerticalJustifyCenter, () => alignSelection(editor, 'y', 'center'), !alignment.align, true)}
                  {action('底部对齐', ArrowDownToLine, () => alignSelection(editor, 'y', 'end'), !alignment.align, true)}
                  {action('水平等距', AlignHorizontalDistributeCenter, () => alignSelection(editor, 'x', 'distribute'), !alignment.distribute, true)}
                  {action('垂直等距', AlignVerticalDistributeCenter, () => alignSelection(editor, 'y', 'distribute'), !alignment.distribute, true)}
                </div>
                <strong>组合形状</strong>
                {([['union', '联合'], ['subtract', '减去顶层'], ['intersect', '交集'], ['exclude', '排除交集'], ['divide', '分割为多边形区域（旧版）']] as const).map(([operation, label]) =>
                  <button type="button" role="menuitem" tabIndex={-1} key={operation} disabled={s.selection.length < 2 || s.busy} onClick={() => { void editor.geometry(operation); setShowCommands(false) }}>{label}</button>)}
                <button type="button" role="menuitem" tabIndex={-1} disabled={!s.selection.length || s.busy} onClick={() => { setShowShapeBuilder(true); setShowCommands(false) }}>形状构建器…</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={s.selection.length < 2} onClick={() => { editor.group(true); setShowCommands(false) }}>蒙版组</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('group')} onClick={() => { void dispatchEditorCommand(editor, 'group'); setShowCommands(false) }}>编组 <kbd>{shortcutLabel('group', shortcutContext)}</kbd></button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('ungroup')} onClick={() => { void dispatchEditorCommand(editor, 'ungroup'); setShowCommands(false) }}>解除编组 <kbd>{shortcutLabel('ungroup', shortcutContext)}</kbd></button>
                <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setShowTools(true); setShowCommands(false) }}>变量 · 组件库 · 原型</button>
              </ToolPopover>
            </div>
          </DesignToolbar>
        </div>
        <div className="properties-workspace">
          <PanelResizeHandle side="right" blocked={editor.interactionActive || hasPendingEdits(editor)} canResize={() => !editor.interactionActive && !hasPendingEdits(editor)} />
          <div className="properties-tabs"><div className="properties-tab-buttons" role="tablist" aria-label="属性工作区" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault(); event.stopPropagation()
            const next = event.key === 'Home' ? 'design' : event.key === 'End' ? 'prototype' : propertiesTab === 'design' ? 'prototype' : 'design'
            setPropertiesTab(next)
            document.getElementById(`${next}-properties-tab`)?.focus()
          }}>
            <button type="button" role="tab" id="design-properties-tab" tabIndex={propertiesTab === 'design' ? 0 : -1} aria-selected={propertiesTab === 'design'} aria-controls="design-properties" onClick={() => setPropertiesTab('design')}>{panelText.design}</button>
            <button type="button" role="tab" id="prototype-properties-tab" tabIndex={propertiesTab === 'prototype' ? 0 : -1} aria-selected={propertiesTab === 'prototype'} aria-controls="prototype-properties" onClick={() => setPropertiesTab('prototype')}>{panelText.prototype}</button>
            </div><div ref={setZoomHost} className="properties-zoom" />
          </div>
          <div className="properties-content" id={`${propertiesTab}-properties`} role="tabpanel" aria-labelledby={`${propertiesTab}-properties-tab`}>
            {['comments','annotate'].includes(s.tool) ? <ReviewsPanel editor={editor}/> : propertiesTab === 'design' ? <PendingEditContext.Provider value={editor} key={`${editor.sessionGeneration}:${s.selection.join(',')}`}><Inspector editor={editor} /></PendingEditContext.Provider>
              : <DesignTools editor={editor} initialTab="prototype" embedded onClose={() => setPropertiesTab('design')} />}
          </div>
        </div>
      </main>
      <BatchRenameDialog editor={editor} />
      {showShapeBuilder && <ShapeBuilderDialog editor={editor} onClose={() => setShowShapeBuilder(false)} />}
      {sketchMode && desktop && <NativeSketchDialog bridge={desktop} mode={sketchMode} suspended={!!desktopPrompt} onClose={() => setSketchMode(null)} returnFocus={fileMenuTrigger.current} />}
      {showAnimation && <AnimationPanel editor={editor} onClose={() => setShowAnimation(false)} />}
      {showSettings && <SettingsDialog editor={editor} desktop={!!desktop} returnFocus={showHome ? homeSettingsFocus.current : fileMenuTrigger.current}
        busy={workspaceRootBusy} workspaceControls={desktop?.workspaceRoot && <>{!ready && <p role="status">设计尚未就绪，暂不能切换工作区目录。</p>}<WorkspaceRootControls bridge={desktop.workspaceRoot}
          busy={workspaceRootBusy || !ready || desktopStatus.busy} onChoose={original => {
            if (workspaceRootPending.current || !ready || desktopStatus.busy || !commitPendingEdits(editor)) return
            workspaceRootPending.current = true; setWorkspaceRootBusy(true)
            void chooseWorkspaceRoot(desktop.workspaceRoot!, original, () => setShowSettings(false))
              .then(error => { if (error) editor.notify(`工作区切换失败，当前设计已保留：${error}`) })
              .catch(error => editor.notify(`工作区切换失败，当前设计已保留：${String(error)}`))
              .finally(() => { workspaceRootPending.current = false; setWorkspaceRootBusy(false) })
          }} /></>}
        onClose={() => setShowSettings(false)} />}
      {showColor && (
        <PendingEditContext.Provider value={editor} key={editor.sessionGeneration}><ColorPanel editor={editor} onClose={() => setShowColor(false)} exports={exports} /></PendingEditContext.Provider>
      )}
      {showCatalog && desktop && desktopSession && <DesktopCatalog bridge={desktop}
        disabled={!ready || desktopStatus.busy} suspended={!!desktopPrompt}
        onOpen={async (request) => {
          fileImports.invalidate()
          const opened = await desktopSession.openCatalogFile(request)
          if (!opened && desktopSession.status.error) throw new Error(desktopSession.status.error)
          return opened
        }} onClose={() => { fileImports.invalidate(); setShowCatalog(false) }} />}
      {localFiles && (
        <div className="modal-backdrop">
          <section className="remote-modal workspace-library" role="dialog" aria-modal="true" aria-label="本机文件"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); fileImports.invalidate(); setLocalFiles(null); focusCanvas()
              } else if (event.key === 'Tab') {
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
                const first = buttons[0], last = buttons.at(-1)
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
              }
            }}>
            <h2>
              本机文件<button autoFocus aria-label="关闭本机文件" onClick={() => { fileImports.invalidate(); setLocalFiles(null); focusCanvas() }}>×</button>
            </h2>
            {!localFiles.length && <p>编辑后的作品会自动保存在这里。</p>}
            {localFiles.map((entry) => (
              <div className="local-file-row" key={entry.id}>
                <button
                  disabled={entry.deleted}
                  onClick={() => {
                    const request = fileImports.begin(editor)
                    void importStep(request, () => localOpen(entry.id))
                      .then((record) => record && switchDocument(record.document, record, true, request))
                      .catch((e) => { recordLocalError('workspace', e, 'STORAGE_ERROR'); if (request.isCurrent()) editor.notify(String(e)) })
                  }}
                >
                  {entry.name}
                  {entry.deleted ? '（回收站）' : ''}
                </button>
                <span>版本 {entry.revision}</span>
                <button
                  disabled={entry.id === s.doc.id}
                  onClick={() =>
                    void trashLocalFile(entry.id, !entry.deleted)
                  }
                >
                  {entry.deleted ? '恢复' : '移入回收站'}
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
      <AutomationPanel editor={editor} desktop={desktop} onHistory={()=>setShowHistory(true)} />
      <footer>
        <span>
          {s.busy ? <span className="spinner" /> : <span className="footer-dot" />}
          {s.message}
        </span>
        <div>
          {s.selection.length ? `${s.selection.length} 个图层已选择` : '空格拖动画布 · H 平移 · V 选择'}
          <span>·</span>
          <button onClick={() => editor.reorder('front')} disabled={!s.selection.length}>
            置顶
          </button>
          <button onClick={() => editor.reorder('back')} disabled={!s.selection.length}>
            置底
          </button>
          <button onClick={() => editor.ungroup()} disabled={!s.selection.length}>
            解除编组
          </button>
          <HelpCircle size={13} />
        </div>
      </footer>
      {exportAsset && (
        <div className="modal-backdrop">
          <section className="remote-modal">
            <h2>
              导出预览<button onClick={() => exports.close()}>×</button>
            </h2>
            <img
              src={exportAsset.url}
              alt="设计导出预览"
              style={{ width: '100%', maxHeight: '50vh', objectFit: 'contain', margin: '20px 0' }}
            />
            <a
              className="primary"
              style={{ display: 'inline-flex', textDecoration: 'none', borderRadius: 6 }}
              href={exportAsset.url}
              download={exportAsset.name}
            >
              下载 {exportAsset.name}
            </a>
          </section>
        </div>
      )}

    </div>
  )
}
