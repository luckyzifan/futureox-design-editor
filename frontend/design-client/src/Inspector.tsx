import { RepeatPanel } from './RepeatPanel'
import {BoardPanel} from './BoardPanel'
import { AlignmentControls } from './AlignmentControls'
import { CanvasContextMenu } from './CanvasContextMenu'
import { propertyUnits, dashInUnits } from './property-units'
import { UnitNumberField } from './UnitNumberField'
import { ScaleInspector } from './ScaleInspector'
import { NodeExportPanel } from './NodeExportPanel'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import { PendingEditContext } from './pending-edit-context'
import { pendingOperationEpoch } from './pending-edits'
import { DraftInput } from './DraftInput'
import { ColorInput } from './ColorInput'
import { StrokeProfilePanel } from './StrokeProfilePanel'
import { TextInput } from './TextEditor'
import { TextStylePanel } from './TextStylePanel'
import { clearWholeTextRunColor, setWholeTextFontSize } from './text'
import { parentBounds, rotationDegrees, rotateNode, selectionLocalBounds } from './canvas-view'
import { ComponentPanel } from './ComponentPanel'
import { NumberField } from './fields'
import { LayoutPanel } from './LayoutPanel'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { resizeNodeDimension, selectionMetric } from './selection-properties'
import React, { useContext, useEffect, useSyncExternalStore, useRef, useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, Eye, EyeOff, ImagePlus } from 'lucide-react'
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
import { imageData } from './persistence'
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
  glass: '玻璃折射',
  noise: '噪声',
  texture: '纹理',
}

function PaintEditor({
  value: p,
  onChange,
  maxImagePixels,
}: {
  value: Paint
  onChange: (p: Paint) => void
  maxImagePixels: number
}) {
  const file = useRef<HTMLInputElement>(null)
  const editor = useContext(PendingEditContext), mounted = useRef(true), latestPaint = useRef(p), imageRequest = useRef(0)
  latestPaint.current = p
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return (
    <div className="paint-editor">
      <div className="paint-row">
        <ColorInput label="颜色" value={p.color} onChange={(color) => onChange({ ...p, color })} />
        <select
          aria-label="填充类型"
          value={p.kind}
          onChange={(e) => onChange({ ...p, kind: e.target.value as Paint['kind'] })}
        >
          <option value="solid">纯色</option>
          <option value="linear">线性渐变</option>
          <option value="radial">径向渐变</option>
          <option value="angular">角度渐变</option>
          <option value="diamond">菱形渐变</option>
          <option value="image">图片</option>
        </select>
        <span className="hex">
          {p.color.startsWith('#') ? p.color.slice(1).toUpperCase() : '扩展颜色'}
        </span>
      </div>
      {p.kind !== 'solid' && (
        <details>
          <summary>填充变换 / 图片裁切</summary>
          <div className="field-grid">
            {['缩放 X', '倾斜 Y', '倾斜 X', '缩放 Y', '平移 X', '平移 Y'].map((label, i) => (
              <NumberField
                key={label}
                label={label}
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
            <button onClick={() => onChange({ ...p, transform: undefined })}>重置变换</button>
          </div>
        </details>
      )}
      <div className="field-grid">
        <NumberField
          label="不透明度 %"
          value={p.opacity * 100}
          min={0}
          max={100}
          onChange={(v) => onChange({ ...p, opacity: v / 100 })}
        />
        <select
          aria-label="填充混合模式"
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
          <NumberField
            label="渐变角度"
            value={p.angle}
            onChange={(v) => onChange({ ...p, angle: v })}
          />
          <div
            className="gradient-preview"
            style={{
              background: `linear-gradient(${p.angle}deg,${p.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(',')})`,
            }}
          />
          {p.stops.map((s, i) => (
            <div className="stop-row" key={i}>
              <ColorInput
                label={`色标 ${i + 1}`}
                value={s.color}
                onChange={(color) =>
                  onChange({
                    ...p,
                    stops: p.stops.map((s, k) => (k === i ? { ...s, color } : s)),
                  })
                }
              />
              <NumberField
                label="位置 %"
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
                title="删除色标"
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
          >
            ＋ 添加色标
          </button>
        </>
      )}
      {p.kind === 'image' && (
        <>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
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
          <button className="wide-button" onClick={() => file.current?.click()}>
            <ImagePlus size={14} />
            选择图片
          </button>
          <select
            aria-label="图片适应方式"
            value={p.fit}
            // Tiling replaces the fit placement (the pattern chain starts
            // from its own tiling math, not cover/contain), so the mode is inert while
            // a tile mode is active.
            disabled={!!p.tile && p.tile.mode !== 'none'}
            onChange={(e) => onChange({ ...p, fit: e.target.value as Paint['fit'] })}
          >
            <option value="cover">填充 / 裁剪</option>
            <option value="contain">适应</option>
            <option value="stretch">拉伸</option>
          </select>
          <details className="pattern-tile">
            <summary>图案平铺</summary>
            <div className="field-grid">
              <label aria-label="平铺模式">
                <span>模式</span>
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
                  <option value="none">不平铺</option>
                  <option value="grid">规则平铺</option>
                  <option value="stagger_horizontal">横错列</option>
                  <option value="stagger_vertical">竖错列</option>
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
                  <label key={`${field}${axis}`} aria-label={label}>
                    <span>{label}</span>
                    <input
                      type="number"
                      step={1}
                      min={field === 'size' ? 0 : undefined}
                      placeholder={hint || '0'}
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
            <summary>图片调整</summary>
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
                  <label key={key} className="adjust-row" aria-label={label}>
                    <span>{label}</span>
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
              <button onClick={() => onChange({ ...p, adjust: undefined })}>重置调整</button>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
export function Inspector({ editor }: { editor: Editor }) {
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot),
    ids = s.selection,
    n = s.doc.nodes[ids[0]]
  const update = (fn: (n: DesignNode) => void, label = '修改属性') => editor.updateProperties(ids, fn, label)
  if (s.tool === 'scale') return <ScaleInspector key={`${editor.sessionGeneration}:${s.page}:${s.selection.join(',')}`} editor={editor} />
  if (ids.length > 1) return <MultiSelectionInspector editor={editor} nodes={ids.map((id) => s.doc.nodes[id]).filter(Boolean)} />
  if (!n)
    return (
      <aside className="inspector">
        <div className="panel-tabs">
          <b>设计</b>
          <span>属性</span>
        </div>
        <section>
          <h3>页面</h3>
          <label className="paint-row">
            <ColorInput
              label="页面背景"
              value={s.doc.pages.find((p) => p.id === s.page)!.background}
              onChange={(color) =>
                editor.change('页面背景', (d) => {
                  d.pages.find((p) => p.id === s.page)!.background = color
                })
              }
            />
            <span>画布背景</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.grid}
              onChange={(e) => editor.set({ grid: e.target.checked })}
            />
            显示网格
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.snap}
              onChange={(e) => editor.set({ snap: e.target.checked })}
            />
            智能吸附
          </label>
        </section>
        <section className="empty-inspector">
          <div className="selection-illustration">⌘</div>
          <h3>为想法留一点空间</h3>
          <p>选中图层，探索它的颜色、形状与质感。</p>
          <dl>
            <dt>选择 / 平移</dt>
            <dd>V / H</dd>
            <dt>矩形 / 椭圆</dt>
            <dd>R / O</dd>
            <dt>画板 / 钢笔</dt>
            <dd>F / P</dd>
            <dt>编组</dt>
            <dd>⌘ G</dd>
            <dt>深层选择</dt>
            <dd>⌘ 点击</dd>
            <dt>适合画布</dt>
            <dd>⇧ 1</dd>
          </dl>
        </section>
        <div className="local-badge">独立工作空间 · 本地优先</div>
      </aside>
    )
  const units = propertyUnits(s.doc, n.id)
  const angle = rotationDegrees(n),
    position = parentBounds(n)
  const listControls = (field: 'fills' | 'strokes' | 'effects', i: number) => (
    <div className="mini-actions">
      <button
        title="上移"
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
        title="下移"
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
        title="切换可见性"
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
        title="删除"
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
  return (
    <aside className="inspector" data-node-id={n.id} data-node-name={n.name} aria-label={`${n.name} 属性`}>
      <div className="panel-tabs">
        <span>{ids.length > 1 ? `${ids.length} 个图层` : ({ slice:'切片', frame: '画板', section: '分区', group: '编组', rectangle: '矩形', ellipse: '椭圆', polygon: '多边形', star: '星形', line: '直线', vector: '矢量', text: '文字' }[n.kind])}</span>
        <button type="button" aria-label="更多图层操作" onClick={event => setContext({ x: event.clientX, y: event.clientY })}>⋯</button>
      </div>
      <div className="inspector-scroll">
        <section>

          <h3>位置</h3>
          <AlignmentControls editor={editor}/>
          <div className="field-grid">
            <NumberField
              label="X"
              value={position.x * units.parentX}
              onChange={(v) =>
                update((n) => {
                  n.transform[4] += v / units.parentX - parentBounds(n).x
                })
              }
            />
            <NumberField
              label="Y"
              value={position.y * units.parentY}
              onChange={(v) =>
                update((n) => {
                  n.transform[5] += v / units.parentY - parentBounds(n).y
                })
              }
            />
            <NumberField
              label="旋转 °"
              value={angle}
              onChange={(v) =>
                update((n) => {
                  rotateNode(n, v, selectionLocalBounds(editor.state.doc, n.id))
                })
              }
            />

          </div>
        </section>
        <section>
          <h3>布局</h3>
          <div className="field-grid">
            <NumberField
              label="W"
              value={selectionMetric(n, 'width', s.doc)}
              min={0.01}
              onChange={(v) =>
                update((n) => resizeNodeDimension(n, 'width', v, s.doc))
              }
            />
            <NumberField
              label="H"
              value={selectionMetric(n, 'height', s.doc)}
              min={0.01}
              onChange={(v) =>
                update((n) => resizeNodeDimension(n, 'height', v, s.doc))
              }
            />
          </div>
          <label className="check-row">
            <input type="checkbox" aria-label="锁定宽高比" checked={!!n.constrainProportions}
              onChange={e => update(n => { n.constrainProportions = e.target.checked }, '锁定宽高比')} />
            锁定宽高比
          </label>
          {n.kind === 'ellipse' && !n.network && (
            <div className="field-grid">
              <NumberField label="圆弧起始 °" value={(n.arc?.startAngle ?? 0) * 180 / Math.PI}
                onChange={v => update(n => { n.arc = { sweepAngle: Math.PI * 2, innerRadius: 0, ...n.arc, startAngle: v * Math.PI / 180 } })} />
              <NumberField label="圆弧扫过 °" value={(n.arc?.sweepAngle ?? Math.PI * 2) * 180 / Math.PI} min={-360} max={360}
                onChange={v => update(n => { n.arc = { startAngle: 0, innerRadius: 0, ...n.arc, sweepAngle: v * Math.PI / 180 } })} />
              <NumberField label="圆环内径 %" value={(n.arc?.innerRadius ?? 0) * 100} min={0} max={100}
                onChange={v => update(n => { n.arc = { startAngle: 0, sweepAngle: Math.PI * 2, ...n.arc, innerRadius: v / 100 } })} />
            </div>
          )}
          {['polygon', 'star'].includes(n.kind) && !n.network && <UnitNumberField unitScale={units.style} label="顶点圆角" min={0} value={n.cornerRadius ?? 0}
            onChange={v => update(n => { n.cornerRadius = v })} />}
          {container(n) && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={n.clip}
                onChange={(e) =>
                  update((n) => {
                    n.clip = e.target.checked
                  })
                }
              />
              裁剪超出内容
            </label>
          )}
          {n.kind!=='slice' && <LayoutPanel editor={editor} node={n} ids={ids} embedded />}
        </section>
        {n.kind!=='slice' && <section>
          <h3>外观</h3>
          <div className="field-grid">
            <NumberField
              label="透明度 %"
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
          <label className="labeled-select">
            混合模式
            <select
              aria-label="混合模式"
              value={n.blend}
              onChange={(e) =>
                update((n) => {
                  n.blend = e.target.value as NodeBlend
                })
              }
            >
              <option value="pass-through">穿透（Pass through）</option>
              {blends.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          {['rectangle', 'frame', 'section'].includes(n.kind) && (
            <>
              <h4>圆角</h4>
              <div className="field-grid">
                {n.radii.map((r, i) => (
                  <UnitNumberField unitScale={units.style}
                    key={i}
                    label={['左上', '右上', '右下', '左下'][i]}
                    value={r}
                    min={0}
                    onChange={(v) =>
                      update((n) => {
                        n.radii[i] = v
                      })
                    }
                  />
                ))}
              </div>
              <NumberField
                label="圆角平滑 %"
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
          {['star', 'polygon'].includes(n.kind) && (
            <NumberField
              label="顶点数量"
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
            <NumberField
              label="内半径 %"
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
          {n.kind === 'text' && (
            <>
              <TextInput key={`${editor.sessionGeneration}:${n.id}`} node={n} editor={editor} />
              {n.textPath&&<><NumberField label="沿路径偏移" value={n.textPath.offset} onChange={v=>update(n=>{n.textPath!.offset=v})}/><NumberField label="路径基线偏移" value={n.textPath.normal} onChange={v=>update(n=>{n.textPath!.normal=v})}/><label><input type="checkbox" checked={n.textPath.reverse} onChange={e=>update(n=>{n.textPath!.reverse=e.target.checked})}/>反向路径</label></>}
              <TextStylePanel editor={editor} node={n} ids={ids} />
              <UnitNumberField unitScale={units.style}
                label="字号"
                value={n.fontSize}
                min={1}
                max={1024}
                onChange={(v) =>
                  update((n) => {
                    setWholeTextFontSize(n, v)
                  })
                }
              />
            </>
          )}
        </section>}
        {n.mask && (
          <label>
            蒙版类型
            <select
              aria-label="蒙版类型"
              value={n.maskType || 'alpha'}
              onChange={(e) =>
                update((n) => {
                  n.maskType = e.target.value as 'alpha' | 'luminance'
                })
              }
            >
              <option value="alpha">Alpha</option>
              <option value="luminance">亮度</option>
            </select>
          </label>
        )}
        {n.booleanOperation && (
          <section>
            <h3>可编辑布尔组合</h3>
            <select
              aria-label="布尔运算"
              value={n.booleanOperation}
              onChange={(e) =>
                update((n) => {
                  n.booleanOperation = e.target.value as typeof n.booleanOperation
                })
              }
            >
              {['union', 'subtract', 'intersect', 'exclude'].map((op) => (
                <option key={op}>{op}</option>
              ))}
            </select>
            <p>在图层树选择原图形可继续修改；组合会重新计算。</p>
            <button onClick={() => editor.ungroup()}>释放原图形</button>
          </section>
        )}
        {n.kind!=='slice' && <>
        <VectorBrushPanel editor={editor} node={n}/>
        {(n.pathOffset!==undefined || s.tool==='offset-path') && <NumberField label="路径偏移距离" value={n.pathOffset||0} min={-10000} max={10000} onChange={v=>update(n=>{n.pathOffset=v})}/>}
        <BoardPanel editor={editor} node={n}/>
        <RepeatPanel editor={editor} node={n}/>
        <ComponentPanel editor={editor} node={n} ids={ids} />
        <section>
          <h3>
            填充
            <button
              title="添加填充"
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
                <span>填充 {i + 1}</span>
                {listControls('fills', i)}
              </div>
              <PaintEditor
                maxImagePixels={s.doc.colorManagement ? 8_388_608 : 16_777_216}
                value={p}
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
          {!n.fills.length && <p className="muted">无填充</p>}
        </section>
        <section>
          <h3>
            描边
            <button
              title="添加描边"
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
                <span>描边 {i + 1}</span>
                {listControls('strokes', i)}
              </div>
              <PaintEditor
                maxImagePixels={s.doc.colorManagement ? 8_388_608 : 16_777_216}
                value={st.paint}
                onChange={(p) =>
                  update((n) => {
                    if (n.strokes[i]) n.strokes[i].paint = p
                  })
                }
              />
              <div className="field-grid">
                <UnitNumberField unitScale={units.style}
                  label="粗细"
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
                  aria-label="描边位置"
                  value={st.align}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].align = e.target.value as Stroke['align']
                    })
                  }
                >
                  <option value="center">居中</option>
                  <option value="inside">内部</option>
                  <option value="outside">外部</option>
                </select>
                <select
                  aria-label="端点"
                  value={st.cap}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].cap = e.target.value as Stroke['cap']
                    })
                  }
                >
                  <option value="butt">平头</option>
                  <option value="round">圆头</option>
                  <option value="square">方头</option>
                </select>
                <select
                  aria-label="连接"
                  value={st.join}
                  onChange={(e) =>
                    update((n) => {
                      if (n.strokes[i]) n.strokes[i].join = e.target.value as Stroke['join']
                    })
                  }
                >
                  <option value="round">圆角</option>
                  <option value="miter">尖角</option>
                  <option value="bevel">斜角</option>
                </select>
              </div>
              {['line', 'vector'].includes(n.kind) && <div className="field-grid">
                {(['startMarker', 'endMarker'] as const).map(field => <label key={field}>
                  {field === 'startMarker' ? '起点' : '终点'}
                  <select aria-label={field === 'startMarker' ? '起点箭头' : '终点箭头'} value={st[field] ?? 'none'}
                    onChange={event => update(n => { if (n.strokes[i]) n.strokes[i][field] = event.target.value as NonNullable<Stroke[typeof field]> })}>
                    {([['none','无'],['arrow','线条箭头'],['triangle','实心三角'],['circle','实心圆'],['diamond','实心菱形'],['square','实心方形'],['bar','垂线']] as const).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>)}
              </div>}
              <DraftInput aria-label="虚线" placeholder="虚线，如 8 4" value={dashInUnits(st.dash, units.style)}
                validate={value => { try { dashInUnits(value, 1 / units.style); return true } catch { return false } }}
                onCommit={(value) => update((n) => { if (n.strokes[i]) n.strokes[i].dash = dashInUnits(value, 1 / units.style) })} />
              <StrokeProfilePanel n={n} index={i} editor={editor} update={update} />
              <UnitNumberField unitScale={units.style}
                label="虚线偏移"
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
          <h3>
            效果
            <select
              aria-label="添加效果"
              value=""
              onChange={(e) => {
                if (e.target.value)
                  update((n) => {
                    if (n.effects.length < 16)
                      n.effects.push(effect(e.target.value as Effect['kind']))
                  }, '添加效果')
              }}
            >
              <option value="">＋ 添加</option>
              {Object.entries(effects).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </h3>
          {n.effects.map((fx, i) => (
            <div className="property-card" key={fx.id}>
              <div className="property-title">
                <b>{effects[fx.kind]}</b>
                {listControls('effects', i)}
              </div>
              <div className="field-grid">
                {(['radius', 'x', 'y', 'spread', 'opacity', 'amount'] as const)
                  .filter((k) =>
                    fx.glass || fx.texture
                      ? k === 'radius'
                      : ['shadow', 'inner-shadow'].includes(fx.kind)
                        ? k !== 'amount'
                        : ['blur', 'background-blur'].includes(fx.kind)
                          ? k === 'radius'
                          : ['noise', 'texture'].includes(fx.kind)
                            ? ['amount', 'opacity'].includes(k)
                            : ['radius', 'amount', 'opacity'].includes(k),
                  )
                  .map((key) => (
                    <UnitNumberField unitScale={['radius', 'x', 'y', 'spread'].includes(key) || (key === 'amount' && fx.kind !== 'noise') ? units.style : 1}
                      key={key}
                      label={
                        {
                          radius: fx.glass ? '磨砂' : fx.texture ? '位移半径' : '模糊',
                          x: '偏移 X',
                          y: '偏移 Y',
                          spread: '扩展',
                          opacity: '强度 %',
                          amount:
                            fx.kind === 'glass'
                              ? '折射'
                              : fx.kind === 'noise'
                                ? '颗粒密度'
                                : '纹理幅度',
                        }[key]
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
              </div>
              {fx.kind === 'blur' && <>
                <label className="check-row"><input aria-label="渐变模糊" type="checkbox" checked={!!fx.gradientBlur} onChange={e=>update(n=>{
                  const effect=n.effects[i];if(e.target.checked)effect.gradientBlur={start:[0,0],end:[n.width,0],startCount:0,endCount:4,smooth:true};else delete effect.gradientBlur
                })}/>渐变模糊</label>
                {fx.gradientBlur && <div className="field-grid">
                  {(['start','end'] as const).flatMap(anchor=>([0,1] as const).map(axis=><UnitNumberField key={`${anchor}:${axis}`} unitScale={axis?units.y:units.x} label={`${anchor==='start'?'起点':'终点'} ${axis?'Y':'X'}`} value={fx.gradientBlur![anchor][axis]} onChange={v=>update(n=>{n.effects[i].gradientBlur![anchor][axis]=v})}/>))}
                  {(['startCount','endCount'] as const).map(key=><NumberField key={key} label={key==='startCount'?'起点强度':'终点强度'} min={0} max={64} step={.1} value={fx.gradientBlur![key]} onChange={v=>update(n=>{n.effects[i].gradientBlur![key]=v})}/>)}
                  <label><input aria-label="平滑渐变模糊" type="checkbox" checked={fx.gradientBlur.smooth} onChange={e=>update(n=>{n.effects[i].gradientBlur!.smooth=e.target.checked})}/>平滑权重</label>
                </div>}
              </>}
              {fx.glass && (
                <div className="field-grid">
                  {(
                    ['depth', 'bevelSize', 'refraction', 'dispersion', 'lightAngle', 'lightIntensity'] as const
                  ).map((key) => {
                    const percentage =
                      key === 'refraction' || key === 'dispersion' || key === 'lightIntensity'
                    return (
                      <UnitNumberField unitScale={key === 'depth' || key === 'bevelSize' ? units.style : 1}
                        key={key}
                        label={
                          {
                            depth: '深度',
                            bevelSize: '倒角宽度',
                            refraction: '折射 %',
                            dispersion: '色散 %',
                            lightAngle: '光线角度',
                            lightIntensity: '照明 %',
                          }[key]
                        }
                        value={(fx.glass?.[key] ?? (key === 'bevelSize' ? 1 : 0)) * (percentage ? 100 : 1)}
                        min={key === 'lightAngle' ? -360 : key === 'depth' ? 1 : key === 'bevelSize' ? 0.001 : 0}
                        max={percentage ? 100 : key === 'depth' || key === 'bevelSize' ? 1000 : 360}
                        step={1}
                        onChange={(value) =>
                          update((n) => {
                            const g = n.effects[i]?.glass
                            if (g) g[key] = value / (percentage ? 100 : 1)
                          })
                        }
                      />
                    )
                  })}
                </div>
              )}
              {fx.texture && (
                <>
                  <label>纹理样式
                    <select aria-label="纹理样式" value={fx.texture.noise ?? 'figma'} onChange={event => {
                      const noise = event.target.value as 'figma' | 'gabor' | 'perlin'
                      update(n => { const t = n.effects[i]?.texture; if (t) t.noise = noise })
                    }}>
                      <option value="figma">颗粒</option>
                      <option value="gabor">Gabor</option>
                      <option value="perlin">Perlin</option>
                    </select>
                  </label>
                  <div className="field-grid">
                    {([0, 1] as const).map((axis) => (
                      <UnitNumberField unitScale={axis === 0 ? units.x : units.y}
                        key={axis}
                        label={axis === 0 ? '纹理尺寸 X' : '纹理尺寸 Y'}
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
                    />
                    裁剪到形状
                  </label>
                </>
              )}
              {['shadow', 'inner-shadow'].includes(fx.kind) && (
                <ColorInput
                  label="阴影颜色"
                  value={fx.color}
                  onChange={(color) =>
                    update((n) => {
                      if (n.effects[i]) n.effects[i].color = color
                    })
                  }
                />
              )}
            </div>
          ))}
          {!n.effects.length && <p className="muted">用光影和质感表达层次</p>}
        </section>
        <SelectionColorsPanel editor={editor} />
        </>}
        <NodeExportPanel key={n.id} editor={editor} node={n} />
      </div>
      {context && <CanvasContextMenu editor={editor} x={context.x} y={context.y} worldPoint={editor.selectionBounds()} candidates={[{ id: n.id, name: n.name, locked: n.locked }]} onClose={() => setContext(null)} />}
    </aside>
  )
}
