import { isRecord } from './framing.mjs'

export const MODERN_PROTOCOL_VERSION = '2026-07-28'
const prefix = 'io.modelcontextprotocol/'
export const modernKeys = Object.freeze({ version: `${prefix}protocolVersion`, capabilities: `${prefix}clientCapabilities`, clientInfo: `${prefix}clientInfo`, serverInfo: `${prefix}serverInfo` })
const extensionName = /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/
const cached = new Set(['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read'])
export function hasModernEnvelope(message) {
  return message.method === 'server/discover' || (isRecord(message.params?._meta) && [modernKeys.version, modernKeys.capabilities, modernKeys.clientInfo, `${prefix}logLevel`].some(key => Object.hasOwn(message.params._meta, key)))
}
export function admitModern(params, ErrorType) {
  const meta = params?._meta
  const fail = message => { throw new ErrorType(-32602, message) }
  if (!isRecord(meta) || typeof meta[modernKeys.version] !== 'string' || !isRecord(meta[modernKeys.capabilities])) fail('Each modern request requires protocolVersion and clientCapabilities in params._meta')
  if (meta[modernKeys.version] !== MODERN_PROTOCOL_VERSION) throw new ErrorType(-32022, 'Unsupported protocol version', { requested: meta[modernKeys.version], supported: [MODERN_PROTOCOL_VERSION] })
  validateCapabilities(meta[modernKeys.capabilities], fail)
  const info = meta[modernKeys.clientInfo]
  if (info !== undefined && (!isRecord(info) || typeof info.name !== 'string' || typeof info.version !== 'string')) fail('clientInfo requires name and version strings')
  if (info !== undefined) {
    for (const key of ['title', 'websiteUrl', 'description']) if (info[key] !== undefined && typeof info[key] !== 'string') fail(`Invalid clientInfo ${key}`)
    if (info.icons !== undefined && (!Array.isArray(info.icons) || info.icons.some(icon => !isRecord(icon) || typeof icon.src !== 'string' || (icon.mimeType !== undefined && typeof icon.mimeType !== 'string') || (icon.sizes !== undefined && (!Array.isArray(icon.sizes) || icon.sizes.some(size => typeof size !== 'string'))) || (icon.theme !== undefined && !['light', 'dark'].includes(icon.theme))))) fail('Invalid clientInfo icons')
  }
  const logLevel = meta[`${prefix}logLevel`]
  if (logLevel !== undefined && !['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(logLevel)) fail('Invalid logLevel')
  if (meta.progressToken !== undefined && typeof meta.progressToken !== 'string' && !(typeof meta.progressToken === 'number' && Number.isFinite(meta.progressToken))) fail('Invalid progressToken')
  // The parsed JSON object belongs only to this request. Never store on server,
  // never merge with a previous request, never use client assertions as grants.
  return Object.freeze({ protocolVersion: MODERN_PROTOCOL_VERSION, clientCapabilities: meta[modernKeys.capabilities], ...(info === undefined ? {} : { clientInfo: info }) })
}
export function modernResult(method, value, serverInfo) {
  return { ...value, resultType: 'complete', _meta: { ...value?._meta, [modernKeys.serverInfo]: serverInfo }, ...(cached.has(method) ? { ttlMs: 0, cacheScope: 'private' } : {}) }
}
export function modernDiscovery(serverInfo) {
  return modernResult('server/discover', {
    supportedVersions: [MODERN_PROTOCOL_VERSION], capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: 'Live local design bridge. Read capabilities and revision before writes. One trusted authorization context per process; client metadata never authorizes. Export resource_links are explicit immutable process-local handles, invalidated by eviction, process close or backend disconnect/revocation; no cross-process recovery. Cancellation cannot roll back committed mutations. No HTTP, cloud, arbitrary code, renderer controls, tasks or subscriptions.',
  }, serverInfo)
}

// Validate the published known capability vocabulary without rejecting opaque
// future top-level capabilities. Named extension maps contain JSON objects.
function validateCapabilities(value, fail) {
  const object = (parent, key) => { if (parent[key] !== undefined && !isRecord(parent[key])) fail(`Invalid clientCapabilities ${key}`); return parent[key] }
  for (const key of ['experimental', 'extensions']) {
    const map = object(value, key)
    if (key === 'extensions' && map && Object.keys(map).some(name => !extensionName.test(name))) fail('Extension identifiers require a valid prefix/name')
    if (map && Object.values(map).some(entry => !isRecord(entry))) fail(`Invalid clientCapabilities ${key} entry`)
  }
  const sampling = object(value, 'sampling')
  if (sampling) { object(sampling, 'context'); object(sampling, 'tools') }
  const elicitation = object(value, 'elicitation')
  if (elicitation) { object(elicitation, 'form'); object(elicitation, 'url') }
  object(value, 'roots')
  // Unknown modern capability names (including legacy tasks) stay opaque JSON.
  // JSON.parse accepts overflowing numeric literals (1e400). Such values are
  // not JSON data in capability schemas. Iteration avoids recursive stack use.
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'number' && !Number.isFinite(item)) fail('Capability metadata must contain finite JSON numbers')
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push(child)
  }
}
