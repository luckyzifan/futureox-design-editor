import { assertFdAppendSupported } from './fd-extensions'
import { cloneValue } from './draft'
import { defaultColorSettings } from './color'
import { node, uid, type DesignDocument } from './model'
import { scene, unionBounds } from './geometry'
import { importClipboardDependencies, remapReferences } from './components'
import { remapDesignDependencies } from './design-system'
import { captureClipboardSemantics, clipboardDependencyNodes, applyClipboardSemantics } from './clipboard-semantics'

/** One atomic append. A static group per source page keeps authored coordinates,
 * clips and animation keyframes intact, and makes each import easy to move. */
export function appendDocument(target: DesignDocument, source: DesignDocument, pageId: string) {
  assertFdAppendSupported(source)
  const page = target.pages.find(p => p.id === pageId)
  if (!page) throw new Error('追加导入的页面已不存在')
  const sourcePages = source.pages.filter(p => p.children.length)
  if (!sourcePages.length) throw new Error('文件没有可导入的图层')
  const empty = !Object.keys(target.nodes).length
  const sourceColor = source.colorManagement || defaultColorSettings()
  const targetColor = target.colorManagement || defaultColorSettings()
  if (!empty && (sourceColor.documentSpace !== targetColor.documentSpace ||
      sourceColor.referenceWhiteNits !== targetColor.referenceWhiteNits || sourceColor.peakLuminanceNits !== targetColor.peakLuminanceNits))
    throw new Error('两个文件的色彩空间不同，请先统一色彩设置，或将文件打开为新设计')
  if (empty) {
    target.colorManagement = cloneValue(source.colorManagement)
    target.rasterProfile = source.rasterProfile
    page.background = sourcePages[0].background
  } else if (source.colorManagement && !target.colorManagement) {
    target.colorManagement = cloneValue(source.colorManagement)
    target.rasterProfile = source.rasterProfile
  }
  target.schemaVersion = Math.max(target.schemaVersion, source.schemaVersion) as DesignDocument['schemaVersion']
  const roots = sourcePages.flatMap(p => p.children), nodes = Object.values(source.nodes)
  const semantics = captureClipboardSemantics(source, nodes, roots)
  // A canvas has one default prototype start; keep it when appending another
  // flow, while retaining every imported interaction and its local targets.
  if (target.prototype?.startNode && semantics.prototype) delete semantics.prototype.startNode
  const ids = new Map(nodes.map(n => [n.id, uid()]))
  const dependencies = importClipboardDependencies(target, source, clipboardDependencyNodes(nodes, semantics), ids)
  for (const original of nodes) {
    const n = cloneValue(original)
    remapReferences(n, dependencies.nodeIds, source)
    remapDesignDependencies(n, dependencies.designSystem)
    if (n.instanceOrigin) n.instanceOrigin.owner = ids.get(original.instanceOrigin!.owner)!
    n.id = ids.get(original.id)!
    n.children = n.children.map(id => ids.get(id)!)
    target.nodes[n.id] = n
  }
  const existing = scene(target, pageId).filter(item => page.children.includes(item.id))
  const occupied = unionBounds(existing.map(item => item.bounds))
  let x = existing.length ? occupied.x + occupied.width + 120 : 0
  const y = existing.length ? occupied.y : 0
  const groups: string[] = []
  // Apply behavior while roots still belong to the destination page, then put
  // them under static groups. No keyframe is offset or re-interpolated.
  page.children.push(...roots.map(id => ids.get(id)!))
  applyClipboardSemantics(target, source, roots, dependencies.nodeIds, dependencies.designSystem, semantics, pageId, 0)
  for (const sourcePage of sourcePages) {
    const items = scene(source, sourcePage.id).filter(item => sourcePage.children.includes(item.id))
    const box = unionBounds(items.map(item => item.bounds))
    const group = node('group', x - box.x, y - box.y, Math.max(1, box.width), Math.max(1, box.height))
    group.name = (sourcePages.length === 1 ? source.name : `${source.name} · ${sourcePage.name}`).slice(0, 200)
    group.fills = []; group.strokes = []; group.effects = []; group.blend = 'pass-through'
    group.children = sourcePage.children.map(id => ids.get(id)!)
    const children = new Set(group.children)
    page.children = page.children.filter(id => !children.has(id))
    page.children.push(group.id); target.nodes[group.id] = group; groups.push(group.id)
    if (source.reviews?.length) {
      target.reviews ??= []
      target.reviews.push(...source.reviews.filter(r => r.pageId === sourcePage.id).map(r => ({
        ...cloneValue(r), id: uid(), pageId, nodeId: r.nodeId ? ids.get(r.nodeId) : undefined,
        position: { x: r.position.x + group.transform[4], y: r.position.y + group.transform[5] },
        messages: r.messages.map(message => ({ ...message, id: uid() })),
      })))
    }
    x += Math.max(1, box.width) + 120
  }
  return groups
}
