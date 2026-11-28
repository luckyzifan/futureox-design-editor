import { randomUUID } from 'node:crypto'
import { isRecord } from './framing.mjs'

/** Desktop and Dev Mode Figma MCP names that the base facade does not own.
 *
 * These names are part of the Figma desktop/Dev Mode surface. The facade lists
 * them so a Figma client discovers a translated answer instead of an unknown
 * tool. Motion reads authored local animation and prototype data. Code Connect
 * reads and writes a bounded process-local mapping store keyed by the live
 * document. FigJam and shader names have no local model and return a typed
 * `unsupported_remote_capability` without calling the Design API.
 *
 * This is not Figma cloud parity: there is no Figma account, team library,
 * Figma cloud Code Connect store, FigJam board model, shader service, or
 * remote request. The mapping store lives only in this MCP process and is
 * bound to the document revision when a mapping is added. */

export const FIGMA_DESKTOP_DOC = 'docs/FIGMA_MCP_FACADE.md#desktop-and-dev-mode-tools'
export const UNSUPPORTED_REMOTE_CAPABILITY = 'unsupported_remote_capability'

const READ_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
const WRITE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })

export const FIGMA_DESKTOP_TOOL_SPECS = Object.freeze([
  {
    name: 'get_code_connect_map',
    description: 'Read Code Connect mappings for nodeId, nodeIds, or the current selection. Futureox keeps a bounded process-local Code Connect map for this document; it is not the Figma cloud Code Connect service. When the requested components have no local mapping, the call returns unsupported_remote_capability instead of inventing a mapping. add_code_connect_map records a mapping.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128, description: 'Local component or instance id from get_metadata.' },
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
    },
    required: [],
  },
  {
    name: 'get_code_connect_suggestions',
    description: 'Suggest Code Connect mappings for nodeId, nodeIds, or the current selection. Suggestions come from local main components, instances, and the process-local Code Connect map; a component without a stored mapping is reported as unmapped with no fabricated source. The call returns unsupported_remote_capability when the requested nodes contain no local component or instance.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128, description: 'Local component or instance id from get_metadata.' },
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
    },
    required: [],
  },
  {
    name: 'get_figjam',
    description: 'Convert a FigJam diagram to XML. Futureox documents have no FigJam board model or connectors, so this tool returns unsupported_remote_capability and does not call the Design API. Use get_metadata for a local XML outline of the open design.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: [],
  },
  {
    name: 'get_motion_context',
    description: 'Read authored local motion for nodeId. Returns animation clips and keyframes that reference the node (optionally its readable descendants) plus a derived CSS @keyframes snippet, and authored prototype interactions for the same node. Motion is local authored data, not Figma timeline playback or a rendered animation. The session must expose animation.list/animation.get or prototype.get.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128, description: 'Local node id from get_metadata. Figma cloud node ids are rejected.' },
      recursive: { type: 'boolean', description: 'Include tracks and interactions for descendants of nodeId that are readable from the current page.' },
    },
    required: ['nodeId', 'fileKey'],
  },
  {
    name: 'get_shader',
    description: 'Read a Figma shader source. Futureox has no shader library or shader source model, so this tool returns unsupported_remote_capability and does not call the Design API. Local effects and fills are available through node and context reads.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 256 },
      version: { type: 'string', minLength: 1, maxLength: 256 },
      includeSource: { type: 'boolean' },
    },
    required: ['id'],
  },
  {
    name: 'list_shaders',
    description: 'List Figma shader effects and fills. Futureox has no shader library, so this tool returns unsupported_remote_capability and does not call the Design API.',
    mutates: false,
    annotations: READ_ANNOTATIONS,
    properties: {
      cursor: { type: 'string', minLength: 1, maxLength: 1024, description: 'Accepted for the Figma shape; not interpreted.' },
    },
    required: [],
  },
  {
    name: 'add_code_connect_map',
    description: 'Map a local component or instance to a code component. This writes the bounded process-local Code Connect map for the open document, not the Figma cloud Code Connect store, and never modifies the design document. nodeId must identify a local main component or instance. A mutationId replay returns the earlier result; a different payload for the same mutationId, or a second mapping for the same node and label, returns a conflict unless replace is true.',
    mutates: true,
    annotations: WRITE_ANNOTATIONS,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      source: { type: 'string', minLength: 1, maxLength: 2048 },
      componentName: { type: 'string', minLength: 1, maxLength: 512 },
      label: { type: 'string', minLength: 1, maxLength: 128 },
      snippet: { type: 'string', maxLength: 65536 },
      version: { type: 'string', minLength: 1, maxLength: 256 },
      mutationId: { type: 'string', minLength: 1, maxLength: 128 },
      replace: { type: 'boolean', description: 'Replace an existing mapping for the same nodeId and label after a mapping_conflict.' },
    },
    required: ['nodeId', 'fileKey', 'source', 'componentName', 'label'],
  },
  {
    name: 'send_code_connect_mappings',
    description: 'Confirm suggested Code Connect mappings in the process-local map. Each mapping must match a mapping added with add_code_connect_map at the current document revision. A changed document revision returns stale_revision and confirms nothing; an unknown mapping returns not_found. This never modifies the design document or the Figma cloud Code Connect store.',
    mutates: true,
    annotations: WRITE_ANNOTATIONS,
    properties: {
      mappings: {
        type: 'array', minItems: 1, maxItems: 100,
        items: {
          type: 'object', additionalProperties: true,
          properties: {
            nodeId: { type: 'string', minLength: 1, maxLength: 128 },
            source: { type: 'string', minLength: 1, maxLength: 2048 },
            componentName: { type: 'string', minLength: 1, maxLength: 512 },
            label: { type: 'string', minLength: 1, maxLength: 128 },
          },
          required: ['nodeId', 'source', 'componentName', 'label'],
        },
      },
      mutationId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['fileKey', 'mappings'],
  },
])

export const FIGMA_DESKTOP_TOOL_NAMES = Object.freeze(FIGMA_DESKTOP_TOOL_SPECS.map(spec => spec.name))
export const FIGMA_DESKTOP_WRITE_TOOLS = new Set(['add_code_connect_map', 'send_code_connect_mappings'])
const FIGMA_DESKTOP_READ_TOOLS = new Set(FIGMA_DESKTOP_TOOL_SPECS.filter(spec => !FIGMA_DESKTOP_WRITE_TOOLS.has(spec.name)).map(spec => spec.name))
const SPEC_BY_NAME = new Map(FIGMA_DESKTOP_TOOL_SPECS.map(spec => [spec.name, spec]))

const IGNORED = new Set(['fileKey', 'clientFrameworks', 'clientLanguages', 'skillNames', 'dir'])
const FIGMA_NODE_ID = /^(?:I\d+[:-]\d+(?:;\d+[:-]\d+)*|T\d+[:-]\d+(?:;\d+[:-]\d+)*|\d+[:-]\d+)$/
const MOTION_CLIP_LIMIT = 8
const MOTION_TRACK_LIMIT = 24
const MOTION_KEYFRAME_LIMIT = 48
const MOTION_KEYFRAME_TOTAL = 600
const MOTION_CSS_CHARS = 65536
const MOTION_PAGE_LIMIT = 5
const MOTION_NODE_LIMIT = 500
const MOTION_PROTOTYPE_EVENTS = 32
const CODE_CONNECT_MAPPINGS = 2000
const CODE_CONNECT_MUTATIONS = 200
const CODE_CONNECT_DOCUMENTS = 8

/** Bounded process-local Code Connect map. Not a document store and not durable.
 * Keyed by the live document id; each mapping records the document revision it
 * was added at so confirmation can enforce a real revision contract. */
const codeConnectStores = new Map()

function documentStore(documentId) {
  let store = codeConnectStores.get(documentId)
  if (store) {
    codeConnectStores.delete(documentId)
    codeConnectStores.set(documentId, store)
    return store
  }
  while (codeConnectStores.size >= CODE_CONNECT_DOCUMENTS) {
    const oldest = codeConnectStores.keys().next().value
    codeConnectStores.delete(oldest)
  }
  store = { mappings: new Map(), mutations: new Map(), revision: 0 }
  codeConnectStores.set(documentId, store)
  return store
}

function rememberMutation(store, mutationId, fingerprint, response) {
  if (typeof mutationId !== 'string') return
  while (store.mutations.size >= CODE_CONNECT_MUTATIONS) {
    store.mutations.delete(store.mutations.keys().next().value)
  }
  store.mutations.set(mutationId, { fingerprint, response: structuredClone(response) })
}

function replayMutation(store, name, mutationId, fingerprint) {
  if (typeof mutationId !== 'string') return null
  const previous = store.mutations.get(mutationId)
  if (!previous) return null
  if (previous.fingerprint !== fingerprint)
    return failure(name, 'mutation_conflict', `mutationId ${mutationId} was already used with a different payload. Use a new mutationId.`)
  return { ...structuredClone(previous.response), result: { ...structuredClone(previous.response.result), replayed: true } }
}

export function isFigmaDesktopTool(name) {
  return FIGMA_DESKTOP_READ_TOOLS.has(name) || FIGMA_DESKTOP_WRITE_TOOLS.has(name)
}

/** Figma cloud/plugin ids use a numeric guid shape. Local Futureox ids are UUIDs. */
export function isFigmaCloudNodeId(value) {
  return typeof value === 'string' && FIGMA_NODE_ID.test(value)
}

const failure = (method, code, message, identity = {}, details) => ({
  ok: false, method, documentId: identity.documentId ?? '', session: identity.session ?? 0, revision: identity.revision ?? 0,
  error: { code, message, ...(details === undefined ? {} : { details }) },
})
const done = (method, identity, result) => ({ ok: true, method, documentId: identity.documentId, session: identity.session, revision: identity.revision, result })
const identityOf = response => ({ documentId: response.documentId, session: response.session, revision: response.revision })
const remap = (response, method) => ({ ...response, method })

function unknownArguments(args, allowed) {
  if (!isRecord(args)) return 'Tool arguments must be an object'
  const extra = Object.keys(args).filter(key => !allowed.has(key) && !IGNORED.has(key))
  if (extra.length) return `Unknown arguments: ${extra.join(', ')}`
  if (!allowed.has('cursor') && args.cursor !== undefined) return 'This tool returns one bounded result. Narrow nodeId instead of passing a cursor.'
  return null
}

function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return `${label} must be a nonempty string of at most ${max} characters`
}

function optionalText(value, label, max = 512) {
  if (value === undefined) return null
  return text(value, label, max)
}

function unsupported(name, capability, hint, identity = {}, details = {}) {
  return failure(name, UNSUPPORTED_REMOTE_CAPABILITY,
    `${name} was not executed. ${capability} is a Figma capability with no local Futureox implementation. ${hint} This call did not contact a remote service.`,
    identity, { capability, docs: FIGMA_DESKTOP_DOC, ...details })
}

function figmaNodeIdRejection(name, nodeId) {
  if (!isFigmaCloudNodeId(nodeId)) return null
  return failure(name, 'unsupported_figma_node_id', `${name} works on local Futureox node ids, not Figma cloud node ids. Use an id returned by get_metadata for this document.`)
}

function nodePayload(result) {
  if (isRecord(result?.node)) return result.node
  return isRecord(result) ? result : {}
}

function componentIdentity(node) {
  if (isRecord(node.instance) && typeof node.instance.componentId === 'string' && node.instance.componentId) {
    return { componentId: node.instance.componentId, role: 'instance' }
  }
  if (isRecord(node.component) || node.componentSet === true) return { componentId: node.id, role: 'component' }
  return null
}

async function requestedIds(facade, args, context, name) {
  if (args.nodeId !== undefined) {
    const problem = text(args.nodeId, 'nodeId', 128)
    if (problem) return { failure: failure(name, 'invalid_params', problem) }
    return { ids: [args.nodeId] }
  }
  if (args.nodeIds !== undefined) {
    if (!Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 100)
      return { failure: failure(name, 'invalid_params', 'nodeIds must contain 1-100 local node ids') }
    const ids = []
    for (const value of args.nodeIds) {
      const problem = text(value, 'nodeIds[]', 128)
      if (problem) return { failure: failure(name, 'invalid_params', problem) }
      if (!ids.includes(value)) ids.push(value)
    }
    return { ids }
  }
  if (!facade.methodNames.has('selection.get'))
    return { boundary: unsupported(name, 'Figma selection', 'This session does not expose selection.get. Pass nodeId or nodeIds.', {}, { reason: 'no_selection_api' }) }
  const selected = await facade.call('selection.get', {}, context)
  if (!selected.ok) return { failure: remap(selected, name) }
  const ids = Array.isArray(selected.result?.ids) ? selected.result.ids.filter(id => typeof id === 'string' && id.length <= 128) : []
  if (!ids.length) return { failure: failure(name, 'invalid_params', 'No nodes are selected. Pass nodeId or nodeIds.', identityOf(selected)) }
  return { ids, identity: identityOf(selected) }
}

async function readNode(facade, id, context, fence) {
  if (!facade.methodNames.has('node.get')) return { missing: true }
  const node = await facade.call('node.get', { id }, context, fence)
  if (!node.ok) return { response: node }
  return { node: nodePayload(node.result), response: node, identity: identityOf(node) }
}

async function codeConnectMap(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['nodeId', 'nodeIds']))
  if (invalid) return failure('get_code_connect_map', 'invalid_params', invalid)
  const target = await requestedIds(facade, args, context, 'get_code_connect_map')
  if (target.failure) return target.failure
  if (target.boundary) return target.boundary
  const fences = await facade.fences(context)
  if (!fences.ok) return remap(fences, 'get_code_connect_map')
  const store = documentStore(fences.documentId)
  const mappings = []
  const unresolved = []
  const unmapped = []
  for (const id of target.ids.slice(0, 100)) {
    const read = await readNode(facade, id, context, fences)
    if (read.response && !read.response.ok) return remap(read.response, 'get_code_connect_map')
    const identity = read.node ? componentIdentity(read.node) : null
    const candidates = [id, identity?.componentId].filter(value => typeof value === 'string')
    let found = null
    for (const candidate of candidates) {
      for (const mapping of store.mappings.values()) {
        if (mapping.nodeId === candidate) { found = mapping; break }
      }
      if (found) break
    }
    if (!found) {
      if (identity) unmapped.push(id)
      else unresolved.push(id)
      continue
    }
    mappings.push({
      requestedNodeId: id, mappingNodeId: found.nodeId, componentId: found.componentId,
      componentName: found.componentName, source: found.source, label: found.label,
      snippet: found.snippet, version: found.version, confirmed: found.confirmed,
      documentRevision: found.documentRevision, stale: found.documentRevision !== fences.revision,
    })
  }
  if (!mappings.length)
    return unsupported('get_code_connect_map', 'Figma Code Connect mapping for the requested nodes',
      `No local Code Connect mapping exists for ${target.ids.length === 1 ? 'that node' : 'those nodes'}. Call add_code_connect_map to record one.`,
      fences, { mappingCount: 0, requestedNodeIds: target.ids, unmappedNodeIds: unmapped, nonComponentNodeIds: unresolved })
  return done('get_code_connect_map', fences, {
    format: 'futureox.figma-code-connect.v1', mappings, unmappedNodeIds: unmapped, nonComponentNodeIds: unresolved,
    documentRevision: fences.revision,
    note: 'Process-local Futureox Code Connect map bound to this MCP process and the listed document revision. This is not the Figma cloud Code Connect service.',
  })
}

async function codeConnectSuggestions(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['nodeId', 'nodeIds']))
  if (invalid) return failure('get_code_connect_suggestions', 'invalid_params', invalid)
  const target = await requestedIds(facade, args, context, 'get_code_connect_suggestions')
  if (target.failure) return target.failure
  if (target.boundary) return target.boundary
  const fences = await facade.fences(context)
  if (!fences.ok) return remap(fences, 'get_code_connect_suggestions')
  if (!facade.methodNames.has('node.get'))
    return unsupported('get_code_connect_suggestions', 'Figma Code Connect suggestions',
      'This session does not expose node.get, so local component identity cannot be read.', fences)
  const store = documentStore(fences.documentId)
  const suggestions = []
  const ignored = []
  for (const id of target.ids.slice(0, 100)) {
    const read = await readNode(facade, id, context, fences)
    if (read.response && !read.response.ok) return remap(read.response, 'get_code_connect_suggestions')
    const node = read.node ?? {}
    const identity = componentIdentity(node)
    if (!identity) { ignored.push(id); continue }
    let stored = null
    for (const mapping of store.mappings.values()) {
      if (mapping.nodeId === identity.componentId) { stored = mapping; break }
    }
    if (stored?.confirmed) continue
    suggestions.push({
      nodeId: id, componentId: identity.componentId, role: identity.role,
      componentName: stored?.componentName ?? (typeof node.name === 'string' ? node.name : ''),
      source: stored?.source ?? null, label: stored?.label ?? null,
      status: stored ? 'suggested' : 'unmapped',
      note: stored
        ? 'Confirm with send_code_connect_mappings at the same document revision.'
        : 'No local code mapping data exists for this component. add_code_connect_map records one; no source was invented.',
    })
  }
  if (!suggestions.length) {
    if (ignored.length)
      return unsupported('get_code_connect_suggestions', 'Figma Code Connect suggestions',
        'The requested nodes are not local components or instances, so there is nothing to suggest.', fences,
        { ignoredNodeIds: ignored })
    return done('get_code_connect_suggestions', fences, {
      format: 'futureox.figma-code-connect-suggestions.v1', suggestions: [], ignoredNodeIds: ignored,
      status: 'all_mapped', documentRevision: fences.revision,
      note: 'Every requested component already has a confirmed local Code Connect mapping.',
    })
  }
  return done('get_code_connect_suggestions', fences, {
    format: 'futureox.figma-code-connect-suggestions.v1', suggestions, ignoredNodeIds: ignored,
    status: 'suggestions', documentRevision: fences.revision,
    note: 'Suggestions come from local component identity and the process-local Code Connect map. This is not the Figma cloud Code Connect suggestion engine.',
  })
}

function mappingFingerprint(value) {
  return JSON.stringify([value.nodeId, value.source, value.componentName, value.label, value.snippet ?? null, value.version ?? null, value.replace === true])
}

async function addCodeConnectMap(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['nodeId', 'source', 'componentName', 'label', 'snippet', 'version', 'mutationId', 'replace']))
  if (invalid) return failure('add_code_connect_map', 'invalid_params', invalid)
  for (const [key, max] of [['nodeId', 128], ['source', 2048], ['componentName', 512], ['label', 128]]) {
    const problem = text(args[key], key, max)
    if (problem) return failure('add_code_connect_map', 'invalid_params', problem)
  }
  const snippetProblem = optionalText(args.snippet, 'snippet', 65536)
  if (snippetProblem) return failure('add_code_connect_map', 'invalid_params', snippetProblem)
  const versionProblem = optionalText(args.version, 'version', 256)
  if (versionProblem) return failure('add_code_connect_map', 'invalid_params', versionProblem)
  if (args.mutationId !== undefined && (typeof args.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.mutationId)))
    return failure('add_code_connect_map', 'invalid_params', 'mutationId must be 1-128 ASCII letters, digits, hyphens, or underscores')
  if (args.replace !== undefined && typeof args.replace !== 'boolean')
    return failure('add_code_connect_map', 'invalid_params', 'replace must be a boolean')
  if (figmaNodeIdRejection('add_code_connect_map', args.nodeId)) return figmaNodeIdRejection('add_code_connect_map', args.nodeId)
  if (facade.scope !== 'write')
    return failure('add_code_connect_map', 'read_only', 'This connection is read-only. Enable read and edit access to write Code Connect mappings.')

  const fences = await facade.fences(context)
  if (!fences.ok) return remap(fences, 'add_code_connect_map')
  const store = documentStore(fences.documentId)
  const replay = replayMutation(store, 'add_code_connect_map', args.mutationId, mappingFingerprint(args))
  if (replay) return replay
  const read = await readNode(facade, args.nodeId, context, fences)
  if (read.response && !read.response.ok) return remap(read.response, 'add_code_connect_map')
  if (!read.node)
    return failure('add_code_connect_map', 'method_unavailable', 'node.get is not available in this Design API session, so component identity cannot be verified.', fences)
  const identity = componentIdentity(read.node)
  if (!identity)
    return failure('add_code_connect_map', 'not_a_component', 'nodeId must identify a local main component or instance. Plain layers have no Code Connect mapping.', fences)
  const key = `${args.nodeId}\u0000${args.label}`
  const existing = store.mappings.get(key)
  if (existing) {
    const same = existing.source === args.source && existing.componentName === args.componentName &&
      existing.snippet === args.snippet && existing.version === args.version
    if (!same && args.replace !== true)
      return failure('add_code_connect_map', 'mapping_conflict',
        'A different local Code Connect mapping already exists for this nodeId and label. Pass the identical mapping, or replace: true to update it.',
        fences, { existing: { nodeId: existing.nodeId, componentName: existing.componentName, source: existing.source, label: existing.label, documentRevision: existing.documentRevision } })
    if (same) {
      const refreshed = existing.documentRevision !== fences.revision
      if (refreshed) {
        store.revision += 1
        existing.documentRevision = fences.revision
        existing.catalogRevision = store.revision
        existing.confirmed = false
        existing.confirmedRevision = null
      }
      const response = done('add_code_connect_map', fences, {
        format: 'futureox.figma-code-connect.v1', mapping: publicMapping(existing), stored: false, unchanged: !refreshed,
        refreshed, documentRevision: fences.revision,
        note: refreshed
          ? 'The identical local Code Connect mapping was rebound to the current document revision and must be confirmed again.'
          : 'The identical local Code Connect mapping already exists at this document revision. Nothing changed.',
      })
      rememberMutation(store, args.mutationId, mappingFingerprint(args), response)
      return response
    }
  }
  while (store.mappings.size >= CODE_CONNECT_MAPPINGS && !store.mappings.has(key)) {
    store.mappings.delete(store.mappings.keys().next().value)
  }
  store.revision += 1
  const mapping = {
    id: randomUUID(), documentId: fences.documentId, nodeId: args.nodeId, componentId: identity.componentId,
    componentName: args.componentName, source: args.source, label: args.label,
    snippet: args.snippet, version: args.version, documentRevision: fences.revision,
    catalogRevision: store.revision, confirmed: false, confirmedRevision: null,
  }
  store.mappings.set(key, mapping)
  const response = done('add_code_connect_map', fences, {
    format: 'futureox.figma-code-connect.v1', mapping: publicMapping(mapping), stored: true,
    replaced: existing !== undefined, documentRevision: fences.revision,
    note: 'Stored in the process-local Futureox Code Connect map for this document. The design document was not modified and no Figma cloud service was contacted.',
  })
  rememberMutation(store, args.mutationId, mappingFingerprint(args), response)
  return response
}

function publicMapping(mapping) {
  return {
    nodeId: mapping.nodeId, componentId: mapping.componentId, componentName: mapping.componentName,
    source: mapping.source, label: mapping.label, snippet: mapping.snippet, version: mapping.version,
    confirmed: mapping.confirmed, documentRevision: mapping.documentRevision, catalogRevision: mapping.catalogRevision,
  }
}

function sendFingerprint(mappings) {
  return JSON.stringify(mappings.map(value => [value.nodeId, value.source, value.componentName, value.label]))
}

async function sendCodeConnectMappings(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['mappings', 'mutationId']))
  if (invalid) return failure('send_code_connect_mappings', 'invalid_params', invalid)
  if (!Array.isArray(args.mappings) || !args.mappings.length || args.mappings.length > 100)
    return failure('send_code_connect_mappings', 'invalid_params', 'mappings must contain 1-100 mapping objects')
  for (const [index, value] of args.mappings.entries()) {
    if (!isRecord(value)) return failure('send_code_connect_mappings', 'invalid_params', `mappings[${index}] must be an object`)
    for (const [key, max] of [['nodeId', 128], ['source', 2048], ['componentName', 512], ['label', 128]]) {
      const problem = text(value[key], `mappings[${index}].${key}`, max)
      if (problem) return failure('send_code_connect_mappings', 'invalid_params', problem)
    }
    const rejection = figmaNodeIdRejection('send_code_connect_mappings', value.nodeId)
    if (rejection) return rejection
  }
  if (args.mutationId !== undefined && (typeof args.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.mutationId)))
    return failure('send_code_connect_mappings', 'invalid_params', 'mutationId must be 1-128 ASCII letters, digits, hyphens, or underscores')
  if (facade.scope !== 'write')
    return failure('send_code_connect_mappings', 'read_only', 'This connection is read-only. Enable read and edit access to confirm Code Connect mappings.')

  const fences = await facade.fences(context)
  if (!fences.ok) return remap(fences, 'send_code_connect_mappings')
  const store = documentStore(fences.documentId)
  const replay = replayMutation(store, 'send_code_connect_mappings', args.mutationId, sendFingerprint(args.mappings))
  if (replay) return replay
  const records = []
  for (const [index, value] of args.mappings.entries()) {
    const record = store.mappings.get(`${value.nodeId}\u0000${value.label}`)
    if (!record)
      return failure('send_code_connect_mappings', 'not_found',
        `mappings[${index}] does not match a local Code Connect mapping. Add it with add_code_connect_map first.`,
        fences, { index, nodeId: value.nodeId, label: value.label })
    const same = record.source === value.source && record.componentName === value.componentName
    if (!same)
      return failure('send_code_connect_mappings', 'mapping_conflict',
        `mappings[${index}] does not match the stored source or componentName for this nodeId and label.`,
        fences, { index, stored: { source: record.source, componentName: record.componentName } })
    if (record.documentRevision !== fences.revision)
      return failure('send_code_connect_mappings', 'stale_revision',
        'The document changed after this mapping was added, so the mapping revision no longer matches. Re-add the mapping at the current revision before confirming.',
        fences, { index, mappingRevision: record.documentRevision, currentRevision: fences.revision })
    records.push(record)
  }
  const changed = records.filter(record => !record.confirmed || record.confirmedRevision !== fences.revision)
  for (const record of changed) {
    record.confirmed = true
    record.confirmedRevision = fences.revision
  }
  store.revision += 1
  for (const record of changed) record.catalogRevision = store.revision
  const response = done('send_code_connect_mappings', fences, {
    format: 'futureox.figma-code-connect.v1', mappings: records.map(publicMapping),
    confirmed: changed.length, unchanged: records.length - changed.length, documentRevision: fences.revision,
    note: 'Confirmed the process-local Futureox Code Connect map at this document revision. The design document was not modified and no Figma cloud service was contacted.',
  })
  rememberMutation(store, args.mutationId, sendFingerprint(args.mappings), response)
  return response
}

function cssForTrack(clip, track) {
  const stem = `futureox-${String(clip.id ?? 'clip').replace(/[^A-Za-z0-9_-]/g, '-')}-${String(track.nodeId).replace(/[^A-Za-z0-9_-]/g, '-')}`
  const frames = track.keyframes.map(keyframe => {
    const percent = clip.durationMs > 0 ? Math.min(100, Math.max(0, keyframe.timeMs / clip.durationMs * 100)) : 0
    const value = keyframe.value ?? keyframe
    const transform = Array.isArray(value?.transform) && value.transform.length === 6 ? value.transform : [1, 0, 0, 1, 0, 0]
    const matrix = transform.map(number => Number.isFinite(number) ? Number(number.toFixed(6)) : 0).join(', ')
    const declarations = [`transform: matrix(${matrix})`]
    if (Number.isFinite(value?.opacity)) declarations.push(`opacity: ${Number(value.opacity.toFixed(4))}`)
    const easing = keyframe.easing?.kind === 'cubic'
      ? `animation-timing-function: cubic-bezier(${keyframe.easing.x1}, ${keyframe.easing.y1}, ${keyframe.easing.x2}, ${keyframe.easing.y2}); `
      : keyframe.easing?.kind === 'named'
        ? `animation-timing-function: ${keyframe.easing.name}; `
        : ''
    return `  ${Number(percent.toFixed(4))}% { ${easing}${declarations.join('; ')}; }`
  })
  const repeat = clip.repeat === 'loop' ? 'infinite' : clip.repeat === 'alternate' ? 'infinite alternate' : '1'
  return `@keyframes ${stem} {\n${frames.join('\n')}\n}\n.${stem} { animation: ${stem} ${clip.durationMs}ms ${clip.delayMs}ms ${repeat} both; }`
}

function motionTrack(clip, track, keyframeBudget) {
  const source = Array.isArray(track.keyframes) ? track.keyframes : []
  const keyframes = source.slice(0, Math.max(0, Math.min(MOTION_KEYFRAME_LIMIT, keyframeBudget))).map(keyframe => ({
    timeMs: keyframe.timeMs,
    easing: keyframe.easing,
    transform: keyframe.value?.transform,
    opacity: keyframe.value?.opacity,
    width: keyframe.value?.width,
    height: keyframe.value?.height,
  }))
  return {
    clipId: clip.id, clipName: clip.name, durationMs: clip.durationMs, delayMs: clip.delayMs, repeat: clip.repeat,
    nodeId: track.nodeId, keyframes, truncated: source.length > keyframes.length,
  }
}

async function motionContext(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['nodeId', 'recursive']))
  if (invalid) return failure('get_motion_context', 'invalid_params', invalid)
  const problem = text(args.nodeId, 'nodeId', 128)
  if (problem) return failure('get_motion_context', 'invalid_params', problem)
  const rejection = figmaNodeIdRejection('get_motion_context', args.nodeId)
  if (rejection) return rejection
  if (typeof args.fileKey !== 'string' || !args.fileKey.trim() || args.fileKey.length > 512)
    return failure('get_motion_context', 'invalid_params', 'fileKey is required by the Figma-shaped schema and is ignored locally')
  if (args.recursive !== undefined && typeof args.recursive !== 'boolean')
    return failure('get_motion_context', 'invalid_params', 'recursive must be a boolean')
  const canAnimate = facade.methodNames.has('animation.list') && facade.methodNames.has('animation.get')
  const canPrototype = facade.methodNames.has('prototype.get')
  if (!canAnimate && !canPrototype)
    return unsupported('get_motion_context', 'Figma keyframe motion',
      'This session does not expose animation.list/animation.get or prototype.get, so there is no local authored motion to read.',
      {}, { reason: 'motion_api_unavailable' })

  const fences = await facade.fences(context)
  if (!fences.ok) return remap(fences, 'get_motion_context')
  if (facade.methodNames.has('node.get')) {
    const node = await facade.call('node.get', { id: args.nodeId }, context, fences)
    if (!node.ok) return remap(node, 'get_motion_context')
  }
  const ids = new Set([args.nodeId])
  let subtreeTruncated = false
  if (args.recursive && facade.methodNames.has('node.find')) {
    let cursor
    for (let page = 0; page < MOTION_PAGE_LIMIT; page++) {
      const found = await facade.call('node.find', { rootId: args.nodeId, limit: 100, ...(cursor ? { cursor } : {}) }, context, fences)
      if (!found.ok) break
      for (const entry of Array.isArray(found.result?.nodes) ? found.result.nodes : []) {
        if (typeof entry?.id === 'string' && ids.size < MOTION_NODE_LIMIT) ids.add(entry.id)
      }
      cursor = found.result?.nextCursor
      if (!cursor) break
      if (page === MOTION_PAGE_LIMIT - 1) subtreeTruncated = true
    }
  }

  const clips = []
  const css = []
  let trackCount = 0
  let keyframeCount = 0
  if (canAnimate) {
    const listed = await facade.call('animation.list', {}, context, fences)
    if (!listed.ok) return remap(listed, 'get_motion_context')
    const summaries = Array.isArray(listed.result?.clips) ? listed.result.clips : []
    for (const summary of summaries.slice(0, MOTION_CLIP_LIMIT)) {
      if (trackCount >= MOTION_TRACK_LIMIT || keyframeCount >= MOTION_KEYFRAME_TOTAL) break
      const read = await facade.call('animation.get', { id: summary.id }, context, fences)
      if (!read.ok) return remap(read, 'get_motion_context')
      const clip = isRecord(read.result) ? read.result : {}
      const tracks = []
      for (const track of Array.isArray(clip.tracks) ? clip.tracks : []) {
        if (!ids.has(track.nodeId) || trackCount >= MOTION_TRACK_LIMIT || keyframeCount >= MOTION_KEYFRAME_TOTAL) continue
        const mapped = motionTrack(clip, track, MOTION_KEYFRAME_TOTAL - keyframeCount)
        if (!mapped.keyframes.length) continue
        tracks.push(mapped)
        trackCount += 1
        keyframeCount += mapped.keyframes.length
      }
      if (!tracks.length) continue
      clips.push({
        id: clip.id, name: clip.name, pageId: clip.pageId, durationMs: clip.durationMs, delayMs: clip.delayMs, repeat: clip.repeat,
        tracks,
      })
      for (const track of tracks) css.push(cssForTrack(clip, track))
    }
  }
  let cssText = css.join('\n')
  const cssTruncated = cssText.length > MOTION_CSS_CHARS
  if (cssTruncated) cssText = `${cssText.slice(0, MOTION_CSS_CHARS)}\n/* CSS snippet truncated. Narrow nodeId or recursive. */`

  let prototype = null
  let prototypeTruncated = false
  if (canPrototype) {
    const authored = await facade.call('prototype.get', {}, context, fences)
    if (!authored.ok) return remap(authored, 'get_motion_context')
    const source = isRecord(authored.result) ? authored.result : {}
    const interactions = {}
    let events = 0
    for (const id of ids) {
      const list = Array.isArray(source.interactions?.[id]) ? source.interactions[id] : []
      if (!list.length) continue
      const keep = list.slice(0, Math.max(0, Math.min(8, MOTION_PROTOTYPE_EVENTS - events)))
      if (keep.length < list.length) prototypeTruncated = true
      if (!keep.length) { prototypeTruncated = true; continue }
      interactions[id] = keep
      events += keep.length
    }
    if (Object.keys(interactions).length) {
      prototype = {
        startNode: typeof source.startNode === 'string' ? source.startNode : null,
        interactions,
        flows: Array.isArray(source.flows) ? source.flows.slice(0, 8) : undefined,
      }
      if (Array.isArray(source.flows) && source.flows.length > 8) prototypeTruncated = true
    }
  }

  const truncated = subtreeTruncated || cssTruncated || prototypeTruncated || trackCount >= MOTION_TRACK_LIMIT ||
    keyframeCount >= MOTION_KEYFRAME_TOTAL
  const result = {
    format: 'futureox.figma-motion.v1', nodeId: args.nodeId, recursive: args.recursive === true,
    clips, css: cssText, prototype, truncated,
    note: 'Authored local animation tracks, derived CSS, and authored prototype interactions. This is not Figma timeline playback, Motion (motion.dev) code generation, or a rendered animation. Easing is copied from the authored keyframe; spring easing has no CSS equivalent here.',
  }
  result.modelText = clips.length
    ? `Motion for ${args.nodeId}: ${clips.length} clip(s), ${trackCount} track(s).\n${result.css}`
    : `No authored animation tracks reference ${args.nodeId}${args.recursive ? ' or its readable descendants' : ''}.${prototype ? ` ${Object.keys(prototype.interactions).length} prototype interaction owner(s) read.` : ''}`
  return done('get_motion_context', fences, result)
}

function figjam(facade, args, context) {
  const invalid = unknownArguments(args, new Set(['nodeId', 'limit']))
  if (invalid) return failure('get_figjam', 'invalid_params', invalid)
  if (args.nodeId !== undefined) {
    const problem = text(args.nodeId, 'nodeId', 128)
    if (problem) return failure('get_figjam', 'invalid_params', problem)
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))
    return failure('get_figjam', 'invalid_params', 'limit must be an integer from 1 to 100')
  return unsupported('get_figjam', 'FigJam document conversion',
    'Futureox documents are not FigJam boards and have no connectors or FigJam-specific XML. Use get_metadata for a local outline.')
}

function getShader(facade, args) {
  const invalid = unknownArguments(args, new Set(['id', 'version', 'includeSource']))
  if (invalid) return failure('get_shader', 'invalid_params', invalid)
  const problem = text(args.id, 'id', 256)
  if (problem) return failure('get_shader', 'invalid_params', problem)
  const versionProblem = optionalText(args.version, 'version', 256)
  if (versionProblem) return failure('get_shader', 'invalid_params', versionProblem)
  if (args.includeSource !== undefined && typeof args.includeSource !== 'boolean')
    return failure('get_shader', 'invalid_params', 'includeSource must be a boolean')
  return unsupported('get_shader', 'Figma shader source',
    'Futureox effects and fills are available through local node and context reads.')
}

function listShaders(facade, args) {
  const invalid = unknownArguments(args, new Set(['cursor']))
  if (invalid) return failure('list_shaders', 'invalid_params', invalid)
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor.length || args.cursor.length > 1024))
    return failure('list_shaders', 'invalid_params', 'cursor must be a nonempty string of at most 1024 characters')
  return unsupported('list_shaders', 'Figma shader library',
    'Futureox documents do not use Figma shader effects or shader fills.')
}

/** Dispatch one desktop/Dev Mode Figma-shaped tool.
 * The facade has already checked and removed sessionId. */
export async function callFigmaDesktopTool(facade, name, args, context = {}) {
  const spec = SPEC_BY_NAME.get(name)
  if (!spec) return failure(name, 'unknown_tool', `Unknown Figma desktop-shaped tool ${name}`)
  if (FIGMA_DESKTOP_WRITE_TOOLS.has(name) && facade.scope !== 'write')
    return failure(name, 'read_only', 'This connection is read-only. Enable read and edit access to use Code Connect write tools.')
  try {
    const toolArgs = args ?? {}
    if (name === 'get_code_connect_map') return await codeConnectMap(facade, toolArgs, context)
    if (name === 'get_code_connect_suggestions') return await codeConnectSuggestions(facade, toolArgs, context)
    if (name === 'get_motion_context') return await motionContext(facade, toolArgs, context)
    if (name === 'add_code_connect_map') return await addCodeConnectMap(facade, toolArgs, context)
    if (name === 'send_code_connect_mappings') return await sendCodeConnectMappings(facade, toolArgs, context)
    if (name === 'get_figjam') return figjam(facade, toolArgs, context)
    if (name === 'get_shader') return getShader(facade, toolArgs)
    if (name === 'list_shaders') return listShaders(facade, toolArgs)
    return failure(name, 'unknown_tool', `Unknown Figma desktop-shaped tool ${name}`)
  } catch (error) {
    return failure(name, typeof error?.code === 'string' ? error.code : 'facade_error', error?.message || 'Figma desktop-shaped tool failed')
  }
}