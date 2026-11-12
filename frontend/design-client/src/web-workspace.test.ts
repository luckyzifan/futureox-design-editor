import { afterEach, expect, test, vi } from 'vitest'
import { blank, node, type DesignDocument } from './model'
import { Backend, BackendError, type RemoteEditReceipt } from './persistence'
import { WebWorkspace } from './web-workspace'
import { applyWorkspacePatch, workspacePatch } from './workspace-patch'

const api = vi.hoisted(() => ({
  changes: vi.fn(),
  getVersion: vi.fn(),
  edit: vi.fn(),
  save: vi.fn(),
}))
vi.mock('./persistence', () => ({
  Backend: class {
    list() { return Promise.resolve([]) }
    getVersion(...args: unknown[]) { return api.getVersion(...args) }
    changes(...args: unknown[]) { return api.changes(...args) }
    edit(...args: unknown[]) { return api.edit(...args) }
    save(...args: unknown[]) { return api.save(...args) }
  },
  BackendError: class extends Error {
    constructor(readonly status: number, message: string) { super(message) }
  },
}))

const close: (() => void)[] = []
afterEach(() => {
  close.splice(0).forEach(dispose => dispose())
  vi.resetAllMocks()
  vi.useRealTimers()
})

async function fixture() {
  vi.useFakeTimers()
  api.changes.mockImplementation(async (_id, revision) => ({ revision, patch: null }))
  api.edit.mockImplementation(async (_id, revision) => ({ revision: revision + 1 }))
  const base = blank(), layers = [node('rectangle', 0, 0), node('rectangle', 40, 0), node('rectangle', 80, 0)]
  for (const layer of layers) base.nodes[layer.id] = layer
  base.pages[0].children = layers.map(layer => layer.id)
  let document = base, busy = false
  const publish = vi.fn(), workspace = new WebWorkspace(publish)
  const install = vi.fn(async (expected: DesignDocument, next: DesignDocument, signal: AbortSignal) => {
    if (signal.aborted || busy || document !== expected) return
    document = next
    workspace.localSaved(next)
    return next
  })
  await workspace.connect('workspace-token', new AbortController().signal)
  const stop = workspace.watch(base.id, { read: () => busy ? undefined : document, install })
  close.push(stop, () => workspace.disconnect())
  workspace.link({ id: base.id, name: base.name, revision: 1, document: base, updatedAt: '' }, base)
  const name = (doc: DesignDocument, index: number, value: string) => {
    const id = layers[index].id
    return { ...doc, nodes: { ...doc.nodes, [id]: { ...doc.nodes[id], name: value } } }
  }
  return { base, layers, workspace, publish, install, name,
    current: () => document,
    write(next: DesignDocument) { document = next; workspace.localSaved(next) },
    busy(value: boolean) { busy = value },
  }
}

test('a peer update waits for the editor to be available and its local save does not echo', async () => {
  const f = await fixture()
  f.busy(true)
  const peer = f.name(f.base, 0, 'remote')
  api.changes.mockResolvedValueOnce({ revision: 2, patch: workspacePatch(f.base, peer) })
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.current()).toBe(f.base)
  expect(api.changes).not.toHaveBeenCalled()
  f.busy(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.current()).toEqual(peer)
  expect(f.install).toHaveBeenCalledOnce()
  expect(api.edit).not.toHaveBeenCalled()
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'saved', revision: 2 }))
})

test('retry sends the same committed local patch and operation identity', async () => {
  const f = await fixture()
  api.edit.mockRejectedValueOnce(new BackendError(503, 'retry'))
  f.write(f.name(f.base, 0, 'local'))
  await vi.advanceTimersByTimeAsync(1)
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }))
  await vi.advanceTimersByTimeAsync(2100)
  expect(api.edit).toHaveBeenCalledTimes(2)
  expect(api.edit.mock.calls[1].slice(0, 4)).toEqual(api.edit.mock.calls[0].slice(0, 4))
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'saved', revision: 2 }))
})

test('a merged receipt keeps later disjoint local edits and submits only those edits next', async () => {
  const f = await fixture()
  const first = f.name(f.base, 0, 'mine'), peerAndFirst = f.name(first, 1, 'peer')
  let ack!: (receipt: RemoteEditReceipt) => void
  api.edit.mockImplementationOnce(() => new Promise(resolve => { ack = resolve }))
  f.write(first)
  await vi.advanceTimersByTimeAsync(1)
  f.write(f.name(first, 2, 'later'))
  ack({ revision: 3, merged: { id: f.base.id, name: f.base.name, revision: 3, document: peerAndFirst, updatedAt: '' } })
  await vi.advanceTimersByTimeAsync(100)
  expect(f.current()).toEqual(f.name(peerAndFirst, 2, 'later'))
  expect(api.edit).toHaveBeenCalledTimes(2)
  expect(api.edit.mock.calls[1][1]).toBe(3)
  expect(Object.keys(api.edit.mock.calls[1][3].nodes)).toEqual([f.layers[2].id])
})

test('the workspace transport preserves authored null separately from deletion', () => {
  const base = blank(), withNull = { ...base, fdCompatibility: null }
  expect(applyWorkspacePatch(base, workspacePatch(base, withNull))).toEqual(withNull)
  const removed = applyWorkspacePatch(withNull, workspacePatch(withNull, base))
  expect(Object.hasOwn(removed, 'fdCompatibility')).toBe(false)
})

test('an interrupted desktop request resumes from the exact server and SQLite revisions', async () => {
  const f = await fixture()
  f.workspace.disconnect()
  const requestId = crypto.randomUUID()
  const submitted = f.name(f.base, 0, 'already sent'), later = f.name(submitted, 1, 'edited offline')
  const write = vi.fn(async () => {})
  const localVersion = vi.fn(async () => submitted)
  f.write(later)
  api.getVersion.mockResolvedValue({
    id: f.base.id, name: f.base.name, revision: 1, document: f.base, updatedAt: '',
  })
  f.workspace.attach(new Backend(), {
    read: async () => ({ revision: 1, pending: { localRevision: 7, requestId } }),
    write,
    localVersion,
    localRevision: document => document === later ? 8 : undefined,
  })
  await vi.advanceTimersByTimeAsync(200)
  expect(api.getVersion).toHaveBeenCalledWith(f.base.id, 1, expect.any(AbortSignal))
  expect(localVersion).toHaveBeenCalledWith(f.base.id, 7)
  expect(api.edit.mock.calls[0].slice(0, 4)).toEqual([f.base.id, 1, requestId, workspacePatch(f.base, submitted)])
  expect(api.edit.mock.calls[1][1]).toBe(2)
  expect(api.edit.mock.calls[1][3]).toEqual(workspacePatch(submitted, later))
  expect(write).toHaveBeenLastCalledWith(f.base.id, { revision: 3 })
})
