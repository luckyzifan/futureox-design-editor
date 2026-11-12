import { documentPatch, equalValue, shareDocument, type DocumentPatch } from './document-patch'
import type { DesignDocument } from './model'

export type WorkspacePatch = DocumentPatch & { deletedFields?: string[] }
const fields = new Set([
  'fdCompatibility', 'schemaVersion', 'name', 'pages', 'fonts', 'animations',
  'rasterProfile', 'colorManagement', 'designSystem', 'prototype', 'reviews',
])
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function workspacePatch(before: DesignDocument, after: DesignDocument): WorkspacePatch {
  const shared = shareDocument(before, after)
  const patch = documentPatch(before, shared)
  const deletedFields = Object.keys(patch.fields).filter(key => !Object.hasOwn(shared, key) ||
    (shared as unknown as Record<string, unknown>)[key] === undefined)
  for (const key of deletedFields) delete patch.fields[key]
  return deletedFields.length ? { ...patch, deletedFields } : patch
}

export function hasWorkspaceChanges(patch: WorkspacePatch) {
  return !!(Object.keys(patch.nodes).length || Object.keys(patch.fields).length || patch.deletedFields?.length)
}

export function readWorkspacePatch(value: unknown): WorkspacePatch {
  if (!object(value) || !object(value.fields) || !object(value.nodes) ||
      Object.keys(value.fields).some(key => !fields.has(key)) ||
      Object.entries(value.nodes).some(([key, node]) => !uuid.test(key) ||
        node !== null && (!object(node) || node.id !== key)) ||
      (value.deletedFields !== undefined && (!Array.isArray(value.deletedFields) ||
        value.deletedFields.some(key => typeof key !== 'string' || !fields.has(key) || Object.hasOwn(value.fields as object, key)))))
    throw Error('服务器编辑增量无效')
  return value as WorkspacePatch
}

export function applyWorkspacePatch(document: DesignDocument, patch: WorkspacePatch): DesignDocument {
  if (!hasWorkspaceChanges(patch)) return document
  const next = { ...document, ...patch.fields, nodes: document.nodes }
  for (const key of patch.deletedFields || []) delete (next as unknown as Record<string, unknown>)[key]
  if (Object.keys(patch.nodes).length) {
    next.nodes = { ...document.nodes }
    for (const [id, node] of Object.entries(patch.nodes)) {
      if (node === null) delete next.nodes[id]
      else next.nodes[id] = node
    }
  }
  return next
}

export function workspacePatchesConflict(local: WorkspacePatch, remote: WorkspacePatch) {
  for (const [id, node] of Object.entries(local.nodes))
    if (Object.hasOwn(remote.nodes, id) && !equalValue(node, remote.nodes[id])) return true
  for (const [key, value] of Object.entries(local.fields))
    if (remote.deletedFields?.includes(key) ||
        Object.hasOwn(remote.fields, key) && !equalValue(value, remote.fields[key])) return true
  return local.deletedFields?.some(key => Object.hasOwn(remote.fields, key)) ?? false
}
