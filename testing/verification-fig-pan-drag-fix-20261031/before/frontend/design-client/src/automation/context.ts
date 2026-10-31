import { kernelLayout, kernelTextLayout } from '../kernel/picking'
import { validateDocument } from '../model'
import type { DesignDocument, DesignNode, Paint } from '../model'
import { AutomationError, type AutomationExtension } from './types'

export type DesignAutomationWarning = { code: string; message: string; nodeId?: string }
export type ContextOptions = {
  pageId?: string
  nodeIds?: string[]
  cursor?: string
  limit?: number
  maxDepth?: number
}
export type AssetReference = {
  id: string
  kind: 'image'
  source: 'embedded' | 'remote' | 'local' | 'unsafe'
  uri?: string
  mediaType?: string
  characters: number
  nodeIds: string[]
  paintIds: string[]
}
export type ContextEntry = { node: DesignNode; parentId: string | null; depth: number }
export const CONTEXT_LIMITS = Object.freeze({ nodes: 500, depth: 64, text: 2048, items: 64, warnings: 128, graph: 100000 })

export function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new AutomationError('invalid_params', `${name} must be an integer between ${min} and ${max}`)
  return value
}
export function contextOptions(params: Record<string, unknown>, pageId?: string): ContextOptions {
  const p = params.pageId ?? pageId
  if (p !== undefined && (typeof p !== 'string' || p.length > 512)) throw new AutomationError('invalid_params', 'pageId must be a string')
  if (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length > 512)) throw new AutomationError('invalid_params', 'cursor must be a string')
  if (params.nodeIds !== undefined && (!Array.isArray(params.nodeIds) || params.nodeIds.length > CONTEXT_LIMITS.nodes ||
    params.nodeIds.some(id => typeof id !== 'string' || id.length > 512))) throw new AutomationError('invalid_params', 'nodeIds must contain at most 500 string IDs')
  return {
    pageId: p as string | undefined, nodeIds: params.nodeIds as string[] | undefined,
    cursor: params.cursor as string | undefined,
    limit: boundedInteger(params.limit, 100, 1, CONTEXT_LIMITS.nodes, 'limit'),
    maxDepth: boundedInteger(params.maxDepth, 8, 0, CONTEXT_LIMITS.depth, 'maxDepth'),
  }
}
// Synchronous SHA-256 content identity keeps context and code export IDs stable
// across pages. Assets must not alias on a 32-bit checksum collision. This is a
// content identifier, not an authentication or authorization primitive.
const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
])
const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))
export function referenceHash(value: string): string {
  const source = new TextEncoder().encode(value)
  const bytes = new Uint8Array(Math.ceil((source.length + 9) / 64) * 64)
  bytes.set(source); bytes[source.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(bytes.length - 8, Math.floor(source.length / 0x20000000))
  view.setUint32(bytes.length - 4, (source.length * 8) >>> 0)
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2]
      words[i] = words[i - 16] + (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10))
    }
    let [a,b,c,d,e,f,g,h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + words[i]) >>> 0
      const t2 = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) hash[i] += value
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('')
}
/** Only web URLs without embedded credentials are portable. No file, javascript,
 * blob, SVG data, or protocol-relative URLs become executable HTML resources. */
export function safeWebUrl(value: string): string | undefined {
  if (value.length > 4096 || /[\u0000-\u0020\u007f<>"'\\]/.test(value)) return
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    return url.href
  } catch { return }
}
export function assetReference(source: string, nodeId: string, paintId: string, identities?: Map<string, string>): AssetReference {
  const image = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,[a-z\d+/=\s]+$/i.exec(source)
  const uri = safeWebUrl(source)
  const id = identities?.get(source) ?? `image-${referenceHash(source)}`
  identities?.set(source, id)
  return {
    id, kind: 'image', characters: source.length,
    source: image ? 'embedded' : uri ? 'remote' : /^(?:blob:|file:|\/|\.\/|\.\.\/)/i.test(source) ? 'local' : 'unsafe',
    ...(uri ? { uri } : {}), ...(image ? { mediaType: image[1].toLowerCase() } : {}),
    nodeIds: [nodeId], paintIds: [paintId],
  }
}
/** Select in authored child order, with iterative traversal even for deep graphs.
 * The scan is bounded; malformed cycles/duplicate ownership never recurse. */
export function contextEntries(document: DesignDocument, input: ContextOptions = {}) {
  const options = contextOptions(input as Record<string, unknown>)
  const page = document.pages.find(item => item.id === (options.pageId ?? document.pages[0]?.id))
  if (!page) throw new AutomationError('invalid_params', 'Page does not exist')
  const reachable = new Map<string, ContextEntry>()
  const stack = [...page.children].reverse().map(id => ({ id, parentId: null as string | null, depth: 0 }))
  while (stack.length) {
    const item = stack.pop()!
    if (reachable.has(item.id)) throw new AutomationError('invalid_params', `Graph has cyclic or duplicate ownership: ${item.id}`)
    const node = document.nodes[item.id]
    if (!node) throw new AutomationError('invalid_params', `Graph references missing node: ${item.id}`)
    if (reachable.size >= CONTEXT_LIMITS.graph) throw new AutomationError('invalid_params', 'Context graph exceeds 100000 nodes; use a smaller document')
    reachable.set(item.id, { node, parentId: item.parentId, depth: item.depth })
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ id: node.children[i], parentId: node.id, depth: item.depth + 1 })
  }
  const requested = options.nodeIds === undefined ? page.children : [...new Set(options.nodeIds)]
  if (!requested.length && options.nodeIds !== undefined) throw new AutomationError('invalid_params', 'nodeIds must not be empty')
  const selected = new Set(requested)
  for (const id of requested) if (!reachable.has(id)) throw new AutomationError('invalid_params', `Node is not on the selected page: ${id}`)
  // Ancestor selections subsume descendants, independently of request order.
  const roots = requested.filter(id => {
    let parent = reachable.get(id)!.parentId
    while (parent) {
      if (selected.has(parent)) return false
      parent = reachable.get(parent)?.parentId ?? null
    }
    return true
  })
  const entries: ContextEntry[] = []
  const pending = [...roots].reverse().map(id => ({ id, depth: 0 }))
  let omittedByDepth = 0
  while (pending.length) {
    const item = pending.pop()!, entry = reachable.get(item.id)!
    entries.push({ ...entry, depth: item.depth })
    if (item.depth === options.maxDepth) { omittedByDepth += entry.node.children.length; continue }
    for (let i = entry.node.children.length - 1; i >= 0; i--) pending.push({ id: entry.node.children[i], depth: item.depth + 1 })
  }
  const signature = referenceHash(JSON.stringify([document.id, page.id, roots, options.maxDepth, entries.map(e => [e.node.id, e.parentId])]))
  return { page, roots, entries, omittedByDepth, signature, options }
}

/** Resource metadata deliberately excludes binary font/image data and deeply
 * nested vendor metadata. Truncation markers are part of the public contract. */
export function boundedMetadata(value: unknown, depth = 0, budget = { remaining: 1024 }): unknown {
  if (--budget.remaining < 0) return { truncated: true }
  if (typeof value === 'string') return value.length <= CONTEXT_LIMITS.text ? value : { preview: value.slice(0, CONTEXT_LIMITS.text), characters: value.length, truncated: true }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined) return undefined
  if (depth >= 5) return { truncated: true }
  if (Array.isArray(value)) return value.length > CONTEXT_LIMITS.items
    ? { items: value.slice(0, CONTEXT_LIMITS.items).map(v => boundedMetadata(v, depth + 1, budget)), total: value.length, truncated: true }
    : value.map(v => boundedMetadata(v, depth + 1, budget))
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, item] of entries.slice(0, CONTEXT_LIMITS.items)) {
      if (key === 'image' && typeof item === 'string') {
        const { nodeIds: _nodes, paintIds: _paints, ...reference } = assetReference(item, '', '')
        result[key] = reference
      } else result[key] = boundedMetadata(item, depth + 1, budget)
    }
    if (entries.length > CONTEXT_LIMITS.items) result.$truncated = { total: entries.length, returned: CONTEXT_LIMITS.items }
    return result
  }
  return null
}
export function summarizeDesignNode(entry: ContextEntry, identities?: Map<string, string>) {
  const n = entry.node
  const paintSummary = (p: Paint) => {
    const { image, ...rest } = p
    return { ...boundedMetadata(rest) as object, ...(image ? { assetId: assetReference(image, n.id, p.id, identities).id } : {}) }
  }
  return {
    id: n.id, name: n.name.slice(0, CONTEXT_LIMITS.text), kind: n.kind, parentId: entry.parentId, depth: entry.depth,
    children: n.children.slice(0, CONTEXT_LIMITS.items), childCount: n.children.length,
    childrenTruncated: n.children.length > CONTEXT_LIMITS.items,
    visible: n.visible, locked: n.locked, opacity: n.opacity, blend: n.blend,
    geometry: { space: 'parent', transform: [...n.transform], width: n.width, height: n.height },
    layout: boundedMetadata(n.layout ?? { mode: 'none' }), sizing: boundedMetadata(n.sizing), constraints: boundedMetadata(n.constraints),
    fills: n.fills.slice(0, 16).map(paintSummary), fillCount: n.fills.length,
    strokes: n.strokes.slice(0, 16).map(s => ({ ...boundedMetadata({ ...s, paint: undefined }) as object, paint: paintSummary(s.paint) })), strokeCount: n.strokes.length,
    effects: boundedMetadata(n.effects.slice(0, 16)), effectCount: n.effects.length,
    materialRefs: [...n.fills, ...n.strokes.map(s => s.paint)].filter(p => p.image).slice(0, 16).map(p => ({ paintId: p.id, assetId: assetReference(p.image!, n.id, p.id, identities).id })),
    shape: { radii: [...n.radii], smoothing: n.smoothing, clip: n.clip, mask: n.mask, maskType: n.maskType, booleanOperation: n.booleanOperation },
    ...(n.kind === 'text' ? { text: { content: n.text.slice(0, CONTEXT_LIMITS.text), characters: n.text.length, truncated: n.text.length > CONTEXT_LIMITS.text, fontSize: n.fontSize, style: boundedMetadata(n.textStyle), runs: boundedMetadata(n.textRuns) } } : {}),
    components: boundedMetadata({ definition: n.component, set: n.componentSet, key: n.componentKey, instance: n.instance, origin: n.instanceOrigin }),
    tokens: boundedMetadata({ bindings: n.bindings, styleRefs: n.styleRefs, variableModes: n.variableModes }),
  }
}
export function collectAssetReferences(entries: ContextEntry[], identities = new Map<string, string>()): AssetReference[] {
  const assets = new Map<string, AssetReference>()
  for (const { node } of entries) for (const p of [...node.fills, ...node.strokes.map(s => s.paint)].slice(0, 32)) {
    if (!p.image) continue
    const asset = assetReference(p.image, node.id, p.id, identities), previous = assets.get(asset.id)
    if (previous) {
      if (!previous.nodeIds.includes(node.id)) previous.nodeIds.push(node.id)
      if (!previous.paintIds.includes(p.id)) previous.paintIds.push(p.id)
    } else assets.set(asset.id, asset)
  }
  return [...assets.values()]
}
function tokenContext(document: DesignDocument, entries: ContextEntry[]) {
  const system = document.designSystem
  if (!system) return { collections: [], variables: [], styles: [], truncated: false }
  const variables = new Set<string>(), styles = new Set<string>(), collections = new Set<string>()
  for (const { node } of entries) {
    Object.values(node.bindings ?? {}).slice(0, 64).forEach(id => variables.add(id))
    Object.values(node.styleRefs ?? {}).slice(0, 64).forEach(id => styles.add(id))
    Object.keys(node.variableModes ?? {}).slice(0, 64).forEach(id => collections.add(id))
  }
  const queue = [...variables]
  for (let i = 0; i < queue.length && i < 256; i++) {
    const variable = system.variables[queue[i]]
    if (!variable) continue
    collections.add(variable.collection)
    for (const value of Object.values(variable.values)) if (typeof value === 'object' && !variables.has(value.alias)) {
      variables.add(value.alias); queue.push(value.alias)
    }
  }
  return {
    collections: [...collections].slice(0, 256).map(id => ({ id, ...boundedMetadata(system.collections[id] ?? { missing: true }) as object, activeMode: system.activeModes[id] })),
    variables: [...variables].slice(0, 256).map(id => ({ id, ...boundedMetadata(system.variables[id] ?? { missing: true }) as object })),
    styles: [...styles].slice(0, 256).map(id => ({ id, ...boundedMetadata(system.styles[id] ?? { missing: true }) as object })),
    truncated: variables.size > 256 || styles.size > 256 || collections.size > 256,
  }
}
export type ContextRevisionScope = { revision?: number; session?: number }
export function getDesignContext(document: DesignDocument, options: ContextOptions = {}, scope?: ContextRevisionScope) {
  const selection = contextEntries(document, options), { entries } = selection
  const prefix = `context-v2:${scope ? `${scope.session ?? 0}:${scope.revision ?? 0}` : 'standalone'}:${selection.signature}:`
  const identities = new Map<string, string>()
  let offset = 0
  if (options.cursor !== undefined) {
    const value = options.cursor.startsWith(prefix) ? options.cursor.slice(prefix.length) : ''
    if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > entries.length)
      throw new AutomationError('invalid_params', 'Invalid or stale context cursor; restart with the same scope')
    offset = Number(value)
  }
  let page = entries.slice(offset, offset + selection.options.limit!)
  let end = offset + page.length
  const warnings: DesignAutomationWarning[] = []
  if (selection.omittedByDepth) warnings.push({ code: 'DEPTH_LIMIT', message: `${selection.omittedByDepth} child branches omitted at maxDepth; request their IDs for deeper context.` })
  for (const { node } of page) if (node.text.length > CONTEXT_LIMITS.text || node.fills.length > 16 || node.strokes.length > 16 || node.effects.length > 16 || node.children.length > CONTEXT_LIMITS.items)
    warnings.push({ code: 'SUMMARY_TRUNCATED', nodeId: node.id, message: 'Summary fields are bounded; counts and truncation markers identify omitted content. Use document.export for canonical source.' })
  const makeResult = () => ({
    format: 'futureox.design-context.v1', document: { id: document.id, name: document.name.slice(0, CONTEXT_LIMITS.text), schemaVersion: document.schemaVersion },
    page: { id: selection.page.id, name: selection.page.name.slice(0, CONTEXT_LIMITS.text), background: selection.page.background },
    geometrySemantics: 'authored-parent-local', rootIds: selection.roots.slice(0, CONTEXT_LIMITS.nodes), rootCount: selection.roots.length,
    nodes: page.map(entry => summarizeDesignNode(entry, identities)), tokens: tokenContext(document, page), assets: collectAssetReferences(page, identities),
    pagination: { offset, returned: page.length, total: entries.length, limit: selection.options.limit, nextCursor: end < entries.length ? `${prefix}${end}` : null },
    warnings: warnings.slice(0, CONTEXT_LIMITS.warnings), warningCount: warnings.length,
  })
  let result = makeResult()
  while (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024) {
    if (page.length <= 1) throw new AutomationError('response_limit', 'A single node context exceeds 1 MiB; use canonical document export')
    page = page.slice(0, Math.max(1, Math.floor(page.length / 2)))
    end = offset + page.length
    if (!warnings.some(w => w.code === 'RESPONSE_LIMIT')) warnings.push({ code: 'RESPONSE_LIMIT', message: 'This page contains fewer nodes to stay within the 1 MiB response budget. Continue with nextCursor.' })
    result = makeResult()
  }
  return result
}
export type DesignCheckIssue = DesignAutomationWarning & { severity: 'error' | 'warning'; certainty: 'structural' | 'heuristic'; metrics?: Record<string, number> }
/** A read-only inspection loop for AI-authored edits. Geometry/text metrics come
 * from the existing kernel. Overflow is a heuristic: intentional bleed, clipped
 * scroll areas and text ink overhang are not declared design errors. */
export function checkDesign(document: DesignDocument, options: ContextOptions = {}, scope?: ContextRevisionScope) {
  const issues: DesignCheckIssue[] = []
  try { validateDocument(document) } catch (error) {
    return { format: 'futureox.design-check.v1', documentId: document.id, checkedNodes: 0, issues: [{ code: 'INVALID_DOCUMENT', message: error instanceof Error ? error.message : String(error), severity: 'error', certainty: 'structural' }], complete: false }
  }
  const resolved = kernelLayout(document), context = getDesignContext(resolved, options, scope)
  const add = (code: string, message: string, nodeId: string, certainty: 'structural' | 'heuristic', metrics?: Record<string, number>) => {
    issues.push({ code, message, nodeId, certainty, severity: certainty === 'structural' ? 'error' : 'warning', ...(metrics ? { metrics } : {}) })
  }
  for (const summary of context.nodes) {
    const n = resolved.nodes[summary.id]
    if (!n.visible) continue
    const parent = summary.parentId ? resolved.nodes[summary.parentId] : undefined
    if (parent && parent.kind !== 'group') {
      const [a,b,c,d,x,y] = n.transform
      const xs = [x, x + a*n.width, x + c*n.height, x + a*n.width + c*n.height]
      const ys = [y, y + b*n.width, y + d*n.height, y + b*n.width + d*n.height]
      const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys)
      if (left < -0.5 || top < -0.5 || right > parent.width + 0.5 || bottom > parent.height + 0.5)
        add('CHILD_OUTSIDE_PARENT', 'Local transformed bounds extend outside the parent. This may be intentional bleed or scroll content; inspect a real preview before changing it.', n.id, 'heuristic', { left, top, right, bottom, parentWidth: parent.width, parentHeight: parent.height })
    }
    if (n.kind === 'text') {
      const text = kernelTextLayout(n), ink = text.bounds
      if (ink && (ink.x < -0.5 || ink.y < -0.5 || ink.x + ink.width > n.width + 0.5 || ink.y + ink.height > n.height + 0.5))
        add('TEXT_INK_OUTSIDE_BOX', 'Native shaped text ink extends beyond its logical box. Overhang or unwrapped text may be intentional.', n.id, 'heuristic', { inkX: ink.x, inkY: ink.y, inkWidth: ink.width, inkHeight: ink.height, boxWidth: n.width, boxHeight: n.height })
    }
    for (const [field, id] of Object.entries(n.bindings ?? {})) if (!resolved.designSystem?.variables[id]) add('MISSING_VARIABLE', `Binding ${field} references missing variable ${id}.`, n.id, 'structural')
    for (const [field, id] of Object.entries(n.styleRefs ?? {})) if (!resolved.designSystem?.styles[id]) add('MISSING_STYLE', `Style ${field} references missing style ${id}.`, n.id, 'structural')
  }
  return { format: 'futureox.design-check.v1', documentId: document.id, checkedNodes: context.nodes.length, issues: issues.slice(0, 500), issueCount: issues.length, pagination: context.pagination, warnings: context.warnings, complete: !context.pagination.nextCursor && !context.warnings.some(w => w.code === 'DEPTH_LIMIT'), scope: 'This page of visible nodes only; no overlap/style/aesthetic judgment or pixel equivalence check.' }
}
export const contextExtensions: AutomationExtension[] = [{
  name: 'design.check', description: 'Read-only self-inspection after edits. Reports structural validation plus native measured text ink and transformed child overflow as explicitly heuristic warnings. Page with context cursors; use preview.capture before fine edits.', mutates: false,
  inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, maxDepth: { type: 'integer', minimum: 0, maximum: 64 } }, additionalProperties: false },
  execute: (document, params, context) => checkDesign(document, contextOptions(params, context.pageId), context),
}, {
  name: 'context.get', description: 'Bounded semantic node/layout/component/token/material context in stable child order. Cursors are bound to the editor revision, session and graph scope; changed documents require restarting pagination.', mutates: false,
  inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, maxDepth: { type: 'integer', minimum: 0, maximum: 64 } }, additionalProperties: false },
  execute: (document, params, context) => getDesignContext(document, contextOptions(params, context.pageId), context),
}]
