import type { Editor } from '../engine'
import { hasPendingEdits } from '../pending-edits'
import { CANVAS_SETTING_KEYS, settingsPreference, type CanvasSettings } from '../settings-preference'
import { SHORTCUT_PROFILE_KEY, shortcutPreference } from '../shortcut-preference'
import type { ShortcutProfile } from '../shortcut-profiles'
import type { WorkspaceAutomationGuard } from './workspace-bridge'

export type AutomationSettingsValues = CanvasSettings & { scrollWheelZoom: boolean; shortcutProfile: ShortcutProfile }
export type AutomationSettingsResult = { settingsRevision: number; values: AutomationSettingsValues; persistence: 'available' | 'session-only'; persistenceByGroup: { canvas: 'available' | 'session-only'; keyboard: 'available' | 'session-only'; wheel: 'available' | 'session-only' }; atomicDurability: false }
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Tracks live menu/keyboard/store changes too. Uses the same preference stores as
 * SettingsDialog; no credentials, grants, paths or network settings are exposed. */
export function createAutomationSettingsAdapter(editor: Editor, options: {
  canvas?: typeof settingsPreference
  keyboard?: typeof shortcutPreference
  storage?: () => Pick<Storage, 'getItem'> | undefined
} = {}) {
  const canvas = options.canvas ?? settingsPreference, keyboard = options.keyboard ?? shortcutPreference
  const storage = options.storage ?? (() => typeof window === 'undefined' ? undefined : window.localStorage)
  let revision = 0, applying = false, disposed = false
  let keyboardProfile = keyboard.getSnapshot()
  const readValues = (): AutomationSettingsValues => ({
    snap: !!editor.state.snap, snapPixels: !!editor.state.snapPixels, pixelGrid: !!editor.state.pixelGrid,
    rulers: !!editor.state.rulers, checkerboard: !!editor.state.checkerboard, grid: !!editor.state.grid,
    scrollWheelZoom: !!editor.state.scrollWheelZoom, shortcutProfile: keyboardProfile,
  })
  let snapshot = readValues()
  const refresh = () => {
    if (disposed || applying) return
    // Camera/selection notifications must not read localStorage or allocate a
    // preference snapshot when all eight primitive preferences are unchanged.
    if (CANVAS_SETTING_KEYS.every(key => !!editor.state[key] === snapshot[key]) && !!editor.state.scrollWheelZoom === snapshot.scrollWheelZoom && keyboardProfile === snapshot.shortcutProfile) return
    snapshot = readValues(); revision++
  }
  const subscriptions = [editor.subscribe(refresh), canvas.subscribe(refresh), keyboard.subscribe(() => { keyboardProfile = keyboard.getSnapshot(); refresh() })]
  let receiptOwner: string | undefined
  const receipts = new Map<string, { fingerprint: string; result: AutomationSettingsResult }>()
  const stored = (key: string, value: string) => { try { return storage()?.getItem(key) === value } catch { return false } }
  const get = (): AutomationSettingsResult => {
    if (disposed) return fail('SESSION_CLOSED', 'The settings adapter was disposed')
    keyboardProfile = keyboard.getSnapshot(); refresh()
    const persistenceByGroup = { canvas: canvas.getPersistenceSnapshot(), keyboard: stored(SHORTCUT_PROFILE_KEY, snapshot.shortcutProfile) ? 'available' as const : 'session-only' as const,
      wheel: stored('forma-scroll-wheel-zoom', String(snapshot.scrollWheelZoom)) ? 'available' as const : 'session-only' as const }
    return { settingsRevision: revision, values: { ...snapshot }, persistence: Object.values(persistenceByGroup).every(value => value === 'available') ? 'available' : 'session-only', persistenceByGroup, atomicDurability: false }
  }
  return {
    get,
    update(params: Record<string, unknown>, guard: WorkspaceAutomationGuard, signal: AbortSignal): AutomationSettingsResult {
      const check = () => {
        if (disposed) fail('SESSION_CLOSED', 'The settings adapter was disposed')
        if (signal.aborted) throw signal.reason ?? Object.assign(new Error('Settings request cancelled'), { code: 'CANCELLED' })
        if (editor.state.doc.id !== guard.documentId || editor.sessionGeneration !== guard.session) fail('STALE_SESSION', 'The selected editor changed')
        if (editor.state.version !== guard.expectedRevision) fail('REVISION_CONFLICT', 'The editor changed')
        if (editor.state.busy) fail('BUSY', 'The editor is busy')
        if (hasPendingEdits(editor)) fail('PENDING_EDITS', 'Finish pending input before changing preferences')
        if (editor.interactionActive) fail('INTERACTION_ACTIVE', 'Finish the current gesture first')
      }
      check()
      if (!plain(params) || Object.keys(params).some(key => !['patch', 'expectedSettingsRevision', 'mutationId'].includes(key)) ||
        !Number.isSafeInteger(params.expectedSettingsRevision) || (params.expectedSettingsRevision as number) < 0 ||
        typeof params.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.mutationId) || !plain(params.patch) || !Object.keys(params.patch).length) return fail('INVALID_PARAMS', 'Invalid settings update')
      const patch = params.patch
      if (Object.entries(patch).some(([key, value]) => [...CANVAS_SETTING_KEYS, 'scrollWheelZoom'].includes(key as never) ? typeof value !== 'boolean' : key !== 'shortcutProfile' || !['figma-like', 'sketch-like'].includes(value as string))) return fail('INVALID_PARAMS', 'Only supported canvas and keyboard preferences are allowed')
      const owner = guard.grantSessionId ?? `editor:${editor.sessionGeneration}`
      if (receiptOwner !== owner) { receipts.clear(); receiptOwner = owner }
      const fingerprint = JSON.stringify({ params, guard }), receipt = receipts.get(params.mutationId)
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail('MUTATION_CONFLICT', 'Settings mutationId was reused with different arguments'); return structuredClone(receipt.result) }
      if (receipts.size >= 128) fail('RECEIPT_LIMIT', 'Settings receipt store is full; reconnect with fresh native approval before new mutations')
      refresh()
      if (params.expectedSettingsRevision !== revision) return fail('SETTINGS_REVISION_CONFLICT', 'Preferences changed; read them again before updating')
      const canvasPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => CANVAS_SETTING_KEYS.includes(key as typeof CANVAS_SETTING_KEYS[number]))) as Partial<CanvasSettings>
      applying = true
      try {
        if (Object.keys(canvasPatch).length) {
          canvas.set(canvasPatch)
          // Keep the actual editor correct even when a caller has not mounted
          // the normal app-level preference binding yet.
          editor.set(canvasPatch)
        }
        if (patch.shortcutProfile !== undefined) keyboard.set(patch.shortcutProfile as ShortcutProfile)
        if (patch.scrollWheelZoom !== undefined) editor.setScrollWheelZoom(patch.scrollWheelZoom as boolean)
      } finally { applying = false; refresh() }
      const result = get()
      receipts.set(params.mutationId, { fingerprint, result: structuredClone(result) })
      check()
      return result
    },
    dispose() { disposed = true; subscriptions.forEach(stop => stop()); receipts.clear() },
  }
}
