import type { DesignDocument, DesignNode } from '../../model'

export type PluginNodeChange =
  | { type: 'CREATE' | 'DELETE'; id: string }
  | { type: 'PROPERTY_CHANGE'; id: string; properties: string[] }
export type PluginDocumentChanges = { documentChanges: PluginNodeChange[]; truncated?: true }

const LIMIT = 256
const PROPERTIES = {
  name: 'name', visible: 'visible', locked: 'locked', opacity: 'opacity', width: 'width', height: 'height',
  fills: 'fills', strokes: 'strokes', effects: 'effects', blend: 'blendMode', clip: 'clipsContent',
  radii: 'cornerRadius', children: 'children', text: 'characters', fontSize: 'fontSize',
} satisfies Partial<Record<keyof DesignNode, string>>
const NODE_PROPERTIES = Object.entries(PROPERTIES) as [keyof typeof PROPERTIES, string][]

function changedProperties(previous: DesignNode, next: DesignNode) {
  const properties: string[] = []
  for (const [field, property] of NODE_PROPERTIES) {
    if (previous[field] !== next[field]) properties.push(property)
  }
  if (previous.transform.some((value, index) => value !== next.transform[index])) {
    properties.push('relativeTransform')
    if (previous.transform[4] !== next.transform[4]) properties.push('x')
    if (previous.transform[5] !== next.transform[5]) properties.push('y')
  }
  if (previous.layout?.mode !== next.layout?.mode) properties.push('layoutMode')
  if (previous.layout?.gap !== next.layout?.gap) properties.push('itemSpacing')
  if (previous.styleRefs?.fills !== next.styleRefs?.fills) properties.push('fillStyleId')
  if (previous.styleRefs?.effects !== next.styleRefs?.effects) properties.push('effectStyleId')
  if (previous.styleRefs?.textStyle !== next.styleRefs?.textStyle) properties.push('textStyleId')
  return properties
}

function subtreeRoots(ids: string[], nodes: DesignDocument['nodes']) {
  const roots = new Set(ids)
  for (const id of ids) {
    for (const child of nodes[id].children) roots.delete(child)
  }
  return roots
}

/** Diff immutable authored snapshots only when a plugin listens to documentchange. */
export function pluginDocumentChanges(previous: DesignDocument, next: DesignDocument): PluginDocumentChanges {
  const documentChanges: PluginNodeChange[] = []
  if (previous.nodes === next.nodes) return { documentChanges }
  let truncated = false
  function record(change: PluginNodeChange) {
    if (documentChanges.length < LIMIT) documentChanges.push(change)
    else truncated = true
  }
  const created: string[] = []
  const deleted: string[] = []
  for (const id in next.nodes) {
    const before = previous.nodes[id]
    const after = next.nodes[id]
    if (before === after) continue
    if (!before) created.push(id)
    else {
      const properties = changedProperties(before, after)
      if (properties.length) record({ type: 'PROPERTY_CHANGE', id, properties })
    }
  }
  for (const id in previous.nodes) {
    if (!next.nodes[id]) deleted.push(id)
  }
  for (const id of subtreeRoots(created, next.nodes)) record({ type: 'CREATE', id })
  for (const id of subtreeRoots(deleted, previous.nodes)) record({ type: 'DELETE', id })
  return truncated ? { documentChanges, truncated: true } : { documentChanges }
}
