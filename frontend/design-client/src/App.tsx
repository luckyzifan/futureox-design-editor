import { webPath } from './web-path'
import { importInputStatus } from './import-input-policy'
import { beginImportDiagnostic, ImportStage, ImportFailure, type ImportDiagnostic } from './import-diagnostics'
import { operationStatusText } from './operation-status-messages'
import { translateProfessional } from './professional-dialog-messages'
import { FramePresetPanel } from './FramePresetPanel'
import { LocalHome, HomeCanvasGate } from './LocalHome'
import { localHomeSource, admitHomeDocumentCommand } from './local-home-source'
import { libraryHostKind, libraryRailVisible } from './library-chrome'
import { ownedPropertyPreviewTarget } from './property-preview'
import { hasCanvasColorPicker } from './canvas-color-picker'
import { appendImageFiles, captureImageImportAnchor, StaleImageImport } from './append-image-files'
import { imageData, RASTER_FILE_ACCEPT, RASTER_IMPORT_EXTENSION } from './image-import'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { ShapeBuilderDialog } from './ShapeBuilderDialog'
import { recordLocalError } from './local-diagnostics'
import { keyboardNudgeActive, keyboardNudgeOwnsKey } from './keyboard-nudge-gesture'
import { BatchRenameDialog } from './BatchRenameDialog'
import { CommandSearch } from './CommandSearch'
import { commandSearchText } from './command-search'
import { commandSearchSnapshot, requestCommandSearch, subscribeCommandSearch } from './command-search-session'
import { NativeSketchDialog } from './NativeSketchDialog'
import { LargeDocumentWorkspace, type SourceWorkspace } from './LargeDocumentWorkspace'
import { SourceDocumentStatus } from './SourceDocumentStatus'
import { SketchLibraryLocate } from './SketchLibraryLocate'
import { sketchOpenBlock } from './sketch-library-locate'
import { importSketchWithLibraries } from './import-file-worker'
import { SourcePageInspector } from './SourcePageInspector'
import { nativeSketchCapabilities } from './native-sketch-capabilities'
import { alignmentAvailability, alignSelection } from './alignment-availability'
import { SettingsDialog } from './SettingsDialog'
import { DesktopCloudSettings } from './DesktopCloudSettings'
import { cloudResult, desktopCloudWorkspace } from './desktop-cloud'
import { PanelResizeHandle, useAdaptivePanels } from './AdaptivePanels'
import { interfaceText, interfacePreference, useInterfacePreferences } from './interface-preference'
import { applyInterfaceLayout, interfaceLayoutFromShortcut } from './interface-layout'
import { bindEditorSettings } from './settings-preference'
import { WorkspaceRootControls, chooseWorkspaceRoot } from './WorkspaceRootControls'
import { useShortcutProfile } from './shortcut-preference'
import { getPrototypeTab, setPrototypeTab, subscribePrototypeTab } from './prototype-chrome'
import { shortcutPlatform, toolShortcutLabel, shortcutLabel, formatShortcutCombo } from './shortcut-profiles'
import { shortcutTargetOwnsKeyboard } from './editor-shortcuts'
import { NativeAutomationDialog } from './AutomationPanelLauncher'
import { DesignAgentLauncher } from './design-ai/DesignAgentLauncher'
import { DesignAgentDock } from './design-ai/DesignAgentDock'
import { getAgentDock, subscribeAgentDock } from './design-ai/design-agent-dock'
import { AnchoredMenu } from './anchored-menu'
import { UiModeSwitch } from './UiModeSwitch'
import { canvasStatusLabel } from './canvas-status-label'
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
import { cancelPendingOperations, commitPendingEdits, hasPendingEdits, pendingEditsChanged, registerPendingEdit, subscribePendingEdits } from './pending-edits'
import { modalOwnsKeyboard } from './modal-keyboard'
import { DesignTools } from './DesignTools'
import { WorkspaceRail, DesignToolbar, ToolPopover, type WorkspaceSection } from './EditorChrome'
import { PrototypePlayer } from './PrototypePlayer'
import { WorkspaceLibrary } from './WorkspaceLibrary'
import { CloudWorkspacePanel } from './CloudWorkspacePanel'
import { CloudWorkspace, type CloudWorkspaceStatus } from './cloud-workspace'
import { BackgroundLocalSave } from './background-local-save'
import { BufferedAutosave } from './buffered-autosave'
import { DocumentHistoryDialog } from './DocumentHistoryDialog'
import { ImportNotice } from './ImportNotice'
import { dispatchEditorCommand, resolveDesktopEditorCommand, type EditorCommand } from './editor-commands'
import { localizedToolCommands, localizedToolLabel, unavailableReason } from './tool-registry'
import { canvasText } from './canvas-interface-messages'
import { fileMenuText } from './file-menu-messages'
import { canvasMenuItems } from './canvas-menu-model'
import { ActivityBanner, EmptyCanvas } from './ActivityBanner'
import { activityKind, activityLabel, activityText } from './activity-chrome'
import { toolGlyph, type GlyphIcon } from './chrome-icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  Settings as SettingsIcon,
  ChevronDown,
  Download,
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
  Check,
  HelpCircle,
  Puzzle,
  Play,
  Search,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react'
import { Editor, type Tool } from './engine'
import { desktopBridge, type DesktopCloudStatus, type DesktopCommand } from './desktop'
import { PluginPanel } from './plugins/PluginPanel'
import { OPEN_PLUGINS_EVENT, pluginLaunchGrant } from './plugins/open-plugins'
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
import { matchesAllAssetsShortcut } from './all-assets-shortcut'
import { ExportPanel } from './ExportPanel'
import { download, exportDocument, readDesignFile } from './persistence'
import { createImportedCopy } from './import-identity'
import { exportSketchInWorker } from './import-file-worker'
import { ImportOwner, importStep, type ImportRequest } from './import-ownership'
import { ExportOwner, commitExportEdits, type ExportRequest } from './export-ownership'
const toolItems: { id: Tool; label: string; icon: GlyphIcon }[] = [
  { id: 'select', label: '选择', icon: toolGlyph.select },
  { id: 'hand', label: '平移', icon: toolGlyph.hand },
  { id: 'zoom', label: '区域缩放', icon: toolGlyph.zoom },
  { id: 'scale', label: '缩放', icon: toolGlyph.scale },
  { id: 'slice', label: '切片', icon: toolGlyph.slice },
  { id: 'frame', label: '画板', icon: toolGlyph.frame },
  { id: 'section', label: '分区', icon: toolGlyph.section },
  { id: 'rectangle', label: '矩形', icon: toolGlyph.rectangle },
  { id: 'ellipse', label: '椭圆', icon: toolGlyph.ellipse },
  { id: 'polygon', label: '多边形', icon: toolGlyph.polygon },
  { id: 'star', label: '星形', icon: toolGlyph.star },
  { id: 'line', label: '直线', icon: toolGlyph.line },
  { id: 'arrow', label: '箭头', icon: toolGlyph.arrow },
  { id: 'pen', label: '钢笔', icon: toolGlyph.pen },
  { id: 'pencil', label: '铅笔', icon: toolGlyph.pencil },
  { id:'marker',label:'马克笔',icon: toolGlyph.marker },
  { id:'washi-tape',label:'和纸胶带',icon: toolGlyph['washi-tape'] },
  { id: 'brush', label: '画笔', icon: toolGlyph.brush },
  { id: 'text', label: '文字', icon: toolGlyph.text },
]
const utilityToolItems: { id: Tool; label: string; icon: GlyphIcon }[] = [
  { id: 'eraser', label: '橡皮', icon: toolGlyph.eraser },
  { id: 'eyedropper', label: '吸管', icon: toolGlyph.eyedropper },
  { id: 'paint-bucket', label: '油漆桶', icon: toolGlyph['paint-bucket'] },
  { id: 'measure', label: '测量', icon: toolGlyph.measure },
  { id: 'slice', label: '切片', icon: toolGlyph.slice },
  { id: 'crop', label: '裁切', icon: toolGlyph.crop },
  { id: 'comments', label: '评论', icon: toolGlyph.comments },
]
export default function App({sourceWorkspace:source}:{sourceWorkspace?:SourceWorkspace}={}) {
  const { locale, uiMode } = useInterfacePreferences()
  const agentDockOpen = useSyncExternalStore(subscribeAgentDock, () => getAgentDock().open, () => false)
  const toolbarText = canvasText[locale]
  const menuText = fileMenuText[locale]
  const shortcutProfile = useShortcutProfile()
  const commandSearchOpen = useSyncExternalStore(subscribeCommandSearch, commandSearchSnapshot, () => 0) !== 0
  const shortcutContext = useMemo(() => ({ profile: shortcutProfile, platform: shortcutPlatform(), desktop: !!desktopBridge() }), [shortcutProfile])
  const tools = useMemo(() => toolItems.map(tool => ({ ...tool, label: localizedToolLabel(tool.id, locale, tool.label), key: toolShortcutLabel(tool.id, shortcutContext) })), [shortcutContext, locale])
  const utilityTools = useMemo(() => utilityToolItems.map(tool => ({ ...tool, label: localizedToolLabel(tool.id, locale, tool.label), key: toolShortcutLabel(tool.id, shortcutContext) })), [shortcutContext, locale])
  const [importReport, setImportReport] = useState<{ documentId: string; warnings: string[] } | null>(null)
  const [showHome, setShowHome] = useState(!source)
  const [homeImportError, setHomeImportError] = useState('')
  const [libraryGap, setLibraryGap] = useState<{ file: File; error: string } | null>(null)
  const [startupError, setStartupError] = useState('')
  const homeSettingsFocus = useRef<HTMLElement | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [showWorkspaceLibrary, setShowWorkspaceLibrary] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showAutomation, setShowAutomation] = useState(false)
  const [pluginLaunch, setPluginLaunch] = useState<{ grant: string; token: number } | null>(null)
  const pluginLaunchToken = useRef(0)
  const [sketchMode, setSketchMode] = useState<'inspect' | 'edit' | null>(null)
  const [largeDocument, setLargeDocument] = useState<{file?:File}|null>(null)
  const sketchCapabilities = nativeSketchCapabilities(desktopBridge())
  const [workspaceRootBusy, setWorkspaceRootBusy] = useState(false)
  const workspaceRootPending = useRef(false)
  const fileMenuTrigger = useRef<HTMLButtonElement>(null)
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('layers')
  const [sketchZoomHost, setSketchZoomHost] = useState<HTMLDivElement | null>(null)
  const [figmaZoomHost, setFigmaZoomHost] = useState<HTMLDivElement | null>(null)
  const workspaceActions = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: Event) => { if (workspaceActions.current && !workspaceActions.current.contains(event.target as Node)) workspaceActions.current.open = false }
    const blur = () => { if (workspaceActions.current) workspaceActions.current.open = false }
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur) }
  }, [])
  const [propertiesTab, setPropertiesTabState] = useState<'design' | 'prototype'>('design')
  const setPropertiesTab = (next: 'design' | 'prototype') => { setPropertiesTabState(next); setPrototypeTab(next) }
  useEffect(() => subscribePrototypeTab(() => setPropertiesTabState(getPrototypeTab())), [])
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
  const [exportEntry, setExportEntry] = useState<'merged' | 'assets'>('merged')
  const [showAnimation, setShowAnimation] = useState(false)
  const adaptivePanels = useAdaptivePanels()
  const showLayers = adaptivePanels.leftOpen
  const setShowLayers = adaptivePanels.setLeftOpen
  const panelText = interfaceText[adaptivePanels.preferences.locale]
  const [uiMinimized, setUiMinimized] = useState(false)
  const showInspector = adaptivePanels.rightOpen
  const setShowInspector = adaptivePanels.setRightOpen
  const [desktop] = useState(desktopBridge)
  const [editor] = useState(() => source?.editor || new Editor(blank()))
  useEffect(() => {
    if (!desktop?.setInterfaceLocale) return
    let disposed = false, previous: string | undefined
    const synchronize = () => {
      const locale = interfacePreference.getSnapshot().locale
      if (locale === previous) return
      previous = locale
      void desktop.setInterfaceLocale!(locale).then(result => {
        if (!disposed && result.status === 'error') editor.notify(result.message)
      }).catch(error => { if (!disposed) editor.notify(String(error)) })
    }
    synchronize()
    const unsubscribe = interfacePreference.subscribe(synchronize)
    return () => { disposed = true; unsubscribe() }
  }, [desktop, editor])
  useEffect(() => desktopPet.bind(editor), [editor])
  useEffect(() => bindEditorSettings(editor), [editor])
  const [exports] = useState(() => new ExportOwner())
  const exportAsset = useSyncExternalStore(exports.subscribe, exports.getSnapshot)
  useLayoutEffect(() => {
    exports.activate(editor)
    return () => exports.dispose()
  }, [editor, exports])
  function openExportPanel(entry: 'merged' | 'assets' = 'merged') {
    setExportEntry(entry)
    if(source)source.prepareExport(()=>setShowExport(true))
    else setShowExport(true)
  }
  async function generateExport(format: 'svg' | 'png' | 'visual-svg') {
    const trace = beginEditorAction(editor, CanvasAction.export, ActionSource.menu, 310)
    try {
    let request: ExportRequest | null = null
    try {
      if (!commitExportEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
      request = exports.begin(editor, `menu:${format}`)
      if (!request) { trace.result(ActionOutcome.blocked, ActionReason.busy); return }
      editor.notify('正在生成导出预览…', { key: 'exportPreviewGenerating' })
      const module = await import('./export')
      if (!request.isCurrent()) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
      const result = format === 'visual-svg'
        ? await module.exportVisualSvg(request.document, request.page)
        : await module.exportImage(request.document, request.page, format, format === 'svg' ? 1 : 2, undefined, request.signal)
      if (exports.publish(request, result)) { trace.result(ActionOutcome.observed); editor.notify('导出文件已生成', { key: 'exportFileReady' }) } else trace.result(ActionOutcome.cancelled, ActionReason.superseded)
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
      editor.notify('正在生成 Sketch 兼容文件…', { key: 'sketchExportGenerating' })
      const bytes = await exportSketchInWorker(request.document, request.signal)
      if (!request.isCurrent()) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
      download(`${request.document.name}.sketch`, new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }))
      trace.result(ActionOutcome.observed)
      desktopPet.event('export')
      editor.notify('Sketch 兼容文件已生成；完整编辑信息请同时保留 .fd 文件', { key: 'sketchExportReadyCompatibility' })
    } catch (error) { trace.result(ActionOutcome.rejected, ActionReason.validation); if (request.isCurrent()) { desktopPet.event('error'); editor.notify(String(error)) } }
    finally { exports.finish(request) }
    } finally { trace.finish() }
  }
  const [fileImports] = useState(() => new ImportOwner())
  const importMode = useRef<'open' | 'append'>('open')
  async function importDesignFile(f: File, mode: 'open' | 'append' = 'open') {
    if(source){if(mode==='open')await source.openFile(f);else editor.notify('当前源画板尚不支持追加保存；已有内容已保留。');return}
    if(mode==='open'&&desktopBridge()?.largeDocument&&/\.(json|sketch)$/i.test(f.name)&&f.size>64*1024**2){
      if(!ready||switching||desktopStatus.busy||!commitPendingEdits(editor)||editor.interactionActive){editor.notify('请结束当前操作后打开文件');return}
      setLargeDocument({file:f});return
    }
    const trace = beginEditorAction(editor, CanvasAction.import, ActionSource.menu, 312)
    const diagnostic = beginImportDiagnostic(f, mode, trace)
    trace.result(ActionOutcome.cancelled, ActionReason.unobserved)
    let trackImport = false
    try {
    if(!ready || switching || desktopStatus.busy || editor.interactionActive){trace.result(ActionOutcome.blocked, ActionReason.busy);editor.notify('请结束当前操作后打开文件', { key: 'openBlockedActiveOperation' });return}
    trackImport = true
    setImporting(true)
    const request = fileImports.begin(editor)
    setHomeImportError('')
    setLibraryGap(null)
    diagnostic.bindRequest(request)
    try {
      const imported = await importStep(request, () => readDesignFile(f, request.signal, diagnostic))
      request.assertCurrent()
      const document = diagnostic.run(ImportStage.copy, () => createImportedCopy(imported.document))
      if (mode === 'append') {
        if (!commitPendingEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
        request.assertCurrent()
        const revision = editor.state.version
        const roots = diagnostic.run(ImportStage.commit, () => editor.appendDocument(document))
        trace.result(editor.state.version !== revision ? ActionOutcome.committed : ActionOutcome.unchanged)
        setImportReport(imported.warnings.length ? { documentId: editor.state.doc.id, warnings: imported.warnings } : null)
        editor.notify(`已追加 ${roots.length} 组内容，可整体拖动；撤销可移除此轮导入`, { key: 'importedGroupsAppended', count: roots.length })
        return
      }
      const opened = await diagnostic.wait(ImportStage.open, () => switchDocument(document, undefined, true, request))
      if (opened) trace.result(ActionOutcome.observed)
      if (opened && request.isLatest() && editor.state.doc.id === document.id && imported.warnings.length) {
        setImportReport({ documentId: document.id, warnings: imported.warnings }); editor.notify('导入完成，可以继续编辑', { key: 'designImportComplete' })
      }
    } catch (error) {
      const retired = request.signal.aborted || !request.isCurrent()
      const cancelled = diagnostic.fail(error, retired) === ImportFailure.cancelled
      trace.result(cancelled ? ActionOutcome.cancelled : ActionOutcome.rejected, cancelled ? ActionReason.superseded : ActionReason.validation)
      if (!cancelled && request.isCurrent()) {
        if(mode==='open'&&desktopBridge()?.largeDocument&&/\.(json|sketch)$/i.test(f.name)&&/Sketch archive: Limit|archive resource limit:/.test(String(error))){setLargeDocument({file:f});return}
        desktopPet.event('error')
        const reason = error instanceof Error ? error.message : String(error)
        if (mode === 'open' && /\.sketch$/i.test(f.name) && sketchOpenBlock(reason)) setLibraryGap({ file: f, error: reason })
        editor.notify(reason, importInputStatus(error))
        if (showHome) setHomeImportError(reason)
      }
    }
    finally { request.finish() }
    } finally { if (trackImport) setImporting(false); trace.finish() }
  }
  async function importImageFiles(files: File[]) {
    const trace = beginEditorAction(editor, CanvasAction.import, ActionSource.menu, 313)
    const diagnostics: ImportDiagnostic[] = []
    try {
      if (!ready || editor.interactionActive) { trace.result(ActionOutcome.blocked, ActionReason.notReady); editor.notify('请结束当前操作后导入图片', { key: 'imageImportBlockedActiveOperation' }); return }
      if (!commitPendingEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
      setImporting(true)
      const canvas = document.querySelector<HTMLElement>('[data-testid=canvas]')
      const anchor = captureImageImportAnchor(editor, { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 })
      const maxPixels = editor.state?.doc?.colorManagement ? 8_388_608 : 16_777_216
      const result = await appendImageFiles(editor, files, anchor, async file => {
        const image = await imageData(file, maxPixels)
        return { uri: image.data, width: image.width, height: image.height }
      }, file => { const diagnostic = beginImportDiagnostic(file, 'append', trace); diagnostics.push(diagnostic); return diagnostic })
      trace.result(result.status === 'committed' ? ActionOutcome.committed : result.status === 'rejected' ? ActionOutcome.rejected : ActionOutcome.unchanged, result.status === 'rejected' ? ActionReason.validation : ActionReason.none)
    } catch (error) {
      const cancelled = error instanceof StaleImageImport || (diagnostics.length > 0 && diagnostics.every(diagnostic => diagnostic.fail(error) === ImportFailure.cancelled))
      trace.result(cancelled ? ActionOutcome.cancelled : ActionOutcome.rejected,
        cancelled ? ActionReason.superseded : ActionReason.validation)
      if (cancelled) editor.notify('图片导入期间画布已变化，请重新导入')
      else { const detail = error instanceof Error ? error.message : String(error); const status = importInputStatus(error); editor.notify(status ? detail : `图片导入失败: ${detail}`, status || { key: 'imageImportFailed', error: detail }) }
    } finally { setImporting(false); trace.finish() }
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
  const [desktopState, setDesktopStatus] = useState<DesktopStatus>({
    dirty: true, busy: false, transitioning: false, operation: 'idle', conflict: false,
  })
  const desktopStatus=source?{...desktopState,busy:source.busy,transitioning:source.locked}:desktopState
  const openingNavigation=(target:Element,pan=false)=>!!source?.openingPreview && !desktopPrompt &&
    (!!target.closest('.canvas-controls,.canvas-scrollbars,.source-page-picker,[data-source-material-id],.source-board-navigation input') ||
      pan && editor.state.tool==='hand' && !!target.closest('[data-testid="canvas"]') &&
      !target.closest('button,input,select,textarea,[contenteditable="true"]'))
  const [desktopPrompt, setDesktopPrompt] = useState<{
    reason: LeaveReason; resolve: (decision: LeaveDecision) => void
  } | null>(null)
  const [desktopSession] = useState(() => desktop && !source ? new DesktopSession(
    desktop, editor,
    (reason) => new Promise<LeaveDecision>((resolve) => setDesktopPrompt({ reason, resolve })),
    setDesktopStatus,
  ) : undefined)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const [blurEdit, setBlurEdit] = useState<{
    session: number; document: string; page: string; node: string; index: number; effect: string; count: number
  } | null>(null)
  const blurNode = blurEdit && s.doc.nodes[blurEdit.node]
  const blurEffect = blurEdit && blurNode && blurNode.effects[blurEdit.index]
  const blurEffectIndex = blurEdit && blurNode && blurEffect?.visible
    && (blurEffect.gradientBlur || blurEffect.zoomBlur)
    && blurEdit.session === editor.sessionGeneration && blurEdit.document === s.doc.id && blurEdit.page === s.page
    && s.tool === 'select' && s.selection.length === 1 && s.selection[0] === blurEdit.node
    && blurNode.effects.length === blurEdit.count && blurEffect.id === blurEdit.effect
    ? blurEdit.index : undefined
  const exitBlurEdit = useCallback(() => setBlurEdit(null), [])
  useEffect(() => {
    if (blurEdit && blurEffectIndex === undefined) exitBlurEdit()
  }, [blurEdit, blurEffectIndex, exitBlurEdit])
  const editBlur = useCallback((index: number | null) => {
    if (index === null) { exitBlurEdit(); return }
    if (!commitPendingEdits(editor)) return
    const state = editor.state
    const node = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined
    const effect = node?.effects[index]
    if (state.tool !== 'select' || editor.interactionActive || !node || !effect?.visible
        || !(effect.gradientBlur || effect.zoomBlur)) return
    setBlurEdit({ session: editor.sessionGeneration, document: state.doc.id, page: state.page,
      node: node.id, index, effect: effect.id, count: node.effects.length })
  }, [editor, exitBlurEdit])
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
  const [showCloudWorkspace, setShowCloudWorkspace] = useState(false)
  const cloudWorkspaceLabel = locale === 'en' ? 'Server workspace' : '服务器工作区'
  const [cloudStatusInWorkspace, setCloudStatusInWorkspace] = useState<CloudWorkspaceStatus>({ connected: false })
  const [cloudStatus, setCloudStatus] = useState<DesktopCloudStatus>()
  const [cloudWorkspace] = useState(() => desktop?.cloud && desktopSession?.supportsWorkspace && !source ? new CloudWorkspace(status => {
    setCloudStatusInWorkspace(status)
    if (status.error && status.documentId === editor.authoredDocument.id) editor.notify(status.error)
  }) : undefined)
  const workspaceAvailable = !!cloudWorkspace && !!cloudStatus?.handle
  const attachDesktopCloud = useCallback((status: DesktopCloudStatus) => {
    setCloudStatus(status)
    if (!desktop?.cloud || !desktopSession || !cloudWorkspace) return
    if (!status.enabled || !status.handle) {
      cloudWorkspace.disconnect()
      setShowCloudWorkspace(false)
      return
    }
    const { backend, journal } = desktopCloudWorkspace(desktop.cloud, status.handle, desktopSession)
    cloudWorkspace.attach(backend, journal)
  }, [desktop, desktopSession, cloudWorkspace])
  const configureDesktopCloud = useCallback(async (request: { enabled: boolean; baseUrl?: string; token?: string }) => {
    if (!desktop?.cloud) throw Error('云端协作不可用')
    attachDesktopCloud(cloudResult(await desktop.cloud.configure(request)))
  }, [desktop, attachDesktopCloud])
  useEffect(() => {
    if (!desktop?.cloud || !cloudWorkspace) return
    let current = true
    void desktop.cloud.status().then(value => {
      if (current) attachDesktopCloud(cloudResult(value))
    }).catch(error => { if (current) editor.notify(String(error)) })
    return () => { current = false }
  }, [desktop, editor, cloudWorkspace, attachDesktopCloud])
  const [backgroundLocalSave] = useState(() => new BackgroundLocalSave())
  useEffect(() => () => { backgroundLocalSave.dispose(); cloudWorkspace?.disconnect() }, [backgroundLocalSave, cloudWorkspace])
  useEffect(() => {
    const open = (event: Event) => {
      if (largeDocument || source) return
      const grant = pluginLaunchGrant((event as CustomEvent<{ grant?: string }>).detail?.grant)
      setMenu(false)
      setShowPlugins(true)
      if (grant) {
        pluginLaunchToken.current += 1
        setPluginLaunch({ grant, token: pluginLaunchToken.current })
      } else setPluginLaunch(null)
    }
    window.addEventListener(OPEN_PLUGINS_EVENT, open)
    return () => window.removeEventListener(OPEN_PLUGINS_EVENT, open)
  }, [largeDocument, source])
  const [startupPreview, setStartupPreview] = useState<StartupPreview>()
  const [localFiles, setLocalFiles] = useState<LocalEntry[] | null>(null)
  const [switching, setSwitching] = useState(false)
  const [importing, setImporting] = useState(false)
  const switchGate = useRef<object | null>(null)
  const panelHost = useRef<HTMLDivElement>(null)
  const leftPanel = useRef<HTMLDivElement>(null), rightPanel = useRef<HTMLDivElement>(null)
  const leftPanelToggle = useRef<HTMLButtonElement>(null), rightPanelToggle = useRef<HTMLButtonElement>(null)
  const panelActionsSummary = useRef<HTMLElement>(null)
  type PanelFocus = { element: HTMLElement; side: 'left' | 'right'; session: number; page: string; selection: string; section: string }
  const panelFocus = useRef<Partial<Record<'left' | 'right', PanelFocus>>>({})
  const revealFocus = useRef<{ focus: PanelFocus; trigger: HTMLButtonElement } | null>(null)
  const panelFocusCurrent = (focus: PanelFocus) => focus.element.isConnected &&
    panelHost.current?.contains(focus.element) && (focus.side === 'left' ? leftPanel : rightPanel).current?.contains(focus.element) &&
    !focus.element.closest('[hidden],[aria-hidden="true"]') &&
    focus.section === (focus.side === 'left' ? workspaceSection : propertiesTab) &&
    focus.session === editor.sessionGeneration && focus.page === editor.state.page &&
    focus.selection === JSON.stringify(editor.state.selection)
  // Only these live App controls can reveal a hidden panel without committing
  // its recoverable input. Closing panels and ordinary navigation retain guards.
  const panelRecoveryReady = () => ready && !showHome && !uiMinimized && !switching && !desktopStatus.busy &&
    !desktopStatus.transitioning && !editor.state.busy && !editor.interactionActive && !editor.propertyPreviewActive
  const panelRevealSide = (target: Element): 'left' | 'right' | null => {
    if (!panelRecoveryReady() || !panelHost.current?.contains(target)) return null
    const button = target.closest('button')
    const side = !showLayers && button && button === leftPanelToggle.current ? 'left' :
      !showInspector && button && button === rightPanelToggle.current ? 'right' : null
    if (!side) return null
    const focus = panelFocus.current[side]
    return !hasPendingEdits(editor) || (focus && panelFocusCurrent(focus)) ? side : null
  }
  const canRefocusPendingPanelInput = (target: Element) => panelRecoveryReady() && hasPendingEdits(editor) &&
    (['left', 'right'] as const).some(side => {
      const focus = panelFocus.current[side]
      return (side === 'left' ? showLayers : showInspector) && !!focus && focus.element === target && panelFocusCurrent(focus)
    })
  const panelRecoveryEntry = (target: Element) => {
    if (panelRevealSide(target)) return true
    if (!panelRecoveryReady() || !hasPendingEdits(editor) || !panelHost.current?.contains(target) ||
      workspaceActions.current?.open || target.closest('summary') !== panelActionsSummary.current) return false
    // The summary only exposes the recovery controls, not permission to use
    // unrelated menu items. Require a reachable target in a hidden panel.
    return (['left', 'right'] as const).some(side => {
      const focus = panelFocus.current[side]
      return !(side === 'left' ? showLayers : showInspector) && !!focus && panelFocusCurrent(focus)
    })
  }
  const togglePanel = (side: 'left' | 'right') => {
    if (!panelRecoveryReady()) return
    const trigger = (side === 'left' ? leftPanelToggle : rightPanelToggle).current
    if (trigger && panelRevealSide(trigger) === side) {
      const focus = panelFocus.current[side]
      if (hasPendingEdits(editor) && focus && panelFocusCurrent(focus)) revealFocus.current = { focus, trigger }
      ;(side === 'left' ? setShowLayers : setShowInspector)(true)
    } else if (!hasPendingEdits(editor) && !editor.interactionActive) {
      ;(side === 'left' ? setShowLayers : setShowInspector)(value => !value)
    }
  }
  useLayoutEffect(() => {
    const recovery = revealFocus.current; revealFocus.current = null
    if (!recovery || !panelRecoveryReady() || !panelHost.current?.contains(recovery.trigger) ||
      recovery.trigger !== (recovery.focus.side === 'left' ? leftPanelToggle : rightPanelToggle).current ||
      !hasPendingEdits(editor) || !panelFocusCurrent(recovery.focus) ||
      !(recovery.focus.side === 'left' ? showLayers : showInspector)) return
    const active = document.activeElement
    if (active !== recovery.trigger && active !== panelActionsSummary.current && active !== recovery.focus.element && active !== document.body) return
    // This is a focus target, not a draft snapshot: never restore values or
    // write state after focus, which can synchronously publish a new owner.
    recovery.focus.element.focus()
  }, [showLayers, showInspector, editor, ready, showHome, uiMinimized, switching, desktopStatus.busy, desktopStatus.transitioning])
  const deferredPreview = useRef<{ document: DesignDocument; version: number; pixels: PreviewPixels } | undefined>(undefined)
  const [saver] = useState(
    () =>
      new SaveCoordinator(backgroundLocalSave.save, (status) => {
        setSaved(status.error ? '自动保存失败' : status.dirty ? '自动保存中…' : '已自动保存到工作副本')
        if (status.error) { const detail = status.error; editor.notify(`保存失败，当前画布已保留：${detail}`, { key: 'saveFailedCanvasRetained', error: detail }) }
      }, (record, version) => {
        const preview = deferredPreview.current
        if (preview?.document.id !== record.document.id || preview.version !== version) return
        deferredPreview.current = undefined
        if (editor.authoredDocument !== preview.document || editor.propertyPreviewActive) return
        void writeStartupPreview({ ...preview.pixels, documentId: record.document.id, revision: record.revision })
          .catch(error => recordLocalError('storage', error, 'STORAGE_ERROR'))
      }),
  )
  useEffect(() => {
    if (!cloudWorkspace || !desktopSession || !ready || showHome || switching || !workspaceAvailable) return
    const id = s.doc.id
    return cloudWorkspace.watch(id, {
      read: () => editor.authoredDocument.id === id ? desktopSession.cloudSnapshot() : undefined,
      install: (expected, next, signal, beforeCommit) => desktopSession.installCloudVersion(next, signal, beforeCommit, expected),
    })
  }, [cloudWorkspace, workspaceAvailable, ready, showHome, switching, s.doc.id, editor, desktopSession])
  useEffect(() => {
    if (!cloudWorkspace || !workspaceAvailable || !desktopSession || desktopStatus.busy) return
    const document = desktopSession.cloudSnapshot()
    if (document) cloudWorkspace.localSaved(document)
  }, [cloudWorkspace, workspaceAvailable, desktopSession, desktopStatus.busy, desktopStatus.revision, s.doc.id])
  const file = useRef<HTMLInputElement>(null)
  const capturePreview = useCallback(async (document: DesignDocument, version: number, pixels: PreviewPixels) => {
    // A property preview may begin while the bitmap/encoding promise is pending.
    // Do not label its pixels as a durable authored revision or startup preview.
    const authored = () => !editor.propertyPreviewActive && editor.authoredDocument === document && editor.state.version === version
    if (source || !authored()) return
    const revision = saver.durableRevision(document.id, version)
    if (revision === undefined) deferredPreview.current = { document, version, pixels }
    else await writeStartupPreview({ ...pixels, documentId: document.id, revision })
  }, [saver, editor])
  const localWindows=useLocalWindows(editor,desktopSession,ready&&!source&&!largeDocument)
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
    if(source){void initializePicking().then(()=>{if(active)setReady(true)}).catch(error=>{if(active)setStartupError(String(error))});return()=>{active=false}}
    if (desktopSession) {
      void initializePicking().then(async () => {
        if (!active) return
        await desktopSession.start()
        if (active) setReady(true)
      }).catch((e) => {
        if (active) { setStartupError(`设计内核载入失败：${String(e)}`); const detail = String(e); editor.notify(`设计内核载入失败：${detail}`, { key: 'kernelStartupFailed', error: detail }) }
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
        if (!record) setSaved('无待保存修改')
        setReady(true)
      })
      .catch((e) => {
        if (!active) return
        recordLocalError('workspace', e, 'STORAGE_ERROR')
        setSaved('本地恢复失败')
        setStartupError('本地恢复失败，文档操作和自动保存已暂停。')
        const detail = e.message
        editor.notify(`本地恢复失败，自动保存已暂停：${detail}`, { key: 'recoveryFailedAutosavePaused', error: detail })
      })
    return () => {
      active = false
    }
  }, [editor, desktopSession, saver])
  useEffect(() => {
    if (!ready || desktopSession || source) return
    const editing = () => hasPendingEdits(editor) || editor.interactionActive || editor.state.busy
    let wasEditing = editing()
    let selectedId = saver.durableRevision(editor.authoredDocument.id, editor.state.version) !== undefined ? editor.authoredDocument.id : undefined
    const buffer = new BufferedAutosave(async () => {
      if (editing() || !saver.dirty) return
      const snapshot = editor.authoredDocument, version = editor.state.version
      await saver.save(snapshot, version)
      if (selectedId !== snapshot.id && editor.authoredDocument.id === snapshot.id) {
        await localSelect(snapshot.id)
        selectedId = snapshot.id
      }
    }, error => { recordLocalError('workspace', error, 'STORAGE_ERROR'); editor.notify(String(error)) })
    const activity = () => {
      const current = editing()
      if (wasEditing && !current && saver.dirty) buffer.schedule()
      wasEditing = current
    }
    const offEdits = editor.subscribeEdits(event => {
      const snapshot = editor.authoredDocument
      if (event.documentId !== snapshot.id || event.session !== editor.sessionGeneration || event.revision !== editor.state.version) return
      if (deferredPreview.current?.document !== snapshot) deferredPreview.current = undefined
      saver.observe(snapshot, event.revision)
      if (saver.dirty) buffer.schedule()
    })
    const offActivity = editor.subscribe(activity), offDrafts = subscribePendingEdits(editor, activity)
    return () => { buffer.cancel(); offEdits(); offActivity(); offDrafts() }
  }, [ready, desktopSession, source, saver, editor])
  useEffect(() => {
    if (desktopSession || source) return
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
    if(source){editor.notify('当前正在编辑独立工作副本，请先返回文档列表。');return false}
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
      if (ready && preserveCurrent && saver.dirty) await saver.save(current.doc, current.version)
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
  async function syncCurrentDesign() {
    if (!cloudWorkspace || !desktopSession || !ready || switching || editor.interactionActive ||
      !editor.settleOwnedPropertyPreview('save') || !commitPendingEdits(editor))
      throw new Error(locale === 'en' ? 'Finish the current edit before syncing.' : '请先完成当前编辑再同步')
    const document = editor.authoredDocument
    if (!desktopSession.cloudSnapshot() && !await desktopSession.save()) throw Error('本机保存尚未完成')
    if (desktopSession.cloudSnapshot() !== document) throw Error('当前文档已变化或仍有本机修改待保存')
    await cloudWorkspace.sync(document)
  }
  async function openLocalFiles() {
    if(source){await source.leave();return}
    fileImports.invalidate()
    try {
      setLocalFiles(await localList())
      setMenu(false)
    } catch (e) {
      recordLocalError('workspace', e, 'STORAGE_ERROR')
      editor.notify(String(e))
    }
  }
  function openPersistentLibrary() {
    if (desktopSession?.supportsWorkspace) setShowWorkspaceLibrary(true)
    else if (desktopSession) setShowCatalog(true)
    else void openLocalFiles()
  }
  useEffect(() => {
    if (!ready || !desktop?.automation || source || largeDocument) return
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
  }, [ready, desktop, editor, desktopSession, largeDocument])
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
      if (largeDocument || source) return
      if (name === 'settings') { openSettings(); return }
      if (name === 'automation-settings') { setMenu(false); setShowAutomation(true); return }
      if (name === 'plugins') { setMenu(false); setShowPlugins(true); return }
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
      else {
        const command = resolveDesktopEditorCommand(name)
        if (command) void dispatchEditorCommand(editor, command)
      }
    }
    const layout = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || shortcutTargetOwnsKeyboard(e.target)) return
      const mode = interfaceLayoutFromShortcut(e)
      if (!mode) return
      e.preventDefault()
      applyInterfaceLayout(mode)
    }
    const shortcut = (e: KeyboardEvent) => {
      if (largeDocument || source) return
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
      } else if (desktopSession && key === 'o' && !e.shiftKey) {
        e.preventDefault(); command('open')
      } else if (desktopSession && key === 'n' && !e.shiftKey) {
        e.preventDefault(); command('new')
      }
    }
    const allAssetsShortcut = (event: KeyboardEvent) => {
      if (!ready || showHome || largeDocument || switching || desktopStatus.busy ||
          desktopStatus.transitioning || editor.interactionActive || event.defaultPrevented ||
          event.keyCode === 229 || shortcutTargetOwnsKeyboard(event.target) ||
          !matchesAllAssetsShortcut(event, shortcutPlatform())) return
      event.preventDefault()
      setMenu(false)
      openExportPanel('assets')
    }
    window.addEventListener('keydown', allAssetsShortcut, true)
    window.addEventListener('keydown', layout)
    window.addEventListener('keydown', shortcut)
    const offCommand = desktop?.onCommand(command)
    const offLaunch = desktop?.plugins?.onLaunch?.(({ grant }) => {
      if (largeDocument || source) return
      pluginLaunchToken.current += 1
      setMenu(false)
      setShowPlugins(true)
      setPluginLaunch({ grant, token: pluginLaunchToken.current })
    })
    const offClose = desktop?.onCloseRequested(({ requestId }) => {
      if (largeDocument || source) return
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
          const detail = String(error)
          editor.notify(`关闭请求失败，设计已保留：${detail}`, { key: 'closeFailedDocumentRetained', error: detail })
        })
    })
    return () => { window.removeEventListener('keydown', allAssetsShortcut, true); window.removeEventListener('keydown', layout); window.removeEventListener('keydown', shortcut); offCommand?.(); offLaunch?.(); offClose?.() }
  }, [editor, desktopSession, desktop, ready, fileImports, openSettings, showHome, switching, desktopStatus.busy, desktopStatus.transitioning, largeDocument, source])
  function resumeEditor() {
    if (!ready) return
    setShowHome(false)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({preventScroll:true}))
  }
  function enterHome() {
    if (!ready || switching || desktopStatus.busy || editor.interactionActive || !commitPendingEdits(editor)) return
    setMenu(false); setShowMove(false); setShowRegions(false); setShowShapes(false); setShowDrawing(false); setShowUtility(false)
    if(source){void source.leave();return}
    setHomeImportError(''); setShowHome(true)
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
  const actionLabels: Record<string, string> = { '撤销': toolbarText.undo, '重做': toolbarText.redo, '左对齐': toolbarText.alignLeft, '水平居中': toolbarText.alignCenter, '右对齐': toolbarText.alignRight, '顶部对齐': toolbarText.alignTop, '垂直居中': toolbarText.alignMiddle, '底部对齐': toolbarText.alignBottom, '水平等距': toolbarText.distributeHorizontal, '垂直等距': toolbarText.distributeVertical }
  const action = (label: string, Icon: GlyphIcon, fn: () => void, disabled = false, menuItem = false) => (
    <button type="button" title={menuItem ? actionLabels[label] || label : undefined} data-tooltip={menuItem ? undefined : label === '撤销' ? `${toolbarText.undo} (${shortcutLabel('undo', shortcutContext)})` : label === '重做' ? `${toolbarText.redo} (${shortcutLabel('redo', shortcutContext)})` : actionLabels[label] || label}
      aria-label={label === '撤销' ? toolbarText.undo : label === '重做' ? toolbarText.redo : actionLabels[label] || label} data-property-preview-undo={label === '撤销' ? '' : undefined} role={menuItem ? 'menuitem' : undefined} tabIndex={menuItem ? -1 : undefined} disabled={disabled}
      onClick={() => { focusCanvas(); fn() }}>
      <Icon size={16} />
    </button>
  )
  const shapeTools = ['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star'].map(id => tools.find(tool => tool.id === id)!)
  const moveTool = tools.find(({ id }) => id === s.tool && ['select', 'hand', 'scale', 'zoom'].includes(id)) || tools.find(({ id }) => id === lastMoveTool)!
  const handTool = tools.find(({ id }) => id === 'hand')!
  const regionTool = tools.find(({ id }) => id === s.tool && ['frame', 'section', 'slice'].includes(id)) || tools.find(({ id }) => id === lastRegionTool)!
  const shapeTool = shapeTools.find(({ id }) => id === s.tool) || tools.find(({ id }) => id === lastShapeTool)!
  const drawingTool = tools.find(({ id }) => id === s.tool && ['pen', 'pencil', 'brush', 'marker', 'washi-tape'].includes(id)) || tools.find(({ id }) => id === lastDrawingTool)!
  const utilityTool = utilityTools.find(({ id }) => id === s.tool) || utilityTools.find(({ id }) => id === lastUtilityTool)!
  const unavailableTools = localizedToolCommands(locale).filter((c) => !c.tool).filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i)
  const MoveIcon = moveTool.icon, RegionIcon = regionTool.icon, ShapeIcon = shapeTool.icon, DrawingIcon = drawingTool.icon
  const UtilityIcon = utilityTool.icon
  const alignment = alignmentAvailability(editor)
  const toolbarCommands = showCommands || showDrawing ? canvasMenuItems(editor) : []
  const commandDisabled = (command: EditorCommand) => {
    const item = toolbarCommands.find(item => item.command === command)
    return !item || !!item.disabled
  }
  const showFileActivity = !showHome && !source?.openingPreview && (!ready || switching || (desktopStatus.transitioning && !desktopPrompt))
  const fileActivity = activityKind({ ready, switching, transitioning: !!(desktopStatus.transitioning && !desktopPrompt), importing })
  const canvasEmpty = !source && (s.doc.pages.find(page => page.id === s.page)?.children.length ?? 0) === 0
  if (largeDocument && desktop?.largeDocument) return <LargeDocumentWorkspace bridge={desktop.largeDocument} parentEditor={editor} initialFile={largeDocument.file}
    renderWorkbench={workspace=><App sourceWorkspace={workspace}/>}
    onExit={file=>{setLargeDocument(null);if(file)queueMicrotask(()=>void importDesignFile(file))}} onWindowClose={async requestId=>{
      const approved=!!desktopSession&&await desktopSession.requestClose()
      const allow=approved&&!!desktopSession?.closeReady
      const response=await desktop.respondToClose({allow,requestId})
      if(!allow||!response.accepted)desktopSession?.cancelClose()
    }}/>
  const saveStatusSource = source
    ? (source.error ? '自动保存或加载失败' : source.busy ? '处理中…' : source.dirty ? '自动保存中…' : '已自动保存到工作副本')
    : desktopSession
      ? (!ready ? '载入中'
        : desktopStatus.operation === 'save' ? '自动保存中…'
        : desktopStatus.conflict ? (desktopSession.supportsWorkspace ? '本机库存在新版本' : '文件已被外部修改')
        : desktopStatus.error ? '操作失败，修改已保留'
        : desktopStatus.dirty ? (desktopStatus.recoveryWarning ? '自动保存有警告' : desktopSession.supportsWorkspace ? '自动保存中…' : '未保存到文件')
        : desktopStatus.warning ? '已写入，有持久化警告'
        : desktopSession.supportsWorkspace ? '已自动保存到工作副本'
        : '已保存到文件')
      : saved
  const saveStatusText = translateProfessional(saveStatusSource, locale)
  const saveStatusHelp = source
    ? translateProfessional('编辑自动保存到独立工作副本，原文件保持不变', locale)
    : desktopSession
      ? translateProfessional(desktopStatus.warning || desktopStatus.recoveryWarning || '编辑自动保存到独立工作副本，原文件保持不变', locale)
      : ''
  const saveStatusTitle = saveStatusHelp && saveStatusHelp !== saveStatusText ? `${saveStatusText} — ${saveStatusHelp}` : saveStatusText
  const designToolbar = (
          <DesignToolbar disabled={!ready || switching || desktopStatus.transitioning || !!source?.nativeCanvas || !!source?.openingPreview || (editor.interactionActive && !editor.propertyPreviewActive)}>
            {ready && !showHome && !source?.nativeCanvas && !source?.openingPreview && !editor.interactionActive && ['rectangle', 'ellipse', 'polygon', 'star', 'frame', 'section', 'slice', 'line', 'arrow', 'pen', 'eraser'].includes(s.tool) && (
              <div className="creation-tool-hint" role="status">
                <b>{localizedToolLabel(s.tool, locale)}</b>
                <span>{s.tool === 'pen' ? toolbarText.penToolHint : s.tool === 'eraser' ? toolbarText.eraserToolHint : s.tool === 'line' || s.tool === 'arrow' ? toolbarText.creationHintLine : toolbarText.creationHint}</span>
              </div>
            )}
            <div className="tool-group">
              <ToolPopover label={toolbarText.moveTools} icon={<MoveIcon size={18} />} open={showMove} onOpenChange={open => openToolbarMenu('move', open)}
                primary={{ label: moveTool.label, title: `${moveTool.label}${moveTool.key ? ` (${moveTool.key})` : ''}`, active: s.tool === moveTool.id, onClick: () => chooseTool(moveTool.id) }}>
                {tools.filter(({ id }) => ['select', 'hand', 'scale', 'zoom'].includes(id)).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={moveTool.id === id} onClick={() => { chooseTool(id); setShowMove(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
              </ToolPopover>
              <ToolPopover label={uiMode === 'sketch' ? (locale === 'en' ? 'Insert' : '置入') : toolbarText.regionTools} icon={<RegionIcon size={18} />} open={showRegions} onOpenChange={open => openToolbarMenu('regions', open)}
                primary={{ label: regionTool.label, title: `${regionTool.label}${regionTool.key ? ` (${regionTool.key})` : ''}`, active: s.tool === regionTool.id, onClick: () => chooseTool(regionTool.id) }}>
                {(['frame', 'section', 'slice'] as const).map(id => tools.find(tool => tool.id === id)!).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={regionTool.id === id} onClick={() => { chooseTool(id); setShowRegions(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
                <button type="button" role="menuitem" tabIndex={-1} onClick={() => { if (!commitPendingEdits(editor)) return; setShowRegions(false); setShowFramePresets(true) }}>{toolbarText.devicePresets}</button>
                {uiMode === 'sketch' && <>
                  {shapeTools.map(({id, label, key, icon: Icon}) =>
                    <button type="button" role="menuitem" tabIndex={-1} key={id} onClick={() => { chooseTool(id); setShowRegions(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>)}
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { chooseTool('text'); setShowRegions(false) }}>{localizedToolLabel('text', locale, '文字')}</button>
                </>}
              </ToolPopover>
              <ToolPopover label={toolbarText.shapeTools} icon={<ShapeIcon size={18} />} open={showShapes} onOpenChange={open => openToolbarMenu('shapes', open)}
                primary={{ label: shapeTool.label, title: `${shapeTool.label}${shapeTool.key ? ` (${shapeTool.key})` : ''}`, active: s.tool === shapeTool.id, onClick: () => chooseTool(shapeTool.id) }}>
                {shapeTools.map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={shapeTool.id === id} onClick={() => { chooseTool(id); setShowShapes(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
              </ToolPopover>
              <ToolPopover label={toolbarText.drawingTools} icon={<DrawingIcon size={18} />} open={showDrawing} onOpenChange={open => openToolbarMenu('drawing', open)}
                primary={{ label: drawingTool.label, title: `${drawingTool.label}${drawingTool.key ? ` (${drawingTool.key})` : ''}`, active: s.tool === drawingTool.id, onClick: () => chooseTool(drawingTool.id) }}>
                {tools.filter(({ id }) => ['pen', 'pencil', 'brush', 'marker', 'washi-tape'].includes(id)).map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={drawingTool.id === id} onClick={() => { chooseTool(id); setShowDrawing(false) }}><Icon size={16} /><span>{label}</span><kbd>{key}</kbd></button>
                ))}
                {(['bend','cut','vector-lasso','eraser','paint-bucket','offset-path','text-path','multiselect'] as const).map(id=><button type="button" role="menuitem" tabIndex={-1} key={id} aria-label={localizedToolLabel(id, locale, utilityToolNames[id])} onClick={()=>{chooseTool(id);setShowDrawing(false)}}>{localizedToolLabel(id, locale, utilityToolNames[id])}</button>)}
                <button type="button" role="menuitem" tabIndex={-1} disabled={s.busy || s.selection.length !== 1 || !editor.topSelection().includes(s.selection[0]) || ['frame', 'section', 'group', 'text'].includes(s.doc.nodes[s.selection[0]]?.kind)} onClick={() => { editor.set({ tool: 'vector', editingVertex: null }); setShowDrawing(false) }}>{toolbarText.editVector}</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('outline-stroke')} onClick={() => { void dispatchEditorCommand(editor, 'outline-stroke'); setShowDrawing(false) }}>{toolbarText.outlineStroke}</button>
              </ToolPopover>
              <button type="button" data-tooltip={`${localizedToolLabel('comments', locale, '评论')}${toolShortcutLabel('comments', shortcutContext) ? ` (${toolShortcutLabel('comments', shortcutContext)})` : ''}`} aria-label={localizedToolLabel('comments', locale, '评论')} aria-pressed={s.tool==='comments'} className={s.tool === 'comments' ? 'active' : ''} onClick={()=>chooseTool('comments')}><toolGlyph.comments size={18} /></button>
              <button type="button" data-tooltip={`${localizedToolLabel('text', locale, '文字')}${toolShortcutLabel('text', shortcutContext) ? ` (${toolShortcutLabel('text', shortcutContext)})` : ''}`} aria-label={localizedToolLabel('text', locale, '文字')} aria-pressed={s.tool === 'text'} className={s.tool === 'text' ? 'active' : ''} onClick={() => chooseTool('text')}><toolGlyph.text size={18} /></button>
              <ToolPopover label={toolbarText.utilityTools} icon={<UtilityIcon size={18} />} open={showUtility} onOpenChange={open => openToolbarMenu('utility', open)}
                primary={{ label: utilityTool.label, title: `${utilityTool.label}${utilityTool.key ? ` (${utilityTool.key})` : ''}`, active: s.tool === utilityTool.id, onClick: () => chooseTool(utilityTool.id) }}>
                {utilityTools.map(({ id, label, key, icon: Icon }) => (
                  <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-label={label} aria-checked={utilityTool.id === id} onClick={() => { chooseTool(id); setShowUtility(false) }}><Icon size={16} /><span>{label}</span>{key ? <kbd>{key}</kbd> : null}</button>
                ))}
                <strong>{toolbarText.decodedUnavailable}</strong>
                {unavailableTools.map((c) => (
                  <button type="button" role="menuitem" tabIndex={-1} key={c.id} disabled title={unavailableReason(c.id, locale) || undefined}>
                    <span>{c.label} · {toolbarText.unavailable}</span>
                  </button>
                ))}
              </ToolPopover>
            </div>
            <i />
            <div className="tool-group">
              {action('撤销', toolGlyph.undo, () => { void dispatchEditorCommand(editor, 'undo') }, !editor.canUndo || s.busy)}
              {action('重做', toolGlyph.redo, () => { void dispatchEditorCommand(editor, 'redo') }, !editor.canRedo || s.busy)}
              <ToolPopover label={uiMode === 'sketch' ? (locale === 'en' ? 'Combine and arrange' : '结合与排列') : toolbarText.arrangeAndEdit} icon={<SlidersHorizontal size={18} />} open={showCommands} onOpenChange={open => openToolbarMenu('commands', open)}>
                {(['eyedropper','measure','comments','annotate'] as const).map(id=><button type="button" role="menuitem" tabIndex={-1} key={id} aria-label={localizedToolLabel(id, locale, utilityToolNames[id])} onClick={()=>{chooseTool(id);setShowCommands(false)}}>{localizedToolLabel(id, locale, utilityToolNames[id])}</button>)}
                <strong>{toolbarText.whiteboardAndResponsive}</strong>{(Object.entries(boardToolNames) as [BoardTool,string][]).map(([id,label])=><button type="button" role="menuitem" tabIndex={-1} key={id} onClick={()=>{chooseTool(id);setShowCommands(false)}}>{localizedToolLabel(id, locale, label)}</button>)}
                <strong>{toolbarText.alignAndDistribute}</strong><div className="arrangement-grid">
                  {action('左对齐', AlignLeft, () => alignSelection(editor, 'x', 'start'), !alignment.align, true)}
                  {action('水平居中', AlignCenterHorizontal, () => alignSelection(editor, 'x', 'center'), !alignment.align, true)}
                  {action('右对齐', AlignRight, () => alignSelection(editor, 'x', 'end'), !alignment.align, true)}
                  {action('顶部对齐', ArrowUpToLine, () => alignSelection(editor, 'y', 'start'), !alignment.align, true)}
                  {action('垂直居中', AlignVerticalJustifyCenter, () => alignSelection(editor, 'y', 'center'), !alignment.align, true)}
                  {action('底部对齐', ArrowDownToLine, () => alignSelection(editor, 'y', 'end'), !alignment.align, true)}
                  {action('水平等距', AlignHorizontalDistributeCenter, () => alignSelection(editor, 'x', 'distribute'), !alignment.distribute, true)}
                  {action('垂直等距', AlignVerticalDistributeCenter, () => alignSelection(editor, 'y', 'distribute'), !alignment.distribute, true)}
                </div>
                <strong>{toolbarText.combineShapes}</strong>
                {([['union', toolbarText.union], ['subtract', toolbarText.subtract], ['intersect', toolbarText.intersect], ['exclude', toolbarText.exclude], ['divide', toolbarText.divideLegacy]] as const).map(([operation, label]) =>
                  <button type="button" role="menuitem" tabIndex={-1} key={operation} disabled={s.selection.length < 2 || s.busy} onClick={() => { void editor.geometry(operation); setShowCommands(false) }}>{label}</button>)}
                <button type="button" role="menuitem" tabIndex={-1} disabled={!s.selection.length || s.busy} onClick={() => { setShowShapeBuilder(true); setShowCommands(false) }}>{toolbarText.shapeBuilder}</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={s.selection.length < 2} onClick={() => { editor.group(true); setShowCommands(false) }}>{toolbarText.maskGroup}</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('group')} onClick={() => { void dispatchEditorCommand(editor, 'group'); setShowCommands(false) }}>{toolbarText.group} <kbd>{shortcutLabel('group', shortcutContext)}</kbd></button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={commandDisabled('ungroup')} onClick={() => { void dispatchEditorCommand(editor, 'ungroup'); setShowCommands(false) }}>{toolbarText.ungroup} <kbd>{shortcutLabel('ungroup', shortcutContext)}</kbd></button>
                <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setShowTools(true); setShowCommands(false) }}>{toolbarText.designSystems}</button>
              </ToolPopover>
              <button type="button" className="command-search-trigger" aria-label={commandSearchText[locale].label} aria-haspopup="dialog" aria-expanded={commandSearchOpen}
                title={shortcutProfile === 'sketch-like' ? `${commandSearchText[locale].label} (${formatShortcutCombo('Mod+K', shortcutContext.platform)} / S)` : commandSearchText[locale].label}
                onClick={() => requestCommandSearch()}>
                <Search size={18} />
              </button>
            </div>
            {uiMode === 'figma' && <div className="figma-view-tools" data-testid="figma-view-tools" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
              <button type="button" aria-label={handTool.label} aria-pressed={s.tool === 'hand'} className={s.tool === 'hand' ? 'active' : ''}
                data-tooltip={`${handTool.label}${handTool.key ? ` (${handTool.key})` : ''}`}
                onClick={() => chooseTool('hand')}>
                <handTool.icon size={16} />
              </button>
              <div ref={setFigmaZoomHost} className="figma-view-zoom" />
            </div>}
    </DesignToolbar>
  )
  return (
    <div
      ref={panelHost}
      onFocusCapture={event => {
        const element = event.target as HTMLElement
        if (!element.matches('input,textarea,select,[contenteditable="true"]')) return
        const side = leftPanel.current?.contains(element) ? 'left' : rightPanel.current?.contains(element) ? 'right' : null
        if (side) panelFocus.current[side] = { element, side, session: editor.sessionGeneration, page: editor.state.page, selection: JSON.stringify(editor.state.selection), section: side === 'left' ? workspaceSection : propertiesTab }
      }}
      style={adaptivePanels.style}
      data-host={desktop ? 'electron' : 'web'}
      data-window-controls={desktop && /Mac OS X/.test(navigator.userAgent) ? 'inset' : undefined}
      data-density={adaptivePanels.density}
      data-ui-mode={uiMode}
      className={`app-shell editor-shell ${showHome ? 'home-route-active' : ''} ${showLayers && !uiMinimized ? '' : 'chrome-hide-layers'} ${(uiMinimized ? !!s.selection.length : showInspector) && !agentDockOpen ? '' : agentDockOpen ? '' : 'chrome-hide-inspector'} ${agentDockOpen ? 'design-agent-open' : ''} ${uiMinimized ? 'chrome-minimized' : ''}`}
      data-history-backend={editor.historyBackend} data-history-operation={editor.historyOperationMode} data-history-frame-bytes={editor.historyFrameBytes}
      data-desktop-ready={desktop ? String(ready) : undefined}
      data-editor-ready={String(ready)}
      data-source-document={source?"true":undefined}
      data-color-picking={s.tool==='eyedropper'}
      aria-busy={switching || desktopStatus.busy}
      onKeyUp={e=>{if(showHome)e.stopPropagation()}}
      onDragOverCapture={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()}}
      onDropCapture={e=>{
        const files=[...e.dataTransfer.files]
        const designFiles=files.filter(f=>/\.(fd|json|svg|svgz|fig|sketch|pdf)$/i.test(f.name))
        const imageFiles=files.filter(f=>RASTER_IMPORT_EXTENSION.test(f.name))
        if(!designFiles.length&&!imageFiles.length)return
        e.preventDefault();e.stopPropagation()
        // A design file dropped onto the home screen opens as a document via
        // the same path as the home import button; images still need an open
        // canvas and keep the previous home-screen ignore.
        if(showHome){ if(designFiles.length===1) void importDesignFile(designFiles[0]); return }
        if(designFiles.length>0){
          if(designFiles.length!==1){editor.notify('请一次导入一个设计文件', { key: 'singleDesignFileRequired' });return}
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
        if (!(e.button === 0 && (panelRecoveryEntry(target) || canRefocusPendingPanelInput(target))) && !penCanvas && target !== document.activeElement && !target.closest('.rich-text-editor') && !commitPendingEdits(editor)) {
          e.preventDefault(); e.stopPropagation(); return
        }
        if (!ready || switching || (desktopStatus.transitioning && !target.closest('[data-desktop-dialog],[data-workspace-tabs],[data-locale-switch]') && !openingNavigation(target,true))) {
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
        if (!((e.key === 'Enter' || e.key === ' ') && panelRecoveryEntry(e.target as Element)) && !penCanvas && !nudgeKey && !(e.target as Element).closest('input,textarea,select,.rich-text-editor') && !commitPendingEdits(editor)) {
          e.preventDefault(); e.stopPropagation(); return
        }
        if (!ready || switching || (desktopStatus.transitioning && !(e.target as Element).closest('[data-desktop-dialog],[data-workspace-tabs],[data-locale-switch]') && !openingNavigation(e.target as Element))) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {showFileActivity && <ActivityBanner activity={fileActivity} label={(!ready && startupError) || activityLabel(fileActivity, locale, source ? 'source' : desktopSession ? 'desktop' : 'web', source?.notice)}>
        {source?.busy&&<button type="button" data-desktop-dialog onClick={source.cancel}>{menuText.stopOperation}</button>}
      </ActivityBanner>}
      {importing && !showHome && !showFileActivity && <ActivityBanner activity="import" label={activityText[locale].importing} />}
      {libraryGap && sketchOpenBlock(libraryGap.error) && <SketchLibraryLocate block={sketchOpenBlock(libraryGap.error)!} error={libraryGap.error} busy={importing} onClose={() => setLibraryGap(null)} onAttach={async libraries => {
        const request = fileImports.begin(editor)
        setImporting(true)
        try {
          const imported = await importStep(request, () => importSketchWithLibraries(libraryGap.file, libraries, libraryGap.file.name.replace(/\.sketch$/i, ''), request.signal))
          request.assertCurrent()
          const document = createImportedCopy(imported.document)
          const opened = await switchDocument(document, undefined, true, request)
          if (!opened || !request.isCurrent()) return
          setLibraryGap(null)
          setHomeImportError('')
          if (imported.warnings.length) setImportReport({ documentId: document.id, warnings: imported.warnings })
          editor.notify('已按库中的真实 ID 补齐并打开')
        } catch (error) {
          if (request.signal.aborted || !request.isCurrent()) return
          const reason = error instanceof Error ? error.message : String(error)
          setLibraryGap({ file: libraryGap.file, error: reason })
          if (showHome) setHomeImportError(reason)
          editor.notify(reason, importInputStatus(error))
        } finally { request.finish(); setImporting(false) }
      }} />}
      {showHome && <LocalHome source={homeSource} ready={ready} startupError={startupError} importError={homeImportError} busy={switching || desktopStatus.busy}
        currentName={s.doc.name} onResume={resumeEditor} onNew={() => switchDocument(blank())}
        onServerWorkspace={workspaceAvailable ? () => setShowCloudWorkspace(true) : undefined}
        onOpenFile={openHomeFile} onImportFile={desktopSession ? () => {
          fileImports.invalidate()
          importMode.current = 'open'
          file.current?.click()
        } : undefined} onSettings={() => {
          homeSettingsFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          openSettings()
        }} />}
      <header className={`editor-header${uiMode === 'sketch' ? ' sketch-window-toolbar' : ''}`}>
        <span className="header-divider" />
        {uiMode === 'sketch' ? designToolbar : null}
        <div className="document-title">
          <button ref={fileMenuTrigger} className="brand" aria-label={panelText.fileMenu} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <img className="brand-mark" src={webPath('/branding/futureox-desgin.svg')} width="28" height="28" alt="" aria-hidden="true" />
            <strong>Futureox Design</strong>
            <ChevronDown size={13} />
          </button>
          <button type="button" className="document-location" title={desktopSession?.supportsWorkspace ? menuText.openLibrary : undefined}
            aria-haspopup={desktopSession?.supportsWorkspace ? 'dialog' : undefined} onClick={openPersistentLibrary}>{desktopSession ? menuText.localDesign : menuText.myDesigns}</button>
          <b>/</b>
          <input
            aria-label={menuText.documentName}
            value={source?.name === '正在打开文件' ? translateProfessional(source.name, locale) : (source?.name || s.doc.name)}
            readOnly={!!source}
            onCompositionStart={() => { titleComposing.current = true; pendingEditsChanged(editor) }}
            onCompositionEnd={() => { titleComposing.current = false; pendingEditsChanged(editor) }}
            onChange={(e) =>
              editor.change('重命名文档', (d) => {
                d.name = e.target.value
              })
            }
          />
          <span className="draft-badge">{panelText.localBadge}</span>
          <button type="button" aria-label={uiMinimized ? menuText.expandUi : menuText.collapseUi} title={`${menuText.collapseUi} / ${menuText.expandUi} (${formatShortcutCombo('Mod+Shift+\\', shortcutContext.platform)})`}
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
            <summary ref={panelActionsSummary} aria-label={menuText.moreActions} title={menuText.moreActions}><SlidersHorizontal size={16} /></summary>
            <div className="workspace-actions-menu" onClick={event => { if ((event.target as Element).closest('button')) { const menu = event.currentTarget.closest('details'); menu?.removeAttribute('open'); menu?.querySelector('summary')?.focus() } }}>
          <button type="button" aria-pressed={showColor} onClick={() => setShowColor((v) => !v)}>
            {menuText.colorHdr}
          </button>
          <button
            type="button"
            aria-pressed={showAnimation}
            onClick={() => setShowAnimation((v) => !v)}
          >
            {menuText.animation}
          </button>
          <button
            type="button"
            aria-pressed={showHistory}
            disabled={!ready||!!source}
            title={menuText.historyTitle}
            onClick={() => setShowHistory(true)}
          >
            {menuText.history}
          </button>
            </div>
          </details>
          <span
            className={`save-status ${(desktopSession ? desktopStatus.error || desktopStatus.warning || desktopStatus.recoveryWarning : saved.includes('失败')) ? 'error' : ''}`}
            title={saveStatusTitle}
            role="status"
          >
            {desktopSession && desktopStatus.dirty ? <span aria-hidden="true">●</span> : <Check size={13} />}
            <span className="save-status-label" title={saveStatusTitle}>{saveStatusText}</span>
          </span>
          {desktopSession&&ready&&<LocalWindowControl editor={editor} session={desktopSession} live={localWindows}/>}
          {!source&&!desktopSession&&<button type="button" disabled={!ready} onClick={() => void openLocalFiles()}>
            <FolderOpen size={16} />{panelText.localFiles}
          </button>}
          <UiModeSwitch />
          <label className="locale-switch" data-locale-switch>
            <span className="sr-only">{panelText.language}</span>
            <select aria-label={panelText.language} value={locale} onChange={event => interfacePreference.set({ locale: event.target.value === 'en' ? 'en' : 'zh-CN' })}>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <DesignAgentLauncher editor={editor} desktop={desktop} disabled={!ready || switching || s.busy} onImport={(file, mode) => void importDesignFile(file, mode)} />
          {uiMode === 'sketch' && <div ref={setSketchZoomHost} className="sketch-window-zoom" />}
          <button type="button" className="prototype-preview-button" aria-label={locale === 'en' ? 'Preview prototype' : '预览原型'} title={locale === 'en' ? 'Preview prototype' : '预览原型'}
            disabled={!s.doc.pages.some((page) => page.children.length)} onClick={() => setShowPrototype(true)}><Play size={16} /><span>{locale === 'en' ? 'Preview' : '预览'}</span></button>
          <button
            className="primary"
            aria-label={locale === 'en' ? 'Export' : '导出'}
            onClick={() => openExportPanel()}
          >
            <Download size={14} />
            {locale === 'en' ? 'Export' : '导出'}
            <ChevronDown size={12} />
          </button>
          <button type="button" className="app-settings-button" aria-label={panelText.openSettings}
            disabled={!ready || switching || desktopStatus.transitioning}
            title={!ready || switching || desktopStatus.transitioning ? translateProfessional('正在处理设计文件，完成后可打开设置', locale) : `${panelText.settingsTitle} (${formatShortcutCombo('Mod+,', shortcutContext.platform)})`}
            aria-haspopup="dialog" aria-expanded={showSettings}
            onClick={openSettings}>
            <SettingsIcon size={16} /><span>{panelText.settingsTitle}</span>
          </button>
          <span className="avatar">{translateProfessional('我', locale)}</span>
        </div>
      </header>
      {desktopSession?.supportsWorkspace && <WorkspaceTabs session={desktopSession} activeId={s.doc.id} />}
      {menu && createPortal(
        <>
          <div className="menu-scrim" onClick={() => setMenu(false)} />
          <AnchoredMenu anchor={fileMenuTrigger.current} className="file-menu" prefer="below">
            <button type="button" onClick={enterHome}><FolderOpen size={15} />{menuText.localHome}</button>
            {uiMode === 'sketch' && <button type="button" className="compact-library-entry" onClick={() => { setMenu(false); openPersistentLibrary() }}>
              {desktopSession ? menuText.localDesign : menuText.myDesigns}
            </button>}
            <button type="button" onClick={openSettings}><SettingsIcon size={15} />{panelText.settingsTitle}</button>
            <button type="button" disabled={!!largeDocument || !!source} onClick={() => { setMenu(false); setShowPlugins(true) }}><Puzzle size={15} />{locale === 'en' ? 'Plugins' : '插件'}</button>
            <button type="button" onClick={() => { const opener = fileMenuTrigger.current; setMenu(false); requestCommandSearch(opener) }}>
              <Search size={15} />{commandSearchText[locale].title}
              {shortcutProfile === 'sketch-like' && <kbd>{formatShortcutCombo('Mod+K', shortcutContext.platform)} / S</kbd>}
            </button>
            <button
              onClick={() => {
                void switchDocument(blank())
              }}
            >
              <Plus size={15} />
              {panelText.newDesign}
            </button>
            {desktopSession ? <>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); setShowCatalog(true) }}>
                <FolderOpen size={15} />{menuText.projectFolder}
              </button>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); void desktopSession.open() }}>
                <FolderOpen size={15} />{menuText.openLocalDesign} <kbd>{formatShortcutCombo('Mod+O', shortcutContext.platform)}</kbd>
              </button>
              <button type="button" disabled={!ready || desktopStatus.busy} onClick={() => { fileImports.invalidate(); setMenu(false); void desktopSession.recover() }}>
                {menuText.recover}
              </button>
            </> : <button onClick={() => void openLocalFiles()}>
              <FolderOpen size={15} />{menuText.localFilesTrash}
            </button>}
            {workspaceAvailable && <button type="button" disabled={!ready || switching} onClick={() => { setMenu(false); setShowCloudWorkspace(true) }}>{cloudWorkspaceLabel}</button>}
            <div className="render-quality" role="group" aria-label={menuText.renderQuality}>
              <span>{menuText.renderQualityShort}</span>
              <button
                aria-pressed={(s.doc.rasterProfile || 'analytic') === 'analytic'}
                disabled={!!s.doc.colorManagement}
                title={s.doc.colorManagement ? menuText.wideGamutTitle : undefined}
                onClick={() =>
                  editor.change('标准渲染质量', (d) => {
                    d.rasterProfile = 'analytic'
                  })
                }
              >
                {menuText.standardQuality}
              </button>
              <button
                aria-pressed={s.doc.rasterProfile === 'figma'}
                onClick={() =>
                  editor.change('精细渲染质量', (d) => {
                    d.rasterProfile = 'figma'
                  })
                }
              >
                {menuText.fineQuality}
              </button>
              <button
                aria-pressed={s.doc.rasterProfile === 'figmaSoftware'}
                title={menuText.figmaQualityTitle}
                onClick={() =>
                  editor.change('Figma 导出兼容渲染', (d) => {
                    d.rasterProfile = 'figmaSoftware'
                  })
                }
              >
                {menuText.figmaExportQuality}
              </button>
            </div>
            <button
              disabled={!ready || desktopStatus.busy}
              onClick={() => {
                if(source){setMenu(false);void source.exportFile()}
                else if (desktopSession) { setMenu(false); void desktopSession.save(true) }
                else void switchDocument(
                  { ...structuredClone(s.doc), id: uid(), name: copyName(s.doc.name, ' 副本') },
                  undefined, false,
                )
              }}
            >
              <Plus size={15} />
              {source?menuText.exportFull:locale==='en'?'Export copy…':'导出副本…'}
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
              {menuText.importFormats}
            </button>
            {!source&&desktop?.largeDocument&&<button type="button" disabled={!ready||switching||desktopStatus.busy||editor.interactionActive} onClick={()=>{if(!commitPendingEdits(editor))return;setMenu(false);setLargeDocument({})}}>{menuText.openLarge}</button>}
            {(['inspect', 'edit'] as const).map(mode => <button type="button" key={mode}
              disabled={!ready || switching || desktopStatus.busy || s.busy || editor.interactionActive || !sketchCapabilities[mode]}
              title={sketchCapabilities[mode] ? (mode === 'inspect' ? menuText.sketchInspectTitle : menuText.sketchEditTitle) : menuText.sketchUnavailable}
              onClick={() => { if (!commitPendingEdits(editor)) return; fileImports.invalidate(); setMenu(false); setSketchMode(mode) }}>
              {mode === 'inspect' ? menuText.inspectSketch : menuText.editSketch}
            </button>)}
            <button disabled={!ready || switching || desktopStatus.busy} onClick={() => {
              fileImports.invalidate()
              importMode.current = 'append'
              file.current?.click()
              setMenu(false)
            }}><Plus size={15} />{menuText.appendCanvas}</button>
            <hr />
            <button
              onClick={() => {
                void switchDocument(demo())
              }}
            >
              {menuText.openSample}
            </button>
            <button onClick={() => { void generateExport('visual-svg'); setMenu(false) }}>{menuText.exportVisualSvg}</button>
            <button type="button" disabled={!ready || exportAsset !== null}
              title={menuText.exportSketchTitle}
              onClick={() => void generateSketchExport()}>{menuText.exportSketch}</button>
            <button type="button" onClick={() => { openExportPanel('assets'); setMenu(false) }}>
              {menuText.exportAllAssets}
              <kbd>{formatShortcutCombo('Mod+Shift+E', shortcutContext.platform)}</kbd>
            </button>
            <button onClick={() => { openExportPanel(); setMenu(false) }}>{menuText.exportImages}</button>
            {(['svg', 'png'] as const).map((format) => (
              <button
                key={format}
                onClick={() => {
                  void generateExport(format)
                  setMenu(false)
                }}
              >
                {locale === 'en' ? 'Export' : '导出'} {format.toUpperCase()}
                {format === 'png' ? ' @2x' : ''}
              </button>
            ))}
          </AnchoredMenu>
        </>,
        document.body,
      )}
      <input
        ref={file}
        type="file"
        accept={`.fd,.json,.svg,.svgz,.fig,.sketch,.pdf,${RASTER_FILE_ACCEPT}`}
        hidden
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (!f) return
          if (RASTER_IMPORT_EXTENSION.test(f.name)) {
            if (showHome) editor.notify('请先打开画布，再导入图片', { key: 'openCanvasBeforeImageImport' })
            else await importImageFiles([f])
          } else await importDesignFile(f, importMode.current)
        }}
      />
      {desktopPrompt && <DesktopLeaveDialog name={s.doc.name} reason={desktopPrompt.reason} onDecision={(decision) => {
        desktopPrompt.resolve(decision)
        setDesktopPrompt(null)
      }} />}
      {desktopStatus.conflict && !desktopPrompt && <div className="desktop-conflict" role="alert">
        <span>{translateProfessional(desktopSession?.supportsWorkspace ? '本机库已有新版本，当前画布已保留。可保存副本，或重新从本机库打开。' : '文件已被外部修改，当前画布已保留。请另存为，或打开磁盘上的文件后再编辑。', locale)}</span>
        <button type="button" disabled={desktopStatus.busy} onClick={() => void (desktopSession?.supportsWorkspace ? desktopSession.saveCopy() : desktopSession?.save(true))}>{translateProfessional(desktopSession?.supportsWorkspace ? '保存本机副本' : '另存为', locale)}</button>
        <button type="button" disabled={desktopStatus.busy} onClick={() => { fileImports.invalidate(); if (desktopSession?.supportsWorkspace) setShowWorkspaceLibrary(true); else void desktopSession?.open() }}>{translateProfessional(desktopSession?.supportsWorkspace ? '打开本机库' : '打开磁盘文件', locale)}</button>
      </div>}
      {showExport && <ExportPanel editor={editor} exportSelectedSketch={source?.exportSelectedSketch} initialTarget={exportEntry === 'assets' ? 'assets' : undefined} onClose={() => { setShowExport(false); setExportEntry('merged') }} />}
      {showTools&&<DesignTools editor={editor} onClose={()=>setShowTools(false)}/>}
      {showPrototype && <PrototypePlayer document={s.doc} onClose={() => setShowPrototype(false)} />}
      {showWorkspaceLibrary && desktopSession && <WorkspaceLibrary session={desktopSession} onClose={() => setShowWorkspaceLibrary(false)} />}
      {showCloudWorkspace && cloudWorkspace && desktopSession && <CloudWorkspacePanel workspace={cloudWorkspace} status={cloudStatusInWorkspace} documentId={s.doc.id}
        canSync={ready && !showHome && !switching} locale={locale}
        onDisconnect={() => configureDesktopCloud({ enabled: false })}
        onOpen={async record => {
          const opened = await cloudWorkspace.adopt(record, (signal, beforeCommit) =>
            desktopSession.installCloudVersion(record.document, signal, beforeCommit))
          if (opened) { setMenu(false); setShowHome(false) }
          return opened
        }}
        onSync={syncCurrentDesign} onClose={() => setShowCloudWorkspace(false)} />}
      {showFramePresets && <FramePresetPanel editor={editor} onClose={() => setShowFramePresets(false)} />}
      {showHistory && !source && (
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
          onFiles={libraryRailVisible(uiMode, libraryHostKind(desktopSession)) ? openPersistentLibrary : undefined}
          onTools={() => setShowCommands((value) => !value)} toolsOpen={showCommands} onVariables={() => setShowTools(true)} />
        <div ref={leftPanel} className="adaptive-layers-shell">{source?.navigation}{(!source||source.showLayers)&&<Layers editor={editor} section={workspaceSection} onSection={setWorkspaceSection} showPages={!source}/>}<PanelResizeHandle side="left" blocked={editor.interactionActive || hasPendingEdits(editor)} canResize={() => !editor.interactionActive && !hasPendingEdits(editor)} /></div>
        <div className="canvas-workspace" ref={source?.canvas}>
          {!showHome&&!uiMinimized&&<div className="canvas-panel-toggles" onKeyDown={event=>event.stopPropagation()}>
            <button type="button" ref={leftPanelToggle} className="canvas-panel-toggle left"
              title={`${showLayers?panelText.collapse:panelText.expand} · ${panelText.left}`} aria-label={panelText.left}
              aria-expanded={showLayers} onClick={() => togglePanel('left')}>
              {showLayers?<PanelLeftClose size={15}/>:<PanelLeftOpen size={15}/>}
            </button>
            <button type="button" ref={rightPanelToggle} className="canvas-panel-toggle right"
              title={`${showInspector?panelText.collapse:panelText.expand} · ${panelText.right}`} aria-label={panelText.right}
              aria-expanded={showInspector} onClick={() => togglePanel('right')}>
              {showInspector?<PanelRightClose size={15}/>:<PanelRightOpen size={15}/>}
            </button>
          </div>}
          {source&&<SourceDocumentStatus source={source}/>}
          {importReport?.documentId === s.doc.id && <ImportNotice warnings={importReport.warnings} onClose={() => setImportReport(null)} />}
          <HomeCanvasGate home={showHome}><Canvas editor={editor} peers={localWindows.peers} compactChrome loading={!ready||!!source&&!source.ready}
            blurEffectIndex={blurEffectIndex} onExitBlurEdit={exitBlurEdit}
            onSelectSourcePoint={source?.selectMaterialAt} selectedMaterialBox={source?.selectedMaterialBox} pickSourceMaterial={source?.pickMaterial} prepareSourceDisplay={source?.prepareSourceDisplay} nativeSource={source?.nativeCanvas?.snapshot} openingSource={source?.openingPreview} openingPage={source?.openingPage} focusedMaterial={source?.focusedMaterial} onSourceDetail={source?.onDetail} onSourceViewport={source?.onViewport} hideNative={source?.hideNative} parkNative={source?.parkNative} sourcePageBoxes={source?.pageBoxes} onSourcePresented={source?.onSourcePresented} onNativeSourceStatus={source?.nativeCanvas?.onStatus} onOpenSourcePoint={source?.nativeCanvas?.openPoint??source?.openPreviewPoint}
            startupPreview={startupPreview} onCapturePreview={desktopSession || source ? undefined : capturePreview}
            zoomControlsTarget={uiMode === 'sketch' ? sketchZoomHost : figmaZoomHost} /></HomeCanvasGate>
          {!showHome && ready && canvasEmpty && !switching && !desktopStatus.busy && !importing && <EmptyCanvas title={activityText[locale].emptyTitle} body={activityText[locale].emptyBody} />}
          {uiMode === 'sketch' ? null : designToolbar}
        </div>
        <div ref={rightPanel} className="properties-workspace">
          <PanelResizeHandle side="right" blocked={editor.interactionActive || hasPendingEdits(editor)} canResize={() => !editor.interactionActive && !hasPendingEdits(editor)} />
          <div className="properties-tabs"><div className="properties-tab-buttons" role="tablist" aria-label={menuText.propertiesWorkspace} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault(); event.stopPropagation()
            const next = event.key === 'Home' ? 'design' : event.key === 'End' ? 'prototype' : propertiesTab === 'design' ? 'prototype' : 'design'
            setPropertiesTab(next)
            document.getElementById(`${next}-properties-tab`)?.focus()
          }}>
            <button type="button" role="tab" id="design-properties-tab" tabIndex={propertiesTab === 'design' ? 0 : -1} aria-selected={propertiesTab === 'design'} aria-controls="design-properties" onClick={() => setPropertiesTab('design')}>{panelText.design}</button>
            <button type="button" role="tab" id="prototype-properties-tab" tabIndex={propertiesTab === 'prototype' ? 0 : -1} aria-selected={propertiesTab === 'prototype'} aria-controls="prototype-properties" onClick={() => setPropertiesTab('prototype')}>{panelText.prototype}</button>
            </div>
          </div>
          <div className="properties-content" id={`${propertiesTab}-properties`} role="tabpanel" aria-labelledby={`${propertiesTab}-properties-tab`}>
            {source && !source.showLayers ? <SourcePageInspector source={source} editor={editor} /> : ['comments','annotate'].includes(s.tool) ? <ReviewsPanel editor={editor}/> : propertiesTab === 'design' ? <PendingEditContext.Provider value={editor} key={`${editor.sessionGeneration}:${s.selection.join(',')}`}><Inspector editor={editor} blurEffectIndex={blurEffectIndex} onEditBlur={editBlur} /></PendingEditContext.Provider>
              : <DesignTools editor={editor} initialTab="prototype" embedded onClose={() => setPropertiesTab('design')} />}
          </div>
          <DesignAgentDock editor={editor} desktop={desktop} onImport={(file, mode) => void importDesignFile(file, mode)} />
        </div>
      </main>
      <BatchRenameDialog editor={editor} />
      <CommandSearch editor={editor} />
      {showShapeBuilder && <ShapeBuilderDialog editor={editor} onClose={() => setShowShapeBuilder(false)} />}
      {sketchMode && desktop && <NativeSketchDialog bridge={desktop} mode={sketchMode} suspended={!!desktopPrompt} onClose={() => setSketchMode(null)} returnFocus={fileMenuTrigger.current} onImportCompatibility={() => {
        fileImports.invalidate()
        importMode.current = 'open'
        setSketchMode(null)
        window.setTimeout(() => file.current?.click(), 0)
      }} />}
      {showAnimation && <AnimationPanel editor={editor} onClose={() => setShowAnimation(false)} />}
      {showPlugins && <PluginPanel editor={editor} desktop={desktop} launch={pluginLaunch} returnFocus={fileMenuTrigger.current} onClose={() => { setShowPlugins(false); setPluginLaunch(null) }} />}
      {showSettings && <SettingsDialog editor={editor} desktop={!!desktop} returnFocus={showHome ? homeSettingsFocus.current : fileMenuTrigger.current}
        cloudControls={desktop?.cloud && cloudWorkspace && <DesktopCloudSettings status={cloudStatus} locale={locale} configure={configureDesktopCloud} />}
        busy={workspaceRootBusy} workspaceControls={desktop?.workspaceRoot && <>{!ready && <p role="status">{translateProfessional('设计尚未就绪，暂不能切换工作区目录。', locale)}</p>}<WorkspaceRootControls bridge={desktop.workspaceRoot}
          busy={workspaceRootBusy || !ready || desktopStatus.busy} onChoose={original => {
            if (workspaceRootPending.current || !ready || desktopStatus.busy || !commitPendingEdits(editor)) return
            workspaceRootPending.current = true; setWorkspaceRootBusy(true)
            void chooseWorkspaceRoot(desktop.workspaceRoot!, original, () => setShowSettings(false))
              .then(error => { if (error) editor.notify(`工作区切换失败，当前设计已保留：${error}`, { key: 'workspaceSwitchFailedDocumentRetained', error }) })
              .catch(error => { const detail = String(error); editor.notify(`工作区切换失败，当前设计已保留：${detail}`, { key: 'workspaceSwitchFailedDocumentRetained', error: detail }) })
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
          <section className="remote-modal workspace-library" role="dialog" aria-modal="true" aria-label={translateProfessional('本机文件', locale)}
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
              {translateProfessional('本机文件', locale)}<button autoFocus aria-label={translateProfessional('关闭本机文件', locale)} onClick={() => { fileImports.invalidate(); setLocalFiles(null); focusCanvas() }}>×</button>
            </h2>
            {!localFiles.length && <p>{translateProfessional('编辑后的作品会自动保存在这里。', locale)}</p>}
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
                  {entry.deleted ? translateProfessional('（回收站）', locale) : ''}
                </button>
                <span>{translateProfessional('版本', locale)} {entry.revision}</span>
                <button
                  disabled={entry.id === s.doc.id}
                  onClick={() =>
                    void trashLocalFile(entry.id, !entry.deleted)
                  }
                >
                  {translateProfessional(entry.deleted ? '恢复' : '移入回收站', locale)}
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
      {showAutomation && desktop?.automation && !source && !largeDocument && <NativeAutomationDialog editor={editor} desktop={desktop} onDismiss={()=>setShowAutomation(false)} onHistory={()=>setShowHistory(true)} />}
      <footer>
        <span>
          {s.busy ? <span className="spinner" /> : <span className="footer-dot" />}
          {translateProfessional(canvasStatusLabel(operationStatusText(s.message, s.messagePresentation, locale)), locale)}
        </span>
        <div>
          {s.selection.length ? translateProfessional(`${s.selection.length} 个图层已选择`, locale) : translateProfessional('空格拖动画布 · H 平移 · V 选择', locale)}
          <span>·</span>
          <button onClick={() => editor.reorder('front')} disabled={!s.selection.length}>
            {translateProfessional('置顶', locale)}
          </button>
          <button onClick={() => editor.reorder('back')} disabled={!s.selection.length}>
            {translateProfessional('置底', locale)}
          </button>
          <button onClick={() => editor.ungroup()} disabled={!s.selection.length}>
            {translateProfessional('解除编组', locale)}
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
