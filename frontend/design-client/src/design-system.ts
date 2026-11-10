import {
  uid,
  validateDocument,
  hasLocalVariableModes,
  type DesignDocument,
  type DesignNode,
  type TextStyle,
} from './model'
import { cloneValue } from './draft'
import { importFonts } from './text'
import { remapReferences } from './components'
export type VariableValue = string | number | boolean | { alias: string }
export type DesignSystem = {
  fontSources?: Record<string, { style?: string; runs?: Record<string, string>; resolved?: string[]; digest?: string; runDigests?: Record<string, string> }>
  /** Format metadata is preserved separately from executable variable bindings. */
  sketchContainers?: Record<string, unknown>
  collections: Record<string, { name: string; modes: string[]; defaultMode: string }>
  variables: Record<
    string,
    {
      name: string
      collection: string
      kind: 'color' | 'number' | 'boolean' | 'string'
      values: Record<string, VariableValue>
    }
  >
  activeModes: Record<string, string>
  /** Paint styles may carry the borders/shadows of a full Sketch layer
   * style; they resolve together with the fills (schema 12). */
  styles: Record<string, {
    name: string
    kind: 'paint' | 'text' | 'effect'
    value: unknown
    strokes?: import('./model').Stroke[]
    effects?: import('./model').Effect[]
  }>
  libraries: Record<
    string,
    {
      name: string
      version: number
      digest: string
      componentIds: string[]
      nodeMap: Record<string, string>
      pageId?: string
    }
  >
}
export const emptySystem = (): DesignSystem => ({
  collections: {},
  variables: {},
  activeModes: {},
  styles: {},
  libraries: {},
})
export type DesignDependencyMap = {
  collections: Map<string, string>
  variables: Map<string, string>
  styles: Map<string, string>
}
function designReferences(n: DesignNode) {
  return [n, ...Object.values(n.instance?.overrides || {})] as Array<{
    bindings?: Record<string, string>
    styleRefs?: Record<string, string>
    variableModes?: Record<string, string>
  }>
}
/** Copy only resources used by the pasted graph. Every alias mode is reachable,
 * even if that mode is inactive at copy time. Cross-document collisions always
 * get independent identities, including collections with a different mode. */
export function importDesignDependencies(
  target: DesignDocument,
  source: DesignDocument,
  nodes: DesignNode[],
): DesignDependencyMap {
  const references = nodes.flatMap(designReferences),
    variables = new Set(references.flatMap((n) => Object.values(n.bindings || {}))),
    styles = new Set(references.flatMap((n) => Object.values(n.styleRefs || {}))),
    collections = new Set(references.flatMap((n) => Object.keys(n.variableModes || {}))),
    result: DesignDependencyMap = {
      collections: new Map(), variables: new Map(), styles: new Map(),
    }
  const needsModes = hasLocalVariableModes({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) })
  if (!variables.size && !styles.size && !collections.size) {
    if (needsModes) {
      if (!source.designSystem) throw new Error('剪贴板缺少设计系统资源')
      target.designSystem ??= emptySystem()
      target.schemaVersion = Math.max(target.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
    }
    return result
  }
  const incoming = source.designSystem
  if (!incoming) throw new Error('剪贴板缺少设计系统资源')
  for (const reference of references)
    for (const [id, mode] of Object.entries(reference.variableModes || {}))
      if (!incoming.collections[id]?.modes.includes(mode))
        throw new Error('剪贴板缺少局部变量模式或集合')
  const pending = [...variables]
  while (pending.length) {
    const id = pending.pop()!,
      variable = incoming.variables[id]
    if (!variable || !incoming.collections[variable.collection])
      throw new Error('剪贴板缺少变量或集合')
    collections.add(variable.collection)
    for (const value of Object.values(variable.values))
      if (typeof value === 'object' && value !== null && !variables.has(value.alias)) {
        variables.add(value.alias)
        pending.push(value.alias)
      }
  }
  for (const id of styles) if (!incoming.styles[id]) throw new Error('剪贴板缺少共享样式')
  const system = (target.designSystem ??= emptySystem()),
    sameDocument = target.id === source.id,
    collectionIds = result.collections
  const mapIds = (ids: Set<string>, existing: object, map: Map<string, string>) => {
    const reserved = new Set([...Object.keys(existing), ...ids])
    for (const id of ids) {
      let local = id
      if (!sameDocument && Object.hasOwn(existing, id)) {
        do {
          local = uid()
        } while (reserved.has(local))
      }
      reserved.add(local)
      map.set(id, local)
    }
  }
  mapIds(collections, system.collections, collectionIds)
  mapIds(variables, system.variables, result.variables)
  mapIds(styles, system.styles, result.styles)
  for (const [id, local] of collectionIds) {
    if (sameDocument && system.collections[local]) continue
    system.collections[local] = cloneValue(incoming.collections[id])
    system.activeModes[local] = incoming.activeModes[id] ?? incoming.collections[id].defaultMode
  }
  for (const [id, local] of result.variables) {
    if (sameDocument && system.variables[local]) continue
    const variable = cloneValue(incoming.variables[id])
    variable.collection = collectionIds.get(variable.collection)!
    for (const [mode, value] of Object.entries(variable.values))
      if (typeof value === 'object' && value !== null)
        variable.values[mode] = { alias: result.variables.get(value.alias)! }
    system.variables[local] = variable
  }
  for (const [id, local] of result.styles) {
    if (sameDocument && system.styles[local]) continue
    system.styles[local] = cloneValue(incoming.styles[id])
  }
  // Authored (not yet resolved) text styles may be the only font reference.
  const styledNodes = [...styles].flatMap((id) => {
    const style = incoming.styles[id]
    return style.kind === 'text'
      ? [{ ...nodes[0], textStyle: style.value as TextStyle, textRuns: [] }]
      : []
  })
  importFonts(target, { ...source, fonts: cloneValue(source.fonts) }, styledNodes)
  if (needsModes) target.schemaVersion = Math.max(target.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
  return result
}
export function remapDesignDependencies(n: DesignNode, ids: DesignDependencyMap) {
  for (const references of designReferences(n)) {
    if (references.variableModes)
      references.variableModes = Object.fromEntries(
        Object.entries(references.variableModes).map(([id, mode]) => [
          ids.collections.get(id) || id, mode,
        ]),
      )
    if (references.bindings)
      for (const [field, id] of Object.entries(references.bindings))
        references.bindings[field] = ids.variables.get(id) || id
    if (references.styleRefs)
      for (const [field, id] of Object.entries(references.styleRefs))
        references.styleRefs[field] = ids.styles.get(id) || id
  }
}
export function variableValue(
  s: DesignSystem,
  id: string,
  modes = s.activeModes,
  seen = new Set<string>(),
): string | number | boolean {
  if (seen.has(id) || seen.size >= 64) throw new Error('变量别名循环或超过 64 层')
  seen.add(id)
  const v = s.variables[id],
    c = v && s.collections[v.collection]
  if (!v || !c) throw new Error('变量或集合不存在')
  const value = v.values[modes[v.collection] ?? c.defaultMode]
  if (value === undefined) throw new Error('变量缺少模式值')
  if (typeof value === 'object') return variableValue(s, value.alias, modes, seen)
  return value
}
export function setVariableMode(doc: DesignDocument, collection: string, mode: string) {
  const s = doc.designSystem
  if (!s?.collections[collection]?.modes.includes(mode)) throw new Error('变量模式不存在')
  s.activeModes[collection] = mode
}
/** Use inside an Editor change to retain atomic validation and undo. Undefined inherits. */
export function setNodeVariableMode(
  doc: DesignDocument,
  id: string,
  collection: string,
  mode?: string,
) {
  const n = doc.nodes[id]
  if (!n) throw new Error('图层不存在')
  if (mode !== undefined && !doc.designSystem?.collections[collection]?.modes.includes(mode))
    throw new Error('变量模式不存在')
  const modes = { ...n.variableModes }
  if (mode === undefined) delete modes[collection]
  else modes[collection] = mode
  if (Object.keys(modes).length) {
    n.variableModes = modes
    doc.schemaVersion = Math.max(doc.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
  } else delete n.variableModes
}
/** Materialized children already expose their local map. Authored instance roots
 * keep placement modes separate, so their replacing $root override takes priority. */
export function effectiveNodeVariableModes(n: DesignNode): Record<string, string> | undefined {
  if (n.instance && !n.instanceOrigin && Object.hasOwn(n.instance.overrides.$root || {}, 'variableModes'))
    return n.instance.overrides.$root.variableModes as Record<string, string>
  return n.variableModes
}
/** UI editing respects an existing replacing root override without modifying
 * authored placement or unrelated collections. An empty replacing map inherits. */
export function setEffectiveNodeVariableMode(
  doc: DesignDocument,
  id: string,
  collection: string,
  mode?: string,
) {
  const n = doc.nodes[id]
  if (!n) throw new Error('图层不存在')
  if (mode !== undefined && !doc.designSystem?.collections[collection]?.modes.includes(mode))
    throw new Error('变量模式不存在')
  if (n.instance && !n.instanceOrigin && Object.hasOwn(n.instance.overrides.$root || {}, 'variableModes')) {
    const modes = { ...effectiveNodeVariableModes(n) }
    if (mode === undefined) delete modes[collection]
    else modes[collection] = mode
    n.instance.overrides.$root.variableModes = modes
    doc.schemaVersion = Math.max(doc.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
  } else setNodeVariableMode(doc, id, collection, mode)
}
export type LibraryPackage = {
  format: 'forma-library'
  id: string
  name: string
  version: number
  document: DesignDocument
  digest: string
}
async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('')
}
export async function publishLibrary(
  document: DesignDocument,
  version: number,
): Promise<LibraryPackage> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('组件库版本必须为正整数')
  const doc = structuredClone(document),
    nodes: Record<string, DesignNode> = {}
  const roots = Object.values(doc.nodes)
    .filter((n) => (n.component || n.componentSet) && !n.instanceOrigin)
    .filter(
      (n) =>
        !Object.values(doc.nodes).some(
          (p) => (p.component || p.componentSet) && p.children.includes(n.id),
        ),
    )
  const visit = (id: string) => {
    if (nodes[id]) return
    const n = doc.nodes[id]
    if (!n) throw new Error('组件库引用缺失')
    nodes[id] = n
    n.children.forEach(visit)
    if (n.instance) visit(n.instance.componentId)
  }
  roots.forEach((n) => visit(n.id))
  // A dependency definition not already under an exported root becomes a root.
  const childIds = new Set(Object.values(nodes).flatMap((n) => n.children))
  const rootIds = Object.keys(nodes).filter((id) => !childIds.has(id))
  doc.nodes = nodes
  doc.pages = [{ id: doc.id, name: doc.name, children: rootIds, background: '#ffffff' }]
  delete doc.animations
  delete doc.prototype
  if (doc.designSystem) doc.designSystem.libraries = {}
  validateDocument(doc)
  return {
    format: 'forma-library',
    id: document.id,
    name: document.name,
    version,
    document: doc,
    digest: await digest(doc),
  }
}
export async function verifyLibrary(value: unknown): Promise<LibraryPackage> {
  const p = value as LibraryPackage
  if (
    p?.format !== 'forma-library' ||
    typeof p.id !== 'string' ||
    !Number.isSafeInteger(p.version) ||
    p.version < 1 ||
    JSON.stringify(p).length > 32 * 1024 * 1024
  )
    throw new Error('无效组件库文件')
  validateDocument(p.document)
  if (p.id !== p.document.id) throw new Error('组件库标识与发布文档不一致')
  if ((await digest(p.document)) !== p.digest) throw new Error('组件库摘要不匹配')
  return p
}
/** Explicit local file refresh. The native archive identity and template keys
 * are stable; content hashes determine a new local release. No network watch. */
export async function prepareSketchLibrary(source: DesignDocument, target: DesignDocument): Promise<LibraryPackage> {
  if (!Object.values(source.nodes).some(n=>n.component && !n.instanceOrigin)) throw new Error('Sketch 文件中没有可发布的 Symbol')
  const old = target.designSystem?.libraries[source.id]
  const candidate = await publishLibrary(source, old?.version ?? 1)
  if (old && candidate.digest !== old.digest) candidate.version = old.version + 1
  return candidate
}
type SketchNodeMetadata = { bindings?: Record<string,string>; styleRefs?: Record<string,string> }
function sketchMetadata(d: DesignDocument) { return (d.designSystem?.sketchContainers?.nodeMetadata || {}) as Record<string,SketchNodeMetadata> }
/** Adopt only embedded foreign symbols whose native symbol ID matches the
 * explicitly selected local source. Never match by visible name or position. */
function embeddedSketchLibrary(doc: DesignDocument, p: LibraryPackage): DesignSystem['libraries'][string] | undefined {
  const localMeta=sketchMetadata(doc), sourceMeta=sketchMetadata(p.document), nodeMap:Record<string,string>={}, roots:string[]=[]
  for (const source of Object.values(p.document.nodes).filter(n=>n.component && !n.instanceOrigin)) {
    const symbol=sourceMeta[source.id]?.bindings?.symbolID
    if (!symbol) continue
    const matches=Object.values(doc.nodes).filter(n=>n.component && localMeta[n.id]?.bindings?.sketchForeignLibraryID && localMeta[n.id]?.bindings?.symbolID?.toUpperCase()===symbol.toUpperCase())
    if (matches.length>1) throw new Error('外部 Symbol 身份重复，无法安全更新')
    if (!matches.length) continue
    const local=matches[0];roots.push(local.id);nodeMap[source.id]=local.id
    let remote:Record<string,string>={}
    try {remote=JSON.parse(localMeta[local.id].bindings?.sketchForeignSymbolRaw || '{}').remoteToLocalIDMap || {}} catch {throw new Error('外部 Symbol 身份映射损坏')}
    const descendants=(d:DesignDocument,n:DesignNode):DesignNode[]=>{const out:DesignNode[]=[];const visit=(id:string)=>{const x=d.nodes[id];if(!x||x.instanceOrigin)return;out.push(x);x.children.forEach(visit)};n.children.forEach(visit);return out}
    const localChildren=descendants(doc,local)
    for(const child of descendants(p.document,source)){
      const key=child.componentKey||child.id, remoteKey=Object.keys(remote).find(k=>k.toUpperCase()===key.toUpperCase())
      const identity=remoteKey?remote[remoteKey]:key
      const matches=localChildren.filter(n=>(n.componentKey||n.id).toUpperCase()===identity.toUpperCase()||n.id.toUpperCase()===identity.toUpperCase())
      if(matches.length>1)throw new Error('外部 Symbol 子图层身份重复')
      if(matches.length===1)nodeMap[child.id]=matches[0].id
    }
  }
  return roots.length ? {name:p.name,version:0,digest:'',componentIds:roots,nodeMap} : undefined
}
/** Import immutable releases with stable local IDs; normal component resolution
 * reapplies the consuming document's instance overrides after each update. */
export function installLibrary(doc: DesignDocument, p: LibraryPackage) {
  if (p.id !== p.document.id || !/^[0-9a-f-]{36}$/i.test(p.id)) throw new Error('组件库标识无效')
  const s = (doc.designSystem ??= emptySystem()),
    old = s.libraries[p.id] || embeddedSketchLibrary(doc,p)
  if (old && (p.version < old.version || (p.version === old.version && p.digest !== old.digest)))
    throw new Error('组件库版本倒退或同版本内容冲突')
  if (old?.version === p.version && old.digest === p.digest) return
  // Instance descendants are derived by the kernel from owner + template key.
  // Import only authored nodes; random IDs for derived nodes break upgrades.
  const authored = Object.entries(p.document.nodes).filter(([, n]) => !n.instanceOrigin)
  const map: Record<string, string> = {}
  for (const [id] of authored) map[id] = old?.nodeMap[id] || uid()
  const ns = (id: string) => `${p.id}/${id}`
  if (p.document.designSystem) {
    const incoming = structuredClone(p.document.designSystem)
    for (const [id, c] of Object.entries(incoming.collections)) {
      s.collections[ns(id)] = c
      if (!c.modes.includes(s.activeModes[ns(id)])) s.activeModes[ns(id)] = c.defaultMode
    }
    for (const [id, v] of Object.entries(incoming.variables)) {
      v.collection = ns(v.collection)
      for (const [mode, x] of Object.entries(v.values))
        if (typeof x === 'object') v.values[mode] = { alias: ns(x.alias) }
      s.variables[ns(id)] = v
    }
    for (const [id, v] of Object.entries(incoming.styles)) s.styles[ns(id)] = v
  }
  const incomingSystem = p.document.designSystem,
    references = authored.flatMap(([, n]) => designReferences(n))
  // Namespace dangling references too: they must fail validation, never bind to
  // an unrelated destination resource that happens to have the same identity.
  const namespaced = (ids: string[]) => new Map(ids.map((id) => [id, ns(id)]))
  const resources: DesignDependencyMap = {
    collections: namespaced([
      ...Object.keys(incomingSystem?.collections || {}),
      ...references.flatMap((n) => Object.keys(n.variableModes || {})),
    ]),
    variables: namespaced([
      ...Object.keys(incomingSystem?.variables || {}),
      ...references.flatMap((n) => Object.values(n.bindings || {})),
    ]),
    styles: namespaced([
      ...Object.keys(incomingSystem?.styles || {}),
      ...references.flatMap((n) => Object.values(n.styleRefs || {})),
    ]),
  }
  const sourceIds = new Set(authored.map(([id]) => id))
  const nodeIds = new Map(Object.entries(map))
  const owners = new Set([...Object.values(old?.nodeMap || {}), ...Object.values(map)])
  for (const [id, n] of Object.entries(doc.nodes))
    if (n.instanceOrigin && owners.has(n.instanceOrigin.owner)) delete doc.nodes[id]
  for (const [source, local] of Object.entries(old?.nodeMap || {}))
    if (!sourceIds.has(source)) {
      delete doc.nodes[local]
      for (const page of doc.pages) page.children = page.children.filter((id) => id !== local)
    }
  for (const [id, source] of authored) {
    const n = structuredClone(source)
    remapReferences(n, nodeIds, p.document)
    n.id = map[id]
    n.children = n.children
      .filter((id) => !p.document.nodes[id].instanceOrigin)
      .map((id) => map[id])
    // Stable template keys are source identities, independent of local UUIDs.
    n.componentKey = doc.nodes[n.id]?.componentKey ?? n.componentKey ?? id
    remapDesignDependencies(n, resources)
    doc.nodes[n.id] = n
  }
  // Copy only provenance for installed authored nodes, remapped to their
  // stable local identities. Document-level foreign containers are not merged.
  for (const key of ['nodeMetadata','textSourceLayouts']) {
    const source = incomingSystem?.sketchContainers?.[key] as Record<string,unknown> | undefined
    const previous = s.sketchContainers?.[key] as Record<string,unknown> | undefined
    if (!source && !previous) continue
    const next = {...previous}
    for (const id of Object.values(old?.nodeMap || {})) delete next[id]
    for (const [id] of authored) if (source?.[id] !== undefined) {
      const value = structuredClone(source[id])
      if (key==='nodeMetadata') {
        const prior=(previous?.[map[id]] as SketchNodeMetadata | undefined)?.bindings
        if (prior?.sketchForeignLibraryID) {
          const metadata=value as SketchNodeMetadata;metadata.bindings ??= {}
          for (const k of ['sketchForeignLibraryID','sketchForeignSymbolRaw']) if(prior[k]) metadata.bindings[k]=prior[k]
        }
      }
      next[map[id]] = value
    }
    ;(s.sketchContainers ??= {})[key] = next
  }
  for (const id of Object.values(old?.nodeMap || {})) if (s.fontSources) delete s.fontSources[id]
  for (const [id] of authored) if (incomingSystem?.fontSources?.[id]) (s.fontSources ??= {})[map[id]] = structuredClone(incomingSystem.fontSources[id])
  for (const [id, font] of Object.entries(p.document.fonts || {})) {
    if (doc.fonts?.[id] && doc.fonts[id].data !== font.data) throw new Error('组件库字体标识冲突')
    doc.fonts = { ...doc.fonts, [id]: font }
  }
  const roots = p.document.pages.flatMap((page) => page.children).map((id) => map[id])
  const oldRoots = new Set(old?.componentIds || [])
  for (const page of doc.pages) page.children = page.children.filter((id) => !oldRoots.has(id))
  let page = doc.pages.find((page) => page.id === old?.pageId)
  if (!page) {
    page = { id: uid(), name: `组件库 · ${p.name}`, background: '#ffffff', children: [] }
    doc.pages.push(page)
  }
  page.children.push(...roots)
  if (hasLocalVariableModes(p.document)) doc.schemaVersion = Math.max(doc.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
  s.libraries[p.id] = {
    name: p.name,
    version: p.version,
    digest: p.digest,
    componentIds: roots,
    nodeMap: map,
    pageId: page.id,
  }
}
