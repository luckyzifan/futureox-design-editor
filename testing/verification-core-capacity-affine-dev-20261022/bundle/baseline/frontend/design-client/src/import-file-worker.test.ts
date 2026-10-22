import { afterEach, expect, test, vi } from 'vitest'
import { blank } from './model'
import { exportSketchInWorker, importFileInWorker } from './import-file-worker'
import { readDesignFile } from './persistence'

class ImportWorker {
  static instances: ImportWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string }) => void
  onmessageerror?: () => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { ImportWorker.instances.push(this) }
  reply(data: unknown) { this.onmessage?.({ data }) }
}
function installWorker() {
  ImportWorker.instances = []
  vi.stubGlobal('Worker', ImportWorker)
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

test.each(['fig', 'sketch', 'pdf'] as const)('imports %s through the same bounded worker and document contract', async (format) => {
  installWorker()
  const bytes = new ArrayBuffer(4), document = blank('shared editor')
  const result = importFileInWorker(bytes, 'shared editor', format)
  const worker = ImportWorker.instances[0]
  expect(worker.postMessage).toHaveBeenCalledWith({ bytes, name: 'shared editor', format }, [bytes])
  worker.reply({ result: { document, warnings: ['字体需要匹配'] } })
  expect(await result).toEqual({ document, warnings: ['字体需要匹配'] })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('cancelling an in-flight import reclaims the worker and ignores a late success', async () => {
  installWorker()
  const controller = new AbortController()
  const result = importFileInWorker(new ArrayBuffer(1), 'cancelled', 'sketch', controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  ImportWorker.instances[0].reply({ result: { document: blank(), warnings: [] } })
  await rejected
  expect(ImportWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

test('an already cancelled import creates no worker', () => {
  installWorker()
  const controller = new AbortController(); controller.abort()
  expect(() => importFileInWorker(new ArrayBuffer(1), 'cancelled', 'sketch', controller.signal)).toThrow()
  expect(ImportWorker.instances).toHaveLength(0)
})

test.each([
  { error: 'ZIP contains unsupported data' },
  { result: { document: { schemaVersion: 999 }, warnings: [] } },
  { result: { document: blank(), warnings: [42] } },
])('failed or malformed imports cannot adopt a document', async (reply) => {
  installWorker()
  const result = importFileInWorker(new ArrayBuffer(1), 'invalid', 'sketch')
  const rejected = expect(result).rejects.toThrow()
  ImportWorker.instances[0].reply(reply)
  await rejected
  expect(ImportWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

test('timed out import reclaims its worker without a retry', async () => {
  installWorker(); vi.useFakeTimers()
  const result = importFileInWorker(new ArrayBuffer(1), 'slow', 'sketch')
  const rejected = expect(result).rejects.toThrow('30 秒预算')
  await vi.advanceTimersByTimeAsync(30_000)
  await rejected
  expect(ImportWorker.instances).toHaveLength(1)
  expect(ImportWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

test('oversized Sketch input is rejected before reading or creating a worker', async () => {
  installWorker()
  const arrayBuffer = vi.fn()
  await expect(readDesignFile({ name: 'large.sketch', size: 32 * 1024 * 1024 + 1, arrayBuffer } as unknown as File))
    .rejects.toThrow('32 MB')
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(ImportWorker.instances).toHaveLength(0)
})

test('Sketch file selection reaches the shared importer and keeps its display name', async () => {
  installWorker()
  const result = readDesignFile(new File([new Uint8Array([80, 75])], '117.SKETCH'))
  await vi.waitFor(() => expect(ImportWorker.instances).toHaveLength(1))
  const worker = ImportWorker.instances[0]
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ name: '117', format: 'sketch' })
  worker.reply({ result: { document: blank('117'), warnings: [] } })
  expect((await result).document.name).toBe('117')
})

test('Sketch compatibility export reclaims the worker and returns owned archive bytes', async () => {
  installWorker()
  const document = blank(), result = exportSketchInWorker(document)
  const worker = ImportWorker.instances[0]
  expect(worker.postMessage.mock.calls[0][0]).toEqual({ format: 'sketch-export', document })
  worker.reply({ bytes: new Uint8Array([80, 75, 3, 4]).buffer })
  expect(await result).toEqual(new Uint8Array([80, 75, 3, 4]))
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test.each(['cancel', 'timeout'] as const)('late FIG response after %s is not decoded', async reason => {
  installWorker(); vi.useFakeTimers()
  const controller = new AbortController()
  const result = importFileInWorker(new ArrayBuffer(1), 'late', 'fig', controller.signal)
  const rejected = expect(result).rejects.toThrow()
  if (reason === 'cancel') controller.abort()
  else await vi.advanceTimersByTimeAsync(30_000)
  await rejected
  const read = vi.fn(() => { throw new Error('Late payload must never be inspected') })
  ImportWorker.instances[0].reply(Object.defineProperty({}, 'error', { get: read }))
  expect(read).not.toHaveBeenCalled()
  expect(ImportWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

test('FIG worker response preserves explicit dropped warning metadata', async () => {
  installWorker()
  const result = importFileInWorker(new ArrayBuffer(1), 'warnings', 'fig')
  ImportWorker.instances[0].reply({ result: { document: blank(),
    warnings: ['FIG compatibility warnings truncated; see droppedOccurrences.'], droppedOccurrences: 42 } })
  expect((await result).droppedOccurrences).toBe(42)
})

test.each([
  { warnings: Array.from({ length: 129 }, () => 'x') },
  { warnings: ['字'.repeat(400)] },
  { warnings: ['x'], droppedOccurrences: 1 },
  { warnings: ['FIG compatibility warnings truncated; see droppedOccurrences.'] },
  { warnings: ['FIG compatibility warnings truncated; see droppedOccurrences.'], droppedOccurrences: -1 },
])('FIG worker rejects malformed warning bounds/metadata', async report => {
  installWorker()
  const result = importFileInWorker(new ArrayBuffer(1), 'warnings', 'fig')
  const rejected = expect(result).rejects.toThrow()
  ImportWorker.instances[0].reply({ result: { document: blank(), ...report } })
  await rejected
})
