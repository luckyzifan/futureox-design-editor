/** Errors the plugin author can catch. `unsupported` is a missing API, not a failed document commit. */
export class PluginApiError extends Error {
  readonly code: 'unsupported' | 'invalid'
  constructor(api: string, code: 'unsupported' | 'invalid') {
    super(code === 'unsupported'
      ? `Futureox plugin host does not implement ${api}. See docs/FIGMA_PLUGIN_HOST.md.`
      : `Invalid ${api} value for the Futureox plugin host.`)
    this.name = 'PluginApiError'
    this.code = code
  }
}

/** Internal control flow for `figma.closePlugin`. Plugin code may catch it; the host still treats the turn as closed. */
export class PluginClosed extends Error {
  constructor(readonly closeMessage: string | undefined) {
    super('Plugin closed')
    this.name = 'PluginClosed'
  }
}
