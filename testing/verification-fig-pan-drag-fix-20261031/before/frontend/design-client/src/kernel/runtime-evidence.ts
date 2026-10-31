import { activeKernelClients, renderExecutionPolicy } from './client'

export async function renderDeviceEvidence() {
  return (await Promise.allSettled(activeKernelClients().map(client=>client.gpuMemorySnapshot())))
    .map(result=>result.status==='fulfilled'?result.value:{error:String(result.reason)})
}

/** Validation-page metadata, collected before timed work. An exposed API is
 * not proof of GPU execution; actual backend/presentation stats are separate. */
export async function renderRuntimeEvidence() {
  let host: Record<string, unknown> | undefined
  try {
    const response = await fetch('/__render_environment')
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) host = await response.json()
  } catch { /* Optional test host endpoint; ordinary Web builds do not have it. */ }
  return { userAgent: navigator.userAgent, dpr: devicePixelRatio, visibility:document.visibilityState, webgpuExposed: !!navigator.gpu,
    executionPolicy: renderExecutionPolicy, host: host || { host: window.coreDesktop ? 'electron' : 'web' } }
}
