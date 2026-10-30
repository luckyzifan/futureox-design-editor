import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, type Point } from './model'

// CPU-only production Editor boundary: the suite's normal WASM setup supplies
// document/history operations; geometry Worker events and its clock are doubles.
class GeometryWorker {
  static instances: GeometryWorker[] = []
  static postError: Error | null = null
  onmessage: ((event: { data: { results?: Point[][][]; error?: string } }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  payload: unknown
  terminate = vi.fn()
  constructor() { GeometryWorker.instances.push(this) }
  postMessage(payload: unknown) {
    this.payload = payload
    if (GeometryWorker.postError) throw GeometryWorker.postError
  }
}
const editors: Editor[] = []
const results: Point[][][] = [[[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }]]]
function fixture() {
  const doc = blank(), a = node('rectangle'), b = node('rectangle')
  doc.nodes = { [a.id]: a, [b.id]: b }
  doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([a.id, b.id])
  return editor
}
function start(editor: Editor) {
  const promise = editor.geometry('divide')
  const worker = GeometryWorker.instances.at(-1)!
  return { promise, worker, lateMessage: worker.onmessage!, lateError: worker.onerror! }
}
function cleaned(editor: Editor, worker: GeometryWorker) {
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(worker.onmessage).toBeNull()
  expect(worker.onerror).toBeNull()
  expect((editor as unknown as { geometryJob: unknown }).geometryJob).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
}
beforeEach(() => {
  GeometryWorker.instances = []
  GeometryWorker.postError = null
  vi.stubGlobal('Worker', GeometryWorker)
  vi.useFakeTimers()
})
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('success commits once and clears the job, handlers and timer', async () => {
  const editor = fixture(), before = editor.state.doc
  const { promise, worker, lateMessage, lateError } = start(editor)
  expect(editor.state.busy).toBe(true)
  worker.onmessage!({ data: { results } })
  await promise
  expect(editor.state.doc).not.toBe(before)
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  expect(editor.canUndo).toBe(true)
  const completed = editor.state
  lateMessage({ data: { results: [] } }); lateError({ message: 'late error' })
  await vi.advanceTimersByTimeAsync(15000)
  expect(editor.state).toBe(completed)
  expect(editor.state.busy).toBe(false)
  cleaned(editor, worker)
})

test.each(['reported error', 'worker error', 'timeout', 'post failure'] as const)(
  '%s preserves the source and reports the failure without retry or fallback', async (kind) => {
    const editor = fixture(), before = editor.state.doc
    if (kind === 'post failure') GeometryWorker.postError = new Error('post failure')
    const { promise, worker } = start(editor)
    if (kind === 'reported error') worker.onmessage!({ data: { error: kind } })
    if (kind === 'worker error') worker.onerror!({ message: kind })
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(15000)
    await promise
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    expect(editor.state.message).toContain(kind === 'timeout' ? '几何运算超时' : kind)
    expect(editor.state.busy).toBe(false)
    expect(GeometryWorker.instances).toHaveLength(1)
    cleaned(editor, worker)
  },
)

test('dispose settles immediately, is idempotent, and ignores retained callbacks', async () => {
  const editor = fixture(), before = editor.state.doc
  const { promise, worker, lateMessage, lateError } = start(editor)
  const listener = vi.fn(), epoch = editor.sessionGeneration
  editor.subscribe(listener)
  editor.dispose()
  const disposed = editor.state
  editor.dispose()
  expect(editor.sessionGeneration).toBe(epoch + 1)
  cleaned(editor, worker)
  // No clock advancement: the awaited public operation must settle on disposal.
  await promise
  lateMessage({ data: { results } }); lateError({ message: 'late failure' })
  await vi.advanceTimersByTimeAsync(15000)
  expect(editor.state).toBe(disposed)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(listener).not.toHaveBeenCalled()
  await editor.geometry('divide')
  await editor.geometry('union')
  expect(editor.load(blank())).toBe(false)
  expect(GeometryWorker.instances).toHaveLength(1)
  expect(editor.state).toBe(disposed)
  cleaned(editor, worker)
})

test.each(['dispose', 'load'] as const)(
  '%s fences a successful response whose Promise continuation is still queued', async (boundary) => {
    const editor = fixture(), { promise, worker } = start(editor)
    worker.onmessage!({ data: { results } })
    if (boundary === 'dispose') editor.dispose()
    else expect(editor.load(blank())).toBe(true)
    const replacement = editor.state
    await promise
    expect(editor.state).toBe(replacement)
    expect(editor.canUndo).toBe(false)
    cleaned(editor, worker)
  },
)

test('load cancels the old operation without clearing a new operation or completing its edit', async () => {
  const editor = fixture(), first = start(editor)
  const replacement = fixture().state.doc
  expect(editor.load(replacement)).toBe(true)
  expect(editor.state.busy).toBe(false)
  cleaned(editor, first.worker)
  editor.select(replacement.pages[0].children)
  const second = start(editor), pending = editor.state
  first.lateMessage({ data: { results } }); first.lateError({ message: 'stale' })
  await first.promise
  expect(editor.state).toBe(pending)
  expect(editor.state.busy).toBe(true)
  expect(second.worker.terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  second.worker.onmessage!({ data: { results } })
  await second.promise
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  expect(editor.state.busy).toBe(false)
  cleaned(editor, second.worker)
})

test('ordinary document changes retain the existing stale-document error behavior', async () => {
  const editor = fixture(), { promise, worker } = start(editor)
  editor.change('rename document', (doc) => { doc.name = 'Changed while computing' })
  const changed = editor.state.doc
  worker.onmessage!({ data: { results } })
  await promise
  expect(editor.state.doc).toBe(changed)
  expect(editor.state.message).toBe('文档已发生变化，请重新执行几何操作')
  expect(editor.state.busy).toBe(false)
  cleaned(editor, worker)
})

test('failed document admission leaves the current geometry operation alive', async () => {
  const editor = fixture(), { promise, worker } = start(editor)
  const before = editor.state, epoch = editor.sessionGeneration
  expect(() => editor.load(null)).toThrow()
  expect(editor.state).toBe(before)
  expect(editor.sessionGeneration).toBe(epoch)
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  worker.onmessage!({ data: { results } })
  await promise
  expect(editor.state.doc).not.toBe(before.doc)
  expect(editor.state.busy).toBe(false)
  cleaned(editor, worker)
})
