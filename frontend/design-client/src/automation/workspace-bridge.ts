import type { Editor } from '../engine'
import { hasPendingEdits } from '../pending-edits'
import type { DesktopAutomationRequest } from './bridge'

export interface WorkspaceAutomationSnapshot {
  documentId: string
  session: number
  revision: number
  storageRevision: number | null
  dirty: boolean
  busy: boolean
  pendingEdits: boolean
  interactionActive: boolean
}
export type WorkspaceAutomationOperation = 'workspace.open' | 'workspace.save' | 'workspace.restore' | 'settings.get' | 'settings.update'
export interface WorkspaceAutomationGuard { documentId: string; session: number; expectedRevision: number; grantSessionId?: string }
export interface WorkspaceAutomationAdapter {
  inspect(): Pick<WorkspaceAutomationSnapshot, 'storageRevision' | 'dirty' | 'busy'>
  execute(method: WorkspaceAutomationOperation, params: Record<string, unknown>, guard: WorkspaceAutomationGuard, signal: AbortSignal): unknown | Promise<unknown>
}
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const allowed: Record<string, string[]> = {
  inspect: [],
  'workspace.open': ['id'],
  'workspace.save': ['expectedStorageRevision', 'mutationId'],
  'workspace.restore': ['id', 'revision', 'expectedStorageRevision', 'mutationId'],
  'settings.get': [],
  'settings.update': ['patch', 'expectedSettingsRevision', 'mutationId'],
}

/** Trusted main-process calls only: no raw caller IDs/paths are resolved here.
 * The adapter must recheck guard after awaits and at its final commit boundary. */
export function createWorkspaceAutomationRenderer(editor: Editor, adapter: WorkspaceAutomationAdapter) {
  const inspect = (): WorkspaceAutomationSnapshot => {
    const state = adapter.inspect()
    return { ...state, busy: state.busy || !!editor.state.busy, documentId: editor.state.doc.id,
      session: editor.sessionGeneration, revision: editor.state.version,
      pendingEdits: hasPendingEdits(editor), interactionActive: !!editor.interactionActive }
  }
  return {
    async execute(payload: DesktopAutomationRequest, signal: AbortSignal): Promise<unknown> {
      const operation = payload.hostOperation
      if (payload.kind !== 'host' || !operation || !Object.hasOwn(allowed, operation.method) || !plain(operation.params) ||
        Object.keys(operation.params).some(key => !allowed[operation.method].includes(key)) ||
        allowed[operation.method].some(key => !Object.hasOwn(operation.params, key))) throw failure('INVALID_PARAMS', 'Invalid trusted host operation')
      const params = operation.params
      const revision = (value: unknown, minimum = 1) => Number.isSafeInteger(value) && (value as number) >= minimum
      if (('mutationId' in params && (typeof params.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.mutationId))) ||
        ('id' in params && (typeof params.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(params.id))) ||
        ('revision' in params && !revision(params.revision)) ||
        ('expectedStorageRevision' in params && !(operation.method === 'workspace.save' && params.expectedStorageRevision === null) && !revision(params.expectedStorageRevision)) ||
        ('expectedSettingsRevision' in params && !revision(params.expectedSettingsRevision, 0)) ||
        ('patch' in params && (!plain(params.patch) || !Object.keys(params.patch).length || Object.entries(params.patch).some(([key, value]) =>
          ['snap', 'snapPixels', 'pixelGrid', 'rulers', 'checkerboard', 'grid', 'scrollWheelZoom'].includes(key) ? typeof value !== 'boolean' : key !== 'shortcutProfile' || !['figma-like', 'sketch-like'].includes(value as string))))) throw failure('INVALID_PARAMS', 'Invalid trusted host arguments')
      const check = (mutates = false) => {
        if (signal.aborted) throw signal.reason ?? failure('CANCELLED', 'The request was cancelled')
        if (!Number.isFinite(payload.deadline) || Date.now() >= payload.deadline) throw failure('TIMEOUT', 'The request expired')
        const state = inspect()
        if (payload.documentId !== state.documentId || payload.session !== state.session) throw failure('STALE_SESSION', 'The editor session changed')
        if (mutates) {
          if (!Number.isSafeInteger(payload.request?.expectedRevision)) throw failure('REVISION_REQUIRED', 'The observed editor revision is required')
          if (payload.request?.expectedRevision !== state.revision) throw failure('REVISION_CONFLICT', 'The editor changed')
          if (state.busy || editor.state.busy) throw failure('BUSY', 'Finish the current editor operation first')
          if (state.pendingEdits) throw failure('PENDING_EDITS', 'Finish the pending input first; it has been preserved')
          if (state.interactionActive) throw failure('INTERACTION_ACTIVE', 'Finish or cancel the current gesture first')
          if (['workspace.open', 'workspace.restore'].includes(operation.method) && state.dirty) throw failure('DIRTY_DOCUMENT', 'Save the current document before switching or restoring history')
        }
        return state
      }
      const mutates = operation.method !== 'inspect' && operation.method !== 'settings.get'
      const state = check(mutates)
      if (operation.method === 'inspect') return state
      const result = await adapter.execute(operation.method as WorkspaceAutomationOperation, operation.params,
        { documentId: state.documentId, session: state.session, expectedRevision: state.revision, grantSessionId: payload.sessionId }, signal)
      // Navigation deliberately invalidates the old document grant. Never label
      // a result from a different editor session as belonging to the old one.
      check()
      return result
    },
  }
}
