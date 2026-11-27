import { isRecord } from './framing.mjs'

/** Desktop/Dev Mode Figma tool names that the base facade does not own.
 * The catalog is Figma-shaped, but every call is answered by the live local
 * Design API or by a typed, documented capability error. Nothing here fabricates
 * Figma cloud data, plugin sources, Code Connect mappings, or FigJam content. */
export const FIGMA_DESKTOP_TOOL_SPECS = Object.freeze([
  {
    name: 'get_code_connect_map',
    description: 'Return the Code Connect mappings for the selected instances. Futureox has no Code Connect store, so this local facade returns unsupported_remote_capability instead of inventing mappings. Use get_design_context for local component context.',
    mutates: false,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
    },
    required: [],
  },
  {
    name: 'get_code_connect_suggestions',
    description: 'Suggest Code Connect mappings for the selected components. Futureox has no Code Connect store or suggestion engine, so this tool returns unsupported_remote_capability.',
    mutates: false,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
    },
    required: [],
  },
  {
    name: 'get_figjam',
    description: 'Convert a FigJam diagram to XML. Futureox documents have no FigJam board model or connectors, so this tool returns unsupported_remote_capability. Use get_metadata for a local XML outline.',
    mutates: false,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: [],
  },
  {
    name: 'get_motion_context',
    description: 'Read authored animation clips and keyframes for nodeId from the local animation API, including a derived CSS @keyframes snippet. Motion is local authored data, not Figma timeline or prototype playback.',
    mutates: false,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128, description: 'Local node id from get_metadata.' },
      recursive: { type: 'boolean', description: 'Include tracks for descendants of nodeId when their ids can be read from the current page.' },
    },
    required: ['nodeId', 'fileKey'],
  },
  {
    name: 'get_shader',
    description: 'Read a Figma shader source. Futureox has no shader library or shader source model, so this tool returns unsupported_remote_capability. Local effects and fills are available through node and context reads.',
    mutates: false,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 256 },
      version: { type: 'string', minLength: 1, maxLength: 256 },
      includeSource: { type: 'boolean' },
    },
    required: ['id'],
  },
  {
    name: 'list_shaders',
    description: 'List Figma shader effects and fills in the account library. Futureox has no shader library, so this tool returns unsupported_remote_capability.',
    mutates: false,
    properties: {
      cursor: { type: 'string', minLength: 1, maxLength: 1024 },
    },
    required: [],
  },
  {
    name: 'add_code_connect_map',
    description: 'Map a Figma component to a code component. Futureox has no Code Connect store, so this write tool returns unsupported_remote_capability and does not modify the document.',
    mutates: true,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      source: { type: 'string', minLength: 1, maxLength: 2048 },
      componentName: { type: 'string', minLength: 1, maxLength: 512 },
      label: { type: 'string', minLength: 1, maxLength: 128 },
      snippet: { type: 'string', maxLength: 65536 },
      version: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['nodeId', 'fileKey', 'source', 'componentName', 'label'],
  },
  {
    name: 'send_code_connect_mappings',
    description: 'Confirm suggested Code Connect mappings. Futureox has no Code Connect store, so this write tool returns unsupported_remote_capability and does not modify the document.',
    mutates: true,
    properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 128 },
      mappings: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } },
    },
    required: ['fileKey', 'mappings'],
  },
])

export const FIGMA_DESKTOP_WRITE_TOOLS = Object.freeze(new Set(['add_code_connect_map', 'send_code_connect_mappings']))
const FIGMA_DESKTOP_READ_TOOLS = Object.freeze(new Set(FIGMA_DESKTOP_TOOL_SPECS.filter(spec => !FIGMA_DESKTOP_WRITE_TOOLS.has(spec.name)).map(spec => spec.name)))
const IGNORED = new Set(['fileKey', 'clientFrameworks', 'clientLanguages', 'skillNames', 'dir'])
const FIGMA_NODE_ID = /^(?:I\d+[:-]\d+(?:;\d+[:-]\d+)*|T\d+[:-]\d+(?:;\d+[:-]\d+)*|\d+[:-]\d+)$/
const MOTION_CLIP_LIMIT = 8
const MOTION_TRACK_LIMIT = 24
const MOTION_KEYFRAME_LIMIT = 48
const MOTION_KEYFRAME_TOTAL = 600
const MOTION_CSS_CHARS = 65536
const MOTION_PAGE_LIMIT = 5

export function isFigmaDesktopTool(name) {
  return FIGMA_DESKTOP_READ_TOOLS.has(name) || FIGMA_DESKTOP_WRITE_TOOLS.has(name)
}

const failure = (method, code, message, identity = {}) => ({
  ok: false, method, documentId: identity.documentId ?? '', session: identity.session ?? 0, revision: identity.revision ?? 0,
  error: { code, message },
})
const done = (method, identity, result) => ({ ok: true, method, documentId: identity.documentId, session: identity.session, revision: identity.revision, result })
const identityOf = response => ({ documentId: response.documentId, session: response.session, revision: response.revision })
const remap = (response, method) => ({ ...response, method })

function unknownArguments(args, allowed) {
  if (!isRecord(args)) return 'Tool arguments must be an object'
  const extra = Object.keys(args).filter(key => !allowed.has(key) && !IGNORED.has(key))
  if (extra.length) return `Unknown arguments: ${extra.join(', ')}`
  return null
}

function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return `${label} must be a nonempty string of at most ${max} characters`
}

function unsupported(name, capability, hint) {
  return failure(name, 'unsupported_remote_capability',
    `${capability} is a Figma capability with no local Futureox implementation. This facade did not call the Design API or modify the document. ${hint}`)
}

/** Figma cloud/plugin ids use a numeric guid shape. Futureox local ids are UUIDs. */
export function isFigmaCloudNodeId(value) {
  return typeof value === 'string' && FIGMA_NODE_ID.test(value)
}

function cssForTrack(clip, track) {
  const stem = `futureox-${String(clip.id ?? 'clip').replace(/[^A-Za-z0-9_-]/g, '-')}-${String(track.nodeId).replace(/[^A-Za-z0-9_-]/g, '-')}`
  const frames = track.keyframes.map(keyframe => {
    const percent = clip.durationMs > 0 ? Math.min(100, Math.max(0, keyframe.timeMs / clip.durationMs * 100)) : 0
    const transform = Array.isArray(keyframe.value?.transform) && keyframe.value.transform.length === 6 ? keyframe.value.transform : [1, 0, 0, 1, 0, 0]
    const matrix = transform.map(value => Number.isFinite(value) ? Number(value.toFixed(6)) : 0).join(', ')
    const declarations = [`transform: matrix(${matrix})`]
    if (Number.isFinite(keyframe.value?.opacity)) declarations.push(`opacity: ${Number(keyframe.value.opacity.toFixed(4))}`)
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
    value: keyframe.value,
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
  const invalid = unknownArguments(args, new Set(['nodeId', 'recursive', 'cursor']))
  if (invalid) return failure('get_motion_context', 'invalid_params', invalid)
  const problem = text(args.nodeId, 'nodeId', 128)
  if (problem) return failure('get_motion_context', 'invalid_params', problem)
  if (isFigmaCloudNodeId(args.nodeId)) return failure('get_motion_context', 'unsupported_figma_node_id', 'Figma cloud node ids do not identify Futureox nodes. Use an id returned by get_metadata for this document.')
  if (typeof args.fileKey !== 'string' || !args.fileKey.trim() || args.fileKey.length > 512) return failure('get_motion_context', 'invalid_params', 'fileKey is required by the Figma-shaped schema and is ignored locally')
  if (args.recursive !== undefined && typeof args.recursive !== 'boolean') return failure('get_motion_context', 'invalid_params', 'recursive must be a boolean')
  if (!facade.methodNames.has('animation.list') || !facade.methodNames.has('animation.get') || !facade.methodNames.has('node.get'))
    return unsupported('get_motion_context', 'Figma keyframe motion', 'This session does not expose the local animation read API.')

  const node = await facade.call('node.get', { id: args.nodeId }, context)
  if (!node.ok) return remap(node, 'get_motion_context')
  const identity = identityOf(node)
  const ids = new Set([args.nodeId])
  let subtreeTruncated = false
  if (args.recursive && facade.methodNames.has('node.find')) {
    let cursor
    for (let page = 0; page < MOTION_PAGE_LIMIT; page++) {
      const found = await facade.call('node.find', { rootId: args.nodeId, limit: 100, ...(cursor ? { cursor } : {}) }, context, identity)
      if (!found.ok) break
      for (const entry of Array.isArray(found.result?.nodes) ? found.result.nodes : []) if (typeof entry?.id === 'string') ids.add(entry.id)
      cursor = found.result?.nextCursor
      if (!cursor) break
      if (page === MOTION_PAGE_LIMIT - 1) subtreeTruncated = true
    }
  }

  const listed = await facade.call('animation.list', {}, context, identity)
  if (!listed.ok) return remap(listed, 'get_motion_context')
  const summaries = Array.isArray(listed.result?.clips) ? listed.result.clips : []
  const clips = []
  const css = []
  let trackCount = 0
  let keyframeCount = 0
  for (const summary of summaries.slice(0, MOTION_CLIP_LIMIT)) {
    if (trackCount >= MOTION_TRACK_LIMIT || keyframeCount >= MOTION_KEYFRAME_TOTAL) break
    const read = await facade.call('animation.get', { id: summary.id }, context, identity)
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
  let cssText = css.join('\n')
  const cssTruncated = cssText.length > MOTION_CSS_CHARS
  if (cssTruncated) cssText = `${cssText.slice(0, MOTION_CSS_CHARS)}\n/* CSS snippet truncated. Narrow nodeId or recursive. */`
  const result = {
    format: 'futureox.figma-motion.v1', nodeId: args.nodeId, recursive: args.recursive === true,
    clips, css: cssText, truncated: summaries.length > MOTION_CLIP_LIMIT || subtreeTruncated || trackCount >= MOTION_TRACK_LIMIT || keyframeCount >= MOTION_KEYFRAME_TOTAL || cssTruncated,
    note: 'Authored local animation tracks and derived CSS. This is not Figma timeline playback, Motion (motion.dev) code generation, or a rendered animation. Easing is copied from the authored keyframe; spring easing has no CSS equivalent here.',
  }
  result.modelText = clips.length
    ? `Motion for ${args.nodeId}: ${clips.length} clip(s), ${trackCount} track(s).\n${result.css}`
    : `No authored animation tracks reference ${args.nodeId}${args.recursive ? ' or its readable descendants' : ''}.`
  return done('get_motion_context', identity, result)
}

function codeConnectUnavailable(name, capability) {
  return unsupported(name, capability, 'Use get_design_context and the design_* catalog for local component context.')
}

/** Dispatch one desktop Figma-shaped tool. The base facade has already stripped sessionId. */
export async function callFigmaDesktopTool(facade, name, args, context = {}) {
  if (!isFigmaDesktopTool(name)) return failure(name, 'unknown_tool', `Unknown Figma desktop-shaped tool ${name}`)
  if (FIGMA_DESKTOP_WRITE_TOOLS.has(name) && facade.scope !== 'write')
    return failure(name, 'read_only', 'This connection is read-only. Enable read and edit access to use Code Connect write tools.')
  try {
    if (name === 'get_motion_context') return await motionContext(facade, args ?? {}, context)
    const spec = FIGMA_DESKTOP_TOOL_SPECS.find(entry => entry.name === name)
    const invalid = unknownArguments(args ?? {}, new Set(Object.keys(spec.properties ?? {})))
    if (invalid) return failure(name, 'invalid_params', invalid)
    if (name === 'get_shader') {
      const problem = text(args.id, 'id', 256)
      if (problem) return failure(name, 'invalid_params', problem)
      return unsupported(name, 'Figma shader source', 'Futureox effects and fills are available through local node and context reads.')
    }
    if (name === 'list_shaders') return unsupported(name, 'Figma shader library', 'Futureox documents do not use Figma shader effects or shader fills.')
    if (name === 'get_figjam') return unsupported(name, 'FigJam document conversion', 'Futureox documents are not FigJam boards and have no connectors or FigJam-specific XML. Use get_metadata for a local outline.')
    if (name === 'get_code_connect_map' || name === 'get_code_connect_suggestions')
      return codeConnectUnavailable(name, 'Figma Code Connect')
    if (typeof args.fileKey !== 'string' || !args.fileKey.trim() || args.fileKey.length > 512) return failure(name, 'invalid_params', 'fileKey is required by the Figma-shaped schema and is ignored locally')
    if (name === 'add_code_connect_map') {
      for (const [key, max] of [['nodeId', 128], ['source', 2048], ['componentName', 512], ['label', 128]]) {
        const problem = text(args[key], key, max)
        if (problem) return failure(name, 'invalid_params', problem)
      }
      return codeConnectUnavailable(name, 'Figma Code Connect')
    }
    if (name === 'send_code_connect_mappings') {
      if (!Array.isArray(args.mappings) || !args.mappings.length || args.mappings.length > 100) return failure(name, 'invalid_params', 'mappings must contain 1-100 objects')
      return codeConnectUnavailable(name, 'Figma Code Connect')
    }
    return failure(name, 'unknown_tool', `Unknown Figma desktop-shaped tool ${name}`)
  } catch (error) {
    return failure(name, typeof error?.code === 'string' ? error.code : 'facade_error', error?.message || 'Figma desktop-shaped tool failed')
  }
}