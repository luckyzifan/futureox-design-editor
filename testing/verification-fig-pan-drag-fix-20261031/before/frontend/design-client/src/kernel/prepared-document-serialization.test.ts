import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { currentPreparedDocumentJson, prepareDocument, takePreparedDocument } from '../prepared-document'
import * as picking from './picking'
import type { KernelClient as KernelClientType } from './client'

const native = { open: vi.fn(async () => 'owned'), close: vi.fn(async () => {}),
  request: vi.fn(async (_owner: string, request: { args: unknown[] }) =>
    ({ id: 1, value: JSON.stringify(request.args[0]) })) }
class WorkerStub {
  static instances: WorkerStub[] = []
  messages: any[] = []
  onmessage?: (event: any) => void
  constructor() { WorkerStub.instances.push(this) }
  postMessage(message: any) { this.messages.push(message) }
  terminate() {}
}
let KernelClient: typeof KernelClientType
const editors: Editor[] = [], clients: KernelClientType[] = []
beforeAll(async () => {
  vi.stubGlobal('window', { coreDesktop: { version: 1, renderPolicy: { cpuOnly: true }, preparation: native } })
  vi.stubGlobal('Worker', WorkerStub)
  ;({ KernelClient } = await import('./client'))
})
afterEach(() => {
  clients.splice(0).forEach(client => client.dispose())
  editors.splice(0).forEach(editor => editor.dispose())
  native.request.mockClear()
  vi.restoreAllMocks()
})
afterAll(() => { vi.unstubAllGlobals() })
function editor() {
  const value = new Editor(blank())
  editors.push(value)
  return value
}
function render(document: ReturnType<typeof blank>) {
  const client = new KernelClient()
  clients.push(client)
  const worker = WorkerStub.instances.at(-1)!
  const result = client.render(document, { pageId: document.pages[0].id, width: 20, height: 20,
    view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }, false, 'cpu')
  return { client, worker, result }
}
async function dispatched(request: ReturnType<typeof render>) {
  await vi.waitFor(() => expect(request.worker.messages.some(message => message.id)).toBe(true))
  return request.worker.messages.find(message => message.id)
}
async function finish(request: ReturnType<typeof render>, id: number) {
  request.worker.onmessage?.({ data: { id, backend: 'cpu', milliseconds: 0, stats: { nodes: 0 } } })
  await request.result
}

test('prepared editor adoption sends the exact validated bytes to the renderer without a desktop object clone', async () => {
  const owner = editor(), source = blank('Imported snapshot'), prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  expect(owner.load(source)).toBe(true)
  expect(prepare).toHaveBeenCalledTimes(1)
  const doc = owner.state.doc, exact = JSON.stringify(doc)
  owner.set({ view: { x: 20, y: 30, zoom: 2 } })
  expect(currentPreparedDocumentJson(doc)).toBe(exact)
  const request = render(doc), message = await dispatched(request)
  expect(message.document).toBe(exact)
  expect(native.request).not.toHaveBeenCalled()
  // An unsupported replica derivation may request a full snapshot later.
  request.worker.onmessage?.({ data: { id: message.id, documentFallback: true } })
  await vi.waitFor(() => expect(request.worker.messages.some(value => value.command === 'document-fallback')).toBe(true))
  expect(request.worker.messages.find(value => value.command === 'document-fallback').document).toBe(exact)
  expect(native.request).not.toHaveBeenCalled()
  await finish(request, message.id)
})

test('unadopted tokens, copies and caller-supplied encoded fields cannot populate the render cache', async () => {
  const source = blank('Not owned'), token = prepareDocument(source), document = takePreparedDocument(token)!
  expect(currentPreparedDocumentJson(document)).toBeUndefined()
  expect(currentPreparedDocumentJson({ ...document, validatedJson: 'forged' } as typeof document)).toBeUndefined()
  const request = render(document), message = await dispatched(request)
  expect(native.request).toHaveBeenCalledTimes(1)
  expect(message.document).toBe(JSON.stringify(document))
  await finish(request, message.id)
})

test('a later versioned mutation of the same root revokes the certificate before a new renderer serializes it', async () => {
  const owner = editor()
  owner.load(blank('Imported'))
  const document = owner.state.doc
  expect(currentPreparedDocumentJson(document)).toBeDefined()
  document.name = 'Versioned mutation'
  owner.set({ version: owner.state.version + 1 })
  expect(currentPreparedDocumentJson(document)).toBeUndefined()
  const request = render(document), message = await dispatched(request)
  expect(native.request).toHaveBeenCalledTimes(1)
  expect(JSON.parse(message.document).name).toBe('Versioned mutation')
  await finish(request, message.id)
})

test.each(['versioned-same-root', 'replacement-owner', 'nested-session'] as const)(
  'reentrant adoption %s cannot certify stale render bytes',
  async mutation => {
    const owner = editor(), source = blank('Saved')
    let handled = false
    owner.subscribe(() => {
      if (handled || owner.state.doc.id !== source.id) return
      handled = true
      const document = owner.state.doc, version = owner.state.version
      if (mutation === 'versioned-same-root') {
        document.name = 'Changed'
        owner.set({ version: version + 1 })
      } else if (mutation === 'replacement-owner') owner.set({ doc: { ...document, name: 'Changed' } })
      else {
        document.name = 'Changed'
        owner.load(blank('Nested'))
        owner.set({ doc: document, page: document.pages[0].id, version })
      }
    })
    expect(owner.load(source)).toBe(true)
    expect(handled).toBe(true)
    expect(currentPreparedDocumentJson(owner.state.doc)).toBeUndefined()
    const request = render(owner.state.doc), message = await dispatched(request)
    expect(native.request).toHaveBeenCalledTimes(1)
    expect(JSON.parse(message.document).name).toBe('Changed')
    await finish(request, message.id)
  },
)

test('edits, undo and editor disposal retire bytes rather than certifying old history objects', () => {
  const owner = editor()
  owner.load(blank('Imported'))
  const original = owner.state.doc
  owner.change('rename', draft => { draft.name = 'Edited' })
  expect(currentPreparedDocumentJson(original)).toBeUndefined()
  owner.undo()
  expect(owner.state.doc.name).toBe('Imported')
  expect(currentPreparedDocumentJson(owner.state.doc)).toBeUndefined()
  owner.redo()
  expect(owner.state.doc.name).toBe('Edited')
  owner.load(blank('Second import'))
  const second = owner.state.doc
  expect(currentPreparedDocumentJson(second)).toBeDefined()
  owner.dispose()
  expect(currentPreparedDocumentJson(second)).toBeUndefined()
})
