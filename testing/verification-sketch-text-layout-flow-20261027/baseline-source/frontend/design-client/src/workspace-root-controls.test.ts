import { describe, expect, it, vi } from 'vitest'
import { chooseWorkspaceRoot } from './WorkspaceRootControls'
import type { WorkspaceRootBridge } from './desktop'
function fixture() {
  const bridge = {
    status: vi.fn(), select: vi.fn().mockResolvedValue({ status: 'ok', selectionId: 'opaque-only', displayName: 'Project', isDefault: false }),
    useDefault: vi.fn().mockResolvedValue({ status: 'ok', selectionId: 'default-capability', displayName: 'Original', isDefault: true }),
    activate: vi.fn().mockResolvedValue({ status: 'ok', restarting: true }),
  } satisfies WorkspaceRootBridge
  return { bridge, close: vi.fn() }
}
describe('native workspace selection UI boundary', () => {
  it('stages before closing settings and activating only an opaque capability', async () => {
    const { bridge, close } = fixture(), events: string[] = []
    bridge.select.mockImplementation(async () => { events.push('select'); return { status: 'ok', selectionId: 'opaque-only', displayName: 'Project', isDefault: false } })
    close.mockImplementation(() => events.push('close-settings'))
    bridge.activate.mockImplementation(async () => { events.push('activate'); return { status: 'ok', restarting: true } })
    expect(await chooseWorkspaceRoot(bridge, false, close)).toBeUndefined()
    expect(events).toEqual(['select', 'close-settings', 'activate'])
    expect(bridge.activate).toHaveBeenCalledWith({ selectionId: 'opaque-only' })
    expect(bridge.useDefault).not.toHaveBeenCalled()
  })
  it('cancel does not dismiss settings or initiate a close handshake', async () => {
    const { bridge, close } = fixture(); bridge.select.mockResolvedValue({ status: 'cancelled' })
    await chooseWorkspaceRoot(bridge, false, close)
    expect(close).not.toHaveBeenCalled(); expect(bridge.activate).not.toHaveBeenCalled()
  })
  it('failed selection preserves settings and reports native error', async () => {
    const { bridge, close } = fixture(); bridge.select.mockResolvedValue({ status: 'error', code: 'invalid_root', message: 'Directory changed' })
    expect(await chooseWorkspaceRoot(bridge, false, close)).toBe('Directory changed')
    expect(close).not.toHaveBeenCalled(); expect(bridge.activate).not.toHaveBeenCalled()
  })
  it('routes explicit original-workspace choice through native default staging', async () => {
    const { bridge, close } = fixture(); await chooseWorkspaceRoot(bridge, true, close)
    expect(bridge.select).not.toHaveBeenCalled(); expect(bridge.activate).toHaveBeenCalledWith({ selectionId: 'default-capability' })
  })
  it('returns activation errors without treating acknowledgement as completed restart', async () => {
    const { bridge, close } = fixture(); bridge.activate.mockResolvedValue({ status: 'conflict', code: 'windows_open', message: 'Other windows are open' })
    expect(await chooseWorkspaceRoot(bridge, false, close)).toBe('Other windows are open')
    expect(close).toHaveBeenCalledOnce()
  })
  it('propagates transport rejection without retrying selection', async () => {
    const { bridge, close } = fixture(); bridge.select.mockRejectedValue(new Error('Disconnected'))
    await expect(chooseWorkspaceRoot(bridge, false, close)).rejects.toThrow('Disconnected')
    expect(bridge.select).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(bridge.activate).not.toHaveBeenCalled()
  })
})
