import { isRecord } from './framing.mjs'

/** Explicit compatibility surface for AI clients that already speak Figma MCP.
 * These names are not added to the shared Design API registry. Every call is
 * translated into that API. This module does not store a document, eval plugin
 * code, or claim Figma account, library, or pixel parity. */
export const FIGMA_MCP_INSTRUCTIONS = 'Futureox Design Figma-shaped MCP facade for the document whose desktop automation bridge is enabled. Tools call the existing Design API; this server applies document/session/revision fences itself. get_metadata, get_selection, get_design_context, get_screenshot, get_variable_defs and download_assets read. use_figma writes structured create/update/delete/move/select operations as one undo step. Plugin JavaScript in use_figma code is forwarded only when the host registered a plugin bridge; otherwise the tool returns plugin_host_unavailable and does not eval. open_document is a local workspace open, not a Figma cloud file. fileKey is ignored. Screenshots are CPU exports of design content, not GPU or window captures. Cancellation cannot undo a committed edit.'

export const FIGMA_MCP_GAPS = Object.freeze([
  { id: 'whoami', tool: 'whoami', status: 'absent', detail: 'No Figma account, plan, seat, or identity.' },
  { id: 'create_new_file', tool: 'create_new_file', status: 'absent', detail: 'No cloud file creation. open_document opens a saved local design when workspace.open is granted.' },
  { id: 'generate_figma_design', tool: 'generate_figma_design', status: 'absent', detail: 'No live-site capture into design layers.' },
  { id: 'generate_diagram', tool: 'generate_diagram', status: 'absent', detail: 'No FigJam or Mermaid diagram generator.' },
  { id: 'generate_image', tool: 'generate_image', status: 'absent', detail: 'No image generation or AI-credit placement.' },
  { id: 'html_to_figma', tool: 'html_to_figma', status: 'absent', detail: 'HTML import is not a Design API operation.' },
  { id: 'upload_assets', tool: 'upload_assets', status: 'absent', detail: 'No multi-file image/SVG upload tool. svg.import remains on the design_* catalog.' },
  { id: 'send_code_to_figma', tool: 'send_code_to_figma', status: 'absent', detail: 'No Figma Make or code-layer import.' },
  { id: 'libraries_and_code_connect', tool: 'get_libraries, search_design_system, get_code_connect_map, add_code_connect_map', status: 'absent', detail: 'No team libraries or Code Connect. clientFrameworks and clientLanguages are ignored.' },
  { id: 'figjam_motion_shaders', tool: 'get_figjam, get_motion_context, shader and generative-plugin tools', status: 'absent', detail: 'No FigJam, motion keyframes, shaders, or generative-plugin library.' },
  { id: 'use_figma_plugin_javascript', tool: 'use_figma', status: 'partial', detail: 'Structured operations map to Design API batches. code is forwarded only through a host-registered plugin bridge. Without that bridge the call returns plugin_host_unavailable and is not evaluated.' },
  { id: 'download_assets_urls_pdf_raw', tool: 'download_assets', status: 'partial', detail: 'One node may export PNG, JPEG, WebP, or SVG. No PDF, no original uploaded-image extraction, no temporary fetch URLs, and no 20-node batch.' },
  { id: 'design_context_not_react', tool: 'get_design_context', status: 'partial', detail: 'Returns Design API context and, when advertised, HTML/CSS from code.export. Not Figma React + Tailwind.' },
  { id: 'screenshot_is_cpu_export', tool: 'get_screenshot', status: 'partial', detail: 'preview.capture CPU raster of design content. Not an application window or GPU canvas screenshot.' },
  { id: 'file_key_ignored', tool: 'fileKey', status: 'partial', detail: 'The server is bound to the enabled local document. A Figma URL or file key does not select a different file.' },
  { id: 'no_remote_account', tool: 'remote MCP', status: 'absent', detail: 'Loopback HTTP and stdio only. No mcp.figma.com, OAuth, or multi-user account.' },
])

const KINDS = new Set(['slice', 'frame', 'section', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector', 'text'])
const IGNORED = new Set(['fileKey', 'clientFrameworks', 'clientLanguages', 'skillNames', 'dir'])
const LOOSE = { description: 'Accepted and ignored. This server is bound to the enabled local document.' }
const NODE_LIMIT = 100
const SELECTION_DETAIL = 20

let registeredBridge = null

/** Host-only registration. The facade never evaluates plugin source. */
export function registerFigmaPluginBridge(bridge) {
  if (bridge !== null && (typeof bridge !== 'object' || typeof bridge.run !== 'function')) throw new TypeError('Plugin bridge requires run()')
  registeredBridge = bridge
}
export function figmaPluginBridge() { return registeredBridge }

const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, fileKey: { type: 'string', ...LOOSE }, clientFrameworks: LOOSE, clientLanguages: LOOSE, skillNames: LOOSE }, required },
  annotations: { readOnlyHint: name !== 'use_figma' && name !== 'open_document', destructiveHint: name === 'use_figma' || name === 'open_document', idempotentHint: name !== 'use_figma' && name !== 'open_document', openWorldHint: false },
})

export const FIGMA_MCP_TOOLS = Object.freeze([
  tool('get_metadata', 'Lightweight XML outline of the open Futureox document. Omit nodeId for pages. A page id outlines that page; any other id outlines that subtree, at most 100 nodes. fileKey is ignored. This is not a Figma file listing.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, cursor: { type: 'string', description: 'Rejected. The outline is one bounded page; narrow nodeId instead of paging.' } }),
  tool('get_selection', 'Read the active page and current selection. Up to 20 nodes include id, name, kind, size, and world bounds. Desktop Figma MCP often implies this selection; call this tool to read it.', {}),
  tool('get_design_context', 'Bounded design context for nodeId or the current selection, from context.get. When code.export is available, HTML/CSS is attached as resources. Output is Futureox HTML/CSS, not Figma React and Tailwind. clientFrameworks is ignored.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 } }),
  tool('get_screenshot', 'PNG export of nodeId, the current selection, or the active page when nothing is selected. Uses preview.capture: a CPU raster of design content, not an application or GPU screenshot. scale is 0.1–4.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, scale: { type: 'number', minimum: 0.1, maximum: 4 } }),
  tool('get_variable_defs', 'Local variables and shared styles used by nodeId or the current selection. An empty selection returns the document’s local variables and styles. No team libraries or published design systems.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 } }),
  tool('download_assets', 'Export one node. defaultFormat png, jpeg, webp, or svg. More than one node, PDF, raw uploaded images, and temporary URLs are refused; call get_screenshot per node. A single raster uses the same CPU export as get_screenshot.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, nodeIds: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 128 } }, defaultFormat: { type: 'string', enum: ['png', 'jpeg', 'jpg', 'webp', 'svg', 'pdf'] }, defaultScale: { type: 'number', minimum: 0.1, maximum: 4 } }),
  tool('use_figma', 'Write the open document. Preferred input is operations (at most 40), applied as one Design API batch and one undo step: create {kind,parentId?,x?,y?,width?,height?,name?,text?,fontSize?,fill?}, update {nodeId,name?,x?,y?,width?,height?,text?,fill?,transform?}, delete {nodeId|nodeIds}, select {nodeIds}, move {nodeId,parentId,index?}. fill is #RRGGBB. Coordinates are parent-local document units. code is plugin JavaScript and runs only when a plugin bridge is registered; otherwise the result is plugin_host_unavailable and the source is not evaluated. description is required.', { description: { type: 'string', minLength: 1, maxLength: 400 }, operations: { type: 'array', maxItems: 40 }, code: { type: 'string', maxLength: 100000 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['description']),
  tool('open_document', 'Open a saved local design through workspace.open. Requires rootHandle, documentHandle, and mutationId from a workspace grant. This is not Figma create_new_file. A successful open can end this automation session.', { rootHandle: { type: 'string', minLength: 1, maxLength: 512 }, documentHandle: { type: 'string', minLength: 1, maxLength: 512 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['rootHandle', 'documentHandle', 'mutationId']),
])

const failure = (method, code, message, identity = {}) => ({
  ok: false, method, documentId: identity.documentId ?? '', session: identity.session ?? 0, revision: identity.revision ?? 0,
  error: { code, message },
})
const done = (method, identity, result) => ({ ok: true, method, documentId: identity.documentId, session: identity.session, revision: identity.revision, result })
const identityOf = response => ({ documentId: response.documentId, session: response.session, revision: response.revision })

function rejectCursor(args) {
  if (args.cursor !== undefined) return 'This server returns one bounded result and does not accept cursors. Narrow nodeId instead.'
}

function unknownArguments(args, allowed) {
  if (!isRecord(args)) return 'Tool arguments must be an object'
  const extra = Object.keys(args).filter(key => !allowed.has(key) && !IGNORED.has(key))
  if (extra.length) return `Unknown arguments: ${extra.join(', ')}`
  return rejectCursor(args)
}

function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function boxAttrs(node) {
  const bounds = isRecord(node.worldBounds) ? node.worldBounds : null
  const x = bounds && Number.isFinite(bounds.x) ? bounds.x : undefined
  const y = bounds && Number.isFinite(bounds.y) ? bounds.y : undefined
  const width = Number.isFinite(node.width) ? node.width : bounds?.width
  const height = Number.isFinite(node.height) ? node.height : bounds?.height
  return `${x === undefined ? '' : ` x="${x}"`}${y === undefined ? '' : ` y="${y}"`}${Number.isFinite(width) ? ` width="${width}"` : ''}${Number.isFinite(height) ? ` height="${height}"` : ''}`
}

export function metadataXml(name, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const ids = new Set(list.map(node => node.id))
  const children = new Map()
  for (const node of list) {
    const parent = ids.has(node.parentId) ? node.parentId : ''
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(node)
  }
  const tagFor = kind => typeof kind === 'string' && /^[a-z][a-z0-9-]*$/.test(kind) ? kind : 'node'
  const render = node => {
    const kids = children.get(node.id) ?? []
    const open = `<${tagFor(node.kind)} id="${xmlEscape(node.id)}" name="${xmlEscape(node.name)}"${boxAttrs(node)}`
    return kids.length ? `${open}>${kids.map(render).join('')}</${tagFor(node.kind)}>` : `${open} />`
  }
  const roots = children.get('') ?? []
  return `<canvas name="${xmlEscape(name)}">${roots.map(render).join('')}</canvas>`
}

function solidFill(color) {
  if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return { error: 'fill must be a #RRGGBB color. Pass a Design API paint array as fills when the paint is not a solid hex color.' }
  }
  return { paint: { kind: 'solid', color, opacity: 1, angle: 0, stops: [] } }
}

function own(object, allowed) {
  return Object.keys(object).filter(key => !allowed.includes(key))
}

function asId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) return `${label} must be a nonempty string of at most 128 characters`
}

/** Pure check of one structured use_figma operation. Position reads happen later. */
export function validateFigmaOperation(operation) {
  if (!isRecord(operation)) return 'Each operation must be an object'
  const op = operation.op
  if (op === 'create') {
    const extra = own(operation, ['op', 'kind', 'parentId', 'id', 'index', 'x', 'y', 'width', 'height', 'name', 'text', 'fontSize', 'opacity', 'visible', 'fill', 'fills'])
    if (extra.length) return `create does not accept ${extra.join(', ')}`
    if (!KINDS.has(operation.kind)) return `create kind must be one of ${[...KINDS].join(', ')}`
    if (operation.fill !== undefined && operation.fills !== undefined) return 'Pass fill or fills, not both'
    if (operation.fill !== undefined && solidFill(operation.fill).error) return solidFill(operation.fill).error
    if (operation.parentId !== undefined && asId(operation.parentId, 'parentId')) return asId(operation.parentId, 'parentId')
    return null
  }
  if (op === 'update') {
    const extra = own(operation, ['op', 'nodeId', 'name', 'text', 'fontSize', 'opacity', 'visible', 'locked', 'width', 'height', 'x', 'y', 'fill', 'fills', 'transform'])
    if (extra.length) return `update does not accept ${extra.join(', ')}`
    if (asId(operation.nodeId, 'nodeId')) return asId(operation.nodeId, 'nodeId')
    if (operation.fill !== undefined && operation.fills !== undefined) return 'Pass fill or fills, not both'
    if (operation.fill !== undefined && solidFill(operation.fill).error) return solidFill(operation.fill).error
    if (operation.transform !== undefined && (!Array.isArray(operation.transform) || operation.transform.length !== 6)) return 'transform must be [a, b, c, d, tx, ty]'
    if ((operation.x !== undefined || operation.y !== undefined) && operation.transform !== undefined) return 'Pass x/y or transform, not both'
    if (!['name', 'text', 'fontSize', 'opacity', 'visible', 'locked', 'width', 'height', 'x', 'y', 'fill', 'fills', 'transform'].some(key => operation[key] !== undefined)) return 'update requires at least one property'
    return null
  }
  if (op === 'delete') {
    const extra = own(operation, ['op', 'nodeId', 'nodeIds'])
    if (extra.length) return `delete does not accept ${extra.join(', ')}`
    if (operation.nodeId !== undefined && operation.nodeIds !== undefined) return 'Pass nodeId or nodeIds, not both'
    if (operation.nodeId === undefined && !Array.isArray(operation.nodeIds)) return 'delete requires nodeId or nodeIds'
    return null
  }
  if (op === 'select') {
    const extra = own(operation, ['op', 'nodeIds', 'pageId'])
    if (extra.length) return `select does not accept ${extra.join(', ')}`
    if (!Array.isArray(operation.nodeIds)) return 'select requires nodeIds'
    return null
  }
  if (op === 'move') {
    const extra = own(operation, ['op', 'nodeId', 'nodeIds', 'parentId', 'index'])
    if (extra.length) return `move does not accept ${extra.join(', ')}`
    if (operation.nodeId !== undefined && operation.nodeIds !== undefined) return 'Pass nodeId or nodeIds, not both'
    if (asId(operation.parentId, 'parentId')) return asId(operation.parentId, 'parentId')
    if (operation.nodeId === undefined && !Array.isArray(operation.nodeIds)) return 'move requires nodeId or nodeIds'
    return null
  }
  return 'operation.op must be create, update, delete, select, or move'
}

function patchFrom(operation, transform) {
  const patch = {}
  for (const key of ['name', 'text', 'fontSize', 'opacity', 'visible', 'locked', 'width', 'height', 'fills']) {
    if (operation[key] !== undefined) patch[key] = operation[key]
  }
  if (operation.fill !== undefined) patch.fills = [solidFill(operation.fill).paint]
  if (transform) patch.transform = transform
  else if (operation.transform !== undefined) patch.transform = operation.transform
  return patch
}

export class FigmaFacade {
  constructor({ execute, methods, scope = 'write', pluginBridge = undefined, target } = {}) {
    if (typeof execute !== 'function') throw new TypeError('FigmaFacade requires the Design API execute function')
    if (!Array.isArray(methods) || methods.some(method => !isRecord(method) || typeof method.name !== 'string')) throw new TypeError('FigmaFacade requires Design API method descriptors')
    if (!['read', 'write'].includes(scope)) throw new TypeError('FigmaFacade scope must be read or write')
    this.execute = execute
    this.methodNames = new Set(methods.map(method => method.name))
    this.scope = scope
    this.pluginBridge = pluginBridge
    this.target = target
  }

  listTools() { return FIGMA_MCP_TOOLS.map(entry => ({ ...entry, inputSchema: entry.inputSchema })) }

  async callTool(name, args, context = {}) {
    const toolArgs = args ?? {}
    try {
      if (name === 'get_metadata') return await this.metadata(toolArgs, context)
      if (name === 'get_selection') return await this.selection(toolArgs, context)
      if (name === 'get_design_context') return await this.designContext(toolArgs, context)
      if (name === 'get_screenshot') return await this.screenshot(toolArgs, context)
      if (name === 'get_variable_defs') return await this.variables(toolArgs, context)
      if (name === 'download_assets') return await this.download(toolArgs, context)
      if (name === 'use_figma') return await this.useFigma(toolArgs, context)
      if (name === 'open_document') return await this.openDocument(toolArgs, context)
      return failure(name, 'unknown_tool', `Unknown Figma-shaped tool ${name}`)
    } catch (error) {
      return failure(name, typeof error?.code === 'string' ? error.code : 'facade_error', error?.message || 'Figma-shaped tool failed')
    }
  }

  async call(method, params, context, fences) {
    if (!this.methodNames.has(method)) return failure(method, 'method_unavailable', `${method} is not available in this Design API session`)
    const request = {
      method, params: params ?? {},
      ...(fences ? { documentId: fences.documentId, session: fences.session, expectedRevision: fences.revision } : this.target ? { documentId: this.target.documentId, session: this.target.session } : {}),
      ...(context.requestId === undefined ? {} : { id: context.requestId }),
    }
    const response = await this.execute(request, context)
    if (!isRecord(response) || typeof response.ok !== 'boolean') return failure(method, 'invalid_backend', 'Design API returned an invalid response')
    return response
  }

  async fences(context) {
    const read = await this.call('document.get', {}, context)
    if (!read.ok) return read
    return { ok: true, ...identityOf(read) }
  }

  nodeId(args) {
    if (args.nodeId === undefined) return undefined
    if (typeof args.nodeId !== 'string' || !args.nodeId.trim() || args.nodeId.length > 128) return { error: 'nodeId must be a nonempty string of at most 128 characters' }
    return args.nodeId
  }

  async metadata(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'cursor']))
    if (invalid) return failure('get_metadata', 'invalid_params', invalid)
    const nodeId = this.nodeId(args)
    if (isRecord(nodeId)) return failure('get_metadata', 'invalid_params', nodeId.error)
    const pages = await this.call('page.list', {}, context)
    if (!pages.ok) return pages
    const pageList = Array.isArray(pages.result?.pages) ? pages.result.pages : []
    if (nodeId === undefined) {
      const xml = metadataXml(pages.documentId, pageList.map(page => ({ id: page.id, name: page.name, kind: 'page' })))
      return done('get_metadata', identityOf(pages), { format: 'futureox.figma-metadata.v1', scope: 'pages', xml, pages: pageList.map(page => ({ id: page.id, name: page.name })), fileKeyIgnored: args.fileKey !== undefined, modelText: xml })
    }
    const page = pageList.find(entry => entry.id === nodeId)
    const found = await this.call('node.find', page ? { pageId: nodeId, limit: NODE_LIMIT } : { rootId: nodeId, limit: NODE_LIMIT }, context)
    if (!found.ok) return found
    const nodes = Array.isArray(found.result?.nodes) ? found.result.nodes : []
    const xml = metadataXml(nodeId, nodes)
    return done('get_metadata', identityOf(found), { format: 'futureox.figma-metadata.v1', scope: page ? 'page' : 'subtree', nodeId, xml, nodes, truncated: Boolean(found.result?.nextCursor), total: found.result?.total, fileKeyIgnored: args.fileKey !== undefined, modelText: xml })
  }

  async selection(args, context) {
    const invalid = unknownArguments(args, new Set(['cursor']))
    if (invalid) return failure('get_selection', 'invalid_params', invalid)
    const selected = await this.call('selection.get', {}, context)
    if (!selected.ok) return selected
    const ids = Array.isArray(selected.result?.ids) ? selected.result.ids : []
    const detailed = []
    for (const id of ids.slice(0, SELECTION_DETAIL)) {
      const node = await this.call('node.get', { id }, context)
      if (!node.ok) return node
      detailed.push(summarize(node.result))
    }
    return done('get_selection', identityOf(selected), {
      pageId: selected.result?.pageId, ids, nodes: detailed, truncated: ids.length > SELECTION_DETAIL,
    })
  }

  async resolveNodes(args, context, toolName) {
    const nodeId = this.nodeId(args)
    if (isRecord(nodeId)) return failure(toolName, 'invalid_params', nodeId.error)
    if (nodeId) return { ok: true, ids: [nodeId] }
    const selected = await this.call('selection.get', {}, context)
    if (!selected.ok) return selected
    return { ok: true, ids: Array.isArray(selected.result?.ids) ? selected.result.ids : [], identity: identityOf(selected), pageId: selected.result?.pageId }
  }

  async designContext(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'cursor']))
    if (invalid) return failure('get_design_context', 'invalid_params', invalid)
    const target = await this.resolveNodes(args, context, 'get_design_context')
    if (!target.ok) return target
    const params = target.ids?.length ? { nodeIds: target.ids.slice(0, 40), limit: 40 } : { limit: 40 }
    const contextResult = await this.call('context.get', params, context)
    if (!contextResult.ok) return contextResult
    const nodes = Array.isArray(contextResult.result?.nodes) ? contextResult.result.nodes.slice(0, 40).map(entry => ({
      id: entry.id ?? entry.node?.id, name: entry.name ?? entry.node?.name, kind: entry.kind ?? entry.node?.kind,
    })) : []
    const outline = metadataXml('context', nodes.filter(node => node.id))
    const result = {
      format: 'futureox.design-context.v1', fidelity: 'futureox-html-css',
      note: 'This is Futureox context and HTML/CSS when code.export is available. It is not Figma React + Tailwind. clientFrameworks is ignored.',
      nodes, outline, warnings: contextResult.result?.warnings, pagination: contextResult.result?.pagination,
      modelText: `${outline}\nFutureox design context. HTML/CSS is included only when code.export is available in this session. This is not Figma React + Tailwind.`,
    }
    if (this.methodNames.has('code.export')) {
      const code = await this.call('code.export', { ...params, maxNodes: 40 }, context)
      if (code.ok && isRecord(code.result) && typeof code.result.html === 'string' && typeof code.result.css === 'string') {
        result.format = 'futureox.design-code.v1'
        result.html = code.result.html
        result.css = code.result.css
        result.warnings = code.result.warnings
        result.codeFidelity = code.result.fidelity
      } else if (!code.ok) result.codeExportError = code.error
    } else result.codeExportError = { code: 'method_unavailable', message: 'code.export is not available in this session' }
    return done('get_design_context', identityOf(contextResult), result)
  }

  async screenshot(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'scale', 'cursor']))
    if (invalid) return failure('get_screenshot', 'invalid_params', invalid)
    if (args.scale !== undefined && (typeof args.scale !== 'number' || args.scale < 0.1 || args.scale > 4)) return failure('get_screenshot', 'invalid_params', 'scale must be a number from 0.1 to 4')
    const target = await this.resolveNodes(args, context, 'get_screenshot')
    if (!target.ok) return target
    const params = { format: 'png', ...(args.scale === undefined ? {} : { scale: args.scale }), ...(target.ids?.length ? { nodeIds: target.ids.slice(0, 256) } : {}) }
    return this.call('preview.capture', params, context)
  }

  async variables(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'cursor']))
    if (invalid) return failure('get_variable_defs', 'invalid_params', invalid)
    const target = await this.resolveNodes(args, context, 'get_variable_defs')
    if (!target.ok) return target
    const variables = await this.call('variable.list', {}, context)
    if (!variables.ok) return variables
    const styles = await this.call('style.list', {}, context)
    if (!styles.ok) return styles
    const usedVariables = new Set()
    const usedStyles = new Set()
    for (const id of (target.ids ?? []).slice(0, SELECTION_DETAIL)) {
      const node = await this.call('node.get', { id }, context)
      if (!node.ok) return node
      const source = node.result?.node ?? {}
      for (const value of Object.values(source.bindings ?? {})) if (typeof value === 'string') usedVariables.add(value)
      for (const value of Object.values(source.styleRefs ?? {})) if (typeof value === 'string') usedStyles.add(value)
    }
    const variableList = asList(variables.result)
    const styleList = asList(styles.result)
    const scoped = target.ids?.length
      ? { scope: 'selection', variables: variableList.filter(entry => usedVariables.has(entry.id)), styles: styleList.filter(entry => usedStyles.has(entry.id)) }
      : { scope: 'document', variables: variableList.slice(0, 50), styles: styleList.slice(0, 50), truncated: variableList.length > 50 || styleList.length > 50 }
    return done('get_variable_defs', identityOf(styles), {
      ...scoped, libraries: [], note: 'Local document variables and styles only. Team libraries are not available.',
    })
  }

  async download(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'nodeIds', 'defaultFormat', 'defaultScale', 'cursor']))
    if (invalid) return failure('download_assets', 'invalid_params', invalid)
    const ids = []
    if (typeof args.nodeId === 'string') ids.push(args.nodeId)
    if (args.nodeIds !== undefined) {
      if (!Array.isArray(args.nodeIds) || args.nodeIds.some(id => typeof id !== 'string' || !id)) return failure('download_assets', 'invalid_params', 'nodeIds must be an array of node ids')
      ids.push(...args.nodeIds)
    }
    const unique = [...new Set(ids)]
    if (!unique.length) return failure('download_assets', 'invalid_params', 'download_assets requires nodeId or nodeIds')
    if (unique.length > 1) return failure('download_assets', 'too_many_nodes', 'This facade exports one node per call and does not return temporary URLs. Call get_screenshot once per node.')
    const format = args.defaultFormat ?? 'png'
    if (format === 'pdf') return failure('download_assets', 'unsupported_format', 'PDF export is not available. Use png, jpeg, webp, or svg.')
    if (!['png', 'jpeg', 'jpg', 'webp', 'svg'].includes(format)) return failure('download_assets', 'invalid_params', 'defaultFormat must be png, jpeg, webp, or svg')
    if (args.defaultScale !== undefined && (typeof args.defaultScale !== 'number' || args.defaultScale < 0.1 || args.defaultScale > 4)) return failure('download_assets', 'invalid_params', 'defaultScale must be a number from 0.1 to 4')
    if (format === 'svg') return this.call('vector.export', { nodeIds: unique, ...(args.defaultScale === undefined ? {} : { scale: args.defaultScale }) }, context)
    const captured = await this.call('preview.capture', { nodeIds: unique, format: format === 'jpg' ? 'jpeg' : format, ...(args.defaultScale === undefined ? {} : { scale: args.defaultScale }) }, context)
    if (!captured.ok) return captured
    return { ...captured, result: { ...captured.result, rawImages: [], rawImagesUnsupported: true, urls: false } }
  }

  async useFigma(args, context) {
    const invalid = unknownArguments(args, new Set(['description', 'operations', 'code', 'mutationId', 'cursor']))
    if (invalid) return failure('use_figma', 'invalid_params', invalid)
    if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 400) return failure('use_figma', 'invalid_params', 'description is required and must be at most 400 characters')
    if (args.code !== undefined && args.operations !== undefined) return failure('use_figma', 'invalid_params', 'Pass code or operations, not both')
    if (args.mutationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(args.mutationId)) return failure('use_figma', 'invalid_params', 'mutationId must be 1–128 ASCII letters, digits, hyphens, or underscores')
    if (this.scope !== 'write') return failure('use_figma', 'read_only', 'This connection is read-only. Enable read and edit access to write.')
    if (args.code !== undefined) return this.pluginCode(args, context)
    if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 40) return failure('use_figma', 'invalid_params', 'operations must contain 1–40 structured operations')
    for (const operation of args.operations) {
      const problem = validateFigmaOperation(operation)
      if (problem) return failure('use_figma', 'invalid_params', problem)
    }
    const fences = await this.fences(context)
    if (!fences.ok) return fences
    const transforms = new Map()
    for (const operation of args.operations) {
      if (operation.op !== 'update' || (operation.x === undefined && operation.y === undefined)) continue
      const current = await this.call('node.get', { id: operation.nodeId }, context)
      if (!current.ok) return current
      if (current.revision !== fences.revision) return failure('use_figma', 'stale_revision', 'The document changed while reading node positions. Read it again before writing.', identityOf(current))
      const matrix = current.result?.node?.transform
      if (!Array.isArray(matrix) || matrix.length !== 6) return failure('use_figma', 'invalid_backend', `Node ${operation.nodeId} has no parent-local transform`, identityOf(current))
      const next = [...matrix]
      if (operation.x !== undefined) next[4] = operation.x
      if (operation.y !== undefined) next[5] = operation.y
      transforms.set(operation, next)
    }
    const operations = args.operations.map(operation => this.compile(operation, transforms.get(operation)))
    const applied = await this.call('batch.apply', { operations, ...(args.mutationId ? { mutationId: args.mutationId } : {}) }, context, fences)
    if (!applied.ok) return applied
    return done('use_figma', identityOf(applied), {
      description: args.description, operations: applied.result, revision: applied.revision,
      modelText: `Applied ${operations.length} structured operations. Revision ${applied.revision}. Plugin JavaScript was not evaluated.`,
    })
  }

  compile(operation, transform) {
    if (operation.op === 'create') {
      const params = { kind: operation.kind }
      for (const key of ['parentId', 'id', 'index', 'x', 'y', 'width', 'height']) if (operation[key] !== undefined) params[key] = operation[key]
      const patch = patchFrom(operation)
      if (Object.keys(patch).length) params.patch = patch
      return { method: 'node.create', params }
    }
    if (operation.op === 'update') {
      const patch = patchFrom(operation, transform)
      if (!Object.keys(patch).length) throw Object.assign(new Error('update requires at least one property'), { code: 'invalid_params' })
      return { method: 'node.update', params: { ids: [operation.nodeId], patch } }
    }
    if (operation.op === 'delete') return { method: 'node.delete', params: { ids: operation.nodeIds ?? [operation.nodeId] } }
    if (operation.op === 'select') return { method: 'selection.set', params: { ids: operation.nodeIds, ...(operation.pageId === undefined ? {} : { pageId: operation.pageId }) } }
    return { method: 'node.move', params: { ids: operation.nodeIds ?? [operation.nodeId], parentId: operation.parentId, ...(operation.index === undefined ? {} : { index: operation.index }) } }
  }

  async pluginCode(args, context) {
    if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > 100000) return failure('use_figma', 'invalid_params', 'code must be plugin source of at most 100000 characters')
    const bridge = this.pluginBridge === undefined ? figmaPluginBridge() : this.pluginBridge
    if (!bridge || typeof bridge.run !== 'function') {
      return failure('use_figma', 'plugin_host_unavailable', 'No plugin host is registered. use_figma did not evaluate code. Send structured operations, or run this document in a desktop build that registers a Figma plugin bridge.')
    }
    const fences = await this.fences(context)
    if (!fences.ok) return fences
    const result = await bridge.run({ code: args.code, description: args.description, ...fences }, context)
    if (!isRecord(result) || typeof result.ok !== 'boolean') return failure('use_figma', 'invalid_plugin_bridge', 'Plugin bridge returned an invalid response', fences)
    return result
  }

  async openDocument(args, context) {
    const invalid = unknownArguments(args, new Set(['rootHandle', 'documentHandle', 'mutationId', 'cursor']))
    if (invalid) return failure('open_document', 'invalid_params', invalid)
    for (const key of ['rootHandle', 'documentHandle']) {
      if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 512) return failure('open_document', 'invalid_params', `${key} must be a nonempty string`)
    }
    if (typeof args.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.mutationId)) return failure('open_document', 'invalid_params', 'mutationId must be 1–128 ASCII letters, digits, hyphens, or underscores')
    if (this.scope !== 'write') return failure('open_document', 'read_only', 'Opening a document requires read and edit access plus a workspace grant.')
    if (!this.methodNames.has('workspace.open')) return failure('open_document', 'open_unavailable', 'workspace.open is not available. Enable the desktop workspace grant, then open the saved design from the app. This tool does not create a Figma cloud file.')
    const fences = await this.fences(context)
    if (!fences.ok) return fences
    const opened = await this.call('workspace.open', { rootHandle: args.rootHandle, documentHandle: args.documentHandle, mutationId: args.mutationId }, context, fences)
    if (!opened.ok) return opened
    return done('open_document', identityOf(opened), { ...opened.result, note: 'A successful open can end this automation session. Read the new document before another call.' })
  }
}

function summarize(result) {
  const node = isRecord(result?.node) ? result.node : {}
  const summary = isRecord(result) ? result : {}
  return {
    id: summary.id ?? node.id, name: summary.name ?? node.name, kind: summary.kind ?? node.kind,
    width: summary.width ?? node.width, height: summary.height ?? node.height, worldBounds: summary.worldBounds,
  }
}

function asList(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.variables)) return result.variables
  if (Array.isArray(result?.styles)) return result.styles
  if (Array.isArray(result?.items)) return result.items
  return []
}
