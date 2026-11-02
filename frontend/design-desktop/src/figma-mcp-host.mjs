/** Starts the loopback Figma-shaped MCP server for one enabled automation session.
 * The bearer token stays the bridge token. Status and errors must not repeat it. */

export function attachFigmaMcp(bridge, start) {
  const hosts = new Map()
  let published = null
  const rawClose = bridge.close.bind(bridge)
  const rawStatus = bridge.status.bind(bridge)
  const rawConnection = bridge.connection.bind(bridge)
  bridge.close = () => {
    const sessionId = bridge.active?.sessionId
    const host = sessionId ? hosts.get(sessionId) : undefined
    if (sessionId) hosts.delete(sessionId)
    published = null
    const closing = rawClose()
    return Promise.resolve()
      .then(() => host?.close?.())
      .then(() => closing, () => closing)
  }
  bridge.status = () => {
    const status = rawStatus()
    if (!published || status.sessionId !== published.sessionId) return status
    return { ...status, figmaMcp: published.info }
  }
  bridge.connection = () => {
    const value = rawConnection()
    if (!value || !published || published.sessionId !== value.sessionId || !published.info.url) return value
    return { ...value, figmaMcp: { url: published.info.url, transport: 'http', protocol: '2025-11-25' } }
  }
  return {
    async afterEnable(config) {
      let host
      try {
        host = await start(config)
        if (bridge.active?.sessionId !== config.sessionId) {
          await host?.close?.()
          const info = { available: false, reason: 'session-changed' }
          published = { sessionId: config.sessionId, info }
          return { ...config, figmaMcp: info }
        }
        if (host?.url) hosts.set(config.sessionId, host)
        const info = host?.url ? { url: host.url, transport: 'http' } : { available: false, reason: host?.reason || 'unavailable' }
        published = { sessionId: config.sessionId, info }
        return { ...config, figmaMcp: host?.url ? { ...info, protocol: '2025-11-25' } : info }
      } catch (error) {
        await host?.close?.()
        const reason = String(error?.message || 'unavailable').replaceAll(config.token || '', '[redacted]').slice(0, 200)
        const info = { available: false, reason }
        published = { sessionId: config.sessionId, info }
        return { ...config, figmaMcp: info }
      }
    },
  }
}

export async function startDesktopFigmaMcp(config) {
  const { startLoopbackFigmaMcp } = await import('../../design-mcp/src/figma-http.mjs')
  return startLoopbackFigmaMcp({
    endpoint: config.endpoint,
    sessionId: config.sessionId,
    token: config.token,
    connectTimeoutMs: 2000,
  })
}
