import { randomUUID } from 'node:crypto'
import { isRecord } from './framing.mjs'
const validBase64 = value => typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
const unavailable = message => Object.assign(new Error(`${message}; narrow or split the export and retry. No export bytes were returned inline.`), { code: 'artifact_unavailable' })
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value))

/** Attach actual small preview bytes, never fabricate/re-render. */
export function previewImage(response, maxBytes = 256 * 1024) {
  const result = response?.result
  if (response?.ok !== true || result?.format !== 'futureox.design-preview.v1' || !['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) || typeof result.dataUrl !== 'string') return
  const prefix = `data:${result.mimeType};base64,`
  if (!result.dataUrl.startsWith(prefix)) return
  const data = result.dataUrl.slice(prefix.length)
  if (!data || !validBase64(data)) return
  const image = { type: 'image', data, mimeType: result.mimeType }
  if (jsonBytes(image) > maxBytes) return
  return image
}

/** Bounded process-local export snapshots, never a design document store.
 * A projected export keeps metadata and field-addressed resources, never large
 * file bytes in model-facing tool output. All resources for one result are
 * admitted atomically, so a returned link is not evicted by its own siblings.
 */
export class ArtifactResources {
  constructor({ maxArtifacts = 16, maxBytes = 32 * 1024 * 1024, maxArtifactBytes = 32 * 1024 * 1024, maxResponseBytes = 32 * 1024 * 1024 } = {}) {
    Object.assign(this, { maxArtifacts, maxBytes, maxArtifactBytes, maxResponseBytes })
    this.records = new Map()
    this.bytes = 0
  }

  project(response, { metadataBytes = 128 * 1024 } = {}) {
    if (response.ok !== true || !isRecord(response.result)) return { value: response, links: [] }
    const result = response.result, metadata = { ...result }, candidates = []
    const text = (field, name, mimeType, encoding = 'text') => {
      if (typeof result[field] !== 'string') return
      candidates.push({ field, name, mimeType, encoding, text: result[field] }); delete metadata[field]
    }
    const blob = (field, name, mimeType) => {
      if (!validBase64(result[field])) throw unavailable('The backend returned invalid binary export data')
      candidates.push({ field, name, mimeType, encoding: 'base64', blob: result[field] }); delete metadata[field]
    }
    if (result.format === 'futureox.design-app.v1') {
      // Trusted exporter output is offered as inert downloadable resources.
      // The MCP server never evaluates the exported JavaScript.
      text('html', 'index.html', 'text/html'); text('css', 'styles.css', 'text/css')
      text('javascript', 'app.js', 'text/javascript'); text('appJson', 'app.json', 'application/json')
      text('readme', 'README.md', 'text/markdown')
      if (Array.isArray(result.assets) && result.assets.length) {
        candidates.push({ field: 'assets', name: 'assets.json', mimeType: 'application/json', encoding: 'json', text: JSON.stringify(result.assets) })
        delete metadata.assets; metadata.assetCount = result.assets.length
      }
    } else if (result.format === 'futureox.design-code.v1') {
      text('html', 'design.html', 'text/html'); text('css', 'design.css', 'text/css')
      if (Array.isArray(result.assets) && result.assets.length) {
        candidates.push({ field: 'assets', name: 'assets.json', mimeType: 'application/json', encoding: 'json', text: JSON.stringify(result.assets) })
        delete metadata.assets; metadata.assetCount = result.assets.length
      }
    } else if (result.format === 'futureox.design-document.v1' && result.mimeType === 'application/json') {
      text('content', 'design.json', 'application/json')
    } else if (result.format === 'futureox.design-vector.v1' && result.mimeType === 'image/svg+xml') {
      text('content', 'design.svg', 'image/svg+xml')
    } else if (result.format === 'futureox.design-document.v1' && result.nativeFormat === 'fd' && result.encoding === 'base64' && result.mimeType === 'application/vnd.futureox-desgin') {
      blob('base64', 'design.fd', result.mimeType)
    } else if (result.format === 'futureox.design-sketch.v1' && result.encoding === 'base64' && result.mimeType === 'application/zip') {
      blob('base64', 'design.sketch', result.mimeType)
    } else if (result.format === 'futureox.design-preview.v1') {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) || typeof result.dataUrl !== 'string') throw unavailable('The backend returned invalid preview media')
      const prefix = `data:${result.mimeType};base64,`, data = result.dataUrl.slice(prefix.length)
      if (!result.dataUrl.startsWith(prefix) || !data || !validBase64(data)) throw unavailable('The backend returned invalid preview data')
      candidates.push({ field: 'dataUrl', name: `preview.${result.mimeType.split('/')[1]}`, mimeType: result.mimeType, encoding: 'data-url', blob: data })
      delete metadata.dataUrl
    }
    if (!candidates.length) return { value: response, links: [] }
    if (jsonBytes(metadata) > metadataBytes) {
      candidates.push({ field: '$metadata', name: 'metadata.json', mimeType: 'application/json', encoding: 'json', text: JSON.stringify(metadata) })
      const keep = new Set(['format', 'language', 'nativeFormat', 'encoding', 'mimeType', 'filename', 'bytes', 'schemaVersion', 'lossless', 'fidelity', 'sourceDocumentId', 'documentId', 'pageId', 'session', 'revision', 'width', 'height', 'scale', 'bounds', 'backend', 'renderer', 'screenshot', 'target', 'assetCount', 'sourceNodeCount'])
      for (const key of Object.keys(metadata)) if (!keep.has(key)) delete metadata[key]
    }
    const prepared = candidates.map(candidate => {
      const storageBytes = Buffer.byteLength(candidate.text ?? candidate.blob)
      const size = candidate.blob === undefined ? storageBytes : candidate.blob.length / 4 * 3 - (candidate.blob.endsWith('==') ? 2 : candidate.blob.endsWith('=') ? 1 : 0)
      if (storageBytes > this.maxArtifactBytes) throw unavailable('An export artifact exceeds the cache limit')
      const uri = `futureox-design://artifacts/${randomUUID()}/${candidate.name}`
      const content = { uri, mimeType: candidate.mimeType, ...(candidate.blob === undefined ? { text: candidate.text } : { blob: candidate.blob }) }
      if (jsonBytes({ contents: [content] }) > this.maxResponseBytes - 2048) throw unavailable('An export artifact exceeds the resource response limit')
      const resource = { uri, name: candidate.name, mimeType: candidate.mimeType, size, description: `Actual ${response.method ?? 'design'} export, revision ${response.revision ?? 'unknown'}. Immutable export snapshot; never represents a later revision. MCP-session-local; expires on eviction or MCP disconnect. ${result.format === 'futureox.design-preview.v1' ? 'Display through client image rendering or save with resources/read; do not paste base64 as model text.' : 'Save through resources/read; inspect the design with context.get instead of reading binary into model context.'}` }
      return { resource, content, storageBytes, field: candidate.field, encoding: candidate.encoding }
    })
    const bytes = prepared.reduce((sum, item) => sum + item.storageBytes, 0)
    if (prepared.length > this.maxArtifacts || bytes > this.maxBytes) throw unavailable('The complete export cannot fit the bounded resource cache')
    while (this.records.size + prepared.length > this.maxArtifacts || this.bytes + bytes > this.maxBytes) {
      const [key, oldest] = this.records.entries().next().value
      this.records.delete(key); this.bytes -= oldest.storageBytes
    }
    for (const entry of prepared) { this.records.set(entry.resource.uri, entry); this.bytes += entry.storageBytes }
    metadata.resourceOnly = true
    metadata.resources = prepared.map(({ resource, field, encoding }) => ({ field, encoding, uri: resource.uri, mimeType: resource.mimeType, bytes: resource.size }))
    return { value: { ...response, result: metadata }, links: prepared.map(({ resource }) => ({ type: 'resource_link', ...resource })) }
  }

  capture(response) { return this.project(response).links }
  list() { return [...this.records.values()].map(entry => entry.resource) }
  read(uri) {
    const entry = this.records.get(uri)
    return entry ? { contents: [{ ...entry.content }] } : undefined
  }
  clear() { this.records.clear(); this.bytes = 0 }
}
