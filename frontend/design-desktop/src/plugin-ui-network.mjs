import { lookup as systemLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { record } from './security.mjs'

const MAX_BODY_BYTES = 1024 * 1024
const restricted = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) restricted.addSubnet(address, prefix)

function denial() {
  return new Error('The plugin UI request is outside its network permissions')
}

function allowedPatterns(domains) {
  if (domains === undefined) return []
  if (!Array.isArray(domains) || domains.length > 40 ||
      domains.some(domain => typeof domain !== 'string' || domain.length > 200)) throw denial()
  // Apply only the public HTTPS-origin subset. Path rules, local development,
  // other schemes and an unrestricted wildcard never expand this policy.
  return domains.flatMap(domain => {
    const match = /^(?:https:\/\/)?(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?\/?$/i.exec(domain.trim())
    if (!match || isIP(match[2])) return []
    return [{ host: match[2].toLowerCase(), subdomains: Boolean(match[1]) }]
  })
}

function checkedRequest(input, patterns) {
  const { url: address, method, accept } = record(input, ['url', 'method', 'accept'])
  if (typeof address !== 'string' || address.length > 2000 || !['GET', 'HEAD'].includes(method) ||
      typeof accept !== 'string' || accept.length > 240 || /[\u0000-\u001f\u007f]/.test(accept)) throw denial()
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) || !patterns.some(({ host, subdomains }) => {
        return subdomains ? url.hostname.endsWith('.' + host) : url.hostname === host
      })) throw denial()
  url.hash = ''
  return { url, method, accept }
}

function untilAbort(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function fetchPublicHttps(request, address, signal, open) {
  return new Promise((resolve, reject) => {
    const outgoing = open(request.url, {
      method: request.method, agent: false, signal,
      servername: request.url.hostname,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      family: 4, autoSelectFamily: false,
      // Pin the connection to the already checked address. TLS still verifies
      // the manifest-approved hostname, even if DNS changes before connect.
      lookup: (_hostname, _options, done) => done(null, address, 4),
      headers: { accept: request.accept, 'accept-encoding': 'identity', origin: 'null' },
    }, response => {
      response.on('error', reject)
      const status = response.statusCode ?? 0
      const cors = response.headers['access-control-allow-origin']
      const encoding = response.headers['content-encoding']
      const redirect = status >= 300 && status < 400
      const publicResponse = cors === '*' || cors === 'null'
      if (status < 200 || status > 599 || redirect || !publicResponse || encoding && encoding !== 'identity' ||
          Number(response.headers['content-length']) > MAX_BODY_BYTES) {
        response.destroy()
        reject(new Error('The plugin UI response is unavailable under its network policy'))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) {
          response.destroy()
          reject(new Error('The plugin UI response exceeded 1 MiB'))
        } else chunks.push(chunk)
      })
      response.on('aborted', () => reject(new Error('The plugin UI response was interrupted')))
      response.on('end', () => {
        const headers = Object.fromEntries(['content-type', 'cache-control', 'etag'].flatMap(key =>
          typeof response.headers[key] === 'string' ? [[key, response.headers[key]]] : []))
        resolve({ status, headers, url: request.url.href, base64: Buffer.concat(chunks).toString('base64') })
      })
    })
    outgoing.on('error', reject)
    outgoing.on('upgrade', (_response, socket) => { socket.destroy(); reject(denial()) })
    outgoing.end()
  })
}

export function createPluginUiNetwork(domains, { lookup = systemLookup, request = httpsRequest } = {}) {
  const patterns = allowedPatterns(domains)
  const owner = new AbortController()
  let used = 0
  let pending = 0
  return {
    close() { owner.abort() },
    async fetch(input) {
      if (owner.signal.aborted || pending >= 4 || used >= 32) throw denial()
      used += 1
      const checked = checkedRequest(input, patterns)
      pending += 1
      try {
        const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(5000)])
        const addresses = await untilAbort(lookup(checked.url.hostname, { family: 4, all: true }), signal)
        if (!addresses.length || addresses.some(({ address, family }) => family !== 4 || isIP(address) !== 4 || restricted.check(address))) throw denial()
        signal.throwIfAborted()
        return await fetchPublicHttps(checked, addresses[0].address, signal, request)
      } finally { pending -= 1 }
    },
  }
}
