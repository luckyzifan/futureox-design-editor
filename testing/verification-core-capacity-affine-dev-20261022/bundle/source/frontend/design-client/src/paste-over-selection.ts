import { assertDocumentStructure } from './document-capacity'
import { cloneValue, produceDraft } from './draft'
import { defaultSizing, node, uid, validateDocument, validateStructure, type DesignDocument, type DesignNode } from './model'
import { allParents, apply, bounds, boxPoints, inverse, multiply, unionBounds, worldMatrix } from './geometry'
import { parentBounds, selectionLocalBounds } from './canvas-view'
import { interactivePath } from './selection-hierarchy'
import { activateDocumentFonts, prepareDocumentForEditing } from './kernel/picking'
import { applyClipboardSemantics, captureClipboardSemantics, clipboardDependencyNodes, hasClipboardSemantics } from './clipboard-semantics'
import { importClipboardDependencies, importDefinitions, insertInstance, remapReferences } from './components'
import { remapDesignDependencies } from './design-system'
import type { ShortcutProfile } from './shortcut-profiles'

const MAX_BYTES = 32 * 1024 * 1024, MAX_TARGETS = 64
/** Build the entire operation without touching an Editor, its history, clipboard,
 * transaction. Kernel preflight temporarily installs source/merged fonts, then
 * restores destination fonts even on rejection. Caller publishes once after stale checks.
 * Figma's documented x/y is interpreted using this editor's parent-local Inspector
 * bounds. Sketch documents per-target copies, but not an alignment anchor: the
 * same top-left contract is an explicit local adaptation, not verified parity. */
export function planPasteOverSelection(before: DesignDocument, pageId: string, selection: readonly string[], serialized: string, profile: ShortcutProfile) {
  try { return buildPlan(before, pageId, selection, serialized, profile) }
  finally { activateDocumentFonts(before) }
}
function buildPlan(before: DesignDocument, pageId: string, selection: readonly string[], serialized: string, profile: ShortcutProfile) {
  const parents = allParents(before), unique = [...new Set(selection)]
  if (!unique.length) throw Error('请选择覆盖粘贴的目标图层')
  if (unique.length > MAX_TARGETS) throw Error('一次覆盖粘贴最多支持 64 个目标')
  for (const id of unique) {
    const path = interactivePath(before, pageId, id, false, parents)
    if (!path.length) throw Error('粘贴目标包含隐藏、锁定或无效图层')
    if (path.slice(0, -1).some(id => before.nodes[id].instance || before.nodes[id].instanceOrigin)) throw Error('不能向组件实例内部粘贴新结构')
  }
  const targets = unique.filter(id => !interactivePath(before, pageId, id, false, parents).slice(0, -1).some(parent => unique.includes(parent)))
  if (profile === 'figma-like' && targets.length !== 1) throw Error('Figma 风格覆盖粘贴目前仅支持一个目标；请单选后重试')
  if (targets.length > MAX_TARGETS) throw Error('一次覆盖粘贴最多支持 64 个目标')
  const bytes = new TextEncoder().encode(serialized).byteLength
  if (bytes * targets.length > MAX_BYTES) throw Error('覆盖粘贴展开内容超过 32 MiB，请减少目标或剪贴板内容')
  const value = JSON.parse(serialized)
  if (value?.format !== 'forma-nodes' || value.version !== 1 || !Array.isArray(value.roots) || !value.roots.length || value.roots.some((id: unknown) => typeof id !== 'string')) throw Error('不支持的图层剪贴板')
  const source = prepareDocumentForEditing(value.document), roots = [...new Set(value.roots as string[])]
  if (roots.some(id => !source.pages.some(page => page.children.includes(id)))) throw Error('剪贴板根图层无效')
  if (roots.some(id => source.nodes[id].mask)) throw Error('覆盖粘贴独立蒙版会改变目标容器的蒙版范围；请先将蒙版与内容编组后复制')
  const copied: DesignNode[] = []
  const visit = (id: string) => { copied.push(source.nodes[id]); source.nodes[id].children.forEach(visit) }
  roots.forEach(visit)
  // A lower bound before any target expansion, followed by exact validation below.
  assertDocumentStructure(Object.keys(before.nodes).length + copied.length * targets.length, before.pages.length)
  const semantics = captureClipboardSemantics(source, copied, roots)
  const animated = new Set(semantics.animations.flatMap(clip => clip.tracks.map(track => track.nodeId)))
  const inserted: string[] = []
  const planned = produceDraft(before, draft => {
    const d = draft as DesignDocument, page = d.pages.find(page => page.id === pageId)
    if (!page) throw Error('粘贴页面不存在')
    d.schemaVersion = Math.max(d.schemaVersion, source.schemaVersion) as DesignDocument['schemaVersion']
    for (const target of targets) {
      let output: string[]
      if (roots.length === 1 && source.nodes[roots[0]].component && !hasClipboardSemantics(semantics)) {
        const component = importDefinitions(d, source, roots[0])
        const id = insertInstance(d, component, pageId, { x: 0, y: 0 })
        d.nodes[id].transform = cloneValue(source.nodes[roots[0]].transform)
        output = [id]
      } else {
        const ids = new Map(copied.map(n => [n.id, uid()]))
        const dependencies = importClipboardDependencies(d, source, clipboardDependencyNodes(copied, semantics), ids)
        for (const original of copied) {
          const n = cloneValue(original)
          remapReferences(n, dependencies.nodeIds, source); remapDesignDependencies(n, dependencies.designSystem)
          if (n.instanceOrigin && original.instanceOrigin) n.instanceOrigin.owner = ids.get(original.instanceOrigin.owner) || n.instanceOrigin.owner
          n.id = ids.get(original.id)!; n.children = n.children.map(id => ids.get(id)!)
          d.nodes[n.id] = n
        }
        page.children.push(...roots.map(id => ids.get(id)!))
        const semanticRoots = applyClipboardSemantics(d, source, roots, dependencies.nodeIds, dependencies.designSystem, semantics, pageId, 0)
        output = roots.map(root => {
          const id = semanticRoots.get(root)!
          // Even identity source placement needs a static wrapper before moving
          // an animated root. Authored keyframes are never rewritten.
          if (!animated.has(root) || id !== ids.get(root)) return id
          const n = d.nodes[id], wrapper = node('group', 0, 0, n.width, n.height)
          wrapper.name = `${n.name} · 动画变换`.slice(0, 200); wrapper.children = [id]
          wrapper.fills = []; wrapper.strokes = []; wrapper.effects = []; wrapper.blend = 'pass-through'
          d.nodes[wrapper.id] = wrapper; page.children[page.children.indexOf(id)] = wrapper.id
          return wrapper.id
        })
      }
      const destination = parents.get(target)!, parent = before.nodes[destination]
      const basis = parent ? inverse(worldMatrix(before, destination, parents)) : [1, 0, 0, 1, 0, 0] as const
      for (const id of output) d.nodes[id].transform = multiply([...basis], d.nodes[id].transform)
      activateDocumentFonts(d)
      const sourceBox = unionBounds(output.map(id => bounds(boxPoints(selectionLocalBounds(d, id)).map(point => apply(d.nodes[id].transform, point)))))
      const targetBox = parentBounds(before.nodes[target]), dx = targetBox.x - sourceBox.x, dy = targetBox.y - sourceBox.y
      for (const id of output) {
        const n = d.nodes[id]; n.transform[4] += dx; n.transform[5] += dy
        if (parent?.layout && parent.layout.mode !== 'none') n.sizing = { ...defaultSizing(), ...n.sizing, absolute: true, width: 'fixed', height: 'fixed' }
      }
      page.children = page.children.filter(id => !output.includes(id))
      const siblings = parent ? d.nodes[destination].children : page.children
      siblings.splice(siblings.indexOf(target) + 1, 0, ...output)
      inserted.push(...output)
      assertDocumentStructure(Object.keys(d.nodes).length, d.pages.length)
    }
  }) as DesignDocument
  // Includes schema/resource/reference/depth validation before the first write.
  validateStructure(planned); validateDocument(planned)
  return { document: planned, selection: inserted }
}

/** Editor normalizers mutate freshly assigned external branches without Immer
 * drafting them. Detach the complete bounded candidate before publication, so
 * every pre-edit branch stays immutable; Editor sharing recovers unchanged node
 * identities after layout. Clipboard correctness takes priority over clone cost. */
export function applyPasteOverPlan(draft: DesignDocument, _before: DesignDocument, planned: DesignDocument) {
  Object.assign(draft, cloneValue(planned))
}
