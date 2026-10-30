import { effectsAreKnown } from '../render-dependency'
import type { GpuNode, GpuScene } from './types'

export type NestedPrefixSource = Readonly<{ id: string; node: GpuNode | undefined }>
export type NestedPrefixPlan = Readonly<{
  lease: object
  scopeId: string
  selectedId: string
  /** Original child-list offset, including compiler-culled no-op children. */
  count: number
  prefixIds: readonly string[]
  /** Ordered immutable native-source identities, including absent-node sentinels. */
  sources: readonly NestedPrefixSource[]
}>

const contributes = (node: GpuNode | undefined) => !!node && node.opacity > 0
const samePlacement = (node: GpuNode, source: GpuNode) =>
  (['x', 'y', 'w', 'h'] as const).every(key => Object.is(node.rect[key], source.rect[key])) &&
  node.matrix.length === source.matrix.length && node.matrix.every((value, i) => Object.is(value, source.matrix[i]))

/** A narrow plan for one final nested branch under a neutral isolated root.
 * The caller captures the original four targets immediately before that branch,
 * without flattening/reordering ancestors or translating the static backdrop.
 *
 * This is not a content or GPU completion certificate. The worker owns the
 * private interaction lease and native previewSource proof; the renderer must
 * additionally match camera/quality/target rects, publish only completed planes,
 * and restore writable copies rather than hand cache textures to in-place blends.
 * Missing native nodes are real compiler-culling no-ops, not authored invisibility:
 * preserve their IDs/sentinels so newly visible support invalidates the prefix.
 */
export function planNestedPrefix(scene: GpuScene, scopeId: string,
  nativeChanging: ReadonlySet<string>, allowSuffix = false): NestedPrefixPlan | undefined {
  if (!scene.coherentSamples || !scene.interactionRetained || !scene.nativeInteraction ||
      !scene.interactionLease || scene.softwareRaster || scene.resolve || scene.presentation ||
      scene.interactionSelection?.length !== 1) return
  const selectedId = scene.interactionSelection[0], scope = scene.nodes[scopeId], selected = scene.nodes[selectedId]
  // Only one neutral ancestor is supported. General clipped/nested isolation
  // requires its own per-scope proof; lifting a selected node to a page root is
  // not equivalent to retaining this original local composition.
  if (!scope || !selected || selectedId === scopeId || !scene.roots.includes(scopeId) ||
      !contributes(scope) || !contributes(selected) || scope.opacity !== 1 || scope.blend !== 'normal' ||
      scope.passthrough || scope.mask || scope.maskId || scope.clip || scope.fills.length ||
      scope.strokes.length || scope.effects.length || scope.captureReplay || scope.textureReplay ||
      scope.children.some(id => scene.nodes[id]?.mask)) return
  if (scene.roots.filter(id => contributes(scene.nodes[id])).at(-1) !== scopeId) return
  const selectedAt = scope.children.indexOf(selectedId)
  if (selectedAt <= 0 || scope.children.lastIndexOf(selectedId) !== selectedAt ||
      (!allowSuffix && scope.children.slice(selectedAt + 1).some(id => contributes(scene.nodes[id])))) return
  // With a suffix, these are still the original four targets immediately
  // before the selected branch. Every following sibling is replayed in its
  // original order against those writable targets, including backdrop reads.
  // The scope remains isolated and mask-free; no suffix pixels are cached.
  // A second incoming edge would make this more than a single nested branch.
  if (Object.values(scene.nodes).some(node => node.id !== scopeId && node.children.includes(selectedId))) return

  const prefixIds = scope.children.slice(0, selectedAt), sources: NestedPrefixSource[] = []
  const seen = new Set<string>([scopeId, selectedId])
  const visit = (id: string): boolean => {
    if (seen.has(id) || nativeChanging.has(id)) return false
    seen.add(id)
    const node = scene.nodes[id]
    if (!node) { sources.push(Object.freeze({ id, node: undefined })); return true }
    const source = node.previewSource || node
    // Every actually compiled descendant participates: a static parent object
    // alone cannot prove that one of its children stayed unchanged.
    if (node.previewDynamic || source.previewDynamic || node.mask || node.maskId || node.clip || node.passthrough ||
        node.captureReplay || node.textureReplay || source.captureReplay || source.textureReplay ||
        !effectsAreKnown(node.effects) || !samePlacement(node, source)) return false
    sources.push(Object.freeze({ id, node: source }))
    return node.children.every(visit)
  }
  if (!prefixIds.every(visit) || !prefixIds.some(id => contributes(scene.nodes[id]))) return
  return Object.freeze({ lease: scene.interactionLease, scopeId, selectedId, count: selectedAt,
    prefixIds: Object.freeze(prefixIds), sources: Object.freeze(sources) })
}
