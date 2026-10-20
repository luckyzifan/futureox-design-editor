import type { DesignDocument } from './model'

export type ChangeKind = 'add' | 'delete' | 'move' | 'style' | 'text' | 'property'
export type DocumentChange = { id: string; name: string; kind: ChangeKind; field: string; before?: string; after?: string }
export const changeLabels: Record<ChangeKind, string> = { add: '新增', delete: '删除', move: '移动 / 排序', style: '样式', text: '文本', property: '属性' }
const styleFields = new Set(['fills', 'strokes', 'effects', 'opacity', 'blend', 'radii', 'smoothing', 'fontSize', 'textStyle', 'textRuns', 'styleRefs', 'visible'])
const moveFields = new Set(['transform', 'width', 'height', 'layout', 'sizing', 'constraints'])
const labels: Record<string, string> = { name: '名称', text: '文本内容', transform: '位置 / 变换', width: '宽度', height: '高度', fills: '填充', strokes: '描边', effects: '效果', opacity: '不透明度', fontSize: '字号', textStyle: '文字样式', children: '子图层顺序', parent: '所属容器 / 顺序' }
// Compare real values but never serialize asset payloads into the readable report.
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>
  const keys = Object.keys(aa).sort(), other = Object.keys(bb).sort()
  return keys.length === other.length && keys.every((key, i) => key === other[i] && equal(aa[key], bb[key]))
}
function summary(value: unknown, field = ''): string {
  if (value === undefined) return '未设置'
  if (/(^|\.)(image|data|bytes|fonts)(\.|$)/i.test(field)) return '[资源内容已省略]'
  if (typeof value === 'string') return /^data:|^[A-Za-z0-9+/]{128}/.test(value) ? '[资源内容]' : value.length > 120 ? `${value.slice(0, 120)}…` : value
  if (value === null || typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.every(v => typeof v === 'number') ? value.join(', ') : `${value.length} 项`
  return '已设置'
}
function changedFields(a: unknown, b: unknown, path: string, depth = 0): { path: string; before: string; after: string }[] {
  if (equal(a, b)) return []
  if (depth < 5 && a && b && typeof a === 'object' && typeof b === 'object' && !/(^|\.)(image|data|bytes|fonts)(\.|$)/i.test(path)) {
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>
    const keys = [...new Set([...Object.keys(aa), ...Object.keys(bb)])].sort()
    if (keys.length <= 100) return keys.flatMap(key => changedFields(aa[key], bb[key], `${path}.${key}`, depth + 1))
  }
  return [{ path, before: summary(a, path), after: summary(b, path) }]
}

function parents(document: DesignDocument) {
  const result = new Map<string, string>()
  for (const parent of [...document.pages, ...Object.values(document.nodes)])
    parent.children.forEach((id, index) => result.set(id, `${parent.id} · ${index + 1}`))
  return result
}
/** Stable IDs, not names or object insertion order, identify nodes across snapshots. */
export function diffDocuments(before: DesignDocument, after: DesignDocument): DocumentChange[] {
  const changes: DocumentChange[] = [], oldParents = parents(before), newParents = parents(after)
  function compare(id: string, name: string, a: Record<string, unknown>, b: Record<string, unknown>, excluded: string[] = []) {
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (excluded.includes(field) || equal(a[field], b[field])) continue
      for (const change of changedFields(a[field], b[field], field))
        changes.push({ id, name, kind: field === 'text' ? 'text' : moveFields.has(field) || field === 'parent' || field === 'children' ? 'move' : styleFields.has(field) ? 'style' : 'property', field: change.path.replace(field, labels[field] || field), before: change.before, after: change.after })
    }
  }
  for (const id of [...new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])].sort()) {
    const a = before.nodes[id], b = after.nodes[id]
    if (!a || !b) { changes.push({ id, name: (b || a).name, kind: b ? 'add' : 'delete', field: '图层' }); continue }
    compare(id, b.name, { ...a, parent: oldParents.get(id) }, { ...b, parent: newParents.get(id) }, ['id', 'children'])
  }
  const oldPages = new Map(before.pages.map(p => [p.id, p])), newPages = new Map(after.pages.map(p => [p.id, p]))
  for (const id of new Set([...oldPages.keys(), ...newPages.keys()])) {
    const a = oldPages.get(id), b = newPages.get(id)
    if (!a || !b) changes.push({ id, name: (b || a)!.name, kind: b ? 'add' : 'delete', field: '页面' })
    else compare(id, b.name, a, b, ['id', 'children'])
  }
  compare(after.id, '文档', before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['id', 'nodes', 'pages', 'fonts'])
  if (!equal(before.pages.map(p => p.id), after.pages.map(p => p.id))) changes.push({ id: after.id, name: '文档', kind: 'move', field: '页面顺序' })
  if (!equal(before.fonts, after.fonts)) changes.push({ id: after.id, name: '文档', kind: 'style', field: '字体资源', before: `${Object.keys(before.fonts || {}).length} 项`, after: `${Object.keys(after.fonts || {}).length} 项` })
  return changes
}
