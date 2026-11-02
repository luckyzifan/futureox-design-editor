import type { DesignDocument, DesignNode } from '../model'

export type PluginPatch = {
  pageId: string
  selection: string[]
  schemaVersion: number
  nodes: Record<string, Record<string, unknown>>
  removed: string[]
  pageChildren: Record<string, string[]>
  addedPages: { id: string; name: string; children: string[]; background: string; guides?: unknown[] }[]
  removedPages: string[]
  pageNames: Record<string, string>
  documentName: string | null
}

export function pluginPatchMutatesDocument(patch: PluginPatch, document: DesignDocument): boolean {
  return Object.keys(patch.nodes).length > 0
    || patch.removed.length > 0
    || patch.addedPages.length > 0
    || patch.removedPages.length > 0
    || Object.keys(patch.pageChildren).length > 0
    || Object.keys(patch.pageNames).length > 0
    || (typeof patch.documentName === 'string' && patch.documentName !== document.name)
    || patch.schemaVersion > document.schemaVersion
}

export function applyPluginPatch(document: DesignDocument, patch: PluginPatch): void {
  if (patch.schemaVersion > document.schemaVersion) {
    document.schemaVersion = patch.schemaVersion as DesignDocument['schemaVersion']
  }
  if (typeof patch.documentName === 'string') document.name = patch.documentName
  for (const id of patch.removedPages) {
    const index = document.pages.findIndex(page => page.id === id)
    if (index >= 0) document.pages.splice(index, 1)
  }
  for (const page of patch.addedPages) {
    document.pages.push({ id: page.id, name: page.name, children: [...page.children], background: page.background })
  }
  for (const [id, name] of Object.entries(patch.pageNames)) {
    const page = document.pages.find(item => item.id === id)
    if (page) page.name = name
  }
  for (const [id, children] of Object.entries(patch.pageChildren)) {
    const page = document.pages.find(item => item.id === id)
    if (page) page.children = [...children]
  }
  for (const id of patch.removed) delete document.nodes[id]
  for (const [id, node] of Object.entries(patch.nodes)) document.nodes[id] = materializeNode(node)
}

export function materializeNode(value: Record<string, unknown>): DesignNode {
  const kind = (typeof value.kind === 'string' ? value.kind : 'rectangle') as DesignNode['kind']
  const node: Record<string, unknown> = {
    ...stripNulls(value) as Record<string, unknown>,
    id: String(value.id),
    kind,
    name: typeof value.name === 'string' ? value.name : '',
    transform: Array.isArray(value.transform) ? value.transform : [1, 0, 0, 1, 0, 0],
    width: Number(value.width),
    height: Number(value.height),
    children: Array.isArray(value.children) ? value.children : [],
    visible: value.visible !== false,
    locked: value.locked === true,
    opacity: typeof value.opacity === 'number' ? value.opacity : 1,
    blend: typeof value.blend === 'string' ? value.blend : 'normal',
    fills: Array.isArray(value.fills) ? value.fills : [],
    strokes: Array.isArray(value.strokes) ? value.strokes : [],
    effects: Array.isArray(value.effects) ? value.effects : [],
    radii: Array.isArray(value.radii) ? value.radii : [0, 0, 0, 0],
    smoothing: typeof value.smoothing === 'number' ? value.smoothing : 0,
    clip: value.clip === true,
    mask: value.mask === true,
    points: typeof value.points === 'number' ? value.points : kind === 'star' ? 5 : kind === 'polygon' ? 3 : 0,
    innerRadius: typeof value.innerRadius === 'number' ? value.innerRadius : kind === 'star' ? 0.45 : 0,
    text: typeof value.text === 'string' ? value.text : '',
    fontSize: typeof value.fontSize === 'number' ? value.fontSize : 28,
  }
  return node as DesignNode
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null).map(([key, item]) => [key, stripNulls(item)]))
}
