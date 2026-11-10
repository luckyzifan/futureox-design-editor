import { documentCapacity } from './document-capacity'
import { expect, test, vi } from 'vitest'
import { blank } from './model'
import { importSketchWithLibraries } from './import-file-worker'

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

test('Sketch library attach checks every file size before reading or creating a worker', async () => {
  ImportWorker.instances = []
  vi.stubGlobal('Worker', ImportWorker)
  const projectRead = vi.fn()
  const libraryRead = vi.fn()
  const project = { name: 'uswds-project.sketch', size: 4, arrayBuffer: projectRead } as unknown as File
  const library = { name: 'uswds.sketch', size: 1024 ** 3 + 1, arrayBuffer: libraryRead } as unknown as File
  expect(() => importSketchWithLibraries(project, [library], 'uswds-project')).toThrow('1 GiB')
  expect(projectRead).not.toHaveBeenCalled()
  expect(libraryRead).not.toHaveBeenCalled()
  expect(ImportWorker.instances).toHaveLength(0)
  vi.unstubAllGlobals()
})

test('Sketch library attach rejects a bad count before reading', async () => {
  ImportWorker.instances = []
  vi.stubGlobal('Worker', ImportWorker)
  const read = vi.fn()
  const project = { name: 'project.sketch', size: 4, arrayBuffer: read } as unknown as File
  expect(() => importSketchWithLibraries(project, [], 'project')).toThrow('1 到 8')
  const libraries = Array.from({ length: 9 }, () => ({ name: 'lib.sketch', size: 4, arrayBuffer: read }) as unknown as File)
  expect(() => importSketchWithLibraries(project, libraries, 'project')).toThrow('1 到 8')
  expect(read).not.toHaveBeenCalled()
  expect(ImportWorker.instances).toHaveLength(0)
  vi.unstubAllGlobals()
})

test('Sketch library attach gives the owned worker the unread files and does not adopt a rejected document', async () => {
  ImportWorker.instances = []
  vi.stubGlobal('Worker', ImportWorker)
  const project = new File([new Uint8Array([1])], 'project.sketch')
  const library = new File([new Uint8Array([2])], 'library.sketch')
  const projectRead = vi.spyOn(project, 'arrayBuffer')
  const libraryRead = vi.spyOn(library, 'arrayBuffer')
  const opened = importSketchWithLibraries(project, [library], 'project')
  const worker = ImportWorker.instances[0]
  expect(projectRead).not.toHaveBeenCalled()
  expect(libraryRead).not.toHaveBeenCalled()
  expect(worker.postMessage).toHaveBeenCalledWith({
    format: 'sketch-with-libraries', project, libraries: [library], name: 'project',
    memoryBytes: documentCapacity().memoryBytes,
  }, [])
  worker.reply({ result: { document: blank('project'), warnings: [] } })
  expect((await opened).document.name).toBe('project')
  const rejected = importSketchWithLibraries(project, [library], 'project')
  const failed = expect(rejected).rejects.toThrow('embedded symbol master')
  ImportWorker.instances[1].reply({ importStage: 233, error: 'unsupported lossless conversion: Sketch instance requires an embedded symbol master: MISSING。上游定义缺失' })
  await failed
  expect(projectRead).not.toHaveBeenCalled()
  expect(libraryRead).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
