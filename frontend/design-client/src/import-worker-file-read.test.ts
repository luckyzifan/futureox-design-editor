import { afterAll, beforeAll, expect, test, vi } from 'vitest'

type WorkerScope = { onmessage?: (event: MessageEvent) => Promise<void>; postMessage: ReturnType<typeof vi.fn> }
const scope: WorkerScope = { postMessage: vi.fn() }
beforeAll(async () => {
  vi.stubGlobal('self', scope)
  await import('./import-worker')
})
afterAll(() => vi.unstubAllGlobals())

// Invokes the production worker handler. The source File-like read boundary is
// controlled; these tests do not claim a browser Worker or a new codec pass.
test('library attach checks every selected file before the first byte read', async () => {
  scope.postMessage.mockClear()
  const projectRead = vi.fn()
  const libraryRead = vi.fn()
  await scope.onmessage!({ data: {
    format: 'sketch-with-libraries', name: 'uswds-project',
    project: { size: 4, arrayBuffer: projectRead },
    libraries: [{ size: 1024 ** 3 + 1, arrayBuffer: libraryRead }],
  } } as MessageEvent)
  expect(projectRead).not.toHaveBeenCalled()
  expect(libraryRead).not.toHaveBeenCalled()
  expect(scope.postMessage.mock.calls.some(call => call[0]?.kind === 'import-stage')).toBe(false)
  expect(scope.postMessage.mock.calls.at(-1)![0].error).toContain('1 GiB')
})

test('library attach reads only after every size check, and a read failure adopts nothing', async () => {
  scope.postMessage.mockClear()
  const order: string[] = []
  await scope.onmessage!({ data: {
    format: 'sketch-with-libraries', name: 'project',
    project: { size: 4, arrayBuffer: async () => { order.push('project'); return new ArrayBuffer(4) } },
    libraries: [{ size: 4, arrayBuffer: async () => { order.push('library'); throw new Error('read denied') } }],
  } } as MessageEvent)
  expect(order).toEqual(['project', 'library'])
  expect(scope.postMessage.mock.calls.map(call => call[0])).toEqual([
    { kind: 'import-stage', importStage: 231 },
    { importStage: 231, error: 'read denied' },
  ])
})

test('a selected File is checked in the worker before its first byte read', async () => {
  scope.postMessage.mockClear()
  const arrayBuffer = vi.fn()
  await scope.onmessage!({ data: { file: { size: 1024 ** 3 + 1, arrayBuffer }, name: 'too-large', format: 'fig' } } as MessageEvent)
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(scope.postMessage).toHaveBeenCalledOnce()
  expect(scope.postMessage.mock.calls[0][0].error).toContain('1 GiB')
})

test('a File read failure is returned as a read failure, not a decode success', async () => {
  scope.postMessage.mockClear()
  const arrayBuffer = vi.fn(async () => { throw new Error('read denied') })
  await scope.onmessage!({ data: { file: { size: 1, arrayBuffer }, name: 'unreadable', format: 'sketch' } } as MessageEvent)
  expect(arrayBuffer).toHaveBeenCalledOnce()
  expect(scope.postMessage.mock.calls.map(call => call[0])).toEqual([
    { kind: 'import-stage', importStage: 231 },
    { importStage: 231, error: 'read denied' },
  ])
})

test('actual File read byte count is checked again before any codec runs', async () => {
  scope.postMessage.mockClear()
  // No gigabyte allocation: this controlled malformed read result exercises
  // only byte admission, which must reject before constructing a Uint8Array.
  const arrayBuffer = vi.fn(async () => ({ byteLength: 1024 ** 3 + 1 }))
  await scope.onmessage!({ data: { file: { size: 1, arrayBuffer }, name: 'mismatched', format: 'pdf' } } as MessageEvent)
  expect(arrayBuffer).toHaveBeenCalledOnce()
  expect(scope.postMessage.mock.calls.at(-1)![0].error).toContain('1 GiB')
  expect(scope.postMessage.mock.calls.some(call => 'result' in call[0])).toBe(false)
})
