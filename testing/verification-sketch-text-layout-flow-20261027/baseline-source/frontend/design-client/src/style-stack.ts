import type { DesignNode, Paint, Stroke, Effect } from './model'
export type StyleField = 'fills' | 'strokes' | 'effects'
export type StyleItem = Paint | Stroke | Effect
export type StyleSlot = { index: number; kind: string; ids: string[] }
export const styleKind = (field: StyleField, item: StyleItem) => field === 'strokes' ? (item as Stroke).paint.kind : (item as Paint | Effect).kind
export function styleSlots(nodes: DesignNode[], field: StyleField): StyleSlot[] {
  const slots = new Map<string, StyleSlot>()
  for (const node of nodes) node[field].forEach((item, index) => {
    const kind = styleKind(field, item), key = `${index}:${kind}`
    if (!slots.has(key)) slots.set(key, { index, kind, ids: [] })
    slots.get(key)!.ids.push(node.id)
  })
  return [...slots.values()].sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind))
}
export function editStyleSlot(node: DesignNode, field: StyleField, slot: StyleSlot, edit: (item: StyleItem) => void) {
  const item = node[field][slot.index]
  if (slot.ids.includes(node.id) && item && styleKind(field, item) === slot.kind) edit(item)
}
export function styleValue(item: StyleItem, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, item)
}
export function setStyleValue(item: StyleItem, path: string, value: unknown) {
  const keys = path.split('.'), last = keys.pop()!
  const parent = keys.length ? styleValue(item, keys.join('.')) : item
  if (!parent || typeof parent !== 'object') return false
  ;(parent as Record<string, unknown>)[last] = value
  return true
}
