import { browserDiagnosticAdapter, classifyDiagnostic, createDiagnosticStore, installDiagnosticHooks, type DiagnosticAdapter } from '../../design-desktop/src/diagnostic-store.mjs'

// Identical schema/UI on both hosts; Electron uses a fixed app-owned local file.
const desktop = (globalThis as typeof globalThis & {coreDesktop?:{diagnostics?:{onError?(callback:(error:unknown)=>void):()=>void; read():Promise<{ok:boolean; data?:string|null}>; write(value:string):Promise<{ok:boolean}>}}}).coreDesktop?.diagnostics
const adapter: DiagnosticAdapter = desktop ? {
  async read() { const reply = await desktop.read(); if (!reply.ok) throw new Error('Diagnostic storage unavailable'); return reply.data ?? null },
  async write(value) { if (!(await desktop.write(value)).ok) throw new Error('Diagnostic storage unavailable') },
} : browserDiagnosticAdapter(() => localStorage)
export const localDiagnostics = createDiagnosticStore({adapter})
export function recordLocalError(component:string, error:unknown, fallback = 'OPERATION_FAILED') {
  const classified = classifyDiagnostic(error)
  return localDiagnostics.record({component, code:classified === 'OPERATION_FAILED' ? fallback : classified})
}
export function startLocalDiagnostics() {
  const remove = installDiagnosticHooks(window, localDiagnostics)
  const removeDesktop = desktop?.onError?.(error => recordLocalError('desktop', error))
  return () => { remove(); removeDesktop?.() }
}
