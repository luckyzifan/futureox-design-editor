import type { DesignDocument, DesignNode, Scene3d } from './model'

/** The parent frame control is shown for a direct 3D child or a direct preserve-3D frame. */
export function frameOffersNested3d(doc: DesignDocument, node: DesignNode): boolean {
  if (node.kind !== 'frame') return false
  return node.children.some(id => {
    const child = doc.nodes[id]
    if (!child) return false
    if (child.transform3d?.type === 'FIXED_ORDER') return true
    return child.kind === 'frame' && child.scene3d?.preserve3d === true
  })
}

/** Selected state 0 is Turn into flat plane. Selected state 1 is Keep nested layers 3D. */
export function nested3dSelected(node: DesignNode): 0 | 1 {
  return node.scene3d?.preserve3d ? 1 : 0
}

export function assignPreserve3d(node: DesignNode, document: DesignDocument, preserve: boolean) {
  const current: Scene3d | undefined = node.scene3d
  const perspective = current?.perspective ?? -1
  const visible = current?.visible
  if (!preserve && perspective === -1 && visible !== false) delete node.scene3d
  else node.scene3d = { perspective, preserve3d: preserve, ...(visible === false ? { visible: false } : {}) }
  if (document.schemaVersion < 24) document.schemaVersion = 24
}
