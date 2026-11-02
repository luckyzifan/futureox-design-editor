import { executePluginSource } from './run'
import { createPluginSession } from './session'
import type { PluginWorkerReply, PluginWorkerRequest } from './protocol'

let session: ReturnType<typeof createPluginSession> | null = null

function block(name: string) {
  const fail = () => { throw new Error(`Plugin ${name} is not available`) }
  try { Object.defineProperty(globalThis, name, { configurable: true, value: fail }) } catch { /* The host global is locked. */ }
}

self.onmessage = async (event: MessageEvent<PluginWorkerRequest>) => {
  const reply = (message: PluginWorkerReply) => self.postMessage(message)
  try {
    if (event.data?.type === 'start') {
      for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches']) block(name)
      session = createPluginSession(event.data.snapshot, { id: event.data.pluginId, name: event.data.pluginName, command: event.data.command })
      await executePluginSource(session, event.data.mainSource, event.data.uiHtml)
      reply({ ok: true, turn: session.exportTurn() })
    } else if (event.data?.type === 'ui') {
      if (!session) throw new Error('Plugin is not running')
      await session.deliver(event.data.pluginMessage)
      reply({ ok: true, turn: session.exportTurn() })
    } else {
      session = null
    }
  } catch (error) {
    reply({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}
