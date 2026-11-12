import type { DesktopCloudBridge, DesktopResult } from './desktop'
import type { DesktopSession } from './desktop-session'
import { Backend } from './persistence'
import type { WorkspaceJournal } from './cloud-workspace'

export function cloudResult<T>(result: DesktopResult<T>) {
  if (result.status !== 'ok') throw Error(result.status === 'cancelled' ? '云端操作已取消' : result.message)
  return result
}

export function desktopCloudWorkspace(bridge: DesktopCloudBridge, handle: string, session: DesktopSession) {
  const journal: WorkspaceJournal = {
    async read(id) { return cloudResult(await bridge.readCursor({ handle, id })).cursor },
    async write(id, cursor) { cloudResult(await bridge.writeCursor({ handle, id, cursor })) },
    localRevision: document => session.cloudLocalRevision(document),
    localVersion: (id, revision) => session.readCloudLocalVersion(id, revision),
  }
  return { backend: new Backend({ bridge, handle }), journal }
}
