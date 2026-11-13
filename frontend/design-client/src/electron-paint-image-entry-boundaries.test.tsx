// DRAFT_NOT_RUN. Tests-only proposal outside the frozen source/active suites.
// Intended integration location: frontend/design-client/src/ (relative imports).
// Exactly two P09 cases: accepted image fill; stale same-ID replacement completion.
// Real mounted Inspector -> actual file input -> production imageData -> Editor/WASM.
// Only FileReader transport and Image.decode are controlled asynchronous doubles.
// jsdom supplies DOM events/File; no mocked Inspector, ownership, history or codec.
// NOT Electron file-dialog, browser decoder, GPU/pixel or filesystem-save evidence.
// Reuses the valid 1x1 PNG fixture from model-image-adjust.test.ts; unlike AA== it
// has actual IHDR/IDAT/IEND chunks. The production FD codec remains unmocked.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { RASTER_MIME_ACCEPT } from './image-import'
import { Editor } from './engine'
import { blank, node, paint, type DesignDocument } from './model'
import { interfacePreference } from './interface-preference'
import { PendingEditContext } from './pending-edit-context'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'

const bootstrap = await vi.hoisted(async () => {
  // React DOM determines event support at import time, before beforeEach.
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator'])
    vi.stubGlobal(key, key === 'window' ? initial.window : initial.window[key])
  return initial
})
bootstrap.window.close()

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_DATA.split(',')[1], 'base64'))

type ReadRequest = { file: File; complete: () => void; completed: boolean }
type DecodeRequest = { source: string; complete: () => void; completed: boolean }
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor
let targetId: string, untouchedId: string, fillId: string
let files: WeakMap<File, string>, reads: ReadRequest[], decodes: DecodeRequest[]
let consoleErrors: ReturnType<typeof vi.spyOn>, alertCalls: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://design.invalid/', pretendToBeVisual: true,
  })
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
    'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent', 'FocusEvent',
    'KeyboardEvent', 'File', 'Blob', 'DOMException', 'localStorage', 'alert',
  ]) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Use jsdom's scheduling rather than an always-success renderer/owner double.
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window))
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  consoleErrors = vi.spyOn(console, 'error') // Call through: do not suppress failures.
  alertCalls = vi.spyOn(globalThis, 'alert')
  interfacePreference.reset()
  files = new WeakMap(); reads = []; decodes = []

  vi.stubGlobal('FileReader', class ControlledFileReader {
    result: string | ArrayBuffer | null = null
    error: DOMException | null = null
    onload: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onabort: ((event: Event) => void) | null = null
    readAsDataURL(file: File) {
      // Unknown files are rejected, not turned into a canned successful image.
      const data = files.get(file)
      if (data === undefined) {
        this.error = new DOMException('Unregistered fixture file', 'NotReadableError')
        this.onerror?.(new Event('error'))
        return
      }
      const request: ReadRequest = {
        file, completed: false,
        complete: () => {
          expect(request.completed).toBe(false)
          request.completed = true
          this.result = data
          this.onload?.(new Event('load'))
        },
      }
      reads.push(request)
    }
  })
  vi.stubGlobal('Image', class ControlledImage {
    src = ''
    naturalWidth = 0
    naturalHeight = 0
    decode() {
      // A deterministic timing seam, not evidence of a real browser decode.
      // The only permitted asset is the valid fixture with known 1x1 dimensions.
      if (this.src !== PNG_DATA) return Promise.reject(new Error('Unknown image fixture'))
      return new Promise<void>(resolve => {
        const request: DecodeRequest = {
          source: this.src, completed: false,
          complete: () => {
            expect(request.completed).toBe(false)
            request.completed = true
            this.naturalWidth = 1; this.naturalHeight = 1
            resolve()
          },
        }
        decodes.push(request)
      })
    }
  })
  mount = document.createElement('div'); document.body.append(mount)
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  const errors = consoleErrors.mock.calls.slice(), alerts = alertCalls.mock.calls.slice()
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  expect(errors).toEqual([])
  expect(alerts).toEqual([])
})

async function microtasks() { for (let i = 0; i < 8; i++) await Promise.resolve() }
async function mountFixture() {
  const doc = blank('P09 image fill ownership')
  doc.schemaVersion = 6
  const target = node('rectangle', 40, 50, 160, 90)
  const untouched = node('rectangle', 320, 70, 80, 60)
  target.name = 'Image fill target'; untouched.name = 'Untouched sibling'
  target.fills = [{ ...paint('#2468ac', 'image'), fit: 'contain', opacity: .625,
    blend: 'multiply', transform: [1, 0, 0, 1, .125, .25] }]
  // A second fill distinguishes the selected image slot from adjacent material.
  target.fills.push(paint('#abcdef'))
  doc.nodes[target.id] = target; doc.nodes[untouched.id] = untouched
  doc.pages[0].children = [target.id, untouched.id]
  targetId = target.id; untouchedId = untouched.id; fillId = target.fills[0].id
  editor = new Editor(doc); editor.select([targetId])
  await act(async () => {
    root.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>)
    await microtasks()
  })
  expect(mount.querySelector('aside')?.getAttribute('data-node-id')).toBe(targetId)
  expect(editor.state.doc.nodes[targetId].fills[0].id).toBe(fillId)
  expect(editor.state.doc.nodes[targetId].fills[0].image).toBeUndefined()
  expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
}

function fileInput() {
  const inputs = [...mount.querySelectorAll<HTMLInputElement>('.paint-editor input[type="file"]')]
  expect(inputs).toHaveLength(1)
  expect(inputs[0].accept).toBe(RASTER_MIME_ACCEPT)
  expect(RASTER_MIME_ACCEPT).toContain('image/gif')
  expect(RASTER_MIME_ACCEPT).toContain('image/tiff')
  return inputs[0]
}
async function chooseImage(name: string) {
  const input = fileInput(), card = input.closest('.paint-editor')!
  const choose = [...card.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.trim() === '选择图片')
  expect(choose).toBeDefined(); expect(choose!.disabled).toBe(false)
  const clicked = vi.fn()
  input.addEventListener('click', clicked)
  await act(async () => { choose!.click() })
  input.removeEventListener('click', clicked)
  expect(clicked).toHaveBeenCalledOnce()
  const file = new File([Uint8Array.from(PNG_BYTES)], name, { type: 'image/png' })
  files.set(file, PNG_DATA)
  expect(file.size).toBe(PNG_BYTES.length)
  // jsdom cannot open an OS picker. Supply its selected File to the real input,
  // then dispatch the native change event; never invoke React props directly.
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await microtasks() })
  expect(reads.at(-1)?.file).toBe(file)
  return input
}
function unchanged(before: DesignDocument, version: number) {
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  expect(editor.state.selection).toEqual([targetId])
  expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
}
async function completeRead(index: number) {
  await act(async () => { reads[index].complete(); await microtasks() })
  expect(decodes[index].source).toBe(PNG_DATA)
  expect(decodes[index].completed).toBe(false)
}
async function completeDecode(index: number) {
  await act(async () => { decodes[index].complete(); await microtasks() })
}
async function assertAccepted(before: DesignDocument, version: number) {
  const expected = structuredClone(before)
  expected.nodes[targetId].fills[0].image = PNG_DATA
  expect(editor.state.doc).toEqual(expected)
  expect(editor.state.doc.nodes[targetId].fills[0].id).toBe(fillId)
  expect(editor.state.doc.nodes[targetId].fills[1]).toEqual(before.nodes[targetId].fills[1])
  expect(editor.state.doc.nodes[untouchedId]).toEqual(before.nodes[untouchedId])
  expect(editor.state.selection).toEqual([targetId])
  expect(editor.state.version).toBe(version + 1)
  expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(false)
  // In-memory production FD persistence boundary, not JSON-only round-tripping
  // and not a claim about a physical disk save or Electron native file dialog.
  const restored = decodeDocumentBinary(encodeDocumentBinary(editor.state.doc))
  expect(restored).toEqual(expected)
  const reopened = new Editor(restored as DesignDocument)
  try {
    expect(reopened.state.doc).toEqual(expected)
    expect(reopened.state.doc.nodes[targetId].fills[0].image).toBe(PNG_DATA)
  } finally { reopened.dispose() }
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo())
  expect(editor.state.doc).toEqual(expected)
  expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(false)
}

test('P09a mounted Inspector file input commits a valid image exactly once after decoding, retaining bytes, owner and FD history', async () => {
  await mountFixture()
  const before = editor.state.doc, version = editor.state.version
  await chooseImage('accepted.png')
  expect(reads).toHaveLength(1); expect(decodes).toHaveLength(0)
  unchanged(before, version)
  await completeRead(0)
  expect(decodes).toHaveLength(1)
  unchanged(before, version) // Proves this case reached, but has not skipped, the await.
  await completeDecode(0)
  await assertAccepted(before, version)
})

test('P09b mounted Inspector rejects old image completion after same-ID replacement but still accepts a new owned request', async () => {
  await mountFixture()
  const original = editor.state.doc, originalVersion = editor.state.version
  const generation = editor.sessionGeneration, page = editor.state.page
  const input = await chooseImage('old-session.png')
  await completeRead(0)
  expect(reads).toHaveLength(1); expect(decodes).toHaveLength(1)
  unchanged(original, originalVersion)

  const replacement = structuredClone(original)
  replacement.name = 'Replacement document with reused IDs'
  replacement.nodes[targetId].name = 'Replacement target, same ID'
  replacement.nodes[targetId].fills[0].fit = 'stretch'
  replacement.nodes[untouchedId].name = 'Replacement sibling sentinel'
  // preserveView keeps the same selection/page through the real load. The paint
  // input remains mounted: this cannot pass merely because its node disappeared.
  await act(async () => { expect(editor.load(replacement, true)).toBe(true); await microtasks() })
  const adopted = editor.state.doc, adoptedVersion = editor.state.version
  expect(adopted.id).toBe(original.id)
  expect(editor.state.page).toBe(page)
  expect(editor.sessionGeneration).toBe(generation + 1)
  expect(adoptedVersion).toBe(originalVersion + 1)
  expect(adopted.nodes[targetId].fills[0].id).toBe(fillId)
  expect(fileInput()).toBe(input)
  unchanged(adopted, adoptedVersion)

  await completeDecode(0)
  unchanged(adopted, adoptedVersion)
  expect(editor.state.doc).toEqual(replacement)
  expect(editor.state.doc.nodes[targetId].fills[0].image).toBeUndefined()
  expect(alertCalls).not.toHaveBeenCalled()

  // Positive control on the retained DOM input: rejecting the stale result must
  // not accidentally leave image selection permanently inert for the new owner.
  expect(await chooseImage('new-session.png')).toBe(input)
  expect(reads).toHaveLength(2); expect(decodes).toHaveLength(1)
  unchanged(adopted, adoptedVersion)
  await completeRead(1)
  expect(decodes).toHaveLength(2)
  unchanged(adopted, adoptedVersion)
  await completeDecode(1)
  await assertAccepted(adopted, adoptedVersion)
})
