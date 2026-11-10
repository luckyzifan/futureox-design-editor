import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const methodKeys = ['name', 'code', 'dispatch', 'browser', 'host']
const rootKeys = ['protocol', 'methods', 'codecMethods']
const header = 'export const preparationProtocol = '
const footer = '\n} as const\n'

function exactKeys(value, keys) {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => actual.includes(key))
}

export function preparationProtocolSource(source) {
  if (!source.startsWith(header)) throw Error('Invalid preparation method protocol source')
  const end = source.indexOf(footer, header.length)
  if (end < 0) throw Error('Invalid preparation method protocol source')
  return JSON.parse(source.slice(header.length, end + 2))
}

/** Shared native-preparation allowlist. Method codes are this array's order and
 * stay stable for preparation diagnostics. Browser methods are also renderer
 * host methods; private source snapshots are not. The object above `as const`
 * is strict JSON so Rust can parse the same bytes. */
export function validatePreparationProtocol(value) {
  if (!value || typeof value !== 'object' || !exactKeys(value, rootKeys) || value.protocol !== 1 || !Array.isArray(value.methods) || !value.methods.length || !Array.isArray(value.codecMethods) || !value.codecMethods.length)
    throw Error('Invalid preparation method protocol')
  const names = new Set()
  for (const [index, method] of value.methods.entries()) {
    if (!method || typeof method !== 'object' || !exactKeys(method, methodKeys)) throw Error('Invalid preparation method')
    if (typeof method.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(method.name) || names.has(method.name)) throw Error('Invalid preparation method name')
    names.add(method.name)
    if (method.code !== index + 1) throw Error('Preparation method codes must stay in protocol order')
    if (method.dispatch !== 'all' && method.dispatch !== 'native') throw Error('Invalid preparation method dispatch')
    if (typeof method.browser !== 'boolean' || !['renderer', 'private', 'none'].includes(method.host)) throw Error('Invalid preparation method admission')
    if (method.browser && (method.host !== 'renderer' || method.dispatch !== 'all')) throw Error('Browser preparation methods require shared renderer admission')
  }
  if (value.codecMethods.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name) || names.has(name))) throw Error('Invalid preparation codec method')
  if (new Set(value.codecMethods).size !== value.codecMethods.length) throw Error('Duplicate preparation codec method')
  return value
}

export const preparationProtocol = validatePreparationProtocol(preparationProtocolSource(readFileSync(fileURLToPath(new URL('./preparation-methods-v1.ts', import.meta.url)), 'utf8')))

export function rendererHostMethods(protocol = preparationProtocol) {
  return new Set([...protocol.codecMethods, ...protocol.methods.filter(method => method.host === 'renderer').map(method => method.name)])
}

export function browserPreparationMethods(protocol = preparationProtocol) {
  return protocol.methods.filter(method => method.browser).map(method => method.name)
}
