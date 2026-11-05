/** Plugin failures stay distinguishable from editor commit errors. */
export class PluginApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginApiError'
    this.code = code
  }
}

/** Thrown after a successful flush so the guest script stops at closePlugin. */
export class PluginClosed extends Error {
  readonly code = 'plugin_closed'
  constructor(message: string) {
    super(message)
    this.name = 'PluginClosed'
  }
}
