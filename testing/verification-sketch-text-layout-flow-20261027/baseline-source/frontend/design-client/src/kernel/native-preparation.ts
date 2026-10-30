import type { DesktopBridge } from '../desktop'
import type { PreparationMethod } from './preparation-channel'

/** Transport only: the preload sends jobs to a host Node worker + Rust child.
 * Browser builds retain their WASM preparation worker. GPU objects stay local. */
export function connectNativePreparation(bridge: NonNullable<DesktopBridge['preparation']>, port: MessagePort, onFailure?: (error: Error) => void, record?: (fields: Record<string, number>) => void) {
  let closed = false
  const active = new Map<number, () => void>()
  const failed = (error: unknown) => {
    if (closed) return
    const failure = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ fatal: failure.message })
    onFailure?.(failure)
  }
  const session = bridge.open()
  session.catch(failed)
  port.onmessage = async event => {
    if (event.data.cancel) { active.get(event.data.cancel)?.(); return }
    const { id, lane, method, args, diagnostics, cancellable, cancellation } = event.data as { id: number; lane: string; method: PreparationMethod; args: unknown[]; diagnostics?: { originChannelId: number; requestId: number }; cancellable?: boolean; cancellation?: SharedArrayBuffer }
    let timer: ReturnType<typeof setInterval> | undefined
    let cancelled = false
    active.set(id, () => { cancelled = true })
    const receivedAt = diagnostics ? performance.now() : 0
    const boundary = (boundaryCode: number) => {
      const bridgeBoundaryAt = performance.timeOrigin + performance.now()
      if (diagnostics && !closed) {
        try { record?.({ originChannelId: diagnostics.originChannelId, requestId: diagnostics.requestId, preparationId: id,
          channel: lane === 'interaction' ? 1 : 0, phase: 5, backendCode: 2, boundaryCode, bridgeBoundaryAt }) } catch { /* Diagnostics never fail transport. */ }
      }
      return bridgeBoundaryAt
    }
    const progress = (boundaryCode: number) => {
      if (!diagnostics || closed) return
      const bridgeBoundaryAt = boundary(boundaryCode), elapsed = performance.now() - receivedAt
      if (diagnostics && !closed) port.postMessage({ id, progress: { backendCode: 2, boundaryCode, bridgeBoundaryAt, ...(elapsed <= 120000 ? { boundaryDurationMs: elapsed } : {}) } })
    }
    progress(1)
    try {
      const owner = await session
      if (closed) return
      progress(5)
      const cancellationId = cancellable && method === 'compile_gpu_packet' ? id : undefined
      let notified = false
      const flag = typeof SharedArrayBuffer !== 'undefined' && cancellation instanceof SharedArrayBuffer && cancellation.byteLength === 4 ? new Int32Array(cancellation) : undefined
      const poll = () => {
        if (!notified && (cancelled || flag && Atomics.load(flag, 0))) {
          notified = true
          if (cancellationId !== undefined) void bridge.cancel?.(owner, cancellationId).catch(failed)
        }
      }
      const pending = bridge.request(owner, { lane, method, args, ...(cancellationId === undefined ? {} : { cancellationId }), ...(diagnostics ? { diagnostics: { originChannelId: diagnostics.originChannelId, requestId: diagnostics.requestId, preparationId: id } } : {}) })
      if (cancellationId !== undefined) { timer = setInterval(poll, 4); poll() }
      const reply = await pending
      progress(6)
      if (closed) return
      const transfer = reply.value instanceof Uint8Array || reply.value instanceof Float32Array ? [reply.value.buffer] : []
      const bridgeBoundaryAt = diagnostics ? boundary(13) : undefined
      port.postMessage({ ...reply, id, ...(bridgeBoundaryAt === undefined ? {} : { bridgeBoundaryAt }) }, transfer)
      if (diagnostics) boundary(14)
    } catch (error) {
      // Application errors arrive as replies. An IPC rejection means the
      // transport failed: retire the session without replaying this job.
      if (method === 'preparation_capabilities_v1') port.postMessage({ id, error: 'DERIVATION_UNSUPPORTED' })
      else failed(error)
    } finally { clearInterval(timer); active.delete(id) }
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
