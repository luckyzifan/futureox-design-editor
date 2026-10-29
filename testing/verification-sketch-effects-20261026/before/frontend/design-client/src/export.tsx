import { svgEmbeddedFonts } from './svg-font-embedding'
import { expandRepeats, repeatSourceId, hasRepeats } from './repeat-transforms'
import { roundSvgCoordinates } from './export-options'
import { renderToStaticMarkup } from 'react-dom/server'
import { Scene } from './Renderer'
import { scene, unionBounds, boxPoints, apply, bounds as pointBounds, inverse, multiply, translate } from './geometry'
import { maskChild, container, type DesignDocument, type Bounds } from './model'
import { KernelClient } from './kernel/client'
import { pdfVectorIssues, type ExportTarget } from './export-metadata'
// Keep the existing synchronous public exports; UI-only metadata callers can
// use the light module without pulling React's SVG serializer into startup.
export { pdfVectorIssues, sliceExportTarget, type ExportTarget } from './export-metadata'
import {
  kernelLayout,
  initializePicking,
  kernelTextLayout,
  kernelExportPlan,
  kernelStrokeContours,
  kernelPdfVector,
} from './kernel/picking'

function repeatExport(doc: DesignDocument, target: ExportTarget): {doc: DesignDocument; target: ExportTarget} {
  const expanded = expandRepeats(doc)
  if (expanded === doc) return {doc,target}
  if (target.kind === 'selection') {
    const selected = new Set(target.nodeIds)
    target = {...target,nodeIds:Object.keys(expanded.nodes).filter(id=>selected.has(repeatSourceId(expanded,id)))}
  }
  // The export is a disposable visual snapshot: re-running layout/components
  // after repetition would reposition appearances (especially auto-layout).
  const nodes = Object.fromEntries(Object.entries(expanded.nodes).map(([id,source])=>{
    const n={...source}
    delete n.component;delete n.componentSet;delete n.componentKey;delete n.instance;delete n.instanceOrigin
    delete n.layout;delete n.sizing;delete n.constraints;delete n.connector
    delete n.bindings;delete n.styleRefs;delete n.variableModes
    return [id,n]
  }))
  return {doc:{...expanded,nodes},target}
}
function projectSlice(doc: DesignDocument, pageId: string, target: ExportTarget): DesignDocument {
  if(target.kind!=='slice'||!target.transform)return doc
  const matrix=inverse(target.transform),page=doc.pages.find(p=>p.id===pageId)
  if(!page)throw new Error('切片页面不存在')
  const nodes={...doc.nodes}
  for(const id of page.children)nodes[id]={...nodes[id],transform:multiply(matrix,nodes[id].transform)}
  return {...doc,nodes}
}

/** Page presentation retains its explicit historical 40-unit margin. */
export function exportBounds(doc: DesignDocument, pageId: string, padding = 40) {
  doc = expandRepeats(doc)
  if (!Number.isFinite(padding) || padding < 0 || padding > 1e6)
    throw new Error('页面留白必须为 0–1000000')
  if (!doc.pages.some((p) => p.id === pageId)) throw new Error('导出页面不存在')
  const entries = scene(doc, pageId).filter(e=>doc.nodes[e.id].kind!=='slice')
  const byId = new Map(entries.map((e) => [e.id, e]))
  const masks = new Set(entries.map((e) => maskChild(doc, doc.nodes[e.id])?.id).filter(Boolean))
  const expand = (b: Bounds, margin: number) => ({
    x: b.x - margin,
    y: b.y - margin,
    width: b.width + margin * 2,
    height: b.height + margin * 2,
  })
  const intersect = (a: Bounds, b: Bounds): Bounds => {
    const x = Math.max(a.x, b.x),
      y = Math.max(a.y, b.y)
    return {
      x,
      y,
      width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
    }
  }
  const effectBounds = (id: string, b: Bounds) => {
    const n = doc.nodes[id],
      m = byId.get(id)!.matrix
    const margin =
      n.effects
        .filter((f) => f.visible)
        .reduce(
          (v, f) =>
            v +
            f.radius * 2 +
            Math.abs(f.spread) +
            Math.abs(f.x) +
            Math.abs(f.y) +
            (f.glass
              ? f.glass.depth * (1 + 2 * (f.glass.refraction + f.glass.dispersion * 0.125))
              : f.texture
                ? f.radius * 2
                : f.kind === 'glass' || f.kind === 'texture'
                  ? Math.abs(f.amount) * 2
                  : 0),
          0,
        ) * Math.hypot(m[0], m[1], m[2], m[3])
    return expand(b, margin)
  }
  const visible: Bounds[] = []
  for (const e of entries) {
    const n = doc.nodes[e.id]
    if (
      n.opacity <= 0 ||
      masks.has(e.id) ||
      e.ancestors.some((id) => masks.has(id) || doc.nodes[id].opacity <= 0)
    )
      continue
    if (n.kind === 'group' && !n.fills.some((p) => p.visible) && !n.strokes.some((s) => s.visible))
      continue
    let geometry = e.hitBounds || e.bounds
    if (n.kind === 'text') {
      const ink = kernelTextLayout(n).bounds
      if (ink) {
        const padding = Math.max(0, ((e.hitBounds?.width || e.bounds.width) - e.bounds.width) / 2)
        geometry = unionBounds([
          geometry,
          expand(pointBounds(boxPoints(ink).map((p) => apply(e.matrix, p))), padding),
        ])
      }
    }
    let b = effectBounds(e.id, geometry)
    for (const id of [...e.ancestors].reverse()) {
      const parent = doc.nodes[id],
        entry = byId.get(id)!
      const mask = maskChild(doc, parent),
        maskEntry = mask && byId.get(mask.id)
      if (mask && maskEntry)
        b =
          mask.opacity <= 0
            ? { ...b, width: 0, height: 0 }
            : intersect(b, effectBounds(mask.id, maskEntry.hitBounds || maskEntry.bounds))
      if (parent.clip) b = intersect(b, entry.bounds)
      if (b.width <= 0 || b.height <= 0) break
      b = effectBounds(id, b)
    }
    if (b.width > 0 && b.height > 0) visible.push(b)
  }
  const box = unionBounds(visible)
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: Math.max(1, box.width + padding * 2),
    height: Math.max(1, box.height + padding * 2),
  }
}

/** Frames retain their authored viewport. Leaf strokes include native expanded
 * endpoints, so thin lines and arrowheads can be exported without cropping them.
 * Selection subtrees are isolated from unselected siblings/ancestor effects. */
export function targetBounds(doc: DesignDocument, pageId: string, target: ExportTarget): Bounds {
  if (target.kind === 'page') return exportBounds(doc, pageId, target.padding ?? 40)
  if (target.kind === 'slice') {
    const b=target.bounds
    if (![b.x,b.y,b.width,b.height].every(Number.isFinite) || b.width<=0 || b.height<=0 ||
      Math.max(Math.abs(b.x),Math.abs(b.y),b.width,b.height)>1e9) throw new Error('切片边界无效')
    return { ...b }
  }
  const ids = new Set(target.nodeIds)
  doc = expandRepeats(doc)
  const entries = scene(doc, pageId).filter((entry) => ids.has(repeatSourceId(doc, entry.id)))
  if (!ids.size || ids.size > 1000 || new Set(entries.map(e=>repeatSourceId(doc,e.id))).size !== ids.size)
    throw new Error('请选择当前页面的 1–1000 个可见图层')
  return unionBounds(
    entries
      .filter((entry) => !entry.ancestors.some((id) => ids.has(repeatSourceId(doc,id))))
      .map((entry) => {
        const n=doc.nodes[entry.id]
        if(container(n) || !n.strokes.some(s=>s.visible && s.paint.visible && s.width>0)) return entry.bounds
        const paths=kernelStrokeContours(n)
        const points=paths.flatMap((cs,i)=>n.strokes[i].visible && n.strokes[i].paint.visible?cs.flat().map(p=>apply(entry.matrix,p)):[])
        return points.length?unionBounds([entry.bounds,pointBounds(points)]):entry.bounds
      }),
  )
}

function targetName(doc: DesignDocument, target: ExportTarget) {
  if (target.kind === 'page') return doc.name
  if (target.kind === 'slice')
    return `${doc.name}-slice-${target.bounds.x}-${target.bounds.y}-${target.bounds.width}x${target.bounds.height}`
  const ids = [...new Set(target.nodeIds)].sort()
  return ids.length === 1
    ? `${doc.name}-${doc.nodes[ids[0]].name || ids[0]}`
    : `${doc.name}-selection`
}
export function filename(name: string) {
  return (
    Array.from(name, (character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 180) || 'design'
  )
}
export function svgExportIssues(doc: DesignDocument, pageId: string) {
  const issues = new Set<string>()
  if (doc.colorManagement) issues.add('线性光广色域/HDR 合成')
  if (doc.rasterProfile === 'figmaSoftware' && !doc.colorManagement)
    issues.add('软件渲染的精确像素取整')
  for (const { id } of scene(doc, pageId)) {
    const n = doc.nodes[id]
    if (n.opacity <= 0) continue
    if (n.effects.some((e) => e.visible)) issues.add('滤镜效果')
    if (
      [...n.fills, ...n.strokes.map((s) => s.paint)].some(
        (p) => p.kind === 'angular' || p.kind === 'diamond' || (p.kind === 'image' && p.transform),
      )
    )
      issues.add('扩展渐变或图片裁切')
    if (n.blend === 'pass-through' && (n.opacity < 1 || maskChild(doc, n)))
      issues.add('带透明度或蒙版的穿透组')
  }
  return [...issues]
}
/** Explicit visual exchange mode. SVG embeds a tagged PNG when its vector
 * vocabulary cannot express the document's compositing contract. */
export async function exportVisualSvg(doc: DesignDocument, pageId: string, scale = 2) {
  const issues = svgExportIssues(doc, pageId)
  if (!issues.length) return exportImage(doc, pageId, 'svg', 1)
  const asset = await exportImage(
    doc,
    pageId,
    'png',
    scale,
    doc.colorManagement ? { space: doc.colorManagement.documentSpace, toneMap: 'none' } : undefined,
  )
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  const box = exportBounds(doc, pageId)
  const source = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${box.width} ${box.height}`}
    >
      <title>{doc.name}</title>
      <metadata>{`futureox-desgin: embedded raster for ${issues.join(', ')}`}</metadata>
      <image width={box.width} height={box.height} href={`data:image/png;base64,${btoa(binary)}`} />
    </svg>,
  )
  return { name: `${doc.name}-visual.svg`, blob: new Blob([source], { type: 'image/svg+xml' }) }
}
export function svgSource(doc: DesignDocument, pageId: string, target: ExportTarget = {kind:'page'}, scale = 1, precision?: number, textMode: 'outlines' | 'editable' = 'outlines', fontMode: 'references' | 'embed' = 'references', fontEmbeddingAllowed = false, fontByteLimit = 4 * 1024 * 1024, embeddedFonts?: DesignDocument['fonts']) {
  if (fontMode === 'embed' && (textMode !== 'editable' || !fontEmbeddingAllowed)) throw new Error('Explicit editable font redistribution permission is required')
  ;({doc,target} = repeatExport(kernelLayout(doc),target))
  doc = projectSlice(doc,pageId,target)
  const b = targetBounds(doc, pageId, target)
  if(!Number.isFinite(scale) || scale<0.001 || scale>128) throw new Error('导出倍率必须在 0.001–128 之间')
  if (target.kind === 'selection') {
    const selected = new Set(target.nodeIds)
    const roots = scene(doc,pageId).filter(entry => selected.has(entry.id) && !entry.ancestors.some(id=>selected.has(id)))
    const page = doc.pages.find(page=>page.id===pageId)!
    // Render the resolved subtree without reapplying inherited opacity, clips or
    // instance overrides. Native selection PNG export uses this same isolation.
    doc={...doc,pages:[{...page,children:roots.map(entry=>entry.id)}],nodes:{...doc.nodes}}
    for(const entry of roots) doc.nodes[entry.id]={...doc.nodes[entry.id],transform:[...entry.matrix]}
  }
  if (scene(doc,pageId).some(entry => doc.nodes[entry.id].effects.some(e => e.visible && e.colorControls?.space === 'display-p3'))) throw new Error('Display-P3 编码域颜色调整需要保留视觉效果的 SVG 或位图导出')
  const source = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={b.width * scale}
      height={b.height * scale}
      viewBox={`${b.x} ${b.y} ${b.width} ${b.height}`}
    >
      <title>{doc.name}</title>
      {fontMode === 'embed' && <defs>{svgEmbeddedFonts(embeddedFonts ?? doc.fonts, new Set(scene(doc,pageId).filter(e=>doc.nodes[e.id].kind === 'text').flatMap(e=>['default', doc.nodes[e.id].textStyle?.fontId || 'default', ...(doc.nodes[e.id].textStyle?.fallbacks || []), ...(doc.nodes[e.id].textRuns || []).map(r=>r.fontId || doc.nodes[e.id].textStyle?.fontId || 'default')])), fontByteLimit).map(font => <style key={font.id} data-svg-font="1" data-font-id={font.id} data-font-family={font.family}>{font.css}</style>)}</defs>}
      <Scene doc={doc} pageId={pageId} exporting textMode={textMode} />
    </svg>,
  )
  return { source: roundSvgCoordinates(source, precision), box: b, issues: svgExportIssues(doc, pageId) }
}
/** True-vector PDF: paths, axial/radial gradients, image fills and text
 * outlines become native PDF objects at design scale (one MediaBox point per
 * design unit). Content outside the vector writer's v1 scope falls back to
 * the established bitmap PDF export. */
export async function exportPdfVector(
  doc: DesignDocument,
  pageId: string,
  target: ExportTarget = { kind: 'page' },
  signal?: AbortSignal,
): Promise<{
  name: string
  blob: Blob
  width: number
  height: number
  scale: number
  vector: true
  fallback?: boolean
}> {
  if (signal?.aborted) throw new Error('已取消导出')
  await initializePicking()
  if (signal?.aborted) throw new Error('已取消导出')
  const repeatedVisual = hasRepeats(doc)
  ;({doc,target} = repeatExport(kernelLayout(doc),target))
  doc = projectSlice(doc, pageId, target)
  if (pdfVectorIssues(doc, pageId, target).length) {
    const bitmap = (await exportRasterBatch(doc, pageId, [1], target, undefined, signal, 'pdf'))[0]
    return { ...bitmap, scale: 1, vector: true, fallback: true }
  }
  const box = targetBounds(doc, pageId, target)
  const width = Math.round(box.width),
    height = Math.round(box.height)
  if (width < 1 || height < 1 || width > 14400 || height > 14400)
    throw new Error('矢量 PDF 单边尺寸必须在 1–14400 pt 之间')
  if (signal?.aborted) throw new Error('已取消导出')
  // The MediaBox starts at (0,0) and RenderOptions.view is ignored, so the
  // exported roots are re-rooted at the target bounds' origin. Selections
  // are isolated from unselected siblings and ancestor effects exactly like
  // the native selection PNG/SVG export.
  const selected = target.kind === 'selection' ? new Set(target.nodeIds) : undefined
  const roots = scene(doc, pageId).filter((entry) =>
    selected
      ? selected.has(entry.id) && !entry.ancestors.some((id) => selected.has(id))
      : entry.ancestors.length === 0,
  )
  if (selected && !roots.length) throw new Error('请选择当前页面的可见图层')
  const page = doc.pages.find((p) => p.id === pageId)!
  const shifted: DesignDocument = {
    ...doc,
    pages: [{ ...page, children: roots.map((entry) => entry.id) }],
    nodes: { ...doc.nodes },
  }
  for (const entry of roots)
    shifted.nodes[entry.id] = {
      ...shifted.nodes[entry.id],
      transform: multiply(translate(-box.x, -box.y), entry.matrix),
    }
  if (repeatedVisual) {
    const reachable = new Set<string>(), pending = [...shifted.pages[0].children]
    while (pending.length) {const id=pending.pop()!;if(reachable.has(id))continue;reachable.add(id);pending.push(...shifted.nodes[id].children)}
    shifted.nodes = Object.fromEntries(Object.entries(shifted.nodes).filter(([id])=>reachable.has(id)))
    delete shifted.prototype;delete shifted.reviews;shifted.animations=[]
  }
  const bytes = kernelPdfVector(shifted, pageId, width, height, true)
  return {
    name: `${filename(targetName(doc, target))}.pdf`,
    blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    width,
    height,
    scale: 1,
    vector: true,
  }
}

export async function exportImage(
  doc: DesignDocument,
  pageId: string,
  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector',
  scale = format === 'png' ? 2 : 1,
  colorOutput?: import('./color').ColorOutput,
  signal?: AbortSignal,
  target: ExportTarget = { kind: 'page' },
): Promise<{
  name: string
  blob: Blob
  backend?: 'cpu'
  width?: number
  height?: number
  scale?: number
  vector?: boolean
  fallback?: boolean
}> {
  if (!['png','svg','jpeg','webp','pdf','pdf-vector'].includes(format)) throw new Error(`不支持的导出格式 ${String(format)}`)
  if (format === 'pdf-vector') return exportPdfVector(doc, pageId, target, signal)
  if (format !== 'svg')
    return (await exportRasterBatch(doc, pageId, [scale], target, colorOutput, signal, format))[0]
  if (signal?.aborted) throw new Error('已取消导出')
  await initializePicking()
  if (signal?.aborted) throw new Error('已取消导出')
  doc = kernelLayout(doc)
  const { source, issues } = svgSource(doc, pageId, target, scale)
  if (issues.length)
    throw new Error(`SVG 暂不能无损保留${issues.join('、')}，请导出 PNG；原设计已保留`)
  return { name: `${filename(targetName(doc,target))}.svg`, blob: new Blob([source], { type: 'image/svg+xml' }) }
}

/** A batch shares one immutable snapshot and worker, and disposes it on every exit. */
export async function exportPngBatch(
  doc: DesignDocument,
  pageId: string,
  scales: number[],
  target: ExportTarget = { kind: 'page' },
  colorOutput?: import('./color').ColorOutput,
  signal?: AbortSignal,
) {
  return exportRasterBatch(doc, pageId, scales, target, colorOutput, signal, 'png')
}
export async function exportRasterBatch(
  doc: DesignDocument, pageId: string, scales: number[], target: ExportTarget = { kind: 'page' },
  colorOutput?: import('./color').ColorOutput, signal?: AbortSignal,
  format: 'png' | 'jpeg' | 'webp' | 'pdf' = 'png',
) {
  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb') throw new Error('JPEG/WebP/PDF 当前使用 sRGB；广色域请导出 PNG')
  if (signal?.aborted) throw new Error('已取消导出')
  if (!scales.length || scales.length > 16 || new Set(scales).size !== scales.length)
    throw new Error('请选择 1–16 个不重复的导出倍率')
  await initializePicking()
  if (signal?.aborted) throw new Error('已取消导出')
  ;({doc,target} = repeatExport(kernelLayout(doc),target))
  doc = projectSlice(doc,pageId,target)
  const box = targetBounds(doc, pageId, target)
  const plans = scales.map((scale) => {
    if (!Number.isFinite(scale) || scale < 0.001 || scale > 128)
      throw new Error('导出倍率必须在 0.001–128 之间')
    return kernelExportPlan(box, scale)
  })
  if (plans.reduce((pixels, plan) => pixels + plan.width * plan.height, 0) > 64e6)
    throw new Error('批量导出总尺寸超过 6400 万像素，请拆分批次')
  const kernel = new KernelClient()
  const cancel = () => kernel.dispose()
  signal?.addEventListener('abort', cancel, { once: true })
  const assets: {
    name: string
    blob: Blob
    backend: 'cpu'
    width: number
    height: number
    scale: number
  }[] = []
  try {
    for (const [index, scale] of scales.entries()) {
      if (signal?.aborted) throw new Error('已取消导出')
      const plan = plans[index]
      const result = await kernel.render(
        doc,
        {
          pageId,
          ...plan,
          exportRegion: {
            bounds: box,
            scale,
            nodeIds: target.kind === 'selection' ? target.nodeIds : undefined,
          },
          transparent: true,
          grid: false,
          colorOutput,
          ...(format === 'png' ? {} : { exportFormat: format }),
        },
        true,
        'cpu',
      )
      if (signal?.aborted) throw new Error('已取消导出')
      if (result.backend !== 'cpu') throw new Error('PNG 导出必须使用 CPU 内核')
      assets.push({
        name: `${filename(targetName(doc, target))}${colorOutput ? `-${colorOutput.space}` : ''}@${scale}x.${format === 'jpeg' ? 'jpg' : format}`,
        blob: new Blob([new Uint8Array(result.bytes)], { type: format === 'pdf' ? 'application/pdf' : `image/${format}` }),
        backend: 'cpu',
        width: plan.width,
        height: plan.height,
        scale,
      })
    }
    return assets
  } finally {
    signal?.removeEventListener('abort', cancel)
    kernel.dispose()
  }
}
