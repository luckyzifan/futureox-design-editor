import { PluginApiError } from './errors'

export type RustPluginSession = {
  call(command: string): string
  free(): void
}

export async function openRustPluginSession(documentJson: string, optionsJson: string): Promise<RustPluginSession> {
  const specifier = new URL('../generated/design-kernel/design_kernel.js', import.meta.url).href
  let kernel: { default?: (input?: unknown) => Promise<unknown>; PluginSession?: new (document: string, options: string) => RustPluginSession }
  try {
    kernel = await import(/* @vite-ignore */ specifier)
  } catch {
    throw new PluginApiError('kernel_missing', 'Rebuild the design kernel before running a plugin. PluginSession is not in this build.')
  }
  if (typeof kernel.default === 'function') {
    try { await kernel.default() } catch { /* The editor may already have initialized this module. */ }
  }
  if (typeof kernel.PluginSession !== 'function') {
    throw new PluginApiError('kernel_missing', 'This design kernel does not export PluginSession. Rebuild the kernel and reload.')
  }
  return new kernel.PluginSession(documentJson, optionsJson)
}
