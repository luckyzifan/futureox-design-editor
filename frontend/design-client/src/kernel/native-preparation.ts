import type { DesktopBridge } from '../desktop'
import type { PreparationMethod } from './preparation-channel'

/** Transport only: the preload sends jobs to a host Node worker + Rust child.
 * Browser builds retain their WASM preparation worker. GPU objects stay local. */
export function connectNativePreparation(bridge: NonNullable<DesktopBridge['preparation']>, port: MessagePort, onFailure?: (error: Error) => void) {
  let closed = false
  const failed = (error: unknown) => {
    if (closed) return
    const failure = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ fatal: failure.message })
    onFailure?.(failure)
  }
  const session = bridge.open()
  session.catch(failed)
  port.onmessage = async event => {
    const { id, lane, method, args } = event.data as { id: number; lane: string; method: PreparationMethod; args: unknown[] }
    try {
      const owner = await session
      if (closed) return
      const reply = await bridge.request(owner, { lane, method, args })
      if (closed) return
      const transfer = reply.value instanceof Uint8Array || reply.value instanceof Float32Array ? [reply.value.buffer] : []
      port.postMessage({ ...reply, id }, transfer)
    } catch (error) {
      // Application errors arrive as replies. An IPC rejection means the
      // transport failed: retire the session without replaying this job.
      failed(error)
    }
  }
  port.start()
  const close = () => {
    if (closed) return
    closed = true; port.close()
    void session.then(owner => bridge.close(owner)).catch(error => console.warn('Native preparation cleanup failed', error))
  }
  const serialize = async (value: unknown): Promise<string> => {
    const owner = await session
    if (closed) throw Error('Native preparation closed')
    const reply = await bridge.request(owner, { lane: 'canvas', method: 'serialize', args: [value] }).catch(error => { failed(error); throw error })
    if (reply.error) throw Error(reply.error)
    if (typeof reply.value !== 'string') throw Error('Invalid native serialization response')
    return reply.value
  }
  return { close, serialize }
}
