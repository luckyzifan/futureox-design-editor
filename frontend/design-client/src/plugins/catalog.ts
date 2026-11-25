import { parsePluginManifest, type PluginManifest } from './rich-host/manifest'

export type DeclaredPlugin = {
  grant: string
  manifestText: string
  displayName: string
  id: string
  name: string
}

const grantPattern = /^[0-9a-f-]{36}$/

/** Keep the plugins the desktop grants. Derive their names and identities from the manifest. */
export function acceptedDeclaredPlugins(value: unknown): DeclaredPlugin[] {
  if (!Array.isArray(value)) return []
  const plugins: DeclaredPlugin[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (plugins.length >= 32) break
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const grant = record.grant
    const manifestText = record.manifestText
    if (typeof grant !== 'string' || !grantPattern.test(grant) || seen.has(grant)) continue
    if (typeof manifestText !== 'string' || new TextEncoder().encode(manifestText).byteLength > 64 * 1024) continue
    let manifest: PluginManifest
    try { manifest = parsePluginManifest(JSON.parse(manifestText), { desktopFolder: true }) } catch { continue }
    seen.add(grant)
    plugins.push({
      grant,
      id: manifest.id,
      name: manifest.name,
      displayName: manifest.name,
      manifestText,
    })
  }
  return plugins
}

export function declaredPluginFiles(manifest: { main: string; ui?: string }) {
  return manifest.ui ? [manifest.main, manifest.ui] : [manifest.main]
}
