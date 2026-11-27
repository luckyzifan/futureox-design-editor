import { randomUUID } from 'node:crypto'
import { isRecord } from './framing.mjs'

/** Figma remote/catalog tools that the small Figma-shaped facade did not list.
 *
 * Every entry keeps the public Figma tool name and input-schema shape. Tools
 * that map to a real local Design API capability implement honest local
 * semantics (local identity, local reviews, local variables/styles, local
 * workspace file creation, inline SVG/raster import, local component metadata).
 * Tools that need a vendor-hosted service (video rendering, AI generation,
 * HTML capture/conversion, Make code layers, generative-plugin and shader
 * build platforms) stay visible in tools/list and return the documented
 * unsupported_remote_capability error instead of fabricating success.
 *
 * This module never evaluates code, fetches URLs, or stores a second document.
 * All reads and writes go through FigmaFacade -> the enabled local Design API.
 */

export const UNSUPPORTED_REMOTE_CAPABILITY = 'unsupported_remote_capability'
export const UPLOAD_ASSET_LIMIT = 60
export const UPLOAD_ASSET_BYTES = 10 * 1024 * 1024
const COMMENT_SCAN_LIMIT = 2000
const COMMENT_PAGE_LIMIT = 100
const COMMENT_MESSAGE_LIMIT = 50
const COMMENT_REPLY_LIMIT = 20
const COMMENT_TEXT_LIMIT = 2000

const FILE_KEY = {
  type: 'string', minLength: 1, maxLength: 256,
  description: 'Accepted and ignored for document selection. This server is bound to the enabled local document.',
}
const SESSION_ID = {
  type: 'string', minLength: 1, maxLength: 256,
  description: 'Optional Futureox session assertion. Use the current HTTP Mcp-Session-Id or the packaged Figma stdio desktop grant session.',
}
const READ_ONLY = 'This connection is read-only. Enable read and edit access to write.'
const ID = { type: 'string', minLength: 1, maxLength: 128 }
const CURSOR = { type: 'string', minLength: 1, maxLength: 512 }
const VERSION_SHA = { type: 'string', minLength: 40, maxLength: 40, pattern: '^[0-9a-f]{40}$', description: 'A 40-character lowercase commit SHA. Omit for the latest built version.' }

const tool = (name, description, properties, required = [], { readOnly = true, destructive = false, idempotent = readOnly } = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, fileKey: FILE_KEY, sessionId: SESSION_ID }, required },
  annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false },
})

export const REMOTE_FIGMA_TOOLS = Object.freeze([
  tool('whoami', 'Local Futureox application identity for this session: a local handle, the bound document, one local plan key, and the local owner seat. It is not a Figma account: email is null and there are no remote plans, teams, seats, or OAuth grants. planKey local::0 is accepted by create_new_file.', {}),
  tool('create_new_file', 'Create a blank local Futureox design and save it in the granted local workspace through workspace.importCopy. Returns an opaque documentHandle and does not switch the editor; open it with open_document. Only editorType design is supported; figjam, slides, and figmake return unsupported_editor_type. planKey and projectId are accepted for schema compatibility and do not select a remote plan or project.', {
    editorType: { type: 'string', enum: ['design', 'figjam', 'slides', 'figmake'] },
    fileName: { type: 'string', minLength: 1, maxLength: 200 },
    planKey: { type: 'string', minLength: 1, maxLength: 256, description: 'Accepted for schema compatibility. Local identity exposes local::0; no remote plan is selected.' },
    projectId: { type: 'string', minLength: 1, maxLength: 256, description: 'Accepted and ignored. Local storage has no projects or team folders.' },
    rootHandle: { type: 'string', minLength: 1, maxLength: 512, description: 'Local extension: the opaque workspace root from the current desktop grant. Required locally.' },
    mutationId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Local extension: idempotency key for workspace.importCopy. Generated when omitted.' },
  }, ['editorType', 'fileName', 'planKey'], { readOnly: false, destructive: true }),
  tool('get_comments', 'Read local document comments and annotations through review.list. Returns thread-starter comments with replies, canvas positions, and resolved state. Figma feedback, reactions, mentions, unread state, and image attachments do not exist locally; author, mentionedUser, unread, and threadStarterOnly return unsupported_filter instead of being ignored.', {
    pageId: ID,
    nodeId: ID,
    resolved: { type: 'boolean' },
    offset: { type: 'integer', minimum: 0, maximum: 1000000 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    author: { type: 'string', minLength: 1, maxLength: 200 },
    mentionedUser: { type: 'string', minLength: 1, maxLength: 200 },
    unread: { type: 'boolean' },
    threadId: ID,
    threadStarterOnly: { type: 'boolean' },
  }, ['fileKey']),
  tool('get_libraries', 'List the local design-system library for the enabled document: variable collections, variables, and shared paint/text/effect styles. offset paginates the local library list. Team, organization, and Community libraries do not exist locally.', {
    offset: { type: 'integer', minimum: 0, maximum: 1000000 },
  }, ['fileKey']),
  tool('search_design_system', 'Search the local design system for variables and shared styles. queries are answered in order. Local components are not indexed and no Code Connect map exists, so component queries return status unsupported with no fabricated matches. includeLibraryKeys adds libraryKey local-document to matches; disableCodeConnect is accepted and has no effect.', {
    queries: {
      type: 'array', minItems: 1, maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['entity', 'query'],
        properties: {
          entity: { type: 'string', enum: ['component', 'variable', 'style'] },
          query: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
    includeLibraryKeys: { type: 'boolean' },
    disableCodeConnect: { type: 'boolean' },
  }, ['fileKey', 'queries']),
  tool('get_context_for_code_connect', 'Read local component metadata for the given node: name, kind, size, variants, component properties, slots, component-set identity, instance link, and a bounded descendant outline. Code Connect templates and code mappings are not stored locally, so codeConnect.available is false and no template is invented.', {
    nodeId: ID,
  }, ['fileKey', 'nodeId']),
  tool('export_video', 'Export an animated frame as MP4. This local build has no timeline renderer or video encoder, so every start or poll request returns unsupported_remote_capability and creates no job. fps, quality, constraint, and ttlSeconds are validated against the documented ranges before the typed error is returned.', {
    nodeId: ID,
    jobId: { type: 'string', minLength: 1, maxLength: 256 },
    fps: { type: 'integer', minimum: 5, maximum: 60 },
    quality: { type: 'string', enum: ['low', 'medium', 'high'] },
    constraint: {
      type: 'object', additionalProperties: false, required: ['type', 'value'],
      properties: {
        type: { type: 'string', enum: ['SCALE', 'WIDTH', 'HEIGHT'] },
        value: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    ttlSeconds: { type: 'integer', minimum: 30, maximum: 604800 },
  }, ['fileKey']),
  tool('upload_assets', 'Import up to 60 assets of at most 10 MB each into the local document. This local server has no upload-URL endpoint: pass assets inline with dataUrl (PNG, JPEG, GIF, WebP) or SVG content. SVG becomes editable vector layers through svg.import; raster becomes a rectangle with the exact embedded image fill. nodeId or nodeIds select a parent container, not an existing fill. scaleMode and batchCommit are accepted and ignored.', {
    count: { type: 'integer', minimum: 1, maximum: UPLOAD_ASSET_LIMIT },
    currentPageId: ID,
    nodeId: ID,
    nodeIds: { type: 'array', minItems: 1, maxItems: UPLOAD_ASSET_LIMIT, items: ID },
    scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'STRETCH', 'CROP'] },
    batchCommit: { type: 'boolean' },
    assets: {
      type: 'array', minItems: 1, maxItems: UPLOAD_ASSET_LIMIT,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] },
          dataUrl: { type: 'string', minLength: 1, maxLength: 14000000, pattern: '^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$' },
          content: { type: 'string', minLength: 1, maxLength: 10485760 },
        },
      },
    },
  }, ['fileKey'], { readOnly: false }),
  tool('generate_figma_design', 'Capture live web UI into design layers. This local build has no browser capture service or remote layer conversion, so the tool returns unsupported_remote_capability and creates nothing. fileKey, captureId, and nodeId are schema-compatible only.', {
    captureId: { type: 'string', minLength: 1, maxLength: 256 },
    nodeId: ID,
  }, ['fileKey'], { readOnly: false }),
  tool('generate_diagram', 'Generate a FigJam diagram from Mermaid syntax. This local editor has no FigJam document type or diagram layout service, so the tool returns unsupported_remote_capability and creates no file or board.', {
    mermaidSyntax: { type: 'string', minLength: 1, maxLength: 100000 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    planKey: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['mermaidSyntax', 'name'], { readOnly: false }),
  tool('generate_image', 'Generate an image and place it. This local build has no image model or AI-credit service, so the tool returns unsupported_remote_capability and places nothing. Import an existing image with upload_assets instead.', {
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    width: { type: 'integer', minimum: 16, maximum: 8192 },
    height: { type: 'integer', minimum: 16, maximum: 8192 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    nodeId: ID,
    planKey: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['prompt'], { readOnly: false }),
  tool('generate_vector_illustration', 'Generate editable vector graphics and place them. This local build has no vector generation model or AI-credit service, so the tool returns unsupported_remote_capability and places nothing. Import an existing SVG with upload_assets instead.', {
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    kind: { type: 'string', enum: ['icon', 'illustration'] },
    width: { type: 'integer', minimum: 16, maximum: 2048 },
    height: { type: 'integer', minimum: 16, maximum: 2048 },
    currentPageId: ID,
    parentNodeId: ID,
  }, ['fileKey', 'prompt'], { readOnly: false }),
  tool('html_to_figma', 'Convert a self-contained HTML document into design layers. The shared local Design API document.import explicitly does not accept HTML, so the tool returns unsupported_remote_capability and creates no layers. Use svg.import or upload_assets for vector artwork.', {
    html: { type: 'string', minLength: 1, maxLength: 52428800 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    pageId: ID,
    parentId: ID,
    selector: { type: 'string', minLength: 1, maxLength: 512 },
  }, ['fileKey', 'html'], { readOnly: false }),
  tool('send_code_to_figma', 'Import a local project as a Figma Make file or code layer. This local build has no code-layer or project build pipeline, so the tool returns unsupported_remote_capability and imports nothing. workspace.importCopy imports native, Sketch, and FIG documents, not code projects.', {
    pageId: ID,
    repairFrom: { type: 'string', minLength: 1, maxLength: 1024 },
    upload: {
      type: 'object', additionalProperties: false,
      properties: { archivePath: { type: 'string', minLength: 1, maxLength: 1024 } },
    },
  }, ['fileKey'], { readOnly: false }),
  tool('list_generative_plugins', 'List generative plugins in the account library. This local application has no generative-plugin library or account, so the tool returns unsupported_remote_capability instead of a fabricated empty catalog.', {
    cursor: CURSOR,
  }, []),
  tool('get_generative_plugin', 'Read a generative plugin and its source files. No local plugin source store exists, so the tool returns unsupported_remote_capability and no resource URI.', {
    id: ID,
    version: VERSION_SHA,
    includeSource: { type: 'boolean' },
  }, ['id']),
  tool('create_generative_plugin', 'Create a generative plugin starter. This local build has no plugin platform or build service, so the tool returns unsupported_remote_capability and creates no starter. planKey is validated for schema compatibility only.', {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    planKey: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['name', 'description', 'planKey'], { readOnly: false }),
  tool('update_generative_plugin', 'Replace whole generative plugin source files and metadata. No local plugin source store or build service exists, so the tool returns unsupported_remote_capability and writes nothing.', {
    id: ID,
    commitMessage: { type: 'string', minLength: 1, maxLength: 500 },
    files: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: {
          path: { type: 'string', enum: ['code.ts', 'ui.html'] },
          content: { type: 'string', minLength: 1, maxLength: 1000000 },
        },
      },
    },
    metadata: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
  }, ['id', 'commitMessage'], { readOnly: false }),
  tool('list_shaders', 'List shader effects and fills in the account library. This local document model has no shader registry, so the tool returns unsupported_remote_capability instead of a fabricated catalog.', {
    cursor: CURSOR,
  }, []),
  tool('get_shader', 'Read a shader and its source files. No local shader resource store exists, so the tool returns unsupported_remote_capability and no resource URI.', {
    id: ID,
    version: VERSION_SHA,
    includeSource: { type: 'boolean' },
  }, ['id']),
  tool('list_file_shaders', 'List shader effects and fills used in a file. Local documents have no shader fills or effects and no shader registry, so the tool returns unsupported_remote_capability. This is not an empty successful list.', {}, ['fileKey']),
  tool('create_shader', 'Create a shader effect or fill starter. This local build has no shader platform or build service, so the tool returns unsupported_remote_capability and creates no starter. planKey is validated for schema compatibility only.', {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    planKey: { type: 'string', minLength: 1, maxLength: 256 },
    kind: { type: 'string', enum: ['effect', 'fill'] },
  }, ['name', 'description', 'planKey', 'kind'], { readOnly: false }),
  tool('update_shader', 'Replace the whole main.ts shader source and metadata. No local shader source store or build service exists, so the tool returns unsupported_remote_capability and writes nothing.', {
    id: ID,
    kind: { type: 'string', enum: ['effect', 'fill'] },
    commitMessage: { type: 'string', minLength: 1, maxLength: 500 },
    files: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: {
          path: { type: 'string', enum: ['main.ts'] },
          content: { type: 'string', minLength: 1, maxLength: 1000000 },
        },
      },
    },
    metadata: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
        isAnimated: { type: 'boolean' },
        usesMouse: { type: 'boolean' },
      },
    },
  }, ['id', 'kind', 'commitMessage'], { readOnly: false }),
])

const TOOLS_BY_NAME = new Map(REMOTE_FIGMA_TOOLS.map(entry => [entry.name, entry]))
export const REMOTE_FIGMA_TOOL_NAMES = new Set(TOOLS_BY_NAME.keys())

/** Additive gap rows for docs/FIGMA_MCP_FACADE.md consumers. Remote-only
 * capabilities are listed instead of silently absent. */
export const REMOTE_FIGMA_GAPS = Object.freeze([
  { id: 'export_video', tool: 'export_video', status: 'unsupported', detail: 'Listed with the documented fps, quality, constraint, and ttlSeconds schema. Returns unsupported_remote_capability; no MP4 renderer or job queue exists locally.' },
  { id: 'get_comments', tool: 'get_comments', status: 'local', detail: 'Reads local document reviews through review.list, including replies, positions, and resolved state. No Figma reactions, mentions, unread state, or image attachments.' },
  { id: 'get_context_for_code_connect', tool: 'get_context_for_code_connect', status: 'local', detail: 'Returns local component variants, properties, slots, and a bounded descendant outline. Code Connect templates and mappings are not stored.' },
  { id: 'search_design_system', tool: 'search_design_system', status: 'local', detail: 'Searches local variables and shared styles in query order. Component queries report status unsupported because no local component index or Code Connect map exists.' },
  { id: 'generate_vector_illustration', tool: 'generate_vector_illustration', status: 'unsupported', detail: 'Listed. Returns unsupported_remote_capability; no vector generation model or AI credits exist locally. Import SVG with upload_assets instead.' },
  { id: 'generative_plugins', tool: 'list_generative_plugins, get_generative_plugin, create_generative_plugin, update_generative_plugin', status: 'unsupported', detail: 'All four are listed. Every call returns unsupported_remote_capability; no account plugin library, source store, or build service exists locally.' },
  { id: 'shaders', tool: 'list_shaders, get_shader, list_file_shaders, create_shader, update_shader', status: 'unsupported', detail: 'All five are listed. Every call returns unsupported_remote_capability; the local document model has no shader fills, effects, source store, or build service.' },
])

function scalarProblems(value, schema, label) {
  if (schema.enum !== undefined && !schema.enum.includes(value)) return `${label} must be one of ${schema.enum.join(', ')}`
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${label} must be a string`
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${label} must be at least ${schema.minLength} characters`
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${label} must be at most ${schema.maxLength} characters`
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${label} has an invalid format`
    return null
  }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) return `${label} must be an integer`
    if (schema.minimum !== undefined && value < schema.minimum) return `${label} must be at least ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${label} must be at most ${schema.maximum}`
    return null
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a finite number`
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${label} must be greater than ${schema.exclusiveMinimum}`
    if (schema.minimum !== undefined && value < schema.minimum) return `${label} must be at least ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${label} must be at most ${schema.maximum}`
    return null
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${label} must be a boolean`
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${label} must be an array`
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${label} must contain at least ${schema.minItems} items`
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${label} must contain at most ${schema.maxItems} items`
    for (let index = 0; index < value.length; index++) {
      const problem = schema.items === undefined ? null : valueProblems(value[index], schema.items, `${label}[${index}]`)
      if (problem) return problem
    }
    return null
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) return `${label} must be an object`
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter(key => !Object.hasOwn(properties, key))
      if (extra.length) return `${label} does not accept ${extra.join(', ')}`
    }
    for (const key of schema.required ?? []) if (value[key] === undefined) return `${label}.${key} is required`
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined) continue
      const problem = valueProblems(value[key], child, `${label}.${key}`)
      if (problem) return problem
    }
    return null
  }
  return null
}

function valueProblems(value, schema, label) {
  return isRecord(schema) ? scalarProblems(value, schema, label) : null
}

/** Validate one tool call against the same schema advertised in tools/list.
 * The MCP server forwards arguments without schema enforcement, so this is the
 * authoritative input check for this module. */
export function remoteToolArgumentsProblem(name, args) {
  const definition = TOOLS_BY_NAME.get(name)
  if (!definition) return 'Unknown tool'
  if (!isRecord(args)) return 'Tool arguments must be an object'
  const properties = definition.inputSchema.properties
  const extra = Object.keys(args).filter(key => !Object.hasOwn(properties, key))
  if (extra.length) return `Unknown arguments: ${extra.join(', ')}`
  for (const key of definition.inputSchema.required) if (args[key] === undefined) return `${key} is required`
  for (const [key, schema] of Object.entries(properties)) {
    if (args[key] === undefined) continue
    const problem = valueProblems(args[key], schema, key)
    if (problem) return problem
  }
  return null
}

const imageDataUrl = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/

function rasterInfo(dataUrl) {
  const match = imageDataUrl.exec(dataUrl)
  if (!match) return null
  const mime = `image/${match[1]}`
  const bytes = Buffer.from(match[2], 'base64')
  if (mime === 'image/png' && bytes.length >= 24) return { mime, bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mime === 'image/gif' && bytes.length >= 10) return { mime, bytes, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { mime, bytes, width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (kind === 'VP8 ' && bytes.length >= 30) return { mime, bytes, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21)
      return { mime, bytes, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue }
      const marker = bytes[at + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      const length = bytes.readUInt16BE(at + 2)
      if (length < 2) break
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { mime, bytes, width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
      at += 2 + length
    }
  }
  return { mime, bytes, width: null, height: null }
}

function blankDocument(fileName) {
  return {
    schemaVersion: 2,
    rasterProfile: 'analytic',
    id: randomUUID(),
    name: fileName,
    pages: [{ id: randomUUID(), name: 'Page 1', children: [], background: '#f5f5f5' }],
    nodes: {},
  }
}

async function whoami(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('whoami', args)
  if (problem) return failure('whoami', 'invalid_params', problem)
  let identity = { documentId: '', session: 0, revision: 0 }
  let document = null
  if (facade.methodNames.has('document.get')) {
    const read = await facade.call('document.get', {}, context)
    if (!read.ok) return read
    identity = identityOf(read)
    document = { documentId: read.documentId, name: typeof read.result?.name === 'string' ? read.result.name : null }
  }
  return done('whoami', identity, {
    format: 'futureox.local-identity.v1',
    account: { kind: 'local-application', authenticated: true, remote: false },
    handle: 'futureox-local',
    email: null,
    plans: [{ key: 'local::0', name: 'Futureox Design local workspace', role: 'owner', seat: 'owner' }],
    seat: 'owner',
    document,
    note: 'This is the local Futureox application identity, not a Figma account. email is null and there are no remote plans, teams, seats, OAuth grants, or AI credits.',
  })
}

async function createNewFile(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('create_new_file', args)
  if (problem) return failure('create_new_file', 'invalid_params', problem)
  if (facade.scope !== 'write') return failure('create_new_file', 'read_only', READ_ONLY)
  if (args.editorType !== 'design')
    return failure('create_new_file', 'unsupported_editor_type', `This local editor only creates Design documents. ${args.editorType} files need a Figma FigJam, Slides, or Make workspace; nothing was created.`)
  if (!facade.methodNames.has('workspace.importCopy'))
    return failure('create_new_file', 'create_file_unavailable', 'workspace.importCopy is not available in this session. Enable the desktop workspace write grant to save a new local design. No Figma cloud file was created.')
  if (typeof args.rootHandle !== 'string' || !args.rootHandle.trim() || args.rootHandle.length > 512)
    return failure('create_new_file', 'workspace_grant_required', 'Pass rootHandle from the current desktop workspace grant. This local tool saves into that local workspace and has no cloud drafts folder.')
  const mutationId = args.mutationId ?? randomUUID()
  const fences = await facade.fences(context)
  if (!fences.ok) return fences
  const draft = blankDocument(args.fileName)
  const created = await facade.call('workspace.importCopy', {
    rootHandle: args.rootHandle,
    format: 'native-json',
    content: JSON.stringify(draft),
    mutationId,
  }, context, fences)
  if (!created.ok) return created
  return done('create_new_file', identityOf(created), {
    format: 'futureox.local-file.v1',
    editorType: 'design',
    fileName: args.fileName,
    opened: false,
    planKeyIgnored: args.planKey !== undefined,
    projectIdIgnored: args.projectId !== undefined,
    ...created.result,
    note: 'Saved a blank local design. It is not active; call open_document with the same rootHandle and the returned documentHandle to switch. No Figma cloud file or URL was created.',
  })
}

function commentText(value) {
  const text = String(value ?? '')
  return text.length > COMMENT_TEXT_LIMIT
    ? { message: text.slice(0, COMMENT_TEXT_LIMIT), messageTruncated: true }
    : { message: text, messageTruncated: false }
}

function commentThread(review) {
  const messages = Array.isArray(review.messages) ? review.messages : []
  const shown = messages.slice(0, COMMENT_MESSAGE_LIMIT)
  const first = shown[0] ?? {}
  const replies = shown.slice(1, COMMENT_REPLY_LIMIT + 1).map(message => ({
    id: message.id, parentId: review.id, author: message.author, createdAt: message.createdAt, ...commentText(message.text),
  }))
  return {
    id: review.id,
    threadId: review.id,
    parentId: null,
    kind: review.kind,
    resolved: review.resolved,
    pageId: review.pageId,
    nodeId: review.nodeId ?? null,
    position: review.position,
    author: first.author ?? null,
    createdAt: first.createdAt ?? null,
    ...commentText(first.text),
    totalMessages: messages.length,
    replies,
    repliesTruncated: messages.length - 1 > replies.length,
    messagesTruncated: messages.length > shown.length,
  }
}

async function getComments(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('get_comments', args)
  if (problem) return failure('get_comments', 'invalid_params', problem)
  for (const key of ['author', 'mentionedUser', 'unread', 'threadStarterOnly'])
    if (args[key] !== undefined) return failure('get_comments', 'unsupported_filter', `${key} has no local equivalent. Local reviews store a fixed author label, no mentions, no read/unread state, and no separate thread-starter records. Filter by pageId, nodeId, resolved, or threadId instead.`)
  if (!facade.methodNames.has('review.list'))
    return failure('get_comments', 'comments_unavailable', 'review.list is not available in this Design API session. This local document has no readable comment model in the current grant.')
  const offset = args.offset ?? 0
  const limit = args.limit ?? 50
  const scan = args.nodeId !== undefined || args.resolved !== undefined || args.threadId !== undefined
  let identity = null
  let rows = []
  if (scan) {
    let at = 0
    while (at < COMMENT_SCAN_LIMIT) {
      context.signal?.throwIfAborted()
      const listed = await facade.call('review.list', { ...(args.pageId ? { pageId: args.pageId } : {}), offset: at, limit: COMMENT_PAGE_LIMIT }, context, identity ?? undefined)
      if (!listed.ok) return listed
      identity = identity ?? identityOf(listed)
      const items = Array.isArray(listed.result?.items) ? listed.result.items : []
      rows.push(...items)
      if (listed.result?.nextOffset === null || listed.result?.nextOffset === undefined || !items.length) break
      at = listed.result.nextOffset
    }
    rows = rows.filter(review =>
      (args.nodeId === undefined || review.nodeId === args.nodeId) &&
      (args.resolved === undefined || review.resolved === args.resolved) &&
      (args.threadId === undefined || review.id === args.threadId))
    if (rows.length > COMMENT_SCAN_LIMIT) rows = rows.slice(0, COMMENT_SCAN_LIMIT)
  } else {
    const listed = await facade.call('review.list', { ...(args.pageId ? { pageId: args.pageId } : {}), offset, limit }, context)
    if (!listed.ok) return listed
    identity = identityOf(listed)
    rows = Array.isArray(listed.result?.items) ? listed.result.items : []
    const total = Number.isSafeInteger(listed.result?.total) ? listed.result.total : rows.length
    return done('get_comments', identity, {
      format: 'futureox.local-comments.v1',
      comments: rows.map(commentThread),
      total,
      offset,
      limit,
      nextOffset: Number.isSafeInteger(listed.result?.nextOffset) ? listed.result.nextOffset : null,
      resolvedFilterApplied: false,
      note: 'Local document reviews only. No Figma feedback threads, reactions, mentions, unread state, image attachments, or remote publishing.',
    })
  }
  const total = rows.length
  const page = rows.slice(offset, offset + limit)
  return done('get_comments', identity, {
    format: 'futureox.local-comments.v1',
    comments: page.map(commentThread),
    total,
    offset,
    limit,
    nextOffset: offset + limit < total ? offset + limit : null,
    resolvedFilterApplied: args.resolved !== undefined,
    note: 'Local document reviews only. Filters are applied across at most 2000 local reviews. No Figma feedback threads, reactions, mentions, unread state, image attachments, or remote publishing.',
  })
}

async function getLibraries(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('get_libraries', args)
  if (problem) return failure('get_libraries', 'invalid_params', problem)
  const document = await facade.call('document.get', {}, context)
  if (!document.ok) return document
  const identity = identityOf(document)
  const offset = args.offset ?? 0
  const collections = facade.methodNames.has('collection.list')
    ? await facade.call('collection.list', {}, context, identity) : null
  if (collections && !collections.ok) return collections
  const variables = facade.methodNames.has('variable.list')
    ? await facade.call('variable.list', {}, context, identity) : null
  if (variables && !variables.ok) return variables
  const styles = facade.methodNames.has('style.list')
    ? await facade.call('style.list', {}, context, identity) : null
  if (styles && !styles.ok) return styles
  const variableList = Array.isArray(variables?.result) ? variables.result : []
  const styleList = Array.isArray(styles?.result) ? styles.result : []
  const collectionList = Array.isArray(collections?.result) ? collections.result : []
  const library = {
    key: 'local-document',
    name: typeof document.result?.name === 'string' && document.result.name ? document.result.name : 'Local document',
    description: 'Local Futureox variable collections, variables, and shared styles in the enabled document.',
    source: 'local',
    added: true,
    collections: collectionList.map(collection => ({
      id: collection.id, name: collection.name, modes: collection.modes, defaultMode: collection.defaultMode, activeMode: collection.activeMode,
    })),
    variableCount: variableList.length,
    styleCount: styleList.length,
  }
  return done('get_libraries', identity, {
    format: 'futureox.local-libraries.v1',
    libraries: offset === 0 ? [library] : [],
    offset,
    total: 1,
    nextOffset: null,
    note: 'Only the local document library exists. Team, organization, Community, and cross-file libraries are unavailable; variables and styles are the local library assets.',
  })
}

async function searchDesignSystem(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('search_design_system', args)
  if (problem) return failure('search_design_system', 'invalid_params', problem)
  const needsVariables = args.queries.some(entry => entry.entity === 'variable')
  const needsStyles = args.queries.some(entry => entry.entity === 'style')
  if (needsVariables && !facade.methodNames.has('variable.list'))
    return failure('search_design_system', 'method_unavailable', 'variable.list is not available in this Design API session, so variable queries cannot be answered honestly.')
  if (needsStyles && !facade.methodNames.has('style.list'))
    return failure('search_design_system', 'method_unavailable', 'style.list is not available in this Design API session, so style queries cannot be answered honestly.')
  const document = await facade.call('document.get', {}, context)
  if (!document.ok) return document
  const identity = identityOf(document)
  const variables = needsVariables ? await facade.call('variable.list', {}, context, identity) : null
  if (variables && !variables.ok) return variables
  const styles = needsStyles ? await facade.call('style.list', {}, context, identity) : null
  if (styles && !styles.ok) return styles
  const variableList = Array.isArray(variables?.result) ? variables.result : []
  const styleList = Array.isArray(styles?.result) ? styles.result : []
  const matchName = (entry, query) => String(entry.name ?? '').toLocaleLowerCase().includes(query)
  const results = args.queries.map(entry => {
    const query = entry.query.toLocaleLowerCase()
    if (entry.entity === 'component') {
      return {
        entity: 'component', query: entry.query, status: 'unsupported', matches: [],
        note: 'Local components are not indexed by this facade and no Code Connect map exists. No matches are fabricated.',
      }
    }
    const source = entry.entity === 'variable' ? variableList : styleList
    const matches = source.filter(item => matchName(item, query)).slice(0, 20).map(item => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      ...(entry.entity === 'variable' ? { collectionId: item.collection, values: item.values } : {}),
      ...(args.includeLibraryKeys ? { libraryKey: 'local-document' } : {}),
    }))
    return { entity: entry.entity, query: entry.query, status: 'ok', matches }
  })
  return done('search_design_system', identity, {
    format: 'futureox.design-system-search.v1',
    results,
    libraries: [{ key: 'local-document', name: 'Local document', source: 'local' }],
    disableCodeConnectIgnored: args.disableCodeConnect !== undefined,
    note: 'Local variables and shared styles only. No team library search, no cross-file component index, and no Code Connect mapping store.',
  })
}

async function getContextForCodeConnect(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('get_context_for_code_connect', args)
  if (problem) return failure('get_context_for_code_connect', 'invalid_params', problem)
  const node = await facade.call('node.get', { id: args.nodeId }, context)
  if (!node.ok) return node
  const identity = identityOf(node)
  const source = isRecord(node.result?.node) ? node.result.node : {}
  const component = isRecord(source.component) ? source.component : null
  let descendants = []
  let descendantsTruncated = false
  if (facade.methodNames.has('node.find')) {
    const found = await facade.call('node.find', { rootId: args.nodeId, limit: 100 }, context, identity)
    if (!found.ok) return found
    const nodes = Array.isArray(found.result?.nodes) ? found.result.nodes : []
    descendants = nodes.filter(entry => entry.id !== args.nodeId).slice(0, 100).map(entry => ({
      id: entry.id, name: entry.name, kind: entry.kind, parentId: entry.parentId ?? null,
    }))
    descendantsTruncated = found.result?.nextCursor !== null && found.result?.nextCursor !== undefined
  }
  return done('get_context_for_code_connect', identity, {
    format: 'futureox.component-context.v1',
    fileKeyIgnored: args.fileKey !== undefined,
    node: {
      id: node.result?.id ?? args.nodeId, name: node.result?.name, kind: node.result?.kind,
      width: node.result?.width, height: node.result?.height, childCount: node.result?.childCount,
    },
    isComponent: component !== null,
    componentSet: source.componentSet === true,
    componentKey: typeof source.componentKey === 'string' ? source.componentKey : null,
    variants: isRecord(component?.variants) ? component.variants : {},
    properties: isRecord(component?.properties) ? Object.fromEntries(Object.entries(component.properties).map(([key, property]) => [key, {
      name: property?.name, kind: property?.kind, targetKey: property?.targetKey,
      defaultValue: property?.defaultValue, alsoTargets: property?.alsoTargets ?? [], unbound: property?.unbound === true,
    }])) : {},
    slots: isRecord(component?.slots) ? component.slots : {},
    instance: isRecord(source.instance) ? { componentId: source.instance.componentId, slotContents: source.instance.slotContents ?? {}, propertyValues: source.instance.propertyValues ?? {} } : null,
    descendants,
    descendantsTruncated,
    codeConnect: {
      available: false, mappings: [],
      note: 'No Code Connect template or mapping store exists in this local application. This response is local component metadata only.',
    },
    note: 'Local Futureox component metadata. It does not generate or store Code Connect templates and does not claim Figma Code Connect parity.',
  })
}

async function exportVideo(facade, args, context, { failure }) {
  const problem = remoteToolArgumentsProblem('export_video', args)
  if (problem) return failure('export_video', 'invalid_params', problem)
  if ((args.nodeId === undefined) === (args.jobId === undefined))
    return failure('export_video', 'invalid_params', 'Provide either nodeId to start an export or jobId to poll an existing job, not both and not neither. Nothing was rendered.')
  if (args.constraint !== undefined) {
    const { type, value } = args.constraint
    if (type === 'SCALE' && value > 10) return failure('export_video', 'invalid_params', 'constraint.value for SCALE must be at most 10')
    if (type !== 'SCALE' && value > 4096) return failure('export_video', 'invalid_params', `constraint.value for ${type} must be at most 4096 pixels`)
  }
  return failure('export_video', UNSUPPORTED_REMOTE_CAPABILITY, args.jobId === undefined
    ? 'MP4 export requires a remote timeline renderer and video encoder. This local server has no video pipeline, so no job was created and nothing was rendered. Use download_assets or vector.export for still assets.'
    : 'No video job exists locally because this server cannot start MP4 exports. Polling cannot succeed here; no jobId was accepted.')
}

async function uploadAssets(facade, args, context, { failure, done, identityOf }) {
  const problem = remoteToolArgumentsProblem('upload_assets', args)
  if (problem) return failure('upload_assets', 'invalid_params', problem)
  if (facade.scope !== 'write') return failure('upload_assets', 'read_only', READ_ONLY)
  if (!Array.isArray(args.assets) || !args.assets.length)
    return failure('upload_assets', 'inline_assets_required', 'This local server has no upload-URL endpoint. Send up to 60 assets inline with assets[] entries: dataUrl for PNG, JPEG, GIF, or WebP, or content for SVG. Nothing was uploaded.')
  if (args.count !== undefined && args.count !== args.assets.length)
    return failure('upload_assets', 'invalid_params', 'count must equal the number of inline assets')
  const fences = await facade.fences(context)
  if (!fences.ok) return fences
  const imported = []
  for (let index = 0; index < args.assets.length; index++) {
    context.signal?.throwIfAborted()
    const asset = args.assets[index]
    const parentId = Array.isArray(args.nodeIds) ? args.nodeIds[index] : args.nodeId
    const isSvg = asset.mimeType === 'image/svg+xml'
    if ((asset.dataUrl !== undefined) === (asset.content !== undefined))
      return failure('upload_assets', 'invalid_params', `assets[${index}] requires exactly one of dataUrl or content`, identityOf(fences))
    if (isSvg) {
      if (asset.content === undefined || asset.dataUrl !== undefined)
        return failure('upload_assets', 'invalid_params', `assets[${index}] is SVG and requires content text, not dataUrl`, identityOf(fences))
      if (Buffer.byteLength(asset.content) > UPLOAD_ASSET_BYTES)
        return failure('upload_assets', 'asset_too_large', `assets[${index}] exceeds 10 MB`, identityOf(fences))
      const pageId = args.currentPageId
      const result = await facade.call('svg.import', {
        format: 'svg', content: asset.content, name: asset.name ?? `Asset ${index + 1}`,
        ...(pageId ? { pageId } : {}),
      }, context, fences)
      if (!result.ok) return { ...result, method: 'upload_assets', error: { ...result.error, details: { imported, failedIndex: index } } }
      imported.push({
        index, name: asset.name ?? `Asset ${index + 1}`, mimeType: 'image/svg+xml', kind: 'svg',
        nodeId: Array.isArray(result.result?.rootIds) ? result.result.rootIds[0] : undefined,
        rootIds: result.result?.rootIds, warnings: result.result?.warnings,
        ...(parentId ? { parentIdIgnored: parentId } : {}),
      })
      continue
    }
    if (asset.dataUrl === undefined || asset.content !== undefined)
      return failure('upload_assets', 'invalid_params', `assets[${index}] is raster and requires a base64 dataUrl, not content`, identityOf(fences))
    const info = rasterInfo(asset.dataUrl)
    if (!info) return failure('upload_assets', 'invalid_params', `assets[${index}].dataUrl must be a PNG, JPEG, GIF, or WebP base64 data URL`, identityOf(fences))
    if (info.bytes.byteLength > UPLOAD_ASSET_BYTES)
      return failure('upload_assets', 'asset_too_large', `assets[${index}] exceeds 10 MB`, identityOf(fences))
    if (asset.mimeType !== undefined && asset.mimeType !== info.mime)
      return failure('upload_assets', 'invalid_params', `assets[${index}].mimeType ${asset.mimeType} does not match ${info.mime}`, identityOf(fences))
    const width = Number.isFinite(info.width) && info.width > 0 ? info.width : 512
    const height = Number.isFinite(info.height) && info.height > 0 ? info.height : 512
    const created = await facade.call('node.create', {
      kind: 'rectangle',
      ...(parentId ? { parentId } : args.currentPageId ? { parentId: args.currentPageId } : {}),
      x: index * 24, y: index * 24, width, height,
      patch: {
        name: asset.name ?? `Asset ${index + 1}`,
        fills: [{ kind: 'image', color: '#000000', opacity: 1, visible: true, angle: 0, stops: [], image: asset.dataUrl, fit: 'cover' }],
      },
    }, context, fences)
    if (!created.ok) return { ...created, method: 'upload_assets', error: { ...created.error, details: { imported, failedIndex: index } } }
    imported.push({ index, name: asset.name ?? `Asset ${index + 1}`, mimeType: info.mime, kind: 'raster', nodeId: created.result?.id, width, height })
  }
  return done('upload_assets', identityOf(fences), {
    format: 'futureox.local-upload.v1',
    assets: imported,
    imported: imported.length,
    scaleModeIgnored: args.scaleMode !== undefined,
    batchCommitIgnored: args.batchCommit !== undefined,
    note: 'Inline local import only. SVG content becomes editable vector layers; raster data becomes a rectangle with the exact embedded image bytes. nodeId/nodeIds select a parent container, not an existing fill. No upload URL, temporary URL, or remote storage was created.',
  })
}

const unsupported = (name, message, { readOnly = true } = {}) => async (facade, args, context, { failure }) => {
  const problem = remoteToolArgumentsProblem(name, args)
  if (problem) return failure(name, 'invalid_params', problem)
  if (!readOnly && facade.scope !== 'write') return failure(name, 'read_only', READ_ONLY)
  return failure(name, UNSUPPORTED_REMOTE_CAPABILITY, message)
}

const HANDLERS = new Map([
  ['whoami', whoami],
  ['create_new_file', createNewFile],
  ['get_comments', getComments],
  ['get_libraries', getLibraries],
  ['search_design_system', searchDesignSystem],
  ['get_context_for_code_connect', getContextForCodeConnect],
  ['export_video', exportVideo],
  ['upload_assets', uploadAssets],
  ['generate_figma_design', unsupported('generate_figma_design', 'Live-site capture requires a browser capture service and a remote layer conversion pipeline. This local server does not capture pages and created nothing.', { readOnly: false })],
  ['generate_diagram', unsupported('generate_diagram', 'FigJam diagram generation requires a FigJam document type and a diagram layout service. This local editor has neither, so no board or file was created.', { readOnly: false })],
  ['generate_image', unsupported('generate_image', 'Image generation requires an AI image model and AI-credit accounting. This local build has neither, so nothing was generated or placed. Import an existing image with upload_assets.', { readOnly: false })],
  ['generate_vector_illustration', unsupported('generate_vector_illustration', 'Vector illustration generation requires an AI vector model and AI-credit accounting. This local build has neither, so nothing was generated or placed. Import an existing SVG with upload_assets.', { readOnly: false })],
  ['html_to_figma', unsupported('html_to_figma', 'HTML-to-design conversion is unavailable. The shared local Design API document.import explicitly rejects HTML and no HTML layout converter exists here. Use svg.import or upload_assets for vector artwork.', { readOnly: false })],
  ['send_code_to_figma', unsupported('send_code_to_figma', 'Figma Make project import and code layers require a remote build and deploy service. This local build has no code-layer pipeline and imported nothing. workspace.importCopy accepts native, Sketch, and FIG documents only.', { readOnly: false })],
  ['list_generative_plugins', unsupported('list_generative_plugins', 'This local application has no generative-plugin account library. The tool is listed for schema compatibility and returns a typed error instead of a fabricated empty catalog.')],
  ['get_generative_plugin', unsupported('get_generative_plugin', 'This local application has no generative-plugin source store or resource URIs, so no plugin source can be read.')],
  ['create_generative_plugin', unsupported('create_generative_plugin', 'This local build has no generative-plugin platform or build service, so no starter was created. planKey is validated for schema compatibility only.', { readOnly: false })],
  ['update_generative_plugin', unsupported('update_generative_plugin', 'This local build has no generative-plugin source store or build service, so no source files or metadata were changed.', { readOnly: false })],
  ['list_shaders', unsupported('list_shaders', 'This local application has no shader resource library. The tool is listed for schema compatibility and returns a typed error instead of a fabricated catalog.')],
  ['get_shader', unsupported('get_shader', 'This local application has no shader source store or resource URIs, so no shader source can be read.')],
  ['list_file_shaders', unsupported('list_file_shaders', 'Local documents have no shader fills or effects and this application has no shader registry, so no file shader list exists. This is a typed unsupported result, not an empty successful list.')],
  ['create_shader', unsupported('create_shader', 'This local build has no shader platform or build service, so no shader starter was created. planKey is validated for schema compatibility only.', { readOnly: false })],
  ['update_shader', unsupported('update_shader', 'This local build has no shader source store or build service, so no shader source or metadata was changed.', { readOnly: false })],
])

/** Dispatch one Figma remote/catalog tool through the enabled local Design API.
 * The caller supplies the facade and its response builders so both modules
 * produce the same { ok, method, documentId, session, revision } envelope. */
export async function callRemoteFigmaTool(facade, name, args, context, helpers) {
  const handler = HANDLERS.get(name)
  if (!handler) return helpers.failure(name, 'unknown_tool', `Unknown Figma-shaped tool ${name}`)
  return handler(facade, isRecord(args) ? args : {}, context, helpers)
}