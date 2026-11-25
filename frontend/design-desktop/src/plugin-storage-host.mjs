import { createHash, randomUUID } from 'node:crypto'
import { record } from './security.mjs'

const LIMIT = 8 * 1024 * 1024
const digest = value => createHash('sha256').update(value).digest('hex')

export function createPluginStorageHost({ folderScope, request }) {
  let active
  function leaseError() {
    return Object.assign(new Error('The plugin storage session ended'), { code: 'PLUGIN_STORAGE_SESSION' })
  }
  return {
    begin(source) {
      record(source, ['folderGrant', 'archiveDigest', 'sample'])
      if (Object.keys(source).length !== 1) throw new Error('Invalid plugin storage origin')
      let scope
      if (Object.hasOwn(source, 'folderGrant')) scope = folderScope(source.folderGrant)
      else if (source.sample === true) scope = digest('bundled-plugin\0labeled-rectangles')
      else if (typeof source.archiveDigest === 'string' && /^[a-f0-9]{64}$/.test(source.archiveDigest))
        scope = digest('archive-plugin\0' + source.archiveDigest)
      else throw new Error('Invalid plugin storage origin')
      active = { scope, token: randomUUID() }
      return active.token
    },
    async call(token, operation) {
      const owner = active
      if (!owner || owner.token !== token) throw leaseError()
      record(operation, ['kind', 'key', 'value'])
      let bytes = 0
      if (operation.kind === 'keys') record(operation, ['kind'])
      else if (operation.kind === 'get' || operation.kind === 'delete') record(operation, ['kind', 'key'])
      else if (operation.kind === 'set') {
        const value = record(operation.value, ['kind', 'json', 'rawBytes', 'parts'])
        if (value.kind === 'json') {
          record(value, ['kind', 'json'])
          if (typeof value.json !== 'string') throw new Error('Invalid plugin storage JSON')
          bytes = Buffer.byteLength(value.json, 'utf8')
        } else if (value.kind === 'bytes') {
          record(value, ['kind', 'rawBytes', 'parts'])
          if (!Number.isInteger(value.rawBytes) || value.rawBytes < 0 || value.rawBytes > 5 * 1024 * 1024 ||
              !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 48 ||
              value.parts.some(part => typeof part !== 'string' || part.length > 200_000))
            throw new Error('Invalid plugin storage bytes')
          bytes = value.parts.reduce((sum, part) => sum + part.length, 0)
        } else if (value.kind === 'undefined') record(value, ['kind'])
        else throw new Error('Invalid plugin storage value')
      } else throw new Error('Invalid plugin storage operation')
      if (operation.kind !== 'keys' && (typeof operation.key !== 'string' ||
          !/^(?:[a-f0-9]{4}){1,200}$/.test(operation.key))) throw new Error('Invalid plugin storage key')
      if (bytes > LIMIT) throw new Error('Plugin storage value exceeds the data limit')
      const method = operation.kind === 'set' || operation.kind === 'delete' ? 'plugin.storage.write' : 'plugin.storage.read'
      const assertCurrent = () => { if (active !== owner) throw leaseError() }
      const result = await request(method, { scope: owner.scope, operation }, bytes, assertCurrent)
      assertCurrent()
      return result
    },
    end(token) { if (active?.token === token) active = undefined },
    clear() { active = undefined },
  }
}
