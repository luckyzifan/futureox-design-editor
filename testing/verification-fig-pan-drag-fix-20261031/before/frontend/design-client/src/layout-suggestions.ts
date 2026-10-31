/** Deterministic, conservative geometry inference. A preview is data, never an edit.
 * Work is bounded to 1,000 inspected nodes; each sibling list is sorted once per
 * candidate axis. Existing hierarchy is retained instead of guessing semantics. */
import { referenceHash } from './automation/context'
import { allParents } from './geometry'
import { container, defaultLayout, type AutoLayout, type DesignDocument, type DesignNode } from './model'

export const LAYOUT_SUGGESTION_LIMIT = 1000
const EPS = 1e-9
/** Optional view metadata; never part of document changes or fingerprint input. */
export type LayoutSuggestionText =
  | { key: 'horizontal' | 'vertical' | 'grid' | 'nested' | 'wrapped' | 'preserve-coordinates' | 'independent-containers' | 'wrapped-compatible' | 'grid-versus-wrap' | 'ancestor-excluded' }
  | { key: 'subtree-excluded' | 'explicit-edit-required' | 'ambiguous-geometry'; frameName: string }
  | { key: 'frame-layout'; frameName: string; mode: AutoLayout['mode']; gap: number; align: AutoLayout['align'] }
export type LayoutSuggestionChange = { frameId: string; layout: AutoLayout; order: string[] }
export type LayoutSuggestion = { id: string; label: string; confidence: number; explanation: string[]; changes: LayoutSuggestionChange[]; display?: { label: LayoutSuggestionText; explanation: LayoutSuggestionText[] } }
export type LayoutSuggestionPreview = { frameId: string; fingerprint: string; revision?: number; inspectedNodes: number; suggestions: LayoutSuggestion[]; warnings: string[]; warningDisplay?: LayoutSuggestionText[] }
const near = (a: number, b: number) => Math.abs(a - b) <= EPS
const uniform = (values: number[]) => values.length === 0 || values.every(v => near(v, values[0]))
const fixed = (n: DesignNode) => (!n.sizing || (n.sizing.width === 'fixed' && n.sizing.height === 'fixed'))
const axisAligned = (n: DesignNode) => n.transform.slice(0, 4).every((v, i) => v === (i === 0 || i === 3 ? 1 : 0))
function boundsOf(nodes: DesignNode[]) {
  return nodes.reduce((b, n) => ({ x: Math.min(b.x, n.transform[4]), y: Math.min(b.y, n.transform[5]), right: Math.max(b.right, n.transform[4] + n.width), bottom: Math.max(b.bottom, n.transform[5] + n.height) }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity })
}
function padding(frame: DesignNode, nodes: DesignNode[]): AutoLayout['padding'] | undefined {
  const b = boundsOf(nodes), values: AutoLayout['padding'] = [b.y, frame.width - b.right, frame.height - b.bottom, b.x]
  return values.every(v => Number.isFinite(v) && v >= 0 && v <= 1e5) ? values : undefined
}
function stack(frame: DesignNode, children: DesignNode[], axis: 0 | 1): LayoutSuggestionChange | undefined {
  const order = [...children].sort((a, b) => a.transform[4 + axis] - b.transform[4 + axis] || a.id.localeCompare(b.id))
  const extent = (n: DesignNode, ax: number) => ax === 0 ? n.width : n.height
  const gaps = order.slice(1).map((n, i) => n.transform[4 + axis] - order[i].transform[4 + axis] - extent(order[i], axis))
  if (!uniform(gaps) || gaps.some(g => g < 0 || g > 1e5)) return
  const cross = 1 - axis
  const align = (['start', 'center', 'end'] as const).find((_, i) => uniform(order.map(n => n.transform[4 + cross] + extent(n, cross) * i / 2)))
  const pad = padding(frame, order)
  if (!align || !pad) return
  return { frameId: frame.id, order: order.map(n => n.id), layout: { ...defaultLayout(), mode: axis === 0 ? 'horizontal' : 'vertical', gap: gaps[0] ?? 0, lineGap: 0, padding: pad, align } }
}
function grid(frame: DesignNode, children: DesignNode[]): LayoutSuggestionChange | undefined {
  // Rectangular regular grids only. Sparse, overlapping or spanning grids need
  // a human choice of topology and are deliberately not silently repacked.
  const order = [...children].sort((a, b) => a.transform[5] - b.transform[5] || a.transform[4] - b.transform[4] || a.id.localeCompare(b.id))
  if (!uniform(order.map(n => n.width)) || !uniform(order.map(n => n.height))) return
  const rows: DesignNode[][] = []
  for (const n of order) {
    if (!rows.length || !near(rows[rows.length - 1][0].transform[5], n.transform[5])) rows.push([])
    rows[rows.length - 1].push(n)
  }
  const cols = rows[0].length
  if (rows.length < 2 || cols < 2 || cols > 100 || rows.some(row => row.length !== cols)) return
  const xs = rows[0].map(n => n.transform[4])
  if (rows.some(row => row.some((n, i) => !near(n.transform[4], xs[i])))) return
  const gaps = xs.slice(1).map((x, i) => x - xs[i] - order[0].width)
  const ys = rows.map(row => row[0].transform[5]), lineGaps = ys.slice(1).map((y, i) => y - ys[i] - order[0].height)
  const pad = padding(frame, order)
  if (!pad || !uniform(gaps) || !uniform(lineGaps) || [...gaps, ...lineGaps].some(v => v < 0 || v > 1e5)) return
  return { frameId: frame.id, order: rows.flat().map(n => n.id), layout: { ...defaultLayout(), mode: 'grid', columns: cols, gap: gaps[0], lineGap: lineGaps[0], padding: pad } }
}
function inspect(doc: DesignDocument, frameId: string): DesignNode[] {
  const root = doc.nodes[frameId]
  if (!root || !container(root)) throw new Error('Select an existing frame or group to preview layout')
  const result: DesignNode[] = [], seen = new Set<string>(), pending = [frameId]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) throw new Error('Repeated or cyclic layout hierarchy')
    seen.add(id)
    if (seen.size > LAYOUT_SUGGESTION_LIMIT) throw new Error(`Layout suggestion is limited to ${LAYOUT_SUGGESTION_LIMIT} nodes`)
    const n = doc.nodes[id]
    if (!n) throw new Error('Missing layout child')
    if (![...n.transform, n.width, n.height].every(Number.isFinite) || n.width <= 0 || n.height <= 0) throw new Error('Invalid layout geometry')
    result.push(n)
    if (seen.size + pending.length + n.children.length > LAYOUT_SUGGESTION_LIMIT) throw new Error(`Layout suggestion is limited to ${LAYOUT_SUGGESTION_LIMIT} nodes`)
    pending.push(...n.children)
  }
  return result
}
export function previewLayoutSuggestion(doc: DesignDocument, frameId: string): LayoutSuggestionPreview {
  const nodes = inspect(doc, frameId), warnings: string[] = [], warningDisplay: LayoutSuggestionText[] = [], changes: LayoutSuggestionChange[] = []
  // SHA-256 covers the complete subtree without echoing text, fonts or image
  // payloads into the preview. Dispatcher/UI revision guards are also mandatory.
  const snapshot = JSON.stringify(nodes)
  if (snapshot.length > 8 * 1024 * 1024 || new TextEncoder().encode(snapshot).length > 8 * 1024 * 1024) throw new Error('Layout preview exceeds the 8 MiB fingerprint budget')
  const fingerprint = referenceHash(snapshot)
  const parents = allParents(doc), ancestors = new Set<string>()
  for (let id = parents.get(frameId); id && doc.nodes[id]; id = parents.get(id)) {
    if (ancestors.has(id)) throw new Error('Cyclic layout ancestry')
    ancestors.add(id)
    const ancestor = doc.nodes[id]
    if (ancestor.locked || !ancestor.visible || ancestor.instance || ancestor.component || ancestor.componentSet || ancestor.instanceOrigin)
      return { frameId, fingerprint, inspectedNodes: nodes.length, suggestions: [], warnings: ['Locked, hidden or component ancestor: subtree left unchanged'], warningDisplay: [{ key: 'ancestor-excluded' }] }
  }
  const excluded = new Set<string>()
  let rootGrid: LayoutSuggestionChange | undefined
  for (const frame of nodes) {
    if (excluded.has(frame.id) || frame.locked || !frame.visible || frame.instance || frame.component || frame.componentSet || frame.instanceOrigin) {
      frame.children.forEach(id => excluded.add(id))
      if (container(frame)) { warnings.push(`${frame.name}: locked, hidden or component subtree left unchanged`); warningDisplay.push({ key: 'subtree-excluded', frameName: frame.name }) }
      continue
    }
    if (!container(frame) || frame.children.length < 2) continue
    if (frame.layout && frame.layout.mode !== 'none') continue
    const children = frame.children.map(id => doc.nodes[id]).filter(n => n.visible && !n.sizing?.absolute)
    if (children.length < 2) continue
    if (!fixed(frame) || children.some(n => n.locked || !fixed(n) || !axisAligned(n) || (n.sizing && (n.sizing.alignSelf !== null || n.sizing.columnSpan !== 1 || n.sizing.rowSpan !== 1)))) {
      warnings.push(`${frame.name}: locked, transformed or responsive children require explicit layout editing`); warningDisplay.push({ key: 'explicit-edit-required', frameName: frame.name }); continue
    }
    const candidate = stack(frame, children, 0) ?? stack(frame, children, 1) ?? grid(frame, children)
    if (!candidate) { warnings.push(`${frame.name}: irregular spacing, overlap or ambiguous geometry; no automatic rearrangement`); warningDisplay.push({ key: 'ambiguous-geometry', frameName: frame.name }); continue }
    if (candidate.layout.mode === 'grid' && frame.id === frameId) rootGrid = candidate
    changes.push(candidate)
  }
  const suggestions: LayoutSuggestion[] = changes.length ? [{ id: 'preserve-geometry', label: changes.length > 1 ? 'Nested layouts' : changes[0].layout.mode, confidence: 1, explanation: ['Regular geometry matches to numerical precision; coordinates and sizes are preserved.', 'Existing nested containers are inferred independently; hidden and absolute children retain their slots.', ...changes.map(c => `${doc.nodes[c.frameId].name}: ${c.layout.mode}, gap ${c.layout.gap}, alignment ${c.layout.align}`)], changes }] : []
  if (rootGrid) suggestions.push({ id: 'wrapped-rows', label: 'Wrapped rows', confidence: 0.85, explanation: ['The same regular geometry also fits wrapped horizontal rows.', 'Choose grid for stable columns, or wrap for flow that adapts to available width.'], changes: changes.map(c => c === rootGrid ? { ...c, layout: { ...c.layout, mode: 'horizontal', wrap: true } } : c) })
  // Attach display descriptors only after inference has produced unchanged raw API data.
  for (const suggestion of suggestions) {
    suggestion.display = suggestion.id === 'wrapped-rows'
      ? { label: { key: 'wrapped' }, explanation: [{ key: 'wrapped-compatible' }, { key: 'grid-versus-wrap' }] }
      : { label: { key: changes.length > 1 ? 'nested' : changes[0].layout.mode as 'horizontal' | 'vertical' | 'grid' }, explanation: [
        { key: 'preserve-coordinates' }, { key: 'independent-containers' },
        ...changes.map(c => ({ key: 'frame-layout' as const, frameName: doc.nodes[c.frameId].name, mode: c.layout.mode, gap: c.layout.gap, align: c.layout.align })),
      ] }
  }
  return { frameId, fingerprint, inspectedNodes: nodes.length, suggestions, warnings, warningDisplay }
}
/** Never trusts client-provided patches. Recompute and compare the preview before
 * applying a named candidate inside the caller's single native undo boundary. */
export function applyLayoutSuggestion(doc: DesignDocument, frameId: string, fingerprint: string, suggestionId: string): string[] {
  const preview = previewLayoutSuggestion(doc, frameId)
  if (preview.fingerprint !== fingerprint) throw new Error('Layout preview is stale; preview again before applying')
  const selected = preview.suggestions.find(s => s.id === suggestionId)
  if (!selected) throw new Error('Unknown or unavailable layout suggestion')
  for (const change of selected.changes) {
    const frame = doc.nodes[change.frameId], flow = new Set(change.order)
    frame.kind = 'frame'
    frame.layout = change.layout
    let at = 0
    frame.children = frame.children.map(id => flow.has(id) ? change.order[at++] : id)
  }
  return selected.changes.map(c => c.frameId)
}
