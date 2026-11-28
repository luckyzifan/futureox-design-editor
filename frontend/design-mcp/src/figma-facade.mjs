import { createHash } from 'node:crypto'
import { isRecord } from './framing.mjs'
import { buildLocalDesignContext, DESIGN_CONTEXT_NODE_LIMIT } from './figma-design-context.mjs'
import { FIGMA_COMPATIBILITY_GAPS, FIGMA_COMPATIBILITY_TOOLS, callCompatibilityTool, isCompatibilityTool } from './figma-weave-tools.mjs'

/** Explicit compatibility surface for AI clients that already speak Figma MCP.
 * These names are not added to the shared Design API registry. Every call is
 * translated into that API. This module does not store a document, eval plugin
 * code, or claim Figma account, library, or pixel parity. */
export const FIGMA_MCP_INSTRUCTIONS = 'Futureox Design Figma-shaped MCP facade for the document whose desktop automation bridge is enabled. Tools call the existing Design API; this server applies document/session/revision fences itself. Loopback Streamable HTTP supports POST JSON-RPC, one GET text/event-stream per session, Mcp-Session-Id, MCP-Protocol-Version, and DELETE. get_metadata, get_selection, get_design_context, get_screenshot, get_variable_defs and download_assets read. get_design_context returns a deterministic local React JSX + Tailwind approximation (not Figma output) and lists unmapped fields. use_figma writes structured create/update/delete/move/select operations as one undo step. Plugin JavaScript in use_figma code is forwarded only when the host registered or injected a plugin bridge; otherwise the tool returns plugin_host_unavailable and does not eval. open_document is a local workspace open, not a Figma cloud file. fileKey is ignored. Screenshots are CPU exports of design content with no temporary URL. Team libraries, Code Connect and remote asset URLs return typed boundaries. Cancellation cannot undo a committed edit.'
export const FIGMA_ASSET_LIMIT = 20
const ASSET_BATCH_BYTES = 32 * 1024 * 1024
const ASSET_MIN_SCALE = 0.01
const ASSET_URL_BOUNDARY = Object.freeze({
  supported: false,
  code: 'unsupported_remote_capability',
  message: 'No temporary asset URL service exists. On this local-first build, export bytes are delivered as exact MCP resources in the same authorized session; no remote URL is invented.',
})
const localAssetDelivery = result => ({
  ...result, delivery: 'mcp-resources', temporaryUrls: false, urls: false, urlExport: ASSET_URL_BOUNDARY,
})

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
  { id: 'use_figma_plugin_javascript', tool: 'use_figma', status: 'partial', detail: 'Structured operations map to Design API batches. code is sent to a host-registered or host-injected plugin bridge (the desktop QuickJS host satisfies this contract). Without a bridge the call returns plugin_host_unavailable and is not evaluated in Node.' },
  { id: 'download_assets_urls_pdf_raw', tool: 'download_assets', status: 'partial', detail: 'PNG, JPEG, WebP, SVG or bitmap PDF for up to 20 local nodes uses MCP resources (also rawImagesOnly). External fetch URLs and temporary asset URLs are unavailable and reported as a typed boundary, never invented.' },
  { id: 'design_context_not_react', tool: 'get_design_context', status: 'partial', detail: 'Returns a deterministic local React JSX + Tailwind approximation with node tree, layout, paints, text metrics, variables and shared styles. Explicitly not Figma cloud output; unmapped fields are listed.' },
  { id: 'screenshot_is_cpu_export', tool: 'get_screenshot', status: 'partial', detail: 'preview.capture CPU raster of design content with Figma nodeId/format/scale/contentsOnly/maxDimension parameters and a 1024 default max side. No temporary URL; bytes are inline or a session resource.' },
  { id: 'file_key_ignored', tool: 'fileKey', status: 'partial', detail: 'The server is bound to the enabled local document. A Figma URL or file key does not select a different file. Figma-style node ids are accepted; an unknown id returns the page list like Figma.' },
  { id: 'team_libraries', tool: 'get_variable_defs', status: 'unsupported', detail: 'Local variables and shared styles only. Team libraries and published design systems return a typed unsupported boundary, not an empty catalog; nodeId is optional and omitted means a document-level catalog.' },
  { id: 'streamable_http_get', tool: 'GET /mcp', status: 'partial', detail: 'POST JSON-RPC, one GET text/event-stream per session, Mcp-Session-Id, MCP-Protocol-Version and DELETE are implemented on loopback with the desktop bearer grant. There is no remote OAuth or multi-user service.' },
  { id: 'no_remote_account', tool: 'remote MCP', status: 'absent', detail: 'Loopback HTTP and stdio only. No mcp.figma.com, OAuth, or multi-user account.' },
  ...FIGMA_COMPATIBILITY_GAPS,
])

const KINDS = new Set(['slice', 'frame', 'section', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector', 'text'])
const IGNORED = new Set(['fileKey', 'clientFrameworks', 'clientLanguages', 'skillNames', 'dir'])
const LOOSE = { description: 'Accepted and ignored. This server is bound to the enabled local document.' }
const NODE_LIMIT = 100
const METADATA_CURSOR_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{2,171})$/
const SELECTION_DETAIL = 20
const FIGMA_NODE_ID_PATTERN = /^(?:[IT])?\d+[:-]\d+(?:[;:]\d+(?::\d+)?)*$/
const FIGMA_URL_NODE_ID_PATTERN = /^\d+-\d+$/

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
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties,
    sessionId: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional Futureox session assertion. Use the current HTTP Mcp-Session-Id or the packaged Figma stdio desktop grant session.' },
    fileKey: { type: 'string', ...LOOSE }, clientFrameworks: LOOSE, clientLanguages: LOOSE, skillNames: LOOSE }, required },
  annotations: { readOnlyHint: name !== 'use_figma' && name !== 'open_document', destructiveHint: name === 'use_figma' || name === 'open_document', idempotentHint: name !== 'use_figma' && name !== 'open_document', openWorldHint: false },
})

export const FIGMA_MCP_TOOLS = Object.freeze([
  tool('get_metadata', 'Lightweight XML outline of the open Futureox document. Omit nodeId for pages. A page id outlines that page; any other id outlines that subtree in pages of up to 100 nodes. Figma-style ids such as 1:23 or the URL form 1-23 are accepted; an id that is not a local page or node returns the page list, matching Figma behavior for an unknown node id. fileKey is ignored.', {
    nodeId: { type: 'string', minLength: 1, maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: NODE_LIMIT, description: 'Nodes per outline page. Defaults to 100.' },
    cursor: { type: 'string', minLength: 46, maxLength: 215, description: 'nextCursor from the same nodeId, editor session, and revision.' },
  }),
  tool('get_selection', 'Read the active page and current selection. Up to 20 nodes include id, name, kind, size, and world bounds. Desktop Figma MCP often implies this selection; call this tool to read it.', {}),
  tool('get_design_context', 'Bounded local design context for nodeId or the current selection. Returns a deterministic React JSX + Tailwind approximation with the node tree, layout, paints, text metrics, variables and shared styles; unsupported fields are listed in unmapped. fileKey and clientFrameworks are accepted; this is not Figma cloud output and no Code Connect registry exists. Page with cursor and limit.', {
    nodeId: { type: 'string', minLength: 1, maxLength: 128 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: DESIGN_CONTEXT_NODE_LIMIT, description: 'Nodes per context page. Defaults to 40.' },
    disableCodeConnect: { type: 'boolean', description: 'Accepted. No Code Connect registry exists locally.' }, excludeScreenshot: { type: 'boolean', description: 'Accepted. Local context never embeds a screenshot; call get_screenshot for pixels.' }, forceCode: { type: 'boolean', description: 'Accepted. Local context always generates JSX code.' },
  }),
  tool('get_screenshot', 'CPU PNG (or JPEG/WebP) of the local node, selection or active page. maxDimension fits the rendered size and defaults to 1024 when scale is omitted. Set contentsOnly to false to include background and other page layers inside the crop. enableBase64Response false requests a resource link without inline image content. Returns local bytes, not a temporary URL.', {
    nodeId: { type: 'string', minLength: 1, maxLength: 128 },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Defaults to png.' },
    scale: { type: 'number', minimum: 0.1, maximum: 4 },
    maxDimension: { type: 'integer', minimum: 1, maximum: 65536, description: 'Longest rendered side. Defaults to 1024 when scale is omitted.' },
    contentsOnly: { type: 'boolean' }, enableBase64Response: { type: 'boolean' },
  }),
  tool('get_variable_defs', 'Local variable definitions and their alias dependencies, plus shared styles referenced by nodeId or the first 20 selected nodes. nodeId is optional here: without it the result is a bounded document-level catalog. Team libraries are not available and are reported as a typed unsupported boundary, not an empty library list.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 } }),
  tool('download_assets', 'Export up to 20 local nodes as individual MCP resources in png, jpeg, webp, svg, or bitmap pdf. Set rawImagesOnly to read up to 20 original embedded image fills in the selected subtrees instead.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, nodeIds: { type: 'array', minItems: 1, maxItems: FIGMA_ASSET_LIMIT, items: { type: 'string', minLength: 1, maxLength: 128 } }, defaultFormat: { type: 'string', enum: ['png', 'jpeg', 'jpg', 'webp', 'svg', 'pdf'] }, defaultScale: { type: 'number', minimum: ASSET_MIN_SCALE, maximum: 4 }, rawImagesOnly: { type: 'boolean' } }),
  tool('use_figma', 'Write the open document. Preferred input is operations (at most 40), applied as one Design API batch and one undo step: create {kind,parentId?,x?,y?,width?,height?,name?,text?,fontSize?,fill?}, update {nodeId,name?,x?,y?,width?,height?,text?,fill?,transform?}, delete {nodeId|nodeIds}, select {nodeIds}, move {nodeId,parentId,index?}. fill is #RRGGBB. Coordinates are parent-local document units. code is plugin JavaScript and is forwarded to the registered plugin host bridge; this Node process never evals it. Without a bridge the result is plugin_host_unavailable and the source is not evaluated. description is required.', { description: { type: 'string', minLength: 1, maxLength: 2000 }, operations: { type: 'array', maxItems: 40 }, code: { type: 'string', maxLength: 50000 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['description']),
  tool('open_document', 'Open a saved local design through workspace.open. Requires rootHandle, documentHandle, and mutationId from a workspace grant. This is not Figma create_new_file. A successful open can end this automation session.', { rootHandle: { type: 'string', minLength: 1, maxLength: 512 }, documentHandle: { type: 'string', minLength: 1, maxLength: 512 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['rootHandle', 'documentHandle', 'mutationId']),
])

const failure = (method, code, message, identity = {}) => ({
  ok: false, method, documentId: identity.documentId ?? '', session: identity.session ?? 0, revision: identity.revision ?? 0,
  error: { code, message },
})
const done = (method, identity, result) => ({ ok: true, method, documentId: identity.documentId, session: identity.session, revision: identity.revision, result })
const identityOf = response => ({ documentId: response.documentId, session: response.session, revision: response.revision })

function rejectCursor(args) {
  if (args.cursor !== undefined) return 'This tool returns one bounded result. Narrow nodeId instead of passing a cursor.'
}

function unknownArguments(args, allowed, { pagination = false } = {}) {
  if (!isRecord(args)) return 'Tool arguments must be an object'
  const extra = Object.keys(args).filter(key => !allowed.has(key) && !IGNORED.has(key))
  if (extra.length) return `Unknown arguments: ${extra.join(', ')}`
  if (!pagination) return rejectCursor(args)
}

function metadataCursorBinding({ documentId, session }, nodeId, scope) {
  return createHash('sha256').update(JSON.stringify([documentId, session, nodeId, scope])).digest('base64url')
}

/** Figma URLs spell a node id with hyphens (`?node-id=1-23`); the API and MCP
 * parameter use colons (`1:23`). Only digit/hyphen forms are rewritten, so a
 * local UUID or arbitrary local id is never modified. */
export function normalizeFigmaNodeId(value) {
  if (typeof value !== 'string') return value
  return FIGMA_URL_NODE_ID_PATTERN.test(value) ? value.replaceAll('-', ':') : value
}

export function isFigmaNodeId(value) {
  return typeof value === 'string' && FIGMA_NODE_ID_PATTERN.test(value)
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

function patchFrom(operation) {
  const patch = {}
  for (const key of ['name', 'text', 'fontSize', 'opacity', 'visible', 'locked', 'width', 'height', 'fills']) {
    if (operation[key] !== undefined) patch[key] = operation[key]
  }
  if (operation.fill !== undefined) patch.fills = [solidFill(operation.fill).paint]
  if (operation.transform !== undefined) patch.transform = operation.transform
  return patch
}

export class FigmaFacade {
  constructor({ execute, methods, scope = 'write', pluginBridge = undefined, target, terminalSignal, localSessionId } = {}) {
    if (typeof execute !== 'function') throw new TypeError('FigmaFacade requires the Design API execute function')
    if (!Array.isArray(methods) || methods.some(method => !isRecord(method) || typeof method.name !== 'string')) throw new TypeError('FigmaFacade requires Design API method descriptors')
    if (!['read', 'write'].includes(scope)) throw new TypeError('FigmaFacade scope must be read or write')
    this.execute = execute
    this.methodNames = new Set(methods.map(method => method.name))
    this.scope = scope
    this.pluginBridge = pluginBridge
    this.target = target
    this.terminalSignal = terminalSignal
    this.localSessionId = localSessionId
  }

  listTools() {
    const canWrite = this.scope === 'write' && this.methodNames.has('document.get')
    const canUseFigma = canWrite && (this.methodNames.has('batch.apply') || this.pluginHost() !== null)
    const canOpenDocument = canWrite && this.methodNames.has('workspace.open')
    const base = FIGMA_MCP_TOOLS.filter(entry =>
      entry.annotations.readOnlyHint ||
      (canUseFigma && entry.name === 'use_figma') ||
      (canOpenDocument && entry.name === 'open_document')
    )
    return [...base, ...FIGMA_COMPATIBILITY_TOOLS].map(entry => ({ ...entry }))
  }

  async callTool(name, args, context = {}) {
    let toolArgs = args ?? {}
    try {
      if (name !== 'create_session' && isRecord(toolArgs) && Object.hasOwn(toolArgs, 'sessionId')) {
        const { sessionId, ...parameters } = toolArgs
        const boundSession = context.localSessionId ?? this.localSessionId
        if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 256 || sessionId !== boundSession)
          return failure(name, 'invalid_local_session', 'Use the active Futureox transport session ID for this connection.')
        toolArgs = parameters
      }
      if (name === 'get_metadata') return await this.metadata(toolArgs, context)
      if (name === 'get_selection') return await this.selection(toolArgs, context)
      if (name === 'get_design_context') return await this.designContext(toolArgs, context)
      if (name === 'get_screenshot') return await this.screenshot(toolArgs, context)
      if (name === 'get_variable_defs') return await this.variables(toolArgs, context)
      if (name === 'download_assets') return await this.download(toolArgs, context)
      if (name === 'use_figma') return await this.useFigma(toolArgs, context)
      if (name === 'open_document') return await this.openDocument(toolArgs, context)
      if (isCompatibilityTool(name)) {
        return await callCompatibilityTool({
          name, args: toolArgs,
          sessionId: context.localSessionId ?? this.localSessionId,
          call: (method, params, fences) => this.call(method, params, context, fences),
        })
      }
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
    const invalid = unknownArguments(args, new Set(['nodeId', 'limit', 'cursor']), { pagination: true })
    if (invalid) return failure('get_metadata', 'invalid_params', invalid)
    const requestedNodeId = this.nodeId(args)
    if (isRecord(requestedNodeId)) return failure('get_metadata', 'invalid_params', requestedNodeId.error)
    const nodeId = normalizeFigmaNodeId(requestedNodeId)
    if (args.limit !== undefined && (nodeId === undefined || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > NODE_LIMIT)) return failure('get_metadata', 'invalid_params', 'limit requires nodeId and must be an integer from 1 to 100')
    const continuation = typeof args.cursor === 'string' && args.cursor.length <= 215 ? METADATA_CURSOR_PATTERN.exec(args.cursor) : null
    if (args.cursor !== undefined && (nodeId === undefined || !continuation)) return failure('get_metadata', 'invalid_params', 'Pass nextCursor from an earlier result with the same nodeId')
    const pages = await this.call('page.list', {}, context)
    if (!pages.ok) return pages
    const pageList = Array.isArray(pages.result?.pages) ? pages.result.pages.map(({ id, name }) => ({ id, name })) : []
    if (nodeId === undefined) {
      const xml = metadataXml(pages.documentId, pageList.map(page => ({ id: page.id, name: page.name, kind: 'page' })))
      return done('get_metadata', identityOf(pages), { format: 'futureox.figma-metadata.v1', scope: 'pages', xml, pages: pageList, fileKeyIgnored: args.fileKey !== undefined, modelText: xml })
    }
    const page = pageList.find(entry => entry.id === nodeId)
    const scope = page ? 'page' : 'subtree'
    const identity = identityOf(pages)
    const binding = metadataCursorBinding(identity, nodeId, scope)
    if (continuation && continuation[1] !== binding) return failure('get_metadata', 'invalid_params', 'Cursor belongs to another document, editor session, or nodeId', identity)
    const found = await this.call('node.find', {
      ...(page ? { pageId: nodeId } : { rootId: nodeId }),
      limit: args.limit ?? NODE_LIMIT,
      ...(continuation ? { cursor: Buffer.from(continuation[2], 'base64url').toString('utf8') } : {}),
    }, context, identity)
    if (!found.ok && continuation && ['stale_revision', 'stale_cursor'].includes(found.error?.code)) {
      return failure('get_metadata', 'stale_cursor', 'The document changed. Restart the outline without a cursor.', identityOf(found))
    }
    if (!found.ok && found.error?.code === 'not_found') {
      if (continuation) return failure('get_metadata', 'stale_cursor', 'The requested node no longer exists. Restart the outline without a cursor.', identity)
      if (!isFigmaNodeId(nodeId)) {
        // A local id that does not exist stays an explicit not_found. Only the
        // Figma id namespace uses Figma's page-list response, so a typo in a
        // local id is not silently converted into a page listing.
        return { ...found, method: 'get_metadata', error: { ...found.error, details: { pages: pageList } } }
      }
      // Figma returns the top-level page list for a node id that is not in the
      // file. The local file has no Figma id namespace, so an unknown Figma id
      // is reported as unresolved instead of an invented subtree.
      const xml = metadataXml(pages.documentId, pageList.map(entry => ({ id: entry.id, name: entry.name, kind: 'page' })))
      return done('get_metadata', identity, {
        format: 'futureox.figma-metadata.v1', scope: 'pages', xml, pages: pageList,
        requestedNodeId, nodeId, unresolvedNodeId: nodeId, figmaStyleNodeId: true,
        ...(requestedNodeId === nodeId ? {} : { normalizedFrom: requestedNodeId }),
        fileKeyIgnored: args.fileKey !== undefined, modelText: xml,
        note: 'The requested Figma-style id is not a page or node in this local document. An unknown Figma node id returns the page list; local ids are not Figma cloud ids.',
      })
    }
    if (!found.ok) return found
    const nodes = Array.isArray(found.result?.nodes) ? found.result.nodes : []
    const xml = metadataXml(nodeId, nodes)
    const nextCursor = found.result?.nextCursor ? `${binding}.${Buffer.from(found.result.nextCursor).toString('base64url')}` : null
    return done('get_metadata', identityOf(found), {
      format: 'futureox.figma-metadata.v1', scope, nodeId,
      ...(requestedNodeId === nodeId ? {} : { requestedNodeId, normalizedFrom: requestedNodeId }),
      figmaStyleNodeId: isFigmaNodeId(nodeId), xml, nodes, truncated: nextCursor !== null, nextCursor,
      total: found.result?.total, fileKeyIgnored: args.fileKey !== undefined, modelText: xml,
    })
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
    const invalid = unknownArguments(args, new Set(['nodeId', 'cursor', 'limit', 'disableCodeConnect', 'excludeScreenshot', 'forceCode']), { pagination: true })
    if (invalid) return failure('get_design_context', 'invalid_params', invalid)
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor.length || args.cursor.length > 512))
      return failure('get_design_context', 'invalid_params', 'cursor must be a nonempty string of at most 512 characters')
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > DESIGN_CONTEXT_NODE_LIMIT))
      return failure('get_design_context', 'invalid_params', `limit must be an integer from 1 to ${DESIGN_CONTEXT_NODE_LIMIT}`)
    for (const key of ['disableCodeConnect', 'excludeScreenshot', 'forceCode']) {
      if (args[key] !== undefined && typeof args[key] !== 'boolean') return failure('get_design_context', 'invalid_params', `${key} must be a boolean`)
    }
    const target = await this.resolveNodes(args, context, 'get_design_context')
    if (!target.ok) return target
    const roots = target.ids?.length ? { nodeIds: target.ids.slice(0, DESIGN_CONTEXT_NODE_LIMIT) } : {}
    const contextResult = await this.call('context.get', {
      ...roots,
      limit: args.limit ?? DESIGN_CONTEXT_NODE_LIMIT,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    }, context)
    if (!contextResult.ok) return contextResult
    const identity = identityOf(contextResult)
    let variables
    let styles
    let variablesError
    let stylesError
    if (this.methodNames.has('variable.list')) {
      const response = await this.call('variable.list', {}, context, identity)
      if (response.ok) variables = response.result
      else variablesError = response.error
    }
    if (this.methodNames.has('style.list')) {
      const response = await this.call('style.list', {}, context, identity)
      if (response.ok) styles = response.result
      else stylesError = response.error
    }
    const result = buildLocalDesignContext({
      context: contextResult.result, variables, styles,
      options: { ...args, nodeId: target.ids?.length === 1 ? target.ids[0] : args.nodeId },
    })
    if (variablesError) result.variablesError = variablesError
    if (stylesError) result.stylesError = stylesError
    if (!this.methodNames.has('variable.list')) result.variablesError = { code: 'method_unavailable', message: 'variable.list is not available in this session' }
    if (!this.methodNames.has('style.list')) result.stylesError = { code: 'method_unavailable', message: 'style.list is not available in this session' }
    // Keep the existing deterministic HTML/CSS export as a supplemental
    // artifact when the session advertises it. It stays a resource-projected
    // `futureox.design-code.v1` payload; the JSX context above is separate.
    if (this.methodNames.has('code.export')) {
      const code = await this.call('code.export', { ...roots, ...(contextResult.result?.page?.id ? { pageId: contextResult.result.page.id } : {}), maxNodes: DESIGN_CONTEXT_NODE_LIMIT }, context, identity)
      if (code.ok && isRecord(code.result) && typeof code.result.html === 'string' && typeof code.result.css === 'string') {
        result.format = 'futureox.design-code.v1'
        result.html = code.result.html
        result.css = code.result.css
        result.warnings = [...result.warnings, ...(Array.isArray(code.result.warnings) ? code.result.warnings : [])].slice(0, 64)
        result.codeFidelity = code.result.fidelity
      } else if (!code.ok) result.codeExportError = code.error
    } else result.codeExportError = { code: 'method_unavailable', message: 'code.export is not available in this session' }
    result.modelText = result.modelText.replace(/\n?$/, '\n\n// Local React/Tailwind approximation of this document. This is not Figma React + Tailwind output; see result.unmapped for fields without a mapping.')
    return done('get_design_context', identity, result)
  }

  async screenshot(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'format', 'scale', 'maxDimension', 'contentsOnly', 'enableBase64Response', 'cursor']))
    if (invalid) return failure('get_screenshot', 'invalid_params', invalid)
    if (args.format !== undefined && !['png', 'jpeg', 'webp'].includes(args.format)) return failure('get_screenshot', 'invalid_params', 'format must be png, jpeg, or webp')
    if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale < 0.1 || args.scale > 4)) return failure('get_screenshot', 'invalid_params', 'scale must be a number from 0.1 to 4')
    const { maxDimension, contentsOnly, enableBase64Response, scale } = args
    if (maxDimension !== undefined && (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > 65536))
      return failure('get_screenshot', 'invalid_params', 'maxDimension must be an integer from 1 to 65536')
    if ([contentsOnly, enableBase64Response].some(value => value !== undefined && typeof value !== 'boolean'))
      return failure('get_screenshot', 'invalid_params', 'contentsOnly and enableBase64Response must be booleans')
    const target = await this.resolveNodes(args, context, 'get_screenshot')
    if (!target.ok) return target
    // Figma documents a 1024-pixel default maximum side. An explicit scale is
    // the caller's own size request and is not clipped by that default.
    const fitted = maxDimension === undefined && scale === undefined ? 1024 : maxDimension
    const params = { format: args.format ?? 'png', ...(scale === undefined ? {} : { scale }),
      ...(fitted === undefined ? {} : { maxDimension: fitted }),
      ...(contentsOnly === undefined ? {} : { contentsOnly }),
      ...(target.pageId ? { pageId: target.pageId } : {}),
      ...(target.ids?.length ? { nodeIds: target.ids.slice(0, 256) } : {}),
    }
    const captured = await this.call('preview.capture', params, context, target.identity)
    if (!captured.ok) return captured
    const result = {
      ...captured.result,
      delivery: 'mcp-image-or-resource',
      temporaryUrl: false,
      urlExport: { supported: false, code: 'unsupported_remote_capability', message: 'No temporary screenshot URL service exists. Pixels are delivered as MCP image content or an exact session-local resource.' },
      ...(enableBase64Response === false ? { inlineImage: false } : {}),
    }
    return { ...captured, result }
  }

  async variables(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'cursor']))
    if (invalid) return failure('get_variable_defs', 'invalid_params', invalid)
    const target = await this.resolveNodes(args, context, 'get_variable_defs')
    if (!target.ok) return target
    const variables = await this.call('variable.list', {}, context, target.identity)
    if (!variables.ok) return variables
    const identity = target.identity ?? identityOf(variables)
    const styles = await this.call('style.list', {}, context, identity)
    if (!styles.ok) return styles
    const usedVariables = new Set()
    const usedStyles = new Set()
    const ids = target.ids.slice(0, SELECTION_DETAIL)
    for (const id of ids) {
      const node = await this.call('node.get', { id }, context, identity)
      if (!node.ok) return node
      const source = node.result?.node ?? {}
      for (const value of Object.values(source.bindings ?? {})) if (typeof value === 'string') usedVariables.add(value)
      for (const value of Object.values(source.styleRefs ?? {})) if (typeof value === 'string') usedStyles.add(value)
    }
    const variableList = asList(variables.result)
    const styleList = asList(styles.result)
    const byId = new Map(variableList.map(variable => [variable.id, variable]))
    for (const id of usedVariables) {
      for (const value of Object.values(byId.get(id)?.values ?? {})) {
        if (isRecord(value) && typeof value.alias === 'string') usedVariables.add(value.alias)
      }
    }
    const scoped = ids.length
      ? { scope: 'selection', variables: variableList.filter(entry => usedVariables.has(entry.id)), styles: styleList.filter(entry => usedStyles.has(entry.id)), truncated: ids.length < target.ids.length }
      : { scope: 'document', variables: variableList.slice(0, 50), styles: styleList.slice(0, 50), truncated: variableList.length > 50 || styleList.length > 50 }
    return done('get_variable_defs', identityOf(styles), {
      ...scoped,
      nodeIds: ids.slice(0, SELECTION_DETAIL),
      fileKeyIgnored: args.fileKey !== undefined,
      librarySupport: false,
      libraries: {
        status: 'unsupported', code: 'unsupported_remote_capability',
        message: 'Team libraries and published design systems are not available in this local document session. variables and styles contain local document definitions only; no empty library catalog is invented.',
        docs: 'docs/FIGMA_MCP_FACADE.md',
      },
      note: 'Local document variables and styles only. nodeId is optional; without it the document catalog is bounded instead of claiming the selection has no tokens.',
    })
  }

  async download(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'nodeIds', 'defaultFormat', 'defaultScale', 'rawImagesOnly', 'cursor']))
    if (invalid) return failure('download_assets', 'invalid_params', invalid)
    const nodeId = this.nodeId(args)
    if (isRecord(nodeId)) return failure('download_assets', 'invalid_params', nodeId.error)
    if (args.nodeIds !== undefined && (!Array.isArray(args.nodeIds) ||
        args.nodeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)))
      return failure('download_assets', 'invalid_params', 'nodeIds must be an array of nonempty ids of at most 128 characters')
    const ids = [...(nodeId ? [nodeId] : []), ...(args.nodeIds ?? [])]
    if (ids.length > FIGMA_ASSET_LIMIT) return failure('download_assets', 'too_many_nodes', `Use at most ${FIGMA_ASSET_LIMIT} node ids`)
    const unique = [...new Set(ids)]
    if (!unique.length) return failure('download_assets', 'invalid_params', 'download_assets requires nodeId or nodeIds')
    if (args.rawImagesOnly !== undefined && typeof args.rawImagesOnly !== 'boolean')
      return failure('download_assets', 'invalid_params', 'rawImagesOnly must be a boolean')
    if (args.rawImagesOnly) {
      if (args.defaultFormat !== undefined || args.defaultScale !== undefined)
        return failure('download_assets', 'invalid_params', 'Omit format and scale when requesting original images')
      const fences = await this.fences(context)
      if (!fences.ok) return fences
      const captured = await this.call('raster.sourceAssets', { nodeIds: unique }, context, fences)
      if (!captured.ok) return captured
      return { ...captured, result: localAssetDelivery(captured.result) }
    }
    const format = args.defaultFormat ?? 'png'
    if (!['png', 'jpeg', 'jpg', 'webp', 'svg', 'pdf'].includes(format)) return failure('download_assets', 'invalid_params', 'defaultFormat must be png, jpeg, webp, svg, or pdf')
    if (args.defaultScale !== undefined && (!Number.isFinite(args.defaultScale) || args.defaultScale < ASSET_MIN_SCALE || args.defaultScale > 4))
      return failure('download_assets', 'invalid_params', `defaultScale must be a number from ${ASSET_MIN_SCALE} to 4`)
    const vector = format === 'svg'
    const kind = format === 'jpg' ? 'jpeg' : format
    const params = { ...(vector ? {} : { format: kind }), ...(args.defaultScale === undefined ? {} : { scale: args.defaultScale }) }
    const method = vector ? 'vector.export' : 'preview.capture'
    if (unique.length === 1) {
      const captured = await this.call(method, { ...params, nodeIds: unique }, context)
      if (!captured.ok) return captured
      if (vector) return { ...captured, result: localAssetDelivery(captured.result) }
      return { ...captured, result: localAssetDelivery({ ...captured.result, rawImages: [], rawImagesUnsupported: !this.methodNames.has('raster.sourceAssets') }) }
    }

    const fences = await this.fences(context)
    if (!fences.ok) return fences
    const mimeType = vector ? 'image/svg+xml' : kind === 'pdf' ? 'application/pdf' : `image/${kind}`
    const prefix = `data:${mimeType};base64,`
    const assets = []
    let bytes = 0
    for (const id of unique) {
      context.signal?.throwIfAborted()
      const captured = await this.call(method, { ...params, nodeIds: [id] }, context, fences)
      if (!captured.ok) return captured
      if (captured.documentId !== fences.documentId || captured.session !== fences.session || captured.revision !== fences.revision)
        return failure('download_assets', 'stale_revision', 'Document changed during export. Start a new batch.', fences)
      const payload = captured.result
      const base64 = vector && typeof payload?.content === 'string'
        ? Buffer.from(payload.content).toString('base64')
        : typeof payload?.dataUrl === 'string' && payload.dataUrl.startsWith(prefix) ? payload.dataUrl.slice(prefix.length) : undefined
      if (!base64) return failure('download_assets', 'invalid_backend', 'The export did not return media bytes', fences)
      bytes += base64.length
      if (bytes > ASSET_BATCH_BYTES)
        return failure('download_assets', 'artifact_unavailable', 'The batch exceeds the export byte budget. Use fewer nodes or a smaller scale.', fences)
      assets.push({ nodeId: id, mimeType, base64 })
    }
    return done('download_assets', fences, localAssetDelivery({
      format: 'futureox.design-asset-batch.v1', assets,
      rawImagesUnsupported: !this.methodNames.has('raster.sourceAssets'),
    }))
  }

  async useFigma(args, context) {
    const invalid = unknownArguments(args, new Set(['description', 'operations', 'code', 'mutationId', 'cursor']))
    if (invalid) return failure('use_figma', 'invalid_params', invalid)
    if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 2000) return failure('use_figma', 'invalid_params', 'description is required and must be at most 2000 characters')
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
    // The shared draft evaluates these leaves in order, including creates and
    // reparenting earlier in the same transaction. Never reread the old matrix.
    const operations = args.operations.flatMap(operation => this.compile(operation))
    const applied = await this.call('batch.apply', { operations, ...(args.mutationId ? { mutationId: args.mutationId } : {}) }, context, fences)
    if (!applied.ok) return applied
    return done('use_figma', identityOf(applied), {
      description: args.description, operations: applied.result, revision: applied.revision,
      modelText: `Applied ${args.operations.length} structured operations. Revision ${applied.revision}. Plugin JavaScript was not evaluated.`,
    })
  }

  compile(operation) {
    if (operation.op === 'create') {
      const params = { kind: operation.kind }
      for (const key of ['parentId', 'id', 'index', 'x', 'y', 'width', 'height']) if (operation[key] !== undefined) params[key] = operation[key]
      const patch = patchFrom(operation)
      if (Object.keys(patch).length) params.patch = patch
      return { method: 'node.create', params }
    }
    if (operation.op === 'update') {
      const ids = [operation.nodeId], patch = patchFrom(operation)
      const xy = {}
      if (operation.x !== undefined) xy.x = operation.x
      if (operation.y !== undefined) xy.y = operation.y
      return [
        ...(Object.keys(xy).length ? [{ method: 'node.patch', params: { ids, patch: { transform: xy } } }] : []),
        ...(Object.keys(patch).length ? [{ method: 'node.update', params: { ids, patch } }] : []),
      ]
    }
    if (operation.op === 'delete') return { method: 'node.delete', params: { ids: operation.nodeIds ?? [operation.nodeId] } }
    if (operation.op === 'select') return { method: 'selection.set', params: { ids: operation.nodeIds, ...(operation.pageId === undefined ? {} : { pageId: operation.pageId }) } }
    return { method: 'node.move', params: { ids: operation.nodeIds ?? [operation.nodeId], parentId: operation.parentId, ...(operation.index === undefined ? {} : { index: operation.index }) } }
  }

  pluginHost() {
    const bridge = this.pluginBridge === undefined ? figmaPluginBridge() : this.pluginBridge
    return typeof bridge?.run === 'function' ? bridge : null
  }

  async pluginCode(args, context) {
    if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > 50000) return failure('use_figma', 'invalid_params', 'code must be plugin source of at most 50000 characters')
    const bridge = this.pluginHost()
    if (!bridge) {
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
