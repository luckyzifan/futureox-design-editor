/** Turn a workspace/native document body into the JSON string the renderer admits. */
export function publishedDocumentJson(result) {
  const documentJson = result?.documentJson
  const document = result?.document
  if (typeof documentJson === 'string' && documentJson.length) return documentJson
  const body = document !== undefined && document !== null ? document : documentJson
  if (typeof body === 'string') return body.length ? (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body) : undefined
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const text = Buffer.from(body).toString('utf8')
    if (!text || text === '\ufeff') return undefined
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    try { return JSON.stringify(body) }
    catch { return undefined }
  }
  return undefined
}
