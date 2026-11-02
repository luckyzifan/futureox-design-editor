/** Declared-domain fetch policy. There is no collaboration server and no ambient network grant.
 * https://www.figma.com/plugin-docs/manifest/#networkaccess */

const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.internal'])

export type NetworkDecision = { ok: true; url: URL } | { ok: false; reason: string }

function hostnameOf(rule: string): { protocol: string; host: string; port: string; wildcard: boolean } | null {
  const trimmed = rule.trim()
  if (!trimmed || trimmed === 'none' || trimmed === '*') return null
  const wildcard = trimmed.startsWith('*.')
  const withProtocol = wildcard ? `https://${trimmed.slice(2)}` : trimmed
  if (!/^https?:\/\//i.test(withProtocol)) return null
  let url: URL
  try { url = new URL(withProtocol) } catch { return null }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  const host = url.hostname.toLowerCase()
  if (wildcard && host.split('.').length < 2) return null
  return { protocol: url.protocol, host, port: url.port, wildcard }
}

function isLoopback(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isBlockedAddress(host: string) {
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') && host !== 'localhost') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map(Number)
  if (parts.some(part => part > 255)) return true
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return true
  return false
}

function ruleMatches(rule: string, url: URL) {
  const parsed = hostnameOf(rule)
  if (!parsed) return false
  if (parsed.protocol !== url.protocol) return false
  if (parsed.port && parsed.port !== url.port) return false
  const host = url.hostname.toLowerCase()
  if (parsed.wildcard) return host !== parsed.host && host.endsWith(`.${parsed.host}`)
  return host === parsed.host
}

/** Allow only manifest origins. Loopback http is allowed when listed. Other http, private networks, and metadata hosts are refused. */
export function matchNetworkAccess(urlString: string, allowed: readonly string[]): NetworkDecision {
  let url: URL
  try { url = new URL(urlString) } catch { return { ok: false, reason: 'Plugin fetch URL is invalid' } }
  if (url.username || url.password) return { ok: false, reason: 'Plugin fetch URLs cannot contain credentials' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Plugin fetch only allows http and https' }
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: 'Plugin fetch cannot reach metadata hosts' }
  const loopback = isLoopback(host)
  if (!loopback && isBlockedAddress(host)) return { ok: false, reason: 'Plugin fetch cannot reach private network addresses' }
  if (url.protocol === 'http:' && !loopback) return { ok: false, reason: 'Plugin fetch requires https except for an explicitly allowed localhost origin' }
  if (!allowed.some(rule => ruleMatches(rule, url))) return { ok: false, reason: 'Plugin fetch domain is not declared in networkAccess' }
  return { ok: true, url }
}

export type PluginFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; url: string; headers: Record<string, string>; body: Uint8Array }>

export const PLUGIN_FETCH_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

export function pluginFetchHeaders(value: unknown): Record<string, string> {
  if (value == null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fetch headers must be an object')
  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(headers).length >= 20) throw new Error('fetch allows at most 20 headers')
    const key = name.toLowerCase()
    if (['cookie', 'host', 'content-length', 'connection'].includes(key)) continue
    if (typeof header !== 'string' || header.length > 4000 || /[\r\n]/.test(header) || /[\r\n]/.test(name)) throw new Error('fetch header is invalid')
    headers[key] = header
  }
  return headers
}
