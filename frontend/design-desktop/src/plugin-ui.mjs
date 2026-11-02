import { randomUUID } from 'node:crypto'
import { isAppResource } from './security.mjs'

export const PLUGIN_UI_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const MAX_HTML_BYTES = 512 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isPluginUiRequest(url) {
  if (typeof url !== 'string' || url.length > 80) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'design-app:' && parsed.hostname === 'plugin' && !parsed.port && !parsed.username &&
      !parsed.search && !parsed.hash && ID.test(parsed.pathname.slice(1))
  } catch {
    return false
  }
}

export function isRendererRequestAllowed(url) {
  return isAppResource(url) || (typeof url === 'string' && (
    url.startsWith('blob:design-app://app/') || url.startsWith('data:') || isPluginUiRequest(url)
  ))
}

export function pluginUiDocument(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PLUGIN_UI_CSP}"></head><body>${html}</body></html>`
}

function pluginHeaders(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PLUGIN_UI_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  }
}

/** One in-memory UI document. The renderer cannot choose the URL or the response headers. */
export function createPluginUiHost() {
  let current = null
  return {
    publish(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'html'))
        return { status: 'error', code: 'PLUGIN_UI_REJECTED', message: 'Plugin UI requires an html string' }
      const html = value.html
      if (typeof html !== 'string' || html.includes('\0') || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES)
        return { status: 'error', code: 'PLUGIN_UI_REJECTED', message: 'Plugin UI must be text within 512 KiB' }
      const id = randomUUID()
      current = { id, html: pluginUiDocument(html) }
      return { status: 'ok', id, url: `design-app://plugin/${id}` }
    },
    revoke(value) {
      if (value && typeof value === 'object' && !Array.isArray(value) && value.id === current?.id) current = null
      return { status: 'ok' }
    },
    respond(request) {
      let url
      try { url = new URL(request.url) } catch { return null }
      if (url.protocol !== 'design-app:' || url.hostname !== 'plugin') return null
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (request.method !== 'GET' || url.port || url.username || url.search || url.hash || !current || current.id !== id)
        return new Response('Not found', { status: request.method === 'GET' ? 404 : 405, headers: pluginHeaders() })
      return new Response(current.html, { status: 200, headers: pluginHeaders() })
    },
  }
}
