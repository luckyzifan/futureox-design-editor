import { allActions, expressionVariables } from './prototype-logic'
/** Authored variable edits. Call inside Editor.change for validation, undo and persistence. */
import { validColor } from './color'
import { emptySystem, variableValue, type DesignSystem, type VariableValue } from './design-system'
import { uid, type DesignDocument, type DesignNode } from './model'
import type { PrototypeAction } from './prototype'

export type Variable = DesignSystem['variables'][string]
export type VariableKind = Variable['kind']
export const variableKinds: VariableKind[] = ['color', 'number', 'boolean', 'string']
export const VARIABLE_PAGE_SIZE = 40
export const MODE_PAGE_SIZE = 3
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
export function validVariableName(value: string) {
  return !!value.trim() && new TextEncoder().encode(value).length <= 512 &&
    !unsafe.has(value) && !/[\u0000-\u001f\u007f]/.test(value)
}
function name(value: string) {
  const next = value.trim()
  if (!validVariableName(next)) throw new Error('名称不能为空、包含控制字符或超过 512 字节')
  return next
}
function collection(doc: DesignDocument, id: string) {
  const s = doc.designSystem
  if (!s || !Object.hasOwn(s.collections, id)) throw new Error('变量集合不存在')
  return s.collections[id]
}
function variable(doc: DesignDocument, id: string) {
  const s = doc.designSystem
  if (!s || !Object.hasOwn(s.variables, id)) throw new Error('变量不存在')
  return s.variables[id]
}
function refs(n: DesignNode) {
  return [
    { label: `图层「${n.name}」`, value: n },
    ...Object.entries(n.instance?.overrides || {}).map(([key, value]) => ({ label: `实例「${n.name}」覆盖 ${key}`, value })),
  ] as { label: string; value: { bindings?: Record<string, string>; variableModes?: Record<string, string> } }[]
}
function actions(doc: DesignDocument) {
  return Object.entries(doc.prototype?.interactions || {}).flatMap(([id, events]) =>
    events.flatMap((event, ei) => allActions(event.actions).map((action, ai) => ({
      action, label: `原型「${doc.nodes[id]?.name || id}」交互 ${ei + 1} / 动作 ${ai + 1}`,
    }))),
  )
}
function actionVariable(a: PrototypeAction) { return a.targetVariable || a.targetVariableData?.id || (a.kind === 'set-variable' ? a.target : undefined) }
function actionDataVariable(a: PrototypeAction) { return a.targetVariableData?.id || a.targetVariable || (a.kind === 'set-variable' ? a.target : undefined) }
export function variableReferences(doc: DesignDocument, id: string): string[] {
  const result: string[] = []
  for (const v of Object.values(doc.designSystem?.variables || {}))
    for (const [mode, value] of Object.entries(v.values))
      if (typeof value === 'object' && value.alias === id) result.push(`别名「${v.name}」/ ${mode}`)
  for (const n of Object.values(doc.nodes)) for (const { label, value } of refs(n))
    for (const [path, target] of Object.entries(value.bindings || {}))
      if (target === id) result.push(`${label} · ${path}`)
  for (const [nodeId, events] of Object.entries(doc.prototype?.interactions || {}))
    events.forEach((event, ei) => {
      if (event.condition?.variable === id) result.push(`原型「${doc.nodes[nodeId]?.name || nodeId}」交互 ${ei + 1} 条件`)
    })
  for (const { action: a, label } of actions(doc)) {
    const fields = [a.targetVariable, a.targetVariableData?.id, a.transitionDurationVar, a.transitionEasingVar,
      a.kind === 'set-variable' ? a.target : undefined]
    if (fields.includes(id) || expressionVariables(a.expression).some(v => v.id === id)) result.push(label)
  }
  return result
}
export function collectionReferences(doc: DesignDocument, id: string): string[] {
  const result: string[] = []
  for (const v of Object.values(doc.designSystem?.variables || {})) if (v.collection === id) result.push(`变量「${v.name}」`)
  for (const n of Object.values(doc.nodes)) for (const { label, value } of refs(n))
    if (Object.hasOwn(value.variableModes || {}, id)) result.push(`${label} · 局部模式`)
  for (const { action: a, label } of actions(doc))
    if (a.targetVariableSetId === id || a.targetVariableSetKey === id) result.push(`${label} · 变量集合`)
  return result
}
export function modeReferences(doc: DesignDocument, id: string, mode: string): string[] {
  const c = collection(doc, id), result: string[] = []
  if (c.defaultMode === mode) result.push('集合默认模式：请先选择其他默认模式')
  if (doc.designSystem!.activeModes[id] === mode) result.push('文档当前模式：请先切换其他模式')
  for (const n of Object.values(doc.nodes)) for (const { label, value } of refs(n))
    if (value.variableModes?.[id] === mode) result.push(`${label} · 局部模式`)
  return result.concat(prototypeVariableModeReferences(doc, id, mode))
}
/** Includes both imported metadata references and the player's independently resolved target/mode. */
export function prototypeVariableModeReferences(doc: DesignDocument, id: string, mode: string): string[] {
  const result: string[] = []
  const belongs = (target: string | undefined) => !!target && doc.designSystem!.variables[target]?.collection === id
  for (const { action: a, label } of actions(doc))
    if ((a.targetVariableModeId === mode && belongs(actionVariable(a))) ||
      (a.targetVariableData?.modeId === mode && belongs(actionDataVariable(a))) ||
      (a.kind === 'set-variable' && belongs(actionVariable(a)) && (a.targetVariableModeId || a.targetVariableData?.modeId) === mode)) result.push(label)
  return result
}
function unreferenced(references: string[]) {
  if (references.length) throw new Error(`仍有 ${references.length} 处引用；请先移除或改用其他资源：${references.slice(0, 3).join('；')}`)
}
export function createVariableCollection(doc: DesignDocument, value: string) {
  const s = doc.designSystem ??= emptySystem(), id = uid()
  s.collections[id] = { name: name(value || '主题'), modes: ['Light', 'Dark'], defaultMode: 'Light' }
  s.activeModes[id] = 'Light'
  return id
}
export function renameVariableCollection(doc: DesignDocument, id: string, value: string) { collection(doc, id).name = name(value) }
export function renameVariable(doc: DesignDocument, id: string, value: string) { variable(doc, id).name = name(value) }
export function createVariable(doc: DesignDocument, collectionId: string, kind: VariableKind) {
  const c = collection(doc, collectionId), s = doc.designSystem!, id = uid()
  const initial = kind === 'color' ? '#7755dd' : kind === 'number' ? 16 : kind === 'boolean' ? true : '文字'
  const base = `新${kind}变量`, names = new Set(Object.values(s.variables).filter(v => v.collection === collectionId).map(v => v.name))
  let candidate = base, suffix = 2
  while (names.has(candidate)) candidate = `${base} ${suffix++}`
  s.variables[id] = { name: candidate, collection: collectionId, kind, values: Object.fromEntries(c.modes.map(mode => [mode, initial])) }
  return id
}
export function addVariableMode(doc: DesignDocument, id: string, value: string, copyFrom?: string) {
  const c = collection(doc, id), mode = name(value), from = copyFrom ?? c.defaultMode
  if (c.modes.length >= 32) throw new Error('每个集合最多 32 个模式')
  if (c.modes.includes(mode)) throw new Error('此模式名称已存在')
  if (!c.modes.includes(from)) throw new Error('复制来源模式不存在')
  c.modes.push(mode)
  for (const v of Object.values(doc.designSystem!.variables)) if (v.collection === id)
    v.values[mode] = typeof v.values[from] === 'object' ? { ...v.values[from] as { alias: string } } : v.values[from]
}
export function renameVariableMode(doc: DesignDocument, id: string, mode: string, value: string) {
  const c = collection(doc, id), next = name(value), s = doc.designSystem!
  if (!c.modes.includes(mode)) throw new Error('变量模式不存在')
  if (mode === next) return
  if (c.modes.includes(next)) throw new Error('此模式名称已存在')
  c.modes = c.modes.map(m => m === mode ? next : m)
  if (c.defaultMode === mode) c.defaultMode = next
  if (s.activeModes[id] === mode) s.activeModes[id] = next
  for (const v of Object.values(s.variables)) if (v.collection === id) { v.values[next] = v.values[mode]; delete v.values[mode] }
  remapVariableModeReferences(doc, id, mode, next)
}
/** Shared by UI edits and the atomic automation API; never evaluates or renders. */
export function remapVariableModeReferences(doc: DesignDocument, id: string, mode: string, next: string) {
  const s = doc.designSystem!
  // Keep materialized copies valid for admission too. captureOverrides
  // recognizes a provably equivalent unique mode rename without freezing inheritance.
  for (const n of Object.values(doc.nodes)) for (const { value } of refs(n))
    if (value.variableModes?.[id] === mode) value.variableModes[id] = next
  for (const { action: a } of actions(doc)) {
    const target = actionVariable(a), dataTarget = actionDataVariable(a)
    const targetHere = !!target && s.variables[target]?.collection === id
    const dataHere = !!dataTarget && s.variables[dataTarget]?.collection === id
    if (a.kind === 'set-variable' && !mode &&
      ((targetHere && a.targetVariableModeId === mode) || (!a.targetVariableModeId && dataHere && a.targetVariableData?.modeId === mode)))
      throw new Error('原型使用空模式回退；请先为动作指定明确的变量模式')
    // Playback takes targetVariable first, but falls back independently to
    // VariableData.modeId. When their collections differ, preserve both the
    // raw metadata and the effective target's mode by pinning an explicit mode.
    if (a.kind === 'set-variable' && !a.targetVariableModeId && a.targetVariableData?.modeId === mode && targetHere !== dataHere) {
      if (!mode) throw new Error('原型使用空模式回退；请先为动作指定明确的变量模式')
      a.targetVariableModeId = targetHere ? next : mode
    }
    if (targetHere && a.targetVariableModeId === mode) a.targetVariableModeId = next
    if (dataHere && a.targetVariableData?.modeId === mode) a.targetVariableData.modeId = next
  }
}
export function setVariableDefaultMode(doc: DesignDocument, id: string, mode: string) {
  const c = collection(doc, id)
  if (!c.modes.includes(mode)) throw new Error('变量模式不存在')
  c.defaultMode = mode
}
export function deleteVariable(doc: DesignDocument, id: string) { variable(doc, id); unreferenced(variableReferences(doc, id)); delete doc.designSystem!.variables[id] }
export function deleteVariableCollection(doc: DesignDocument, id: string) {
  collection(doc, id); unreferenced(collectionReferences(doc, id))
  delete doc.designSystem!.collections[id]; delete doc.designSystem!.activeModes[id]
}
export function deleteVariableMode(doc: DesignDocument, id: string, mode: string) {
  const c = collection(doc, id)
  if (!c.modes.includes(mode)) throw new Error('变量模式不存在')
  if (c.modes.length === 1) throw new Error('必须保留至少一个模式')
  unreferenced(modeReferences(doc, id, mode))
  c.modes = c.modes.filter(m => m !== mode)
  for (const v of Object.values(doc.designSystem!.variables)) if (v.collection === id) delete v.values[mode]
}
export function parseVariableLiteral(kind: VariableKind, value: string, managed = false): string | number | boolean {
  if (kind === 'number') {
    if (!value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e7)
      throw new Error('请输入 -10000000 至 10000000 的有限数值')
    return Number(value)
  }
  if (kind === 'boolean') { if (!['true', 'false'].includes(value)) throw new Error('布尔值必须为 true 或 false'); return value === 'true' }
  if (kind === 'color' && !validColor(value, managed)) throw new Error('请输入 #RRGGBB 或文档支持的 color() 颜色')
  if (new TextEncoder().encode(value).length > 100000) throw new Error('文字超过 100000 字节')
  return value
}
export function setVariableCell(doc: DesignDocument, id: string, mode: string, value: VariableValue) {
  const v = variable(doc, id), c = collection(doc, v.collection)
  if (!c.modes.includes(mode)) throw new Error('变量模式不存在')
  if (typeof value === 'object') {
    const target = variable(doc, value.alias)
    if (target.kind !== v.kind || value.alias === id) throw new Error('别名必须引用其他同类型变量')
    v.values[mode] = { alias: value.alias }
  } else v.values[mode] = parseVariableLiteral(v.kind, String(value), !!doc.colorManagement)
}
/** Resolve the edited column, not the document's active mode. Other collections
 * retain their own active/default modes, matching the kernel's context semantics. */
export function materializeVariableCell(doc: DesignDocument, id: string, mode: string) {
  const v = variable(doc, id), s = doc.designSystem!
  setVariableCell(doc, id, mode, variableValue(s, id, { ...s.activeModes, [v.collection]: mode }))
}
export function variableIndex(system: DesignSystem) {
  const byCollection = new Map<string, [string, Variable][]>(), byKind = new Map<VariableKind, [string, Variable][]>()
  for (const entry of Object.entries(system.variables)) {
    const [, v] = entry
    const collection = byCollection.get(v.collection) || []; collection.push(entry); byCollection.set(v.collection, collection)
    const kind = byKind.get(v.kind) || []; kind.push(entry); byKind.set(v.kind, kind)
  }
  for (const list of byCollection.values()) list.sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]))
  return { byCollection, byKind }
}
export function variableGroup(value: string) { const at = value.lastIndexOf('/'); return at < 0 ? '未分组' : value.slice(0, at) || '未分组' }
