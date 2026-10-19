import type { DesignDocument, Matrix } from '../../model'
import { equalValue } from '../../document-patch'
import type { GpuPaint, GpuScene, PathMesh, Rect } from './types'

import { sceneIndex, inheritTranslatedIndex } from './scene-index'

function stableConstraints(scene: GpuScene, document: DesignDocument, id: string, parents: Map<string, string>) {
  const constraints = document.nodes[id]?.constraints
  if (!constraints) return true
  const parentId = parents.get(id)
  if (!parentId) return scene.roots.includes(id)
  const parent = document.nodes[parentId], compiled = scene.nodes[parentId]
  return !!parent && !!compiled && (constraints.referenceWidth ?? parent.width) === parent.width &&
    (constraints.referenceHeight ?? parent.height) === parent.height &&
    compiled.size[0] === parent.width && compiled.size[1] === parent.height
}

export function preparePreviewSelection(scene: GpuScene, ids: readonly string[]): GpuScene {
  const parents = sceneIndex(scene).parents, changed = new Set<string>()
  for (const id of ids) {
    let parent = parents.get(id)
    while (parent) { changed.add(parent); parent = parents.get(parent) }
  }
  if (!changed.size) return scene
  const nodes = { ...scene.nodes }
  for (const id of changed) nodes[id] = { ...nodes[id], previewDynamic: true, previewSource: undefined }
  return { ...scene, nodes }
}

/** A stationary clipped frame keeps the same backdrop read/output support
 * when a descendant translates. Its children and final blend are still drawn
 * again; unbounded foreground filters and optical effects keep the fallback. */
export function stableAncestorEffects(node: DesignDocument['nodes'][string]) {
  return node.effects.every(effect => !effect.visible ||
    node.kind === 'frame' && node.clip && effect.kind === 'background-blur')
}

/** Convert an authored local translation through its unchanged parent. */
export function previewTranslationDelta(scene: GpuScene, id: string, transform: Matrix): [number, number] | null {
  const node = scene.nodes[id]
  if (!node) return null
  const parentId = sceneIndex(scene).parents.get(id), parent = parentId ? scene.nodes[parentId] : undefined
  if (!parent && !scene.roots.includes(id)) return null
  const m = parent?.matrix || [scene.view.zoom, 0, 0, scene.view.zoom, scene.view.x, scene.view.y]
  const delta: [number, number] = [m[0] * transform[4] + m[2] * transform[5] + m[4] - node.matrix[4],
    m[1] * transform[4] + m[3] * transform[5] + m[5] - node.matrix[5]]
  return delta.every(value => Number.isFinite(value) && Math.abs(value) < 1_000_000) ? delta : null
}

/** Reuse local interval programs for a transient translation. Area
 * programs address mask-local pixels; continuous placement therefore moves
 * their rectangles, not their coverage arrays. Composition bilinearly samples
 * those local textures at the fractional translation. No exact/export caller
 * may use this approximation. Clipped geometry, replay recipes, derived
 * mutations and camera changes retain ordinary kernel compilation. */
export function translatePreviewScene(scene: GpuScene, before: DesignDocument, after: DesignDocument): GpuScene | null {
  if (scene.softwareRaster || before.animations?.length || after.id !== before.id ||
      Object.keys(before).length !== Object.keys(after).length ||
      Object.keys(before.nodes).length !== Object.keys(after.nodes).length ||
      Object.keys(after).some(k => k !== 'nodes' && !equalValue(after[k as keyof DesignDocument], before[k as keyof DesignDocument])) ||
      Object.values(scene.nodes).some(n => n.captureReplay || n.textureReplay)) return null
  const offsets = new Map<string, [number, number]>()
  const parents = sceneIndex(scene).parents
  const changed = new Set<string>(), affectedParents = new Set<string>(), nested = new Set<string>()
  for (const [id, n] of Object.entries(after.nodes)) {
    const previous = before.nodes[id]
    if (!previous) return null
    if (n === previous || equalValue(n, previous)) continue
    if (!scene.nodes[id] || n.instance || n.instanceOrigin || n.component || n.componentSet || n.componentKey || !stableConstraints(scene, before, id, parents) ||
        Object.keys(n).length !== Object.keys(previous).length ||
        Object.keys(n.variableModes || {}).length ||
        n.layout && n.layout.mode !== 'none' || Object.keys(n.bindings || {}).length ||
        n.transform.slice(0, 4).some((v, i) => v !== previous.transform[i]) ||
        Object.keys(n).some(k => k !== 'transform' && !equalValue(n[k as keyof typeof n], previous[k as keyof typeof previous]))) return null
    const offset = previewTranslationDelta(scene, id, n.transform)
    if (!offset) return null
    changed.add(id)
    if (!scene.roots.includes(id)) {
      // Nested motion must rebuild ancestor compositions, not move a cached
      // ancestor image. Keep layout, mask and ancestor filter dependencies on
      // the full compiler path until their derived bounds can be certified.
      if (n.mask) return null
      let parent = parents.get(id)
      if (!parent) return null
      while (parent) {
        const authored = before.nodes[parent], compiled = scene.nodes[parent]
        if (!authored || !compiled || compiled.maskId || authored.mask || !stableAncestorEffects(authored) ||
            authored.layout && authored.layout.mode !== 'none' || authored.instance || authored.instanceOrigin ||
            authored.component || authored.componentSet || authored.componentKey || !stableConstraints(scene, before, parent, parents) ||
            Object.keys(authored.bindings || {}).length || Object.keys(authored.variableModes || {}).length) return null
        affectedParents.add(parent); parent = parents.get(parent)
      }
    }
    const pending = [id]
    while (pending.length) {
      const child = pending.pop()!, node = scene.nodes[child]
      if (!node) continue
      offsets.set(child, offset); pending.push(...node.children)
      if (!scene.roots.includes(id)) nested.add(child)
    }
  }
  if (!offsets.size) return scene
  if ([...changed].some(id => affectedParents.has(id))) return null
  return translatePreviewOffsets(scene, offsets, affectedParents, nested)
}

/** Shared numeric path: the validated patch session and the full-document
 * reference use exactly the same clipping, rounding and gradient operations. */
export function translatePreviewOffsets(scene: GpuScene, offsets: Map<string, [number, number]>,
  affectedParents: Set<string>, nested: Set<string>, targetNodes?: GpuScene['nodes']): GpuScene | null {
  const extent = scene.extent
  const window = scene.interactionWindow
  if (window && (window.x < extent.x || window.y < extent.y ||
      window.x + window.w > extent.x + extent.w || window.y + window.h > extent.y + extent.h)) return null
  const inside = (r: Rect) => r.x > extent.x && r.y > extent.y &&
    r.x + r.w < extent.x + extent.w && r.y + r.h < extent.y + extent.h
  const nodes = targetNodes || { ...scene.nodes }
  const signed = (words: number[]) => BigInt.asIntN(64, words.reduce((v, word, i) => v | BigInt(word) << BigInt(i * 16), 0n))
  for (const [id, [dx, dy]] of offsets) {
    const n = scene.nodes[id], shift = (r: Rect) => ({ ...r, x: r.x + dx, y: r.y + dy })
    // A source touching the compile guard could have omitted geometry which
    // the move would expose. Recompile rather than moving an incomplete mask.
    // A fully captured nested glyph/shape can move without discarding its
    // coverage program; its unchanged ancestors apply their real clips again.
    const completeNestedSource = nested.has(id) && inside((n.previewSource || n).rect)
    if (window && !completeNestedSource) {
      // A clipped mask may move inside the guarded capture while the visible
      // interior remains completely supported by its original geometry.
      // Accumulate from the original source: repeated small moves must not
      // accidentally permit unlimited travel beyond the compile guard.
      const source = n.previewSource || n
      const totalX = n.matrix[4] + dx - source.matrix[4]
      const totalY = n.matrix[5] + dy - source.matrix[5]
      if (window.x < extent.x + totalX || window.y < extent.y + totalY ||
          window.x + window.w > extent.x + extent.w + totalX ||
          window.y + window.h > extent.y + extent.h + totalY) return null
    } else if (!window && (!inside(n.rect) || !inside(shift(n.rect)))) return null
    // A warped coverage texture no longer has the compiler's whole-device-
    // pixel proof. Integer translation preserves it; fractional translation
    // needs a new proof from exact native recompilation.
    const path = (p: PathMesh): PathMesh | null => p.area || !p.count ? { ...p, rect: shift(p.rect),
      opaqueRect:p.opaqueRect&&Number.isInteger(dx)&&Number.isInteger(dy)?shift(p.opaqueRect):undefined } : null
    const fill = path(n.fill), strokes = n.strokes.map(s => ({ ...s, path: path(s.path) }))
    if (!fill || strokes.some(s => !s.path)) return null
    const paint = (p: GpuPaint): GpuPaint => {
      if (!p.fixedGradient) return p
      const [a, b, c] = p.fixedGradient.words.map(signed)
      // Fixed-gradient coefficients retain their integer representation. Use
      // a bounded subpixel denominator for transient translation, avoiding
      // conversion of the 64-bit coefficients through imprecise JS numbers.
      const denominator = 65536n
      const shift = BigInt(Math.round(dx * Number(denominator))) * a + BigInt(Math.round(dy * Number(denominator))) * b
      const translated = c - (shift >= 0n ? (shift + denominator / 2n) / denominator : -((-shift + denominator / 2n) / denominator))
      if (BigInt.asIntN(64, translated) !== translated) throw Error('Preview gradient translation overflow')
      return { ...p, fixedGradient: { ...p.fixedGradient, words: [p.fixedGradient.words[0], p.fixedGradient.words[1],
        Array.from({ length: 4 }, (_, i) => Number(BigInt.asUintN(64, translated) >> BigInt(16 * i) & 65535n))] } }
    }
    try {
      nodes[id] = { ...n, previewSource: n.previewSource || n, rect: shift(n.rect), fill, strokes: strokes.map(s => ({ ...s, path: s.path!, paint: paint(s.paint) })),
        fills: n.fills.map(paint), matrix: [...n.matrix.slice(0, 4), n.matrix[4] + dx, n.matrix[5] + dy] as Matrix,
        inverse: [...n.inverse.slice(0, 4), n.inverse[4] - n.inverse[0] * dx - n.inverse[2] * dy,
          n.inverse[5] - n.inverse[1] * dx - n.inverse[3] * dy] as Matrix,
        backdropBox: n.backdropBox ? [n.backdropBox[0] + dx, n.backdropBox[1] + dy, n.backdropBox[2], n.backdropBox[3]] : undefined }
    } catch { return null }
  }
  const grow = (a: Rect, b: Rect): Rect => {
    const x = Math.max(extent.x, Math.min(a.x, b.x)), y = Math.max(extent.y, Math.min(a.y, b.y))
    const right = Math.min(extent.x + extent.w, Math.max(a.x + a.w, b.x + b.w))
    const bottom = Math.min(extent.y + extent.h, Math.max(a.y + a.h, b.y + b.h))
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
  }
  // Descendants first: expanded groups need room for the moved child. Clipped
  // frames keep their own allocation and clip shape. Clearing previewSource
  // is essential: an ancestor's old painted subtree contains the old position.
  const rebuild = (id: string) => {
    if (!affectedParents.has(id)) return
    const node = nodes[id]
    node.children.forEach(rebuild)
    const rect = node.clip ? node.rect : node.children.reduce((r, child) => nodes[child] ? grow(r, nodes[child].rect) : r, node.rect)
    nodes[id] = { ...node, rect, previewSource: undefined, previewDynamic: true }
  }
  scene.roots.forEach(rebuild)
  inheritTranslatedIndex(scene, nodes)
  return { ...scene, nodes }
}
