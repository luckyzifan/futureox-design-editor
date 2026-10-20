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
    const { id, lane, method, args, diagnostics } = event.data as { id: number; lane: string; method: PreparationMethod; args: unknown[]; diagnostics?: { originChannelId: number; requestId: number } }
    const receivedAt = performance.now()
    const progress = (boundaryCode: number) => { const elapsed = performance.now() - receivedAt; if (diagnostics && !closed) port.postMessage({ id, progress: { backendCode: 2, boundaryCode, ...(elapsed <= 120000 ? { boundaryDurationMs: elapsed } : {}) } }) }
    progress(1)
    try {
      const owner = await session
      if (closed) return
      progress(5)
      const reply = await bridge.request(owner, { lane, method, args, ...(diagnostics ? { diagnostics: { originChannelId: diagnostics.originChannelId, requestId: diagnostics.requestId, preparationId: id } } : {}) })
      progress(6)
      if (closed) return
      const transfer = reply.value instanceof Uint8Array || reply.value instanceof Float32Array ? [reply.value.buffer] : []
      port.postMessage({ ...reply, id }, transfer)
    } catch (error) {
      // Application errors arrive as replies. An IPC rejection means the
      // transport failed: retire the session without replaying this job.
      if (method === 'preparation_capabilities_v1') port.postMessage({ id, error: 'DERIVATION_UNSUPPORTED' })
      else failed(error)
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
