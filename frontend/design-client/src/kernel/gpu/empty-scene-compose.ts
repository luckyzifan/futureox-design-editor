import type { GpuScene } from './types'

/** Conservative dependency classification, not scene validation. Like the
 * renderer's scene index this assumes immutable, ordinary compiled topology.
 * No reflection check can prove an adversarial Proxy stays empty across await. */
export function emptyManagedComposeScene(scene: GpuScene, managed: boolean) {
  if (managed !== true) return false
  try {
    const nodesProperty = Object.getOwnPropertyDescriptor(scene, 'nodes')
    const rootsProperty = Object.getOwnPropertyDescriptor(scene, 'roots')
    const sequentialProperty = Object.getOwnPropertyDescriptor(scene, 'sequentialDisplay')
    if (!nodesProperty || !('value' in nodesProperty) || !rootsProperty || !('value' in rootsProperty)) return false
    if (sequentialProperty ? !('value' in sequentialProperty) ||
      sequentialProperty.value !== undefined && sequentialProperty.value !== false : 'sequentialDisplay' in scene) return false
    const nodes: unknown = nodesProperty.value, roots: unknown = rootsProperty.value
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return false
    const prototype = Object.getPrototypeOf(nodes)
    if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(nodes).length !== 0) return false
    // Reject array-likes, custom iterators/prototypes and extra own properties.
    return Array.isArray(roots) && Object.getPrototypeOf(roots) === Array.prototype &&
      roots.length === 0 && Reflect.ownKeys(roots).length === 1
  } catch { return false }
}
