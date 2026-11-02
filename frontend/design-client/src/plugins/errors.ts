export class PluginApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginApiError'
    this.code = code
  }
}

export function pluginErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 2000)
  return String(error).slice(0, 2000)
}
