import { PluginClosed } from './errors'
import type { PluginSession } from './session'

/** Run plugin main as an async function body so top-level await works. The worker global, not this wrapper, is the isolation boundary. */
export async function executePluginSource(session: PluginSession, source: string, html: string) {
  if (typeof source !== 'string' || source.length > 1_000_000) throw new Error('Plugin main exceeds 1 MiB')
  if (typeof html !== 'string' || html.length > 1_000_000) throw new Error('Plugin UI file exceeds 1 MiB')
  const runner = new Function(
    'figma', '__html__', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches',
    `return (async () => {\n${source}\n})()`,
  ) as (figma: unknown, html: string, ...blocked: unknown[]) => Promise<unknown>
  const blocked = () => { throw new Error('Plugin network and storage APIs are not available') }
  try {
    await runner(session.figma, html, blocked, blocked, blocked, blocked, blocked, blocked)
  } catch (error) {
    if (error instanceof PluginClosed) return
    throw error
  }
}
