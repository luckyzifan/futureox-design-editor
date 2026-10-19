import { scene, worldMatrix } from './geometry'
import { maskChild, type DesignDocument, type Bounds, type Matrix } from './model'

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
