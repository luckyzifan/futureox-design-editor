import { usePropertyText, propertyOwnerLabel, propertyLayerCount } from './property-interface-messages'
import { RepeatPanel } from './RepeatPanel'
import {BoardPanel} from './BoardPanel'
import { AlignmentControls, FlipControls } from './AlignmentControls'
import { SketchLayerStyle } from './SketchLayerStyle'
import { BlurEffectPanel } from './BlurEffectPanel'
import { canAddSketchEffect, isMotionZoomBlur, isSketchProgressiveBlur, setProgressiveMode } from './blur-settings'
import { GlassEffectPanel, createGlassEffect, prepareGlassFill } from './GlassEffectPanel'
import { GraphicTemplatePanel } from './GraphicTemplatePanel'
import { CanvasContextMenu } from './CanvasContextMenu'
import { propertyUnits, dashInUnits, styleUnitDescription } from './property-units'
import { UnitNumberField } from './UnitNumberField'
import { ScaleInspector } from './ScaleInspector'
import { NodeExportPanel } from './NodeExportPanel'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import { PendingEditContext } from './pending-edit-context'
import { commitPendingEdits, pendingOperationEpoch } from './pending-edits'
import { DraftInput } from './DraftInput'
import { ColorInput } from './ColorInput'
import { LoosePaintColor, SolidFillColorInput } from './ColorPickerPopover'
import { nearestStopIndex } from './color-field'
import { rememberPaintChannel } from './eyedropper-target'
import type { SolidFillTarget } from './property-preview'
import { StrokeProfilePanel } from './StrokeProfilePanel'
import { TextInput } from './TextEditor'
import { TextStylePanel } from './TextStylePanel'
import { TextSizingControls } from './TextSizingControls'
import { clearWholeTextRunColor, setWholeTextFontSize } from './text'
import { selectionParentBounds, rotateNode, selectionLocalBounds } from './canvas-view'
import { formatAngleDegrees } from './selection-handles'
import { figmaRotationDegrees, nodeDegreesForFigmaAngle, type LiveRotation } from './rotation-field'
import { nextConstraint } from './layout-constraints'
import { ComponentPanel } from './ComponentPanel'
import { CornerRadiusFields } from './corner-radius-fields'
import { VectorCornerFields } from './VectorCornerFields'
import { CalculatedDimension, NumberField } from './fields'
import { formatPercent, numericExpression } from './numeric-expression'
import { sketchNumericAnchor } from './sketch-numeric-anchor'
import { LayoutPanel } from './LayoutPanel'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { dispatchEditorCommand } from './editor-commands'
import { desktopBridge } from './desktop'
import { shortcutLabel, shortcutPlatform } from './shortcut-profiles'
import { useShortcutProfile } from './shortcut-preference'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
import { sketchGradientStopOffset } from './canvas-material-handles'
import { FramePresetPanel } from './FramePresetPanel'
import { addSpatialEffect, PreserveDepthControl, SpatialEffectRow, type SpatialKind } from './SpatialEffectsPanel'
import { frameSizePresetGate } from './frame-presets'
import type { PencilCap } from './freehand'
import { canFitFrameContents, editableFrameCrop, figmaPositionOffset, frameCropPatches, resizeNodeDimension, selectionMetric, setNodePosition } from './selection-properties'
import { frameEdgeDisplayLocal, sketchFrameDistance, sketchFrameEdges, sketchNestedFramePins } from './sketch-frame-distance'
import React, { memo, useContext, useEffect, useSyncExternalStore, useRef, useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, Eye, EyeOff, ImagePlus, Link2, Unlink2, RotateCw } from 'lucide-react'
import type { Editor } from './engine'
import { VectorBrushPanel } from './VectorBrushPanel'
import {
  type DesignNode,
  type Paint,
  type Stroke,
  type Effect,
  type Blend,
  type NodeBlend,
  type ImageAdjust,
  type PatternTile,
  paint,
  stroke,
  effect,
  container,
  defaultImageAdjust,
  isIdentityImageAdjust,
  defaultPatternTile,
} from './model'
import { imageData, GIF_FIRST_FRAME_RULE, RASTER_MIME_ACCEPT } from './image-import'
import { kernelNoiseFillPreset } from './kernel/picking'
import { backdropEffect } from './kernel/render-dependency'
const blends: Blend[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'linear-burn',
  'linear-dodge',
]
const effects: Record<Effect['kind'], string> = {
  shadow: '投影',
  'inner-shadow': '内阴影',
  blur: '图层模糊',
  'background-blur': '背景模糊',
  glass: '玻璃',
  noise: '噪声',
  texture: '纹理',
  'color-controls': '颜色调整',
  'gaussian-blur': '高斯模糊', 'motion-blur': '运动模糊', 'zoom-blur':'缩放模糊',
}

function PaintEditor({
  value: p,
  onChange,
  maxImagePixels,
  target,
  channel = 'fill',
}: {
  target?: SolidFillTarget
  value: Paint
  onChange: (p: Paint) => void
  maxImagePixels: number
  channel?: 'fill' | 'stroke'
}) {
  const { tr } = usePropertyText()
  const file = useRef<HTMLInputElement>(null)
  const editor = useContext(PendingEditContext), mounted = useRef(true), latestPaint = useRef(p), imageRequest = useRef(0)
  const [stopAt, setStopAt] = useState(0)
  latestPaint.current = p
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setStopAt(index => Math.min(index, Math.max(0, p.stops.length - 1))) }, [p.stops.length])
  const hex = p.color.startsWith('#') ? p.color.slice(1).toUpperCase() : tr('扩展颜色')
  const changeKind = (next: Paint['kind'] | 'none', patch?: { color: string; opacity: number }) => {
    const base = { ...latestPaint.current, ...patch }
    if (next === 'none') onChange({ ...base, visible: false })
    else onChange({ ...base, kind: next, visible: true })
  }
  return (
    <div className="paint-editor">
      <div className="paint-color-row" onPointerDownCapture={() => rememberPaintChannel(editor, channel)}>
        {target ? <>
          <SolidFillColorInput target={target} label={tr('颜色')} value={p.color} kind={p.kind} onKind={changeKind} channel={channel} />
          <span className="paint-hex">{hex}</span>
          <SolidFillColorInput target={target} label={tr('填充不透明度')} value={formatPercent(p.opacity * 100)} opacity kind={p.kind} onKind={changeKind} channel={channel} />
        </> : <LoosePaintColor label={tr('颜色')} color={p.color} opacity={p.opacity} hex={hex} kind={p.kind} channel={channel} onKind={changeKind}
          onChange={patch => onChange({ ...p, ...patch })} />}
        <select
          className="paint-kind-native"
          aria-label={tr("填充类型")}
          value={p.kind}
          onChange={(e) => onChange(e.target.value==='noise-image' ? {...kernelNoiseFillPreset(),id:p.id,visible:p.visible} : { ...p, kind: e.target.value as Paint['kind'] })}
        >
          <option value="solid">{tr("纯色")}</option>
          <option value="linear">{tr("线性渐变")}</option>
          <option value="radial">{tr("径向渐变")}</option>
          <option value="angular">{tr("角度渐变")}</option>
          <option value="diamond">{tr("菱形渐变")}</option>
          <option value="image">{tr("图片")}</option>
          <option value="noise-image">{tr("噪声图片预设")}</option>
        </select>
      </div>
      {p.kind !== 'solid' && (
        <details>
          <summary>{tr("填充变换 / 图片裁切")}</summary>
          <div className="field-grid">
            {['缩放 X', '倾斜 Y', '倾斜 X', '缩放 Y', '平移 X', '平移 Y'].map((label, i) => (
              <NumberField historyLabel={label} unit="number" diagnosticFamily={2}
                key={label}
                label={tr(label)}
                value={(p.transform || [1, 0, 0, 1, 0, 0])[i]}
                onChange={(v) => {
                  const transform = [
                    ...(p.transform || [1, 0, 0, 1, 0, 0]),
                  ] as import('./model').Matrix
                  transform[i] = v
                  onChange({ ...p, transform })
                }}
              />
            ))}
            <button onClick={() => onChange({ ...p, transform: undefined })}>{tr("重置变换")}</button>
          </div>
        </details>
      )}
      <div className="field-grid">
        {target ? null : <NumberField historyLabel="不透明度 %" diagnosticFamily={11} unit="percent"
          label={tr("不透明度 %")}
          value={p.opacity * 100}
          min={0}
          max={100}
          onChange={(v) => onChange({ ...p, opacity: v / 100 })}
        />}
        <select
          aria-label={tr("填充混合模式")}
          value={p.blend}
          onChange={(e) => onChange({ ...p, blend: e.target.value as Blend })}
        >
          {blends.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>
      {['linear', 'radial', 'angular', 'diamond'].includes(p.kind) && (
        <>
          <NumberField historyLabel="渐变角度" diagnosticFamily={2} unit="angle"
            label={tr("渐变角度")}
            value={p.angle}
            onChange={(v) => onChange({ ...p, angle: v })}
          />
          <div
            className="gradient-preview gradient-stop-bar"
            role="listbox"
            aria-label={tr('色标')}
            style={{
              background: `linear-gradient(90deg,${p.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(',')})`,
            }}
            onPointerDown={event => {
              if ((event.target as Element).closest('button')) return
              const rect = event.currentTarget.getBoundingClientRect()
              if (!rect.width) return
              setStopAt(nearestStopIndex(p.stops, Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))))
            }}
          >
            {p.stops.map((stop, index) => <button type="button" key={index} className="gradient-stop-thumb" aria-pressed={index === stopAt}
              aria-label={`${tr('选择色标')} ${index + 1}`} style={{ left: `${stop.offset * 100}%`, background: stop.color }}
              onClick={() => setStopAt(index)}
              onKeyDown={event => {
                if (interfacePreference.getSnapshot().uiMode !== 'sketch' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
                    event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !/^[0-9=]$/.test(event.key)) return
                event.preventDefault()
                event.stopPropagation()
                if (event.repeat) return
                const offset = sketchGradientStopOffset(p.stops, index, event.key)
                if (offset !== undefined && offset !== stop.offset) {
                  setStopAt(index)
                  onChange({ ...p, stops: p.stops.map((value, at) => at === index ? { ...value, offset } : value) })
                }
              }} />)}
          </div>
          {p.stops.map((s, i) => (
            <div className="stop-row" key={i} data-selected={i === stopAt ? 'true' : undefined}>
              <ColorInput
                label={`${tr("色标")} ${i + 1}`}
                value={s.color}
                onChange={(color) =>
                  onChange({
                    ...p,
                    stops: p.stops.map((s, k) => (k === i ? { ...s, color } : s)),
                  })
                }
              />
              <NumberField historyLabel="位置 %" diagnosticFamily={2} unit="percent"
                label={tr("位置 %")}
                value={s.offset * 100}
                min={0}
                max={100}
                onChange={(v) =>
                  onChange({
                    ...p,
                    stops: p.stops
                      .map((s, k) => (k === i ? { ...s, offset: v / 100 } : s))
                      .sort((a, b) => a.offset - b.offset),
                  })
                }
              />
              <button
                title={tr("删除色标")}
                disabled={p.stops.length <= 2}
                onClick={() => onChange({ ...p, stops: p.stops.filter((_, k) => k !== i) })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            className="text-button"
            onClick={() =>
              onChange({
                ...p,
                stops: [...p.stops, { offset: 0.5, color: '#ffffff' }].sort(
                  (a, b) => a.offset - b.offset,
                ),
              })
            }
          >{tr("＋ 添加色标")}</button>
        </>
      )}
      {p.kind === 'image' && (
        <>
          <input
            ref={file}
            type="file"
            accept={RASTER_MIME_ACCEPT}
            title={GIF_FIRST_FRAME_RULE}
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) {
                const request = ++imageRequest.current, generation = editor?.sessionGeneration, page = editor?.state.page
                const epoch = editor ? pendingOperationEpoch(editor) : 0
                let pageChanged = false
                const unsubscribe = editor?.subscribe(() => { if (editor.state.page !== page) pageChanged = true })
                const current = () => mounted.current && !pageChanged && request === imageRequest.current && latestPaint.current === p &&
                  (!editor || (editor.sessionGeneration === generation && editor.state.page === page && pendingOperationEpoch(editor) === epoch))
                try {
                  const image = await imageData(f, maxImagePixels)
                  if (!current()) return
                  onChange({ ...p, image: image.data })
                } catch (error) {
                  if (current()) alert(String(error))
                } finally {
                  unsubscribe?.()
                }
              }
            }}
          />
          <button className="wide-button" title={GIF_FIRST_FRAME_RULE} onClick={() => file.current?.click()}>
            <ImagePlus size={14} />{tr("选择图片")}</button>
          <select
            aria-label={tr("图片适应方式")}
            value={p.fit}
            // Tiling replaces the fit placement (the pattern chain starts
            // from its own tiling math, not cover/contain), so the mode is inert while
            // a tile mode is active.
            disabled={!!p.tile && p.tile.mode !== 'none'}
            onChange={(e) => onChange({ ...p, fit: e.target.value as Paint['fit'] })}
          >
            <option value="cover">{tr("填充 / 裁剪")}</option>
            <option value="contain">{tr("适应")}</option>
            <option value="stretch">{tr("拉伸")}</option>
          </select>
          <details className="pattern-tile">
            <summary>{tr("图案平铺")}</summary>
            <div className="field-grid">
              <label aria-label={tr("平铺模式")}>
                <span>{tr("模式")}</span>
                <select
                  value={p.tile?.mode ?? 'none'}
                  onChange={(e) => {
                    const mode = e.target.value as PatternTile['mode']
                    // 'none' removes the field: documents stay on the legacy
                    // single-placement path (and pre-14 schemas valid).
                    onChange({
                      ...p,
                      tile: mode === 'none' ? undefined : { ...defaultPatternTile(), mode },
                    })
                  }}
                >
                  <option value="none">{tr("不平铺")}</option>
                  <option value="grid">{tr("规则平铺")}</option>
                  <option value="stagger_horizontal">{tr("横错列")}</option>
                  <option value="stagger_vertical">{tr("竖错列")}</option>
                </select>
              </label>
              {(
                [
                  ['size', 0, '宽', '0 = 原始尺寸'],
                  ['size', 1, '高', '0 = 原始尺寸'],
                  ['offset', 0, '偏移 X', ''],
                  ['offset', 1, '偏移 Y', ''],
                ] as [keyof Pick<PatternTile, 'size' | 'offset'>, 0 | 1, string, string][]
              ).map(([field, axis, label, hint]) => {
                const tile = { ...defaultPatternTile(), ...p.tile }
                return (
                  <label key={`${field}${axis}`} aria-label={tr(label)}>
                    <span>{tr(label)}</span>
                    <input
                      type="number"
                      step={1}
                      min={field === 'size' ? 0 : undefined}
                      placeholder={tr(hint) || '0'}
                      value={tile[field][axis]}
                      onChange={(e) => {
                        const raw = Number(e.target.value)
                        const next: PatternTile = {
                          ...tile,
                          mode: tile.mode === 'none' ? 'grid' : tile.mode,
                          [field]: tile[field].map((_, i) =>
                            i === axis && Number.isFinite(raw) ? raw : tile[field][i],
                          ) as [number, number],
                        }
                        onChange({ ...p, tile: next })
                      }}
                    />
                  </label>
                )
              })}
            </div>
          </details>
          <details className="image-adjust">
            <summary>{tr("图片调整")}</summary>
            <div className="field-grid">
              {(
                [
                  ['exposure', '曝光'],
                  ['contrast', '对比度'],
                  ['temperature', '色温'],
                  ['tint', '色调'],
                  ['highlights', '高光'],
                  ['shadows', '阴影'],
                  ['color', '颜色强度'],
                ] as [keyof ImageAdjust, string][]
              ).map(([key, label]) => {
                const adjust = { ...defaultImageAdjust(), ...p.adjust }
                return (
                  <label key={key} className="adjust-row" aria-label={tr(label)}>
                    <span>{tr(label)}</span>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      step={1}
                      value={Math.round((adjust[key] as number) * 100)}
                      onChange={(e) => {
                        const next: ImageAdjust = { ...adjust, [key]: Number(e.target.value) / 100 }
                        // All-zero removes the field entirely: documents stay
                        // on the identity path (and pre-13 schemas valid).
                        onChange({
                          ...p,
                          adjust: isIdentityImageAdjust(next) ? undefined : next,
                        })
                      }}
                    />
                    <span className="adjust-value">
                      {Math.round((adjust[key] as number) * 100)}
                    </span>
                  </label>
                )
              })}
              <button onClick={() => onChange({ ...p, adjust: undefined })}>{tr("重置调整")}</button>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
const pencilCapChoices = [
  ['butt', '无端点'],
  ['square', '端点方形'],
  ['round', '端点圆形'],
] as const
function PencilCapSection({ editor, cap }: { editor: Editor; cap: PencilCap }) {
  const { tr } = usePropertyText()
  return (
    <section className="pencil-cap-section">
      <h3>{tr('描边')}</h3>
      <div className="pencil-cap-choices" role="radiogroup" aria-label={tr('描边')}>
        {pencilCapChoices.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={cap === value}
            aria-label={tr(label)}
            onClick={() => {
              const pencil = editor.state.pencil
              if ((pencil.cap ?? 'round') === value) return
              editor.set({ pencil: { ...pencil, cap: value } })
            }}
          >
            {tr(label)}
          </button>
        ))}
      </div>
    </section>
  )
}
// Camera presentation updates re-render the parent shell. The controls consume
// the editor's independent panel snapshot and must not rebuild for those frames.
export const Inspector = memo(function Inspector({ editor, blurEffectIndex, blurStopIndex, onSelectBlurStop, onEditBlur, allowSpatial = true }: {
  editor: Editor
  blurEffectIndex?: number
  blurStopIndex?: number
  onSelectBlurStop?: (index: number) => void
  onEditBlur?: (index: number | null) => void
  allowSpatial?: boolean
}) {
  const { uiMode } = useInterfacePreferences()
  const shortcutProfile = useShortcutProfile()
  const { locale, tr } = usePropertyText()
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const [presetFrameId, setPresetFrameId] = useState<string | null>(null)
  const [blurToOpen, setBlurToOpen] = useState<string | null>(null)
  const [spatialOpen, setSpatialOpen] = useState<SpatialKind | null>(null)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot),
    ids = s.selection,
    n = s.doc.nodes[ids[0]]
  const live = useSyncExternalStore(editor.subscribeLiveRotation, () => editor.liveRotation) as LiveRotation | null
  const liveBlur = useSyncExternalStore(editor.subscribeLiveBlur, () => editor.liveBlur)
  const update = (fn: (n: DesignNode) => void, label = '修改属性') => editor.updateProperties(ids, fn, label)
  const [glassToOpen, setGlassToOpen] = useState<string | null>(null)
  if (uiMode === 'sketch' && s.tool === 'graphic') return <GraphicTemplatePanel editor={editor}/>
  if (s.tool === 'scale') return <ScaleInspector key={`${editor.sessionGeneration}:${s.page}:${s.selection.join(',')}`} editor={editor} />
  if (ids.length > 1) return <MultiSelectionInspector editor={editor} nodes={ids.map((id) => s.doc.nodes[id]).filter(Boolean)} />
  if (!n)
    return (
      <aside className="inspector">
        <div className="panel-tabs">
          <b>{tr("设计")}</b>
          <span>{tr("属性")}</span>
        </div>
        <section>
          <h3>{tr("页面")}</h3>
          <label className="paint-row">
            <ColorInput
              label={tr("页面背景")}
              value={s.doc.pages.find((p) => p.id === s.page)!.background}
              onChange={(color) =>
                editor.change('页面背景', (d) => {
                  d.pages.find((p) => p.id === s.page)!.background = color
                })
              }
            />
            <span>{tr("画布背景")}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.grid}
              onChange={(e) => editor.set({ grid: e.target.checked })}
            />{tr("显示网格")}</label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.snap}
              onChange={(e) => editor.set({ snap: e.target.checked })}
            />{tr("智能吸附")}</label>
        </section>
        {uiMode === 'figma' && s.tool === 'pencil'
          ? <PencilCapSection editor={editor} cap={s.pencil.cap ?? 'round'} />
          : <section className="empty-inspector"><p>{tr("选中图层后，在这里编辑颜色、形状与约束。")}</p></section>}
        <div className="local-badge">{tr("独立工作空间 · 本地优先")}</div>
      </aside>
    )
  const parents = editor.parentMap(s.doc)
  const presetGate = frameSizePresetGate(s.doc, s.page, ids, parents)
  const showFramePreset = presetGate === 'ready' || presetGate === 'locked' || presetGate === 'instance'
  const framePresetButton = showFramePreset ? <button type="button" className="frame-size-preset"
    disabled={presetGate !== 'ready' || s.busy || editor.interactionActive}
    onClick={() => { if (commitPendingEdits(editor) && frameSizePresetGate(editor.state.doc, editor.state.page, editor.state.selection, editor.parentMap()) === 'ready') setPresetFrameId(n.id) }}>
    {tr(uiMode === 'sketch' ? '选择模板' : '画框尺寸预设')}
  </button> : null
  const units = propertyUnits(s.doc, n.id, parents)
  const blurReadout = liveBlur && editor.interactionActive
    && liveBlur.session === editor.sessionGeneration && liveBlur.page === s.page
    && liveBlur.documentId === s.doc.id && liveBlur.nodeId === n.id
    ? liveBlur : undefined
  const authoredFills = editor.authoredDocument.nodes[n.id]?.fills ?? n.fills
  const visibleFills = authoredFills.filter(paint => paint.visible && paint.opacity > 0)
  const opaqueFill = visibleFills.length === 1 && visibleFills[0].kind === 'solid'
    && visibleFills[0].blend === 'normal' && visibleFills[0].opacity === 1
    && /^#[0-9a-f]{6}$/i.test(visibleFills[0].color) ? visibleFills[0] : undefined
  const activeBackdrop = opaqueFill && backdropEffect(n.effects)
  const styleDescription = styleUnitDescription(s.doc, [n.id], parents)
  const liveText = live && editor.interactionActive && live.session === editor.sessionGeneration && live.page === s.page && live.documentId === s.doc.id
    ? live.textById[n.id] : undefined
  const angle = liveText !== undefined ? Number(liveText) : figmaRotationDegrees(n.transform),
    position = selectionParentBounds(s.doc, n.id)
  const constraintParent = s.doc.nodes[parents.get(n.id) || '']
  const frameDistance = uiMode === 'sketch' ? sketchFrameDistance(s.doc, n.id, parents) : undefined
  const frameNode = frameDistance ? s.doc.nodes[frameDistance.frameId] : undefined
  const positionOffset = uiMode === 'figma'
    ? figmaPositionOffset(s.doc, n.id, parents)
    : frameDistance ? { x: frameDistance.offsetX, y: frameDistance.offsetY } : { x: 0, y: 0 }
  const constraintFlow = !!constraintParent?.layout && constraintParent.layout.mode !== 'none'
  const directFrameConstraints = !!constraintParent && !constraintParent.graphic
    && (constraintParent.kind === 'frame' || constraintParent.kind === 'section')
    && (!constraintFlow || !!n.sizing?.absolute)
  const showConstraints = directFrameConstraints || (uiMode === 'sketch' && sketchNestedFramePins(s.doc, n.id, parents))
  const updateBounds = (edit: (node: DesignNode) => void) => {
    const source = editor.state.doc
    if (s.frameCrop !== n.id || editableFrameCrop(editor) !== n.id) { update(edit); return }
    editor.updateProperties(ids, (node, draft) => {
      edit(node)
      const { transform, width, height, sizing } = node
      const patches = frameCropPatches(source, node.id, { transform, width, height, sizing })
      for (const id of node.children) if (patches[id]) Object.assign(draft.nodes[id], patches[id])
    }, '裁切画框')
  }
  const resolvePositionInput = (axis: 'x' | 'y') => (text: string, original: number) => {
    const suffix = sketchNumericAnchor(text, axis)
    if (!suffix) return
    const doc = editor.state.doc, layer = doc.nodes[n.id], parents = editor.parentMap(doc)
    const parent = doc.nodes[parents.get(n.id) || '']
    if (parent?.layout && parent.layout.mode !== 'none' && !layer?.sizing?.absolute)
      throw new Error('层叠布局控制该图层的位置')
    const distance = layer && sketchFrameDistance(doc, n.id, parents)
    const frame = distance && doc.nodes[distance.frameId]
    if (!distance || !frame) throw new Error('该图层没有可换算的画框坐标')
    const units = propertyUnits(doc, n.id, parents), box = selectionParentBounds(doc, n.id)
    const scale = axis === 'x' ? units.parentX : units.parentY
    const shift = (axis === 'x' ? distance.offsetX : distance.offsetY) * scale
    const amount = numericExpression(suffix.expression, original, 'length')
    const edges = axis === 'x' ? ['left', 'right'] as const : ['top', 'bottom'] as const
    const local = suffix.anchor === 0.5
      ? ((axis === 'x' ? frame.width - box.width : frame.height - box.height) * scale) / 2 + amount - shift
      : frameEdgeDisplayLocal(edges[suffix.anchor], amount, box, distance, frame, units.parentX, units.parentY).displayLocal
    return { value: local + shift, commit: () => updateBounds(node => setNodePosition(node, axis, local, doc, units)) }
  }
  const positionFields = <>
    <NumberField historyLabel="X" diagnosticFamily={2} unit="length" label="X" value={(position.x + positionOffset.x) * units.parentX}
      resolveInput={uiMode === 'sketch' ? resolvePositionInput('x') : undefined}
      onChange={v => updateBounds(node => setNodePosition(node, 'x', v - positionOffset.x * units.parentX, editor.state.doc, units))} />
    <NumberField historyLabel="Y" diagnosticFamily={2} unit="length" label="Y" value={(position.y + positionOffset.y) * units.parentY}
      resolveInput={uiMode === 'sketch' ? resolvePositionInput('y') : undefined}
      onChange={v => updateBounds(node => setNodePosition(node, 'y', v - positionOffset.y * units.parentY, editor.state.doc, units))} />
  </>
  const writeFrameEdge = (edge: 'right' | 'bottom', value: number) => updateBounds(node => {
    const doc = editor.state.doc
    const distance = sketchFrameDistance(doc, node.id, parents)
    const frame = distance && doc.nodes[distance.frameId]
    if (!distance || !frame) throw new Error('当前图层没有可写的画框距离')
    const box = selectionParentBounds(doc, node.id, node.transform)
    const { axis, displayLocal } = frameEdgeDisplayLocal(edge, value, box, distance, frame, units.parentX, units.parentY)
    setNodePosition(node, axis, displayLocal, doc, units)
  })
  const frameEdges = frameDistance && frameNode ? sketchFrameEdges(position, frameDistance, frameNode) : undefined
  const frameEdgeFields = frameEdges ? <div className="geometry-frame-edges">
    <NumberField historyLabel="距画框右边" diagnosticFamily={2} unit="length" label="距画框右边" caption="右"
      value={frameEdges.right * units.parentX} onChange={value => writeFrameEdge('right', value)} />
    <NumberField historyLabel="距画框下边" diagnosticFamily={2} unit="length" label="距画框下边" caption="下"
      value={frameEdges.bottom * units.parentY} onChange={value => writeFrameEdge('bottom', value)} />
  </div> : null
  const angleField = <NumberField historyLabel="旋转 °" diagnosticFamily={2} unit="angle" label={tr("旋转 °")}
    caption="∠" formatValue={formatAngleDegrees} value={angle}
    onChange={v => update(node => rotateNode(node, nodeDegreesForFigmaAngle(v), selectionLocalBounds(editor.state.doc, node.id)))} />
  const dimensionField = (field: 'width' | 'height') => {
    const label = field === 'width' ? 'W' : 'H', value = selectionMetric(n, field, s.doc, units)
    if (uiMode === 'figma' && n.kind === 'text' && n.sizing?.[field] === 'hug') return <CalculatedDimension label={label} value={value} />
    if (n.sizing?.[field] === 'relative' && !n.sizing.absolute &&
        (constraintParent?.layout?.mode === 'horizontal' || constraintParent?.layout?.mode === 'vertical'))
      return <CalculatedDimension label={label} value={value} />
    return <NumberField historyLabel={label} diagnosticFamily={field === 'width' ? 3 : 4} unit="length" label={label}
      value={value} min={0.01}
      resolveInput={uiMode === 'sketch' ? (text, original) => {
        const suffix = sketchNumericAnchor(text, field)
        if (!suffix) return
        if (suffix.anchor && constraintFlow && !n.sizing?.absolute)
          throw new Error('层叠布局控制该图层的位置')
        return { value: numericExpression(suffix.expression, original, 'length'),
          commit: v => updateBounds(node => resizeNodeDimension(node, field, v, editor.state.doc, undefined, suffix.anchor)) }
      } : undefined}
      onChange={v => updateBounds(node => resizeNodeDimension(node, field, v, editor.state.doc))} />
  }
  const proportion = <label className="geometry-proportion" title={tr("锁定宽高比")}>
    <input type="checkbox" aria-label={tr("锁定宽高比")} checked={!!n.constrainProportions}
      onChange={event => update(node => { node.constrainProportions = event.target.checked }, '锁定宽高比')} />
    {n.constrainProportions ? <Link2 size={14} aria-hidden /> : <Unlink2 size={14} aria-hidden />}
  </label>
  const dimensions = <>
    <div className="geometry-dimensions">
      {dimensionField('width')}
      {uiMode === 'sketch' && proportion}
      {dimensionField('height')}
      {uiMode === 'sketch' ? <div className="geometry-actions"><FlipControls editor={editor} /></div> : proportion}
    </div>
    {container(n) && <label className="check-row geometry-clip">
      <input type="checkbox" checked={n.clip} onChange={event => update(node => { node.clip = event.target.checked })} />
      {tr("裁剪超出内容")}
    </label>}
  </>
  const listControls = (field: 'fills' | 'strokes' | 'effects', i: number) => (
    <div className="mini-actions" onClickCapture={field === 'effects' ? () => onEditBlur?.(null) : undefined}>
      <button
        title={tr("上移")}
        disabled={!i}
        onClick={() =>
          update((n) => {
            const a = n[field]
            if (a[i] && a[i - 1]) {
              [a[i - 1], a[i]] = [a[i], a[i - 1]]
              if (field === 'fills') clearWholeTextRunColor(n)
            }
          })
        }
      >
        <ChevronUp size={13} />
      </button>
      <button
        title={tr("下移")}
        disabled={i === n[field].length - 1}
        onClick={() =>
          update((n) => {
            const a = n[field]
            if (a[i + 1]) {
              [a[i + 1], a[i]] = [a[i], a[i + 1]]
              if (field === 'fills') clearWholeTextRunColor(n)
            }
          })
        }
      >
        <ChevronDown size={13} />
      </button>
      <button
        title={tr("切换可见性")}
        onClick={() =>
          update((n) => {
            if (n[field][i]) {
              n[field][i].visible = !n[field][i].visible
              if (field === 'fills') clearWholeTextRunColor(n)
            }
          })
        }
      >
        {n[field][i].visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <button
        title={tr("删除")}
        onClick={() =>
          update((n) => {
            if (n[field][i]) {
              n[field].splice(i, 1)
              if (field === 'fills') clearWholeTextRunColor(n)
            }
          })
        }
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
  const backdropFillNotice = (effect: Effect) => effect === activeBackdrop && opaqueFill && <div className="effect-fill-notice">
    <p>{tr('不透明填充遮住了此效果')}</p>
    <SolidFillColorInput
      target={{ kind: 'solid-fill', nodeId: n.id, fillId: opaqueFill.id, fillIndex: authoredFills.indexOf(opaqueFill) }}
      value="100" opacity label={tr('调整填充不透明度')} buttonText={tr('调整填充不透明度')}
    />
  </div>
  const usesSketchRamp = (effect: Effect) => !!(effect.gradientBlur?.sketch || effect.inactiveGradientBlur?.parameters.sketch)
  const nativeBlurSettings = (kind: Effect['kind']) =>
    uiMode === 'figma' ? kind === 'blur' || kind === 'background-blur' : isMotionZoomBlur(kind) || isSketchProgressiveBlur(kind)
  return (
    <>
    <aside className="inspector" data-node-id={n.id} data-node-name={n.name} data-geometry-mode={uiMode} aria-label={propertyOwnerLabel(n.name, locale)}>
      {uiMode === 'sketch' && <div className="sketch-inspector-alignment"><AlignmentControls editor={editor} compact /></div>}
      <div className="panel-tabs">
        <span>{n.graphic ? tr('图形容器') : ids.length > 1 ? propertyLayerCount(ids.length, locale) : tr({ slice:'切片', frame: '画板', section: '分区', group: '编组', rectangle: '矩形', ellipse: '椭圆', polygon: '多边形', star: '星形', line: '直线', vector: '矢量', text: '文字' }[n.kind])}</span>
        <button type="button" aria-label={tr("更多图层操作")} onClick={event => setContext({ x: event.clientX, y: event.clientY })}>⋯</button>
      </div>
      <div className="inspector-scroll">
        {styleDescription && <p role="note" className="property-unit-notice">{tr('＊ 最大缩放系数换算。')}{tr(styleDescription)}</p>}
        <section className="geometry-position-section">
          {uiMode === 'sketch' && framePresetButton}
          {uiMode === 'sketch' ? <>
            <div className="geometry-position">{positionFields}{angleField}</div>
            {frameEdgeFields}
            {dimensions}
            {n.kind === 'text' && !constraintParent?.graphic && <TextSizingControls editor={editor} nodes={[n]} sketch />}
          </> : <>
            <h3>{tr("位置")}</h3>
            <AlignmentControls editor={editor} compact />
            <div className="geometry-position">{positionFields}</div>
            <div className="geometry-rotation">
              {angleField}
              <div className="geometry-actions">
                <button type="button" aria-label={tr("顺时针旋转 90°")} title={tr("顺时针旋转 90°")}
                  disabled={s.busy || editor.interactionActive || n.locked}
                  onClick={() => update(node => rotateNode(node, figmaRotationDegrees(node.transform) + 90,
                    selectionLocalBounds(editor.state.doc, node.id)), '旋转 90°')}><RotateCw size={15} /></button>
                <FlipControls editor={editor} />
              </div>
            </div>
          </>}
          {showConstraints && <div className="constraint-box" role="group" aria-label={tr("父画板尺寸约束")}>
            {([
              ['top', 'vertical', 'start', tr('顶部')],
              ['left', 'horizontal', 'start', tr('左侧')],
              ['right', 'horizontal', 'end', tr('右侧')],
              ['bottom', 'vertical', 'end', tr('底部')],
            ] as const).map(([edge, axis, anchor, label]) => {
              const current = n.constraints?.[axis] || 'start'
              return <button key={edge} type="button" className={`constraint-edge edge-${edge}`} aria-label={label}
                aria-pressed={current === anchor || current === 'stretch'}
                title={tr('按住 Shift 同时约束对边')}
                onClick={event => update(node => {
                  node.constraints = { horizontal: 'start', vertical: 'start', ...node.constraints, [axis]: nextConstraint(node.constraints?.[axis] || 'start', anchor, event.shiftKey) }
                }, '修改约束')} />
            })}
            <button type="button" className="constraint-edge edge-center" aria-label={tr('居中')}
              aria-pressed={(n.constraints?.horizontal || 'start') === 'center' && (n.constraints?.vertical || 'start') === 'center'}
              onClick={() => update(node => {
                node.constraints = { horizontal: 'center', vertical: 'center', ...node.constraints }
                node.constraints.horizontal = 'center'
                node.constraints.vertical = 'center'
              }, '修改约束')} />
          </div>}
        </section>
        <section>
          <h3>{tr("布局")}</h3>
          {n.kind==='slice' && uiMode === 'figma' && dimensions}
          {n.kind === 'ellipse' && !n.network && (
            <div className="field-grid">
              <NumberField historyLabel="圆弧起始 °" diagnosticFamily={2} unit="angle" label={tr("圆弧起始 °")} value={(n.arc?.startAngle ?? 0) * 180 / Math.PI}
                onChange={v => update(n => { n.arc = { sweepAngle: Math.PI * 2, innerRadius: 0, ...n.arc, startAngle: v * Math.PI / 180 } })} />
              <NumberField historyLabel="圆弧扫过 °" diagnosticFamily={2} unit="angle" label={tr("圆弧扫过 °")} value={(n.arc?.sweepAngle ?? Math.PI * 2) * 180 / Math.PI} min={-360} max={360}
                onChange={v => update(n => { n.arc = { startAngle: 0, innerRadius: 0, ...n.arc, sweepAngle: v * Math.PI / 180 } })} />
              <NumberField historyLabel="圆环内径 %" diagnosticFamily={2} unit="percent" label={tr("圆环内径 %")} value={(n.arc?.innerRadius ?? 0) * 100} min={0} max={100}
                onChange={v => update(n => { n.arc = { startAngle: 0, sweepAngle: Math.PI * 2, ...n.arc, innerRadius: v / 100 } })} />
            </div>
          )}
          {['polygon', 'star'].includes(n.kind) && !n.network && <UnitNumberField unitDescription={styleDescription} historyLabel="顶点圆角" diagnosticFamily={2} unit="length" unitScale={units.style} label={tr("顶点圆角")} min={0} value={n.cornerRadius ?? 0}
            onChange={v => update(n => { n.cornerRadius = v })} />}
          {uiMode === 'sketch' && n.kind === 'frame' && ids.length === 1 && <button type="button"
            disabled={!canFitFrameContents(s.doc, n) || !editor.topSelection().length}
            onClick={() => void dispatchEditorCommand(editor, 'fit-frame-content')}>
            {tr('调整尺寸以适应内容')} {shortcutLabel('fit-frame-content', { profile: shortcutProfile, platform: shortcutPlatform(), desktop: !!desktopBridge() })}
          </button>}
          {n.kind!=='slice' && <LayoutPanel editor={editor} node={n} ids={ids} uiMode={uiMode} embedded geometry={uiMode === 'figma' ? <>
            {framePresetButton}
            {dimensions}
            {n.kind === 'text' && !constraintParent?.graphic && <TextSizingControls editor={editor} nodes={[n]} />}
          </> : undefined} />}
        </section>
        {n.kind!=='slice' && <section>
          <h3>{tr("外观")}</h3>
          {uiMode === 'sketch' && ids.length === 1 && <SketchLayerStyle key={n.id} editor={editor} node={n} />}
          <div className={uiMode === 'sketch' ? 'sketch-appearance-opacity' : 'field-grid'}>
            <NumberField historyLabel="透明度 %" diagnosticFamily={10} unit="percent"
              label={tr("透明度 %")}
              sliderLabel={uiMode === 'sketch' ? '图层不透明度滑块' : undefined}
              value={n.opacity * 100}
              min={0}
              max={100}
              onChange={(v) =>
                update((n) => {
                  n.opacity = v / 100
                })
              }
            />
          </div>
          <label className="labeled-select">{tr("混合模式")}<select
              aria-label={tr("混合模式")}
              value={n.blend}
              onChange={(e) =>
                update((n) => {
                  n.blend = e.target.value as NodeBlend
                })
              }
            >
              <option value="pass-through">{tr("穿透（Pass through）")}</option>
              {blends.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          {['rectangle', 'frame', 'section'].includes(n.kind) && (
            <>
              <CornerRadiusFields nodeId={n.id} radii={n.radii} tr={tr} update={update} unitDescription={styleDescription} unitScale={units.style} />
              <NumberField historyLabel="圆角平滑 %" diagnosticFamily={2} unit="percent"
                label={tr("圆角平滑 %")}
                value={n.smoothing * 100}
                min={0}
                max={100}
                onChange={(v) =>
                  update((n) => {
                    n.smoothing = v / 100
                  })
                }
              />
            </>
          )}
          {n.kind === 'vector' && n.vectorGeometry?.cornerSource &&
            <VectorCornerFields key={n.id} geometry={n.vectorGeometry} styleScale={units.style}
              styleDescription={styleDescription} update={update}/>}
          {['star', 'polygon'].includes(n.kind) && (
            <NumberField historyLabel="顶点数量" diagnosticFamily={2} unit="number"
              label={tr("顶点数量")}
              value={n.points}
              min={3}
              max={60}
              onChange={(v) =>
                update((n) => {
                  n.points = Math.round(v)
                })
              }
            />
          )}
          {n.kind === 'star' && (
            <NumberField historyLabel="内半径 %" diagnosticFamily={2} unit="percent"
              label={tr("内半径 %")}
              value={n.innerRadius * 100}
              min={1}
              max={99}
              onChange={(v) =>
                update((n) => {
                  n.innerRadius = v / 100
                })
              }
            />
          )}
        </section>}
        {n.kind === 'text' && (
            <section>
              <h3>{tr(uiMode === 'sketch' ? '字符' : '排版')}</h3>
              <TextInput key={`${editor.sessionGeneration}:${n.id}`} node={n} editor={editor} />
              {n.textPath&&<><NumberField historyLabel="沿路径偏移" diagnosticFamily={2} unit="number" label={tr("沿路径偏移")} value={n.textPath.offset} onChange={v=>update(n=>{n.textPath!.offset=v})}/><NumberField historyLabel="路径基线偏移" diagnosticFamily={2} unit="number" label={tr("路径基线偏移")} value={n.textPath.normal} onChange={v=>update(n=>{n.textPath!.normal=v})}/><label><input type="checkbox" checked={n.textPath.reverse} onChange={e=>update(n=>{n.textPath!.reverse=e.target.checked})}/>{tr("反向路径")}</label></>}
              <TextStylePanel editor={editor} node={n} ids={ids} />
              <UnitNumberField unitDescription={styleDescription} historyLabel="字号" diagnosticFamily={2} unit="length" unitScale={units.style}
                label={tr("字号")}
                value={n.fontSize}
                min={1}
                max={1024}
                onChange={(v) =>
                  update((n) => {
                    setWholeTextFontSize(n, v)
                  })
                }
              />
            </section>
        )}
        {n.mask && (
          <label>{tr("蒙版类型")}<select
              aria-label={tr("蒙版类型")}
              value={n.maskType || 'alpha'}
              onChange={(e) =>
                update((n) => {
                  n.maskType = e.target.value as 'alpha' | 'luminance' | 'outline'
                })
              }
            >
              <option value="alpha">Alpha</option>
              <option value="outline">{tr("轮廓")}</option>
              <option value="luminance">{tr("亮度")}</option>
            </select>
          </label>
        )}
        {n.booleanOperation && (
          <section>
            <h3>{tr("可编辑布尔组合")}</h3>
            <select
              aria-label={tr("布尔运算")}
              value={n.booleanOperation}
              onChange={(e) =>
                update((n) => {
                  n.booleanOperation = e.target.value as typeof n.booleanOperation
                })
              }
            >
              <option value="compoundNonzero">{tr("复合路径（非零绕组）")}</option>
              <option value="compoundEvenodd">{tr("复合路径（奇偶规则）")}</option>
              {['union', 'subtract', 'intersect', 'exclude'].map((op) => (
                <option key={op}>{op}</option>
              ))}
            </select>
            <p>{tr("在图层树选择原图形可继续修改；组合会重新计算。")}</p>
            <button onClick={() => editor.ungroup()}>{tr("释放原图形")}</button>
          </section>
        )}
        {n.kind!=='slice' && <>
        <VectorBrushPanel editor={editor} node={n}/>
        {(n.pathOffset!==undefined || s.tool==='offset-path') && <NumberField historyLabel="路径偏移距离" diagnosticFamily={2} unit="number" label={tr("路径偏移距离")} value={n.pathOffset||0} min={-10000} max={10000} onChange={v=>update(n=>{n.pathOffset=v})}/>}
        <BoardPanel editor={editor} node={n}/>
        <RepeatPanel editor={editor} node={n}/>
        <ComponentPanel editor={editor} node={n} ids={ids} />
        {!n.spatial?.preserve3d && <section>
          <h3>{tr("填充")}<button
              title={tr("添加填充")}
              onClick={() =>
                update((n) => {
                  if (n.fills.length < 16) {
                    n.fills.push(paint())
                    clearWholeTextRunColor(n)
                  }
                }, '添加填充')
              }
            >
              <Plus size={15} />
            </button>
          </h3>
          {n.fills.map((p, i) => (
            <div className="property-card" key={p.id}>
              <div className="property-title">
                <span>{tr("填充")}{i + 1}</span>
                {listControls('fills', i)}
              </div>
              <PaintEditor
                maxImagePixels={s.doc.colorManagement ? 8_388_608 : 16_777_216}
                value={p}
                target={p.kind === 'solid' ? { kind: 'solid-fill', nodeId: n.id, fillId: p.id, fillIndex: i } : undefined}
                onChange={(p) =>
                  update((n) => {
                    if (n.fills[i]) {
                      n.fills[i] = { ...p, id: n.fills[i].id }
                      clearWholeTextRunColor(n)
                    }
                  }, '修改填充')
                }
              />
            </div>
          ))}
          {!n.fills.length && <p className="muted">{tr("无填充")}</p>}
        </section>}
        <section>
          <h3>{tr("描边")}<button
              title={tr("添加描边")}
              onClick={() =>
                update((n) => {
                  if (n.strokes.length < 16) n.strokes.push(stroke())
                }, '添加描边')
              }
            >
              <Plus size={15} />
            </button>
          </h3>
          {n.strokes.map((st, i) => (
            <div className="property-card" key={st.id}>
              <div className="property-title">
                <span>{tr("描边")}{i + 1}</span>
                {listControls('strokes', i)}
              </div>
              <PaintEditor
                channel="stroke"
                maxImagePixels={s.doc.colorManagement ? 8_388_608 : 16_777_216}
                value={st.paint}
                onChange={(p) =>
                  update((n) => {
                    if (n.strokes[i]) n.strokes[i].paint = p
                  })
                }
              />
              <div className="field-grid">
                <UnitNumberField unitDescription={styleDescription} historyLabel="粗细" diagnosticFamily={2} unit="number" unitScale={units.style}
                  label={tr("粗细")}
                  value={st.width}
                  min={0}
                  max={10000}
                  onChange={(v) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].width = v
                    })
                  }
                />
                <select
                  aria-label={tr("描边位置")}
                  value={st.align}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].align = e.target.value as Stroke['align']
                    })
                  }
                >
                  <option value="center">{tr("居中")}</option>
                  <option value="inside">{tr("内部")}</option>
                  <option value="outside">{tr("外部")}</option>
                </select>
                <select
                  aria-label={tr("端点")}
                  value={st.cap}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].cap = e.target.value as Stroke['cap']
                    })
                  }
                >
                  <option value="butt">{tr("平头")}</option>
                  <option value="round">{tr("圆头")}</option>
                  <option value="square">{tr("方头")}</option>
                </select>
                <select
                  aria-label={tr("连接")}
                  value={st.join}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].join = e.target.value as Stroke['join']
                    })
                  }
                >
                  <option value="round">{tr("圆角")}</option>
                  <option value="miter">{tr("尖角")}</option>
                  <option value="bevel">{tr("斜角")}</option>
                </select>
              </div>
              {['line', 'vector'].includes(n.kind) && <div className="field-grid">
                {(['startMarker', 'endMarker'] as const).map(field => <label key={field}>
                  {field === 'startMarker' ? tr("起点") : tr("终点")}
                  <select aria-label={tr(field === 'startMarker' ? '起点箭头' : '终点箭头')} value={st[field] ?? 'none'}
                    onChange={event => update(n => { if (n.strokes[i]) n.strokes[i][field] = event.target.value as NonNullable<Stroke[typeof field]> })}>
                    {([['none','无'],['arrow','线条箭头'],['triangle','实心三角'],['circle','实心圆'],['diamond','实心菱形'],['square','实心方形'],['bar','垂线']] as const).map(([value,label]) => <option key={value} value={value}>{tr(label)}</option>)}
                  </select>
                </label>)}
              </div>}
              {styleDescription && <small title={tr(styleDescription)}>{tr('虚线：最大缩放系数换算')}</small>}
              <DraftInput aria-description={styleDescription} title={styleDescription} aria-label={tr("虚线")} placeholder={tr("虚线，如 8 4")} value={dashInUnits(st.dash, units.style)}
                validate={value => { try { dashInUnits(value, 1 / units.style); return true } catch { return false } }}
                onCommit={(value) => update((n) => { if (n.strokes[i]) n.strokes[i].dash = dashInUnits(value, 1 / units.style) })} />
              <label className="check-row">
                <input type="checkbox" aria-label={tr("在拐角居中")} checked={!!st.centerDashes}
                  onChange={event => update(n => { if (n.strokes[i]) n.strokes[i].centerDashes = event.target.checked }, '在拐角居中')} />
                {tr("在拐角居中")}
              </label>
              <StrokeProfilePanel n={n} index={i} editor={editor} update={update} />
              <UnitNumberField unitDescription={styleDescription} historyLabel="虚线偏移" diagnosticFamily={2} unit="number" unitScale={units.style}
                label={tr("虚线偏移")}
                value={st.dashOffset || 0}
                min={-1e7}
                max={1e7}
                onChange={(value) =>
                  update((n) => {
                    if (n.strokes[i]) n.strokes[i].dashOffset = value
                  })
                }
              />
            </div>
          ))}
        </section>
        <section>
          <h3>{tr("效果")}<select
              aria-label={tr("添加效果")}
              value=""
              onChange={(e) => {
                const choice = e.currentTarget.value
                if (choice === 'pose' || choice === 'perspective') {
                  if (allowSpatial && uiMode === 'figma' && addSpatialEffect(editor, n.id, choice)) setSpatialOpen(choice)
                  return
                }
                const kind = choice as Effect['kind'] | ''
                if (!kind || n.effects.length >= 16) return
                if (uiMode === 'sketch' && !canAddSketchEffect(kind, n.effects)) return
                const added = kind === 'glass' ? createGlassEffect(uiMode) : effect(kind)
                if (uiMode === 'sketch' && kind === 'background-blur') added.sketchBackdrop = true
                if (nativeBlurSettings(kind)) added.radius = uiMode === 'figma' ? 4 : 10
                update(target => {
                  if (target.effects.length >= 16 || uiMode === 'sketch' && !canAddSketchEffect(kind, target.effects)) return
                  if (added.glass) prepareGlassFill(target, uiMode)
                  target.effects.push(added)
                }, '添加效果')
                if (added.glass) setGlassToOpen(added.id)
                else if (nativeBlurSettings(kind)) setBlurToOpen(added.id)
              }}
            >
              <option value="">{tr("＋ 添加")}</option>
              {(Object.keys(effects) as Effect['kind'][]).filter(kind =>
                uiMode !== 'sketch' || kind !== 'blur' && kind !== 'zoom-blur').map(kind => (
                <option key={kind} value={kind} disabled={uiMode === 'sketch' && !canAddSketchEffect(kind, n.effects)}>
                  {tr(uiMode === 'sketch' && kind === 'motion-blur' ? '运动和缩放模糊' :
                    uiMode === 'sketch' && kind === 'gaussian-blur' ? effects.blur : effects[kind])}
                </option>
              ))}
              {allowSpatial && uiMode === 'figma' && <>
                <option value="pose" disabled={!!n.spatial?.pose || ['slice', 'section'].includes(n.kind)}>{locale === 'en' ? '3D transform' : '3D 变换'}</option>
                <option value="perspective" disabled={!!n.spatial?.perspective || n.kind !== 'frame' || !!n.graphic}>{locale === 'en' ? 'Perspective' : '透视'}</option>
              </>}
            </select>
          </h3>
          {n.effects.map((fx, i) => nativeBlurSettings(fx.kind) || usesSketchRamp(fx) ?
            <BlurEffectPanel key={`${uiMode}:${fx.id}`} effect={fx} layer={n}
              label={uiMode === 'sketch' && isMotionZoomBlur(fx.kind) ? '运动和缩放模糊' :
                uiMode === 'sketch' && fx.kind === 'gaussian-blur' ? effects.blur : effects[fx.kind]}
              sketchModes={usesSketchRamp(fx) || uiMode === 'sketch' && isSketchProgressiveBlur(fx.kind)}
              blurStopIndex={blurEffectIndex === i ? blurStopIndex : undefined}
              onSelectBlurStop={blurEffectIndex === i ? onSelectBlurStop : undefined}
              styleScale={units.style} coordinateScale={[units.x, units.y]} styleDescription={styleDescription}
              openOnCreate={fx.id === blurToOpen} onOpened={() => setBlurToOpen(null)}
              readout={blurReadout?.effectId === fx.id ? blurReadout : undefined}
              onEdit={onEditBlur && (enable => onEditBlur(enable ? i : null))}
              onChange={(label, apply) => update(node => {
                const current = node.effects.find(effect => effect.id === fx.id)
                if (current) apply(current)
              }, label)}
              actions={listControls('effects', i)} fillNotice={backdropFillNotice(fx)} /> :
            <div className="property-card" key={fx.id}>
              <div className="property-title">
                <b>{tr(effects[fx.kind])}</b>
                {fx.glass && <GlassEffectPanel effect={fx} mode={uiMode} styleScale={units.style}
                  styleDescription={styleDescription}
                  documentSpace={s.doc.colorManagement?.documentSpace === 'display-p3' ? 'display-p3' : 'srgb'}
                  openOnCreate={fx.id === glassToOpen} onOpened={() => setGlassToOpen(null)}
                  onChange={apply => update(node => {
                    const current = node.effects.find(effect => effect.id === fx.id)
                    if (current?.glass) apply(current)
                  }, '修改玻璃效果')}/>}
                {listControls('effects', i)}
              </div>
              {!fx.glass && <div className="field-grid effect-fields">
                {(['radius', 'x', 'y', 'spread', 'opacity', 'amount'] as const)
                  .filter((k) =>
                    ['color-controls','zoom-blur'].includes(fx.kind) ? false : fx.glass || fx.texture
                      ? k === 'radius'
                      : ['shadow', 'inner-shadow'].includes(fx.kind)
                        ? k !== 'amount'
                        : ['blur', 'gaussian-blur', 'motion-blur', 'background-blur'].includes(fx.kind)
                          ? k === 'radius'
                          : ['noise', 'texture'].includes(fx.kind)
                            ? ['amount', 'opacity'].includes(k)
                            : ['radius', 'amount', 'opacity'].includes(k),
                  )
                  .map((key) => (
                    <UnitNumberField unitDescription={['radius', 'x', 'y', 'spread'].includes(key) || (key === 'amount' && fx.kind !== 'noise') ? styleDescription : undefined} historyLabel={
                        {
                          radius: fx.glass ? '磨砂' : fx.texture ? '位移半径' : '模糊',
                          x: '偏移 X',
                          y: '偏移 Y',
                          spread: '扩展',
                          opacity: ['shadow', 'inner-shadow'].includes(fx.kind) ? '不透明度 %' : '强度 %',
                          amount:
                            fx.kind === 'glass'
                              ? '折射'
                              : fx.kind === 'noise'
                                ? '颗粒密度'
                                : '纹理幅度',
                        }[key]
                      } unit={key === 'opacity' ? 'percent' : key === 'radius' && fx.texture ? 'length' : 'number'} diagnosticFamily={2} unitScale={['radius', 'x', 'y', 'spread'].includes(key) || (key === 'amount' && fx.kind !== 'noise') ? units.style : 1}
                      key={key}
                      label={
                        tr({
                          radius: fx.glass ? '磨砂' : fx.texture ? '位移半径' : '模糊',
                          x: '偏移 X',
                          y: '偏移 Y',
                          spread: '扩展',
                          opacity: ['shadow', 'inner-shadow'].includes(fx.kind) ? '不透明度 %' : '强度 %',
                          amount:
                            fx.kind === 'glass'
                              ? '折射'
                              : fx.kind === 'noise'
                                ? '颗粒密度'
                                : '纹理幅度',
                        }[key])
                      }
                      value={key === 'opacity' ? fx[key] * 100 : fx[key]}
                      min={key === 'x' || key === 'y' || key === 'spread' ? -1000 : 0}
                      max={key === 'opacity' ? 100 : 1000}
                      step={key === 'amount' ? 0.05 : 1}
                      onChange={(v) =>
                        update((n) => {
                          if (n.effects[i]) n.effects[i][key] = key === 'opacity' ? v / 100 : v
                        })
                      }
                    />
                  ))}
              </div>}
              {backdropFillNotice(fx)}
              {(fx.kind === 'background-blur' || (fx.colorControls && !(fx.glass && uiMode === 'sketch'))) && <div className="field-grid effect-fields">
                {(['brightness','contrast','saturation','hue'] as const).filter(key => fx.kind !== 'background-blur' || key === 'saturation').map(key => {
                  const controls = fx.colorControls || { space:'srgb' as const, brightness:0, contrast:1, saturation:1, hue:0 }
                  const label = {brightness:'亮度',contrast:'对比度',saturation:'饱和度',hue:'色相（弧度）'}[key]
                  return <NumberField key={key} label={tr(label)} historyLabel={label} unit="number" diagnosticFamily={2}
                    min={key === 'brightness' ? -1 : key === 'hue' ? -Math.PI : 0} max={key === 'brightness' ? 1 : key === 'hue' ? Math.PI : 4}
                    step={0.05} value={controls[key]} onChange={v => update(n => {
                      const target = n.effects[i]
                      target.colorControls = {...(target.colorControls || {space:'srgb' as const,brightness:0,contrast:1,saturation:1,hue:0}), [key]:v}
                    },label)}/>
                })}
              </div>}
              {fx.zoomBlur && <div className="field-grid effect-fields">
                <NumberField label={tr('缩放模糊强度')} historyLabel="缩放模糊强度" unit="number" diagnosticFamily={2} min={0} max={1000} value={fx.zoomBlur.amount} onChange={v=>update(n=>{n.effects[i].zoomBlur!.amount=v})}/>
                {([0,1] as const).map(axis=><NumberField key={axis} label={tr(axis===0?'焦点 X %':'焦点 Y %')} historyLabel="缩放模糊焦点" unit="number" diagnosticFamily={2} min={-1e8} max={1e8} value={(blurReadout?.effectId === fx.id && blurReadout.zoomCenter ? blurReadout.zoomCenter : fx.zoomBlur!.center)[axis]*100} onChange={v=>update(n=>{n.effects[i].zoomBlur!.center[axis]=v/100})}/>)}
              </div>}
              {fx.kind === 'motion-blur' && <NumberField label={tr('方向 °')} historyLabel="运动模糊方向" unit="number" diagnosticFamily={2} min={-1e7} max={1e7} value={fx.motionAngle??0} onChange={v=>update(n=>{n.effects[i].motionAngle=v})}/>}
              {(fx.kind === 'blur' || fx.kind === 'background-blur') && <>
                <label className="check-row"><input aria-label={tr("渐变模糊")} type="checkbox" checked={!!fx.gradientBlur} onChange={e=>update(n=>{
                  setProgressiveMode(n.effects[i], e.target.checked, n.width, n.height)
                })}/>{tr("渐变模糊")}</label>
                {fx.gradientBlur && <div className="field-grid effect-fields">
                  {(['start','end'] as const).flatMap(anchor=>([0,1] as const).map(axis=>{
                    const gradient = blurReadout?.effectId === fx.id && blurReadout.gradient ? blurReadout.gradient : fx.gradientBlur!
                    return <UnitNumberField historyLabel={`${anchor==='start'?'起点':'终点'} ${axis?'Y':'X'}`} unit="number" diagnosticFamily={2} key={`${anchor}:${axis}`} unitScale={axis?units.y:units.x} label={`${tr(anchor==='start'?'起点':'终点')} ${axis?'Y':'X'}`} value={gradient[anchor][axis]} onChange={v=>update(n=>{n.effects[i].gradientBlur![anchor][axis]=v})}/>
                  }))}
                  {(['startCount','endCount'] as const).map(key=><NumberField historyLabel={key==='startCount'?'起点强度':'终点强度'} unit="number" diagnosticFamily={2} key={key} label={tr(key==='startCount'?'起点强度':'终点强度')} min={0} max={64} step={.1} value={fx.gradientBlur![key]} onChange={v=>update(n=>{n.effects[i].gradientBlur![key]=v})}/>)}
                  <label><input aria-label={tr("平滑渐变模糊")} type="checkbox" checked={fx.gradientBlur.smooth} onChange={e=>update(n=>{n.effects[i].gradientBlur!.smooth=e.target.checked})}/>{tr("平滑权重")}</label>
                </div>}
              </>}
              {(fx.zoomBlur || fx.gradientBlur) && fx.visible && onEditBlur &&
                <button type="button" className="wide-button" aria-pressed={blurEffectIndex === i}
                  onClick={() => onEditBlur(blurEffectIndex === i ? null : i)}>
                  {tr(blurEffectIndex === i ? '完成画布编辑' : '在画布上编辑模糊')}
                </button>}
              {fx.texture && (
                <>
                  <label>{tr("纹理样式")}<select aria-label={tr("纹理样式")} value={fx.texture.noise ?? 'figma'} onChange={event => {
                      const noise = event.target.value as 'figma' | 'gabor' | 'perlin'
                      update(n => { const t = n.effects[i]?.texture; if (t) t.noise = noise })
                    }}>
                      <option value="figma">{tr("颗粒")}</option>
                      <option value="gabor">Gabor</option>
                      <option value="perlin">Perlin</option>
                    </select>
                  </label>
                  <div className="field-grid">
                    {([0, 1] as const).map((axis) => (
                      <UnitNumberField historyLabel={axis === 0 ? '纹理尺寸 X' : '纹理尺寸 Y'} unit="length" diagnosticFamily={2} unitScale={axis === 0 ? units.x : units.y}
                        key={axis}
                        label={tr(axis === 0 ? '纹理尺寸 X' : '纹理尺寸 Y')}
                        value={fx.texture?.noiseSize[axis] ?? 8}
                        min={0.001}
                        max={10000}
                        step={0.5}
                        onChange={(value) =>
                          update((n) => {
                            const t = n.effects[i]?.texture
                            if (t) t.noiseSize[axis] = value
                          })
                        }
                      />
                    ))}
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={fx.texture.clipToShape}
                      onChange={(event) => {
                        const checked = event.target.checked
                        update((n) => {
                          const t = n.effects[i]?.texture
                          if (t) t.clipToShape = checked
                        })
                      }}
                    />{tr("裁剪到形状")}</label>
                </>
              )}
              {['shadow', 'inner-shadow'].includes(fx.kind) && (
                <ColorInput
                  label={tr("阴影颜色")}
                  value={fx.color}
                  onChange={(color) =>
                    update((n) => {
                      if (n.effects[i]) n.effects[i].color = color
                    })
                  }
                />
              )}
            </div>
          )}
          {!n.effects.length && !n.spatial && <p className="muted">{tr("用光影和质感表达层次")}</p>}
        </section>
        {allowSpatial && uiMode === 'figma' && (n.spatial || n.kind === 'frame' && !n.graphic &&
          n.children.some(id => s.doc.nodes[id]?.spatial)) && <section>
          <h3>{locale === 'en' ? 'Transform effects' : '变换效果'}</h3>
          {(['pose', 'perspective'] as const).map(kind => n.spatial?.[kind] &&
            <SpatialEffectRow key={kind} editor={editor} layer={n} kind={kind} open={spatialOpen === kind}
              onOpen={open => setSpatialOpen(open ? kind : null)} />)}
          {n.kind === 'frame' && !n.graphic && <PreserveDepthControl editor={editor} layer={n} />}
        </section>}
        <SelectionColorsPanel editor={editor} />
        </>}
        <NodeExportPanel key={n.id} editor={editor} node={n} />
      </div>
      {context && <CanvasContextMenu editor={editor} x={context.x} y={context.y} origin="inspector" worldPoint={editor.selectionBounds()} onClose={() => setContext(null)} />}
    </aside>
    {presetFrameId === n.id && presetGate === 'ready' && <FramePresetPanel editor={editor} intent="apply" onClose={() => setPresetFrameId(null)} />}
    </>
  )
})
