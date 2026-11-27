import { createHash } from 'node:crypto'
import { isRecord } from './framing.mjs'
import { FIGMA_DESKTOP_TOOL_SPECS, FIGMA_DESKTOP_WRITE_TOOLS, callFigmaDesktopTool, isFigmaCloudNodeId, isFigmaDesktopTool } from './figma-desktop-tools.mjs'

/** Explicit compatibility surface for AI clients that already speak Figma MCP.
 * These names are not added to the shared Design API registry. Every call is
 * translated into that API. This module does not store a document, eval plugin
 * code, or claim Figma account, library, or pixel parity. */
export const FIGMA_MCP_INSTRUCTIONS = 'Futureox Design Figma-shaped MCP facade for the document whose desktop automation bridge is enabled. Tools call the existing Design API; this server applies document/session/revision fences itself. get_metadata, get_design_context, get_screenshot, get_variable_defs, download_assets and the desktop reads get_motion_context/Code Connect/FigJam/shader names read. use_figma writes structured create/update/delete/move/select operations as one undo step. Plugin JavaScript in use_figma code is forwarded only when the host registered a plugin bridge; otherwise the tool returns unsupported_remote_capability and does not eval. get_selection and open_document are Futureox extension tools listed only when extensions are enabled. Code Connect, FigJam, and shader tools are visible but return unsupported_remote_capability because no local store exists. open_document is a local workspace open, not a Figma cloud file. fileKey is ignored. A UUID-shaped Figma cloud sessionId is ignored; another active local transport session is rejected. Screenshots are CPU exports of design content, not GPU or window captures. Cancellation cannot undo a committed edit.'
export const FIGMA_ASSET_LIMIT = 20
const ASSET_BATCH_BYTES = 32 * 1024 * 1024
const ASSET_MIN_SCALE = 0.01

export const FIGMA_MCP_GAPS = Object.freeze([
  { id: 'whoami', tool: 'whoami', status: 'absent', detail: 'No Figma account, plan, seat, or identity.' },
  { id: 'create_new_file', tool: 'create_new_file', status: 'absent', detail: 'No cloud file creation. open_document (extensions only) opens a saved local design when workspace.open is granted.' },
  { id: 'generate_figma_design', tool: 'generate_figma_design', status: 'absent', detail: 'No live-site capture into design layers.' },
  { id: 'generate_diagram', tool: 'generate_diagram', status: 'absent', detail: 'No FigJam or Mermaid diagram generator.' },
  { id: 'generate_image', tool: 'generate_image', status: 'absent', detail: 'No image generation or AI-credit placement.' },
  { id: 'html_to_figma', tool: 'html_to_figma', status: 'absent', detail: 'HTML import is not a Design API operation.' },
  { id: 'upload_assets', tool: 'upload_assets', status: 'absent', detail: 'No multi-file image/SVG upload tool. svg.import remains on the design_* catalog.' },
  { id: 'send_code_to_figma', tool: 'send_code_to_figma', status: 'absent', detail: 'No Figma Make or code-layer import.' },
  { id: 'libraries_and_code_connect', tool: 'get_libraries, search_design_system, get_code_connect_map, get_code_connect_suggestions, add_code_connect_map, send_code_connect_mappings', status: 'partial', detail: 'No team libraries or Code Connect store. Library tools are absent. Code Connect tools are advertised and return unsupported_remote_capability without inventing mappings.' },
  { id: 'figjam_motion_shaders', tool: 'get_figjam, get_motion_context, get_shader, list_shaders', status: 'partial', detail: 'get_motion_context reads authored local animation clips, keyframes, and a derived CSS snippet. get_figjam and shader tools are advertised but return unsupported_remote_capability: there is no FigJam model, shader library, or generative-plugin library.' },
  { id: 'use_figma_plugin_javascript', tool: 'use_figma', status: 'partial', detail: 'Structured operations map to Design API batches. code is forwarded only through a host-registered plugin bridge. Without that bridge the call returns unsupported_remote_capability and is not evaluated.' },
  { id: 'download_assets_urls_pdf_raw', tool: 'download_assets', status: 'partial', detail: 'PNG, JPEG, WebP, SVG or bitmap PDF for up to 20 local nodes uses MCP resources. rawImagesOnly reads the original embedded image fills. Temporary Figma URLs and external image sources are unavailable; delivery is MCP resources.' },
  { id: 'design_context_not_react', tool: 'get_design_context', status: 'partial', detail: 'Returns Design API context and, when advertised, HTML/CSS from code.export. Not Figma React + Tailwind; Code Connect and inline screenshots are unavailable.' },
  { id: 'screenshot_is_cpu_export', tool: 'get_screenshot', status: 'partial', detail: 'preview.capture CPU raster of design content. Not an application window or GPU canvas screenshot.' },
  { id: 'file_key_ignored', tool: 'fileKey', status: 'partial', detail: 'The server is bound to the enabled local document. A Figma URL or file key does not select a different file. Figma cloud node ids return unsupported_figma_node_id.' },
  { id: 'futureox_extension_tools', tool: 'get_selection, open_document', status: 'partial', detail: 'Futureox extensions, not Figma tool names. Hidden by default so the catalog stays Figma-shaped; enable FUTUREOX_FIGMA_EXTENSIONS=1 or --extensions to advertise them.' },
  { id: 'no_remote_account', tool: 'remote MCP', status: 'absent', detail: 'Loopback HTTP and stdio only. No mcp.figma.com, OAuth, or multi-user account.' },
])

const KINDS = new Set(['slice', 'frame', 'section', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector', 'text'])
const IGNORED = new Set(['fileKey', 'clientFrameworks', 'clientLanguages', 'skillNames', 'dir'])
const LOOSE = { description: 'Accepted and ignored. This server is bound to the enabled local document.' }
const NODE_LIMIT = 100
const METADATA_CURSOR_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{2,171})$/
const SELECTION_DETAIL = 20
const CLOUD_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let registeredBridge = null

/** Host-only registration. The facade never evaluates plugin source. */
export function registerFigmaPluginBridge(bridge) {
  if (bridge !== null && (typeof bridge !== 'object' || typeof bridge.run !== 'function')) throw new TypeError('Plugin bridge requires run()')
  registeredBridge = bridge
}
export function figmaPluginBridge() { return registeredBridge }

const tool = (name, description, properties, required = [], mutates = name === 'use_figma' || name === 'open_document') => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties,
    sessionId: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional Figma client session id. A matching Futureox transport session is asserted; a UUID-shaped Figma cloud session is ignored; another active local transport session is rejected.' },
    fileKey: { type: 'string', ...LOOSE }, clientFrameworks: LOOSE, clientLanguages: LOOSE, skillNames: LOOSE }, required },
  annotations: { readOnlyHint: !mutates, destructiveHint: mutates, idempotentHint: !mutates, openWorldHint: false },
})

export const FIGMA_MCP_TOOLS = Object.freeze([
  tool('get_metadata', 'Lightweight XML outline of the open Futureox document. Omit nodeId for pages. A page id outlines that page; any other local id outlines that subtree in pages of up to 100 nodes. A Figma cloud node id returns the page list like an unknown id. fileKey is ignored.', {
    nodeId: { type: 'string', minLength: 1, maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: NODE_LIMIT, description: 'Nodes per outline page. Defaults to 100.' },
    cursor: { type: 'string', minLength: 46, maxLength: 215, description: 'nextCursor from the same nodeId, editor session, and revision.' },
  }),
  tool('get_selection', 'Futureox extension tool. Read the active page and current selection. Up to 20 nodes include id, name, kind, size, and world bounds. Enable FUTUREOX_FIGMA_EXTENSIONS=1 or --extensions to advertise it; Figma clients get the selection through get_design_context, get_screenshot and get_variable_defs.', {}),
  tool('get_design_context', 'Bounded design context for nodeId or the current selection, from context.get. When code.export is available, HTML/CSS is attached as resources. Output is Futureox HTML/CSS, not Figma React and Tailwind. clientFrameworks and disableCodeConnect are ignored; forceCode is the local default when code.export exists; excludeScreenshot is accepted because screenshots stay in get_screenshot.', {
    nodeId: { type: 'string', minLength: 1, maxLength: 128 },
    disableCodeConnect: { type: 'boolean', description: 'Accepted and ignored. This facade has no Code Connect mappings.' },
    excludeScreenshot: { type: 'boolean', description: 'Accepted. Design context never embeds a screenshot; call get_screenshot for pixels.' },
    forceCode: { type: 'boolean', description: 'Accepted. HTML/CSS is included whenever code.export is available.' },
  }),
  tool('get_screenshot', 'CPU PNG of the local node, selection or active page. maxDimension fits the rendered size. Set contentsOnly to false to include background and other page layers inside the crop. Set enableBase64Response to false for a resource link without inline image content. Pixels are delivered as MCP image content or resources, not Figma temporary URLs.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, scale: { type: 'number', minimum: 0.1, maximum: 4 }, maxDimension: { type: 'integer', minimum: 1, maximum: 65536 }, contentsOnly: { type: 'boolean' }, enableBase64Response: { type: 'boolean' } }),
  tool('get_variable_defs', 'Local variable definitions and their alias dependencies, plus shared styles referenced by nodeId or the first 20 selected nodes. An empty selection returns a bounded document catalog. There are no team libraries: libraries is always empty.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 } }),
  tool('download_assets', 'Export up to 20 local nodes as individual MCP resources in png, jpeg, webp, svg, or bitmap pdf. Set rawImagesOnly to read up to 20 original embedded image fills in the selected subtrees instead. Delivery is MCP resources, not temporary Figma URLs.', { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, nodeIds: { type: 'array', minItems: 1, maxItems: FIGMA_ASSET_LIMIT, items: { type: 'string', minLength: 1, maxLength: 128 } }, defaultFormat: { type: 'string', enum: ['png', 'jpeg', 'jpg', 'webp', 'svg', 'pdf'] }, defaultScale: { type: 'number', minimum: ASSET_MIN_SCALE, maximum: 4 }, rawImagesOnly: { type: 'boolean' } }),
  tool('use_figma', 'Write the open document. Preferred input is operations (at most 40), applied as one Design API batch and one undo step: create {kind,parentId?,x?,y?,width?,height?,name?,text?,fontSize?,fill?}, update {nodeId,name?,x?,y?,width?,height?,text?,fill?,transform?}, delete {nodeId|nodeIds}, select {nodeIds}, move {nodeId,parentId,index?}. fill is #RRGGBB. Coordinates are parent-local document units. code is Figma plugin JavaScript and runs only when a plugin bridge is registered; otherwise the result is unsupported_remote_capability and the source is not evaluated. description is required.', { description: { type: 'string', minLength: 1, maxLength: 2000 }, operations: { type: 'array', maxItems: 40 }, code: { type: 'string', maxLength: 50000 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['description']),
  tool('open_document', 'Futureox extension tool. Open a saved local design through workspace.open. Requires rootHandle, documentHandle, and mutationId from a workspace grant. This is not Figma create_new_file. Enable FUTUREOX_FIGMA_EXTENSIONS=1 or --extensions to advertise it. A successful open can end this automation session.', { rootHandle: { type: 'string', minLength: 1, maxLength: 512 }, documentHandle: { type: 'string', minLength: 1, maxLength: 512 }, mutationId: { type: 'string', minLength: 1, maxLength: 128 } }, ['rootHandle', 'documentHandle', 'mutationId']),
  ...FIGMA_DESKTOP_TOOL_SPECS.map(spec => tool(spec.name, spec.description, spec.properties, spec.required, spec.mutates)),
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
  constructor({ execute, methods, scope = 'write', pluginBridge = undefined, target, terminalSignal, localSessionId, extensions = false } = {}) {
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
    this.extensions = extensions === true
  }

  listTools() {
    const canWrite = this.scope === 'write' && this.methodNames.has('document.get')
    const canUseFigma = canWrite && (this.methodNames.has('batch.apply') || this.pluginHost() !== null)
    const canOpenDocument = canWrite && this.methodNames.has('workspace.open')
    return FIGMA_MCP_TOOLS.filter(entry => {
      if (entry.name === 'get_selection') return this.extensions
      if (entry.name === 'open_document') return this.extensions && canOpenDocument
      if (FIGMA_DESKTOP_WRITE_TOOLS.has(entry.name)) return canWrite
      if (isFigmaDesktopTool(entry.name)) return true
      return entry.annotations.readOnlyHint || (canUseFigma && entry.name === 'use_figma')
    }).map(entry => ({ ...entry }))
  }

  async callTool(name, args, context = {}) {
    let toolArgs = args ?? {}
    try {
      if (isRecord(toolArgs) && Object.hasOwn(toolArgs, 'sessionId')) {
        const { sessionId, ...parameters } = toolArgs
        if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 256)
          return failure(name, 'invalid_params', 'sessionId must be a nonempty string of at most 256 characters')
        const boundSession = context.localSessionId ?? this.localSessionId
        // A future call may ask the transport which session ids this grant owns.
        // A Figma cloud/plugin session is not one of them and cannot select a
        // Futureox document, so its UUID is ignored like fileKey.
        const known = typeof context.localSessionIds === 'function' ? context.localSessionIds() : undefined
        const isActiveLocal = known instanceof Set ? known.has(sessionId) : Array.isArray(known) && known.includes(sessionId)
        if (sessionId !== boundSession && (isActiveLocal || !CLOUD_SESSION_PATTERN.test(sessionId)))
          return failure(name, 'invalid_local_session', 'Use the active Futureox transport session ID for this connection, or omit sessionId.')
        toolArgs = parameters
      }
      if ((name === 'get_selection' || name === 'open_document') && !this.extensions)
        return failure(name, 'unknown_tool', `${name} is a Futureox extension tool, not a Figma tool name. Enable FUTUREOX_FIGMA_EXTENSIONS=1 or --extensions to advertise it.`)
      if (isFigmaDesktopTool(name)) return await callFigmaDesktopTool(this, name, toolArgs, context)
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
    const invalid = unknownArguments(args, new Set(['nodeId', 'limit', 'cursor']), { pagination: true })
    if (invalid) return failure('get_metadata', 'invalid_params', invalid)
    const nodeId = this.nodeId(args)
    if (isRecord(nodeId)) return failure('get_metadata', 'invalid_params', nodeId.error)
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
    if (!page && isFigmaCloudNodeId(nodeId)) {
      const xml = metadataXml(pages.documentId, pageList.map(entry => ({ id: entry.id, name: entry.name, kind: 'page' })))
      return done('get_metadata', identityOf(pages), {
        format: 'futureox.figma-metadata.v1', scope: 'pages', nodeId, nodeIdIgnored: true, xml, pages: pageList,
        fileKeyIgnored: args.fileKey !== undefined, note: 'A Figma cloud node id cannot address this local document; the page list is returned like an unknown id.',
        modelText: xml,
      })
    }
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
      return { ...found, method: 'get_metadata', error: { ...found.error, details: { pages: pageList } } }
    }
    if (!found.ok) return found
    const nodes = Array.isArray(found.result?.nodes) ? found.result.nodes : []
    const xml = metadataXml(nodeId, nodes)
    const nextCursor = found.result?.nextCursor ? `${binding}.${Buffer.from(found.result.nextCursor).toString('base64url')}` : null
    return done('get_metadata', identityOf(found), { format: 'futureox.figma-metadata.v1', scope, nodeId, xml, nodes, truncated: nextCursor !== null, nextCursor, total: found.result?.total, fileKeyIgnored: args.fileKey !== undefined, modelText: xml })
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
    if (nodeId && isFigmaCloudNodeId(nodeId)) return failure(toolName, 'unsupported_figma_node_id', 'Figma cloud node ids do not identify Futureox nodes. Use an id returned by get_metadata for this document, or omit nodeId to use the current selection.')
    if (nodeId) return { ok: true, ids: [nodeId] }
    const selected = await this.call('selection.get', {}, context)
    if (!selected.ok) return selected
    return { ok: true, ids: Array.isArray(selected.result?.ids) ? selected.result.ids : [], identity: identityOf(selected), pageId: selected.result?.pageId }
  }

  async designContext(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'disableCodeConnect', 'excludeScreenshot', 'forceCode', 'cursor']))
    if (invalid) return failure('get_design_context', 'invalid_params', invalid)
    for (const key of ['disableCodeConnect', 'excludeScreenshot', 'forceCode'])
      if (args[key] !== undefined && typeof args[key] !== 'boolean') return failure('get_design_context', 'invalid_params', `${key} must be a boolean`)
    const target = await this.resolveNodes(args, context, 'get_design_context')
    if (!target.ok) return target
    const roots = target.ids?.length ? { nodeIds: target.ids.slice(0, 40) } : {}
    const contextResult = await this.call('context.get', { ...roots, limit: 40 }, context)
    if (!contextResult.ok) return contextResult
    const nodes = Array.isArray(contextResult.result?.nodes) ? contextResult.result.nodes.slice(0, 40).map(entry => ({
      id: entry.id ?? entry.node?.id, name: entry.name ?? entry.node?.name, kind: entry.kind ?? entry.node?.kind,
    })) : []
    const outline = metadataXml('context', nodes.filter(node => node.id))
    const result = {
      format: 'futureox.design-context.v1', fidelity: 'futureox-html-css', framework: 'futureox-html-css',
      react: false, tailwind: false, codeConnect: false, screenshot: false,
      disableCodeConnect: args.disableCodeConnect === true, excludeScreenshot: args.excludeScreenshot === true, forceCode: args.forceCode === true,
      note: 'This is Futureox context and HTML/CSS when code.export is available. It is not Figma React + Tailwind, and it never embeds a Code Connect mapping or screenshot. clientFrameworks and disableCodeConnect are ignored; screenshots come from get_screenshot.',
      nodes, outline, warnings: contextResult.result?.warnings, pagination: contextResult.result?.pagination,
      modelText: `${outline}\nFutureox design context. HTML/CSS is included only when code.export is available in this session. This is not Figma React + Tailwind.`,
    }
    if (this.methodNames.has('code.export')) {
      const code = await this.call('code.export', { ...roots, ...(contextResult.result?.page?.id ? { pageId: contextResult.result.page.id } : {}), maxNodes: 40 }, context, identityOf(contextResult))
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
    const invalid = unknownArguments(args, new Set(['nodeId', 'scale', 'maxDimension', 'contentsOnly', 'enableBase64Response', 'cursor']))
    if (invalid) return failure('get_screenshot', 'invalid_params', invalid)
    if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale < 0.1 || args.scale > 4)) return failure('get_screenshot', 'invalid_params', 'scale must be a number from 0.1 to 4')
    const { maxDimension, contentsOnly, enableBase64Response, scale } = args
    if (maxDimension !== undefined && (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > 65536))
      return failure('get_screenshot', 'invalid_params', 'maxDimension must be an integer from 1 to 65536')
    if ([contentsOnly, enableBase64Response].some(value => value !== undefined && typeof value !== 'boolean'))
      return failure('get_screenshot', 'invalid_params', 'contentsOnly and enableBase64Response must be booleans')
    const target = await this.resolveNodes(args, context, 'get_screenshot')
    if (!target.ok) return target
    const params = { format: 'png', ...(scale === undefined ? {} : { scale }),
      ...(maxDimension === undefined ? {} : { maxDimension }),
      ...(contentsOnly === undefined ? {} : { contentsOnly }),
      ...(target.pageId ? { pageId: target.pageId } : {}),
      ...(target.ids?.length ? { nodeIds: target.ids.slice(0, 256) } : {}),
    }
    const captured = await this.call('preview.capture', params, context, target.identity)
    if (!captured.ok) return captured
    const result = { ...captured.result, delivery: 'mcp-image-or-resource', temporaryUrl: false, url: null }
    if (enableBase64Response === false) result.inlineImage = false
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
      ...scoped, libraries: [], librarySupport: false, fileKeyIgnored: args.fileKey !== undefined,
      note: 'Local document variables and styles only. Team libraries and published design systems are not available; libraries is always empty.',
    })
  }

  async download(args, context) {
    const invalid = unknownArguments(args, new Set(['nodeId', 'nodeIds', 'defaultFormat', 'defaultScale', 'rawImagesOnly', 'cursor']))
    if (invalid) return failure('download_assets', 'invalid_params', invalid)
    const nodeId = this.nodeId(args)
    if (isRecord(nodeId)) return failure('download_assets', 'invalid_params', nodeId.error)
    if (nodeId && isFigmaCloudNodeId(nodeId)) return failure('download_assets', 'unsupported_figma_node_id', 'Figma cloud node ids do not identify Futureox nodes. Use ids returned by get_metadata for this document.')
    if (args.nodeIds !== undefined && (!Array.isArray(args.nodeIds) ||
        args.nodeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)))
      return failure('download_assets', 'invalid_params', 'nodeIds must be an array of nonempty ids of at most 128 characters')
    if (Array.isArray(args.nodeIds) && args.nodeIds.some(isFigmaCloudNodeId))
      return failure('download_assets', 'unsupported_figma_node_id', 'Figma cloud node ids do not identify Futureox nodes. Use ids returned by get_metadata for this document.')
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
      const raw = await this.call('raster.sourceAssets', { nodeIds: unique }, context, fences)
      if (!raw.ok) return raw
      return { ...raw, result: { ...raw.result, delivery: 'mcp-resources', temporaryUrls: false } }
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
      if (vector) return { ...captured, result: { ...captured.result, delivery: 'mcp-resources', temporaryUrls: false } }
      return { ...captured, result: { ...captured.result, rawImages: [], rawImagesUnsupported: !this.methodNames.has('raster.sourceAssets'), urls: false, delivery: 'mcp-resources', temporaryUrls: false } }
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
    return done('download_assets', fences, { format: 'futureox.design-asset-batch.v1', assets, rawImagesUnsupported: !this.methodNames.has('raster.sourceAssets'), urls: false, delivery: 'mcp-resources', temporaryUrls: false })
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
      return failure('use_figma', 'unsupported_remote_capability', 'Figma Plugin API JavaScript needs the remote Figma server or a registered host plugin bridge. No plugin host is registered, so use_figma did not evaluate code and did not modify the document. Send structured operations instead.')
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
