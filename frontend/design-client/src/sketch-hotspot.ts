import { emptySystem } from './design-system'
import { defaultSizing, type DesignDocument, type DesignNode } from './model'

type LayerMetadata = Record<string, { bindings?: Record<string, string> }>

export function isSketchHotspot(doc: DesignDocument, node: DesignNode | undefined) {
  if (!node) return false
  const metadata = doc.designSystem?.sketchContainers?.nodeMetadata as LayerMetadata | undefined
  return !!(node.bindings?.sketchSourceHotspot || metadata?.[node.id]?.bindings?.sketchSourceHotspot)
}

/** Use the same paintless layer and metadata the Sketch importer produces. */
export function authorSketchHotspot(doc: DesignDocument, node: DesignNode) {
  node.name = '热点'
  node.fills = []
  node.strokes = []
  node.sizing = { ...defaultSizing(), absolute: true }
  const system = doc.designSystem ??= emptySystem()
  const containers = system.sketchContainers ??= {}
  if (!containers.nodeMetadata || typeof containers.nodeMetadata !== 'object' || Array.isArray(containers.nodeMetadata))
    containers.nodeMetadata = {}
  const metadata = containers.nodeMetadata as LayerMetadata
  metadata[node.id] = { bindings: { sketchSourceHotspot: 'true' } }
  const prototype = doc.prototype ??= { interactions: {} }
  prototype.interactions[node.id] = [{ trigger: 'click', actions: [] }]
}
