/** Canvas and the file menu open the existing plugin panel. No new host. */
export const OPEN_PLUGINS_EVENT = 'futureox-open-plugins'

const grantPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function pluginLaunchGrant(value: unknown): string | undefined {
  return typeof value === 'string' && grantPattern.test(value) ? value : undefined
}

export function requestOpenPlugins(grant?: string) {
  if (typeof window === 'undefined') return
  const accepted = pluginLaunchGrant(grant)
  window.dispatchEvent(new window.CustomEvent(OPEN_PLUGINS_EVENT, { detail: accepted ? { grant: accepted } : {} }))
}
