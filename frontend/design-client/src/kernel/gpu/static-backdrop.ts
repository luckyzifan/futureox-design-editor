import { sceneIndex } from './scene-index'
import type { GpuNode, GpuScene } from './types'

/** Only the first moving root's stationary clipped backdrop is independent of
 * its selected descendants. Earlier moving roots, root movement, a new compiled
 * scene, camera or capture lattice must invalidate this proof. */
export function staticBackdropKey(scene: GpuScene, n: GpuNode): string | undefined {
  const index = sceneIndex(scene), selection = scene.interactionSelection || []
  if (!scene.interactionRetained || scene.coherentSamples || !n.clip || n.mask || n.passthrough ||
      !index.roots.has(n.id) || selection.includes(n.id) || !selection.some(id=>index.rootFor.get(id)===n.id)) return
  const position=scene.roots.indexOf(n.id)
  if(selection.some(id=>{const root=index.rootFor.get(id);return !root||scene.roots.indexOf(root)<position}))return
  const prefix=scene.roots.slice(0,position).map(id=>scene.nodes[id])
  // A prior gesture can have changed an earlier subtree without changing its
  // root box. Such dynamic ancestors cannot certify a stationary background.
  if(prefix.some(node=>node?.previewDynamic))return
  return JSON.stringify([prefix.map(node=>node?[node.id,node.rect,node.matrix]:null),n.id,n.rect,n.matrix,n.effects,scene.view,scene.extent,scene.background,scene.transparent,
    scene.grid,scene.checkerboard,scene.colorManagement,scene.integratedBlur,scene.floatCompositing],
    (_key,value)=>Object.is(value,-0)?'-0':value)
}

/** A translated first selected root samples an unchanged prefix. The lease
 * certifies that only selected transforms changed; no arbitrary document edit
 * may reuse this result. Crop boundaries are handled by the overlap planner. */
export function movingBackdropKey(scene: GpuScene, n: GpuNode): string | undefined {
  if (!scene.nativeInteraction || !scene.interactionLease || !scene.interactionRetained || scene.coherentSamples ||
      !n.clip || n.mask || n.passthrough || !scene.interactionSelection?.includes(n.id)) return
  const index=sceneIndex(scene), position=scene.roots.indexOf(n.id)
  if(position<0 || scene.interactionSelection.some(id=>index.rootFor.get(id)!==n.id))return
  const prefix=scene.roots.slice(0,position).map(id=>scene.nodes[id])
  if(prefix.some(node=>node?.previewDynamic))return
  return JSON.stringify([prefix.map(node=>node?[node.id,node.rect,node.matrix]:null),n.id,n.effects,
    scene.view,scene.extent,scene.background,scene.transparent,scene.grid,scene.checkerboard,
    scene.colorManagement,scene.integratedBlur,scene.floatCompositing,scene.displayFilters],
    (_key,value)=>Object.is(value,-0)?'-0':value)
}
