import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

/** Outside ASAR so both Electron and external stdio clients can run these exact files. */
export function desktopMcpPaths(resourcesPath) {
  const root = resourcesPath ? path.join(resourcesPath, 'design-mcp', 'src') : fileURLToPath(new URL('../../design-mcp/src/', import.meta.url))
  return { cli: path.join(root, 'cli.mjs'), figmaCli: path.join(root, 'figma-cli.mjs'), http: path.join(root, 'figma-http.mjs') }
}

// Some clients replace the child environment with this object. Packaged Electron
// still has to resolve its libraries, temporary directory, and locale from here.
const LAUNCH_ENV_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA']

function readEnv(env, name, platform) {
  if (platform !== 'win32') return { key: name, value: env[name] }
  const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase())
  return key ? { key, value: env[key] } : { key: name, value: undefined }
}

export function packagedElectronLaunchEnv(baseEnv = process.env, platform = process.platform) {
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of LAUNCH_ENV_KEYS) {
    const { key, value } = readEnv(baseEnv, name, platform)
    if (typeof value !== 'string' || value.length === 0 || value.length > 32768 || /[\0\r\n]/.test(value)) continue
    env[key] = value
  }
  return env
}

export function desktopMcpClientConfig(connection, cli, executable = process.execPath, options = {}) {
  const baseEnv = options.env ?? process.env
  const platform = options.platform ?? process.platform
  return { mcpServers: { futureox_design: {
    command: executable, args: [cli],
    env: {
      ...packagedElectronLaunchEnv(baseEnv, platform),
      FUTUREOX_DESIGN_SOCKET: connection.endpoint,
      FUTUREOX_DESIGN_SESSION: connection.sessionId,
      FUTUREOX_DESIGN_BRIDGE_TOKEN: connection.token,
    },
  } } }
}

export function codexMcpToml({ mcpServers: { futureox_design: entry } }) {
  return ['[mcp_servers.futureox_design]', 'command = ' + JSON.stringify(entry.command),
    'args = ' + JSON.stringify(entry.args), '', '[mcp_servers.futureox_design.env]',
    ...Object.entries(entry.env).map(([key, value]) => key + ' = ' + JSON.stringify(value)), ''].join('\n')
}

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
        if (bridge.active?.sessionId === config.sessionId) published = { sessionId: config.sessionId, info }
        return { ...config, figmaMcp: info }
      }
    },
  }
}

export async function startDesktopFigmaMcp(config, resourcesPath) {
  const { startLoopbackFigmaMcp } = await import(pathToFileURL(desktopMcpPaths(resourcesPath).http).href)
  return startLoopbackFigmaMcp({
    endpoint: config.endpoint,
    sessionId: config.sessionId,
    token: config.token,
    connectTimeoutMs: 2000,
  })
}
