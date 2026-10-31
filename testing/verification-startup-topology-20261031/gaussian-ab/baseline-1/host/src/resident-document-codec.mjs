import { DOCUMENT_BYTE_LIMIT, assertDocumentSerialization } from './document-capacity.mjs'
// Encoding fragments only: no document semantics, edits, history or filesystem.
// One owner is retained per existing renderer-owned codec worker.
export class ResidentDocumentCodec {
  constructor(limit = DOCUMENT_BYTE_LIMIT) { this.limit = limit; this.state = undefined }
  encode(request) {
    const {owner, base, sequence, install, fieldOrder, nodeOrder, fields, nodes} = request || {}
    if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128 ||
        !Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(sequence) || sequence <= base ||
        typeof install !== 'boolean' || install && base !== 0) throw Error('Invalid codec sequence')
    const order = value => Array.isArray(value) && value.length <= 1000000 &&
      value.every(key => typeof key === 'string') && new Set(value).size === value.length
    if (!order(fieldOrder) || !order(nodeOrder) || !fieldOrder.includes('nodes') || fieldOrder.length > 256)
      throw Error('Invalid codec key order')
    if (!install && (!this.state || this.state.owner !== owner || this.state.sequence !== base))
      throw Error('CODEC_BASE_MISSING')
    const update = (previous, replacements, keys, nodeMap) => {
      if (!Array.isArray(replacements) || replacements.length > keys.length) throw Error('Invalid codec replacements')
      const result = new Map(), allowed = new Set(keys), changes = new Map()
      for (const entry of replacements) {
        if (!Array.isArray(entry) || entry.length !== 2 || !allowed.has(entry[0]) || changes.has(entry[0]) ||
            !nodeMap && entry[0] === 'nodes') throw Error('Invalid codec replacement')
        assertDocumentSerialization(entry[1], this.limit)
        const value = JSON.stringify(entry[1])
        if (typeof value !== 'string') throw Error('Invalid codec value')
        changes.set(entry[0], {text:value, bytes:Buffer.byteLength(value)})
      }
      for (const key of keys) {
        if (!nodeMap && key === 'nodes') continue
        const value = changes.get(key) || previous?.get(key)
        if (!value) throw Error('Incomplete codec install')
        result.set(key, value)
      }
      return result
    }
    let prior = install ? undefined : this.state
    if (request.installJson !== undefined) {
      if (!install || typeof request.installJson !== 'string' || Buffer.byteLength(request.installJson) > this.limit)
        throw Error('Invalid codec prepared base')
      const document = JSON.parse(request.installJson)
      assertDocumentSerialization(document, this.limit)
      if (!document || typeof document !== 'object' || Array.isArray(document) ||
          !document.nodes || typeof document.nodes !== 'object' || Array.isArray(document.nodes))
        throw Error('Invalid codec prepared document')
      const fields = Object.keys(document), nodes = Object.keys(document.nodes)
      if (!order(fields) || fields.length > 256 || !order(nodes)) throw Error('Invalid codec prepared key order')
      // Stage the prepared base locally. A bad delta must retain the previously
      // acknowledged owner/sequence and its complete encoding fragments.
      prior = {
        fields: update(undefined, Object.entries(document).filter(([key]) => key !== 'nodes'), fields, false),
        nodes: update(undefined, Object.entries(document.nodes), nodes, true),
      }
    }
    const nextNodes = update(prior?.nodes, nodes, nodeOrder, true)
    const nextFields = update(prior?.fields, fields, fieldOrder, false)
    let nodeBytes = 2, bytes = 2
    for (const [key,value] of nextNodes) nodeBytes += Buffer.byteLength(JSON.stringify(key)) + 1 + value.bytes
    nodeBytes += Math.max(0,nodeOrder.length-1)
    for (const key of fieldOrder) bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + (key === 'nodes' ? nodeBytes : nextFields.get(key).bytes)
    bytes += Math.max(0,fieldOrder.length-1)
    if (!Number.isSafeInteger(bytes) || bytes > this.limit) throw Error('Document exceeds the available working-memory allowance')
    const nodeText = '{' + nodeOrder.map(key => JSON.stringify(key)+':'+nextNodes.get(key).text).join(',') + '}'
    const json = '{' + fieldOrder.map(key => JSON.stringify(key)+':'+(key==='nodes' ? nodeText : nextFields.get(key).text)).join(',') + '}'
    this.state = {owner,sequence,nodes:nextNodes,fields:nextFields}
    return {owner,sequence,json}
  }
}
