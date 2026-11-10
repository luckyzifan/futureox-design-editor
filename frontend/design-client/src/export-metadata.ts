import { scene, worldMatrix } from './geometry'
import { maskChild, type DesignDocument, type DesignNode, type Bounds, type Matrix } from './model'
import type { ColorOutput } from './color'

export type ExportTarget =
  | { kind: 'page'; padding?: number }
  | { kind: 'selection'; nodeIds: string[] }
  | { kind: 'slice'; bounds: Bounds; transform?: Matrix }

/** An authored slice exports in its own axes; an AABB would change its
 * dimensions and include unwanted pixels after rotation. */
export function sliceExportTarget(doc: DesignDocument, id: string): ExportTarget {
  const n=doc.nodes[id]
  if(!n||n.kind!=='slice')throw new Error('切片不存在')
  const m=worldMatrix(doc,id),sx=Math.hypot(m[0],m[1]),sy=Math.hypot(m[2],m[3])
  if(!sx||!sy)throw new Error('切片变换不可逆')
  if(m[1]===0&&m[2]===0&&m[0]>0&&m[3]>0)
    return {kind:'slice',bounds:{x:m[4],y:m[5],width:n.width*sx,height:n.height*sy}}
  return {kind:'slice',bounds:{x:0,y:0,width:n.width*sx,height:n.height*sy},transform:[m[0]/sx,m[1]/sx,m[2]/sy,m[3]/sy,m[4],m[5]]}
}
/** Content the true-vector PDF writer cannot preserve (its v1 scope ignores
 * effects and masks and approximates angular/diamond gradients as solid
 * fills). Targets with issues fall back to the bitmap PDF export. */
export function pdfVectorIssues(doc: DesignDocument, pageId: string, target: ExportTarget = { kind: 'page' }) {
  const issues = new Set<string>()
  const selected = target.kind === 'selection' ? new Set(target.nodeIds) : undefined
  for (const entry of scene(doc, pageId)) {
    if (selected && !selected.has(entry.id) && !entry.ancestors.some((id) => selected.has(id))) continue
    const n = doc.nodes[entry.id]
    if (!n.visible || n.opacity <= 0) continue
    if (n.effects.some((e) => e.visible)) issues.add('滤镜效果')
    if (maskChild(doc, n)?.visible) issues.add('蒙版')
    if (
      [...n.fills, ...n.strokes.map((s) => s.paint)].some(
        (p) => p.kind === 'angular' || p.kind === 'diamond',
      )
    )
      issues.add('角向/菱形渐变')
  }
  return [...issues]
}

/** `#rrggbb` and in-range `color(srgb …)` are ordinary SDR. Any other authored
 * color, or a non-sRGB document space, needs an explicit output encoding. */
export function colorNeedsExplicitEncoding(value: string): boolean {
  if (/^#[0-9a-f]{6}$/i.test(value)) return false
  const match = /^color\(\s*([a-z0-9-]+)\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)/i.exec(value.trim())
  if (!match || match[1].toLowerCase() !== 'srgb') return true
  return [match[2], match[3], match[4]].some((part) => {
    const channel = Number(part)
    return !Number.isFinite(channel) || channel < 0 || channel > 1
  })
}

function nodeColors(node: DesignNode): string[] {
  const colors = [...node.fills.flatMap((paint) => [paint.color, ...paint.stops.map((stop) => stop.color)])]
  for (const stroke of node.strokes) colors.push(stroke.paint.color, ...stroke.paint.stops.map((stop) => stop.color))
  for (const effect of node.effects) colors.push(effect.color)
  for (const run of node.textRuns || []) if (run.color) colors.push(run.color)
  return colors
}

/** True when this subtree cannot reuse the top bar's ordinary sRGB encoding
 * without an explicit wide-gamut / HDR choice. */
export function subtreeNeedsExplicitColorEncoding(doc: DesignDocument, rootId: string): boolean {
  if (!doc.colorManagement) return false
  if (doc.colorManagement.documentSpace !== 'srgb') return true
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) continue
    if (nodeColors(node).some(colorNeedsExplicitEncoding)) return true
    stack.push(...node.children)
  }
  return false
}

/** The layer preset and the top bar share this encoding. Ordinary sRGB is
 * explicit clip. A missing kernel color output is that same sRGB clip default.
 * HDR, wide-gamut, and negative channels stay unset until the user chooses. */
export function layerExportColorOutput(
  doc: DesignDocument,
  rootId: string,
  encoding: 'srgb' | 'display-p3' | '',
): ColorOutput | undefined {
  if (!doc.colorManagement) return undefined
  if (subtreeNeedsExplicitColorEncoding(doc, rootId) && encoding !== 'srgb' && encoding !== 'display-p3') {
    throw new Error('广色域 / HDR 或负值分量需要先明确选择输出编码；图层预设不会静默裁成 8 位')
  }
  return { space: encoding === 'display-p3' ? 'display-p3' : 'srgb', toneMap: 'clip' }
}
