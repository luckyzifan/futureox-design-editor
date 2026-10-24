import { documentCapacity } from './document-capacity'
import { afterEach, expect, test, vi } from 'vitest'
import { blank } from './model'
import { exportSketchInWorker, importFileInWorker } from './import-file-worker'
import { readDesignFile } from './persistence'
import { beginImportDiagnostic, ImportFailure, ImportStage } from './import-diagnostics'

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
  expect(worker.postMessage).toHaveBeenCalledWith({ bytes, name: 'shared editor', format, memoryBytes: documentCapacity().memoryBytes }, [bytes])
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
  await expect(readDesignFile({ name: 'large.sketch', size: 1024 ** 3 + 1, arrayBuffer } as unknown as File))
    .rejects.toThrow('1 GiB')
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
  expect(worker.postMessage.mock.calls[0][0]).toEqual({ format: 'sketch-export', document, memoryBytes: documentCapacity().memoryBytes })
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


test.each(['fig', 'sketch', 'pdf'] as const)('selected %s File is owned by its worker before reading', async format => {
  installWorker()
  const file = new File([new Uint8Array([1, 2, 3])], `local.${format}`)
  const read = vi.spyOn(file, 'arrayBuffer')
  const result = readDesignFile(file)
  const worker = ImportWorker.instances[0]
  expect(read).not.toHaveBeenCalled()
  expect(worker.postMessage).toHaveBeenCalledWith({ file, name: 'local', format,
    memoryBytes: documentCapacity().memoryBytes }, [])
  worker.reply({ kind: 'import-stage', importStage: 231 })
  worker.reply({ kind: 'import-stage', importStage: 238 })
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.reply({ result: { document: blank('local'), warnings: [] } })
  expect((await result).document.name).toBe('local')
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test.each(['cancel', 'timeout'] as const)('a selected File waiting to read is reclaimed on %s', async reason => {
  installWorker(); vi.useFakeTimers()
  const file = new File(['pending'], 'local.fig')
  const read = vi.spyOn(file, 'arrayBuffer')
  const controller = new AbortController()
  const result = readDesignFile(file, controller.signal)
  const rejected = expect(result).rejects.toThrow()
  const worker = ImportWorker.instances[0]
  worker.reply({ kind: 'import-stage', importStage: 231 })
  if (reason === 'cancel') controller.abort()
  else await vi.advanceTimersByTimeAsync(30_000)
  await rejected
  worker.reply({ result: { document: blank('late'), warnings: [] } })
  expect(read).not.toHaveBeenCalled()
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('worker file-read failure retains read-stage attribution and rejects without adoption', async () => {
  installWorker()
  const file = new File(['x'], 'local.fig')
  const diagnostic = beginImportDiagnostic(file, 'open', { actionId: 1, actionOwner: 1 })
  const result = readDesignFile(file, undefined, diagnostic).catch(error => error)
  ImportWorker.instances[0].reply({ importStage: ImportStage.read, error: 'cannot read file' })
  const error = await result
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe('cannot read file')
  expect(diagnostic.fail(error)).toBe(ImportFailure.read)
  expect(ImportWorker.instances[0].terminate).toHaveBeenCalledOnce()
})


test.each(['onerror', 'onmessageerror'] as const)('generic %s during file reading stays an unknown worker failure', async callback => {
  installWorker()
  const file = new File(['x'], 'local.fig')
  const diagnostic = beginImportDiagnostic(file, 'open', { actionId: 2, actionOwner: 1 })
  const result = readDesignFile(file, undefined, diagnostic).catch(error => error)
  const worker = ImportWorker.instances[0]
  worker.reply({ kind: 'import-stage', importStage: ImportStage.read })
  if (callback === 'onerror') worker.onerror?.({ message: 'worker crashed' })
  else worker.onmessageerror?.()
  const error = await result
  expect(error).toBeInstanceOf(Error)
  expect(diagnostic.fail(error)).toBe(ImportFailure.unknown)
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('an explicit empty read-error message remains a read failure with bounded fallback text', async () => {
  installWorker()
  const file = new File(['x'], 'local.fig')
  const diagnostic = beginImportDiagnostic(file, 'open', { actionId: 3, actionOwner: 1 })
  const result = readDesignFile(file, undefined, diagnostic).catch(error => error)
  const worker = ImportWorker.instances[0]
  worker.reply({ kind: 'import-stage', importStage: ImportStage.read })
  worker.reply({ importStage: ImportStage.read, error: '' })
  const error = await result
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe('文件导入失败')
  expect(diagnostic.fail(error)).toBe(ImportFailure.read)
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test.each(['onerror', 'onmessageerror', 'read-error'] as const)('late %s cannot replace cancellation after a pending file read', async callback => {
  installWorker()
  const controller = new AbortController()
  const file = new File(['x'], 'local.fig')
  const diagnostic = beginImportDiagnostic(file, 'open', { actionId: 4, actionOwner: 1 })
  diagnostic.bindRequest({ signal: controller.signal, isCurrent: () => true })
  const result = readDesignFile(file, controller.signal, diagnostic).catch(error => error)
  const worker = ImportWorker.instances[0]
  worker.reply({ kind: 'import-stage', importStage: ImportStage.read })
  controller.abort()
  if (callback === 'onerror') worker.onerror?.({ message: 'late worker crash' })
  else if (callback === 'onmessageerror') worker.onmessageerror?.()
  else worker.reply({ importStage: ImportStage.read, error: '' })
  const error = await result
  expect(error).toMatchObject({ name: 'AbortError' })
  expect(diagnostic.fail(error)).toBe(ImportFailure.cancelled)
  expect(worker.terminate).toHaveBeenCalledOnce()
})
