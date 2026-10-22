// DRAFT_NOT_RUN. Tests-only proposal outside the frozen source/active suites.
// Intended integration location: frontend/design-client/src/ (relative imports).
// C06 single continuous preview/stack/async session-replacement/resource/history chain.
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
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { Canvas } from './Canvas'
import { shortcutPreference } from './shortcut-preference'
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
vi.mock('./kernel/Surface',async()=>{const {useLayoutEffect}=await import('react');return {KernelSurface(props:import('./kernel/Surface').SurfaceProps){useLayoutEffect(()=>{props.onPresentation?.({...props,epoch:props.presentationEpoch!,pixelRatio:1,managed:false})},[props.document,props.pageId,props.view,props.width,props.height,props.presentationEpoch,props.onPresentation]);return <div/>}}})

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
    'HTMLButtonElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'FocusEvent',
    'KeyboardEvent', 'File', 'Blob', 'DOMException', 'localStorage', 'alert',
  ]) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Use jsdom's scheduling rather than an always-success renderer/owner double.
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window))
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  consoleErrors = vi.spyOn(console, 'error') // Call through: do not suppress failures.
  alertCalls = vi.spyOn(globalThis, 'alert')
  interfacePreference.reset();shortcutPreference.set('sketch-like')
  Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'});vi.stubGlobal('PointerEvent',dom.window.MouseEvent);vi.stubGlobal('devicePixelRatio',1)
  vi.stubGlobal('CSS',{escape:(s:string)=>s});dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.spyOn(dom.window.HTMLCanvasElement.prototype,'getContext').mockReturnValue(null)
  dom.window.HTMLElement.prototype.setPointerCapture=()=>{};dom.window.HTMLElement.prototype.releasePointerCapture=()=>{};dom.window.HTMLElement.prototype.hasPointerCapture=()=>false
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
    root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor}/><Inspector editor={editor} /></PendingEditContext.Provider>)
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
  expect(inputs[0].accept).toBe('image/png,image/jpeg,image/webp')
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
async function completeRead(index: number) {
  await act(async () => { reads[index].complete(); await microtasks() })
  expect(decodes[index].source).toBe(PNG_DATA)
  expect(decodes[index].completed).toBe(false)
}
async function completeDecode(index: number) {
  await act(async () => { decodes[index].complete(); await microtasks() })
}
async function draft(input:HTMLInputElement,value:string){await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
async function click(element:Element){await act(async()=>{element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));await microtasks()})}
async function historyKey(redo=false){const host=mount.querySelector<HTMLElement>('[data-testid="canvas"]')!;expect(host).not.toBeNull();host.focus();const event=new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,shiftKey:redo,bubbles:true,cancelable:true});await act(async()=>{host.dispatchEvent(event);await microtasks()});expect(event.defaultPrevented).toBe(true);expect(document.activeElement).toBe(host)}
test('C06 Inspector preview stack edits then stale image after same-ID document switch, retry alpha edit keyboard history FD reopen',async()=>{
 await mountFixture();const original=editor.state.doc
 const solid=mount.querySelectorAll<HTMLElement>('.paint-editor')[1];expect(solid).toBeDefined();await click(solid.querySelector('button[aria-label="颜色"]')!)
 const color=document.querySelector<HTMLInputElement>('input[aria-label="填充颜色值"]')!;expect(color).not.toBeNull();await draft(color,'#112233');const preview=editor.state.doc;expect(editor.authoredDocument).toBe(original);expect(editor.state.version).toBe(0)
 await click(solid.closest('.property-card')!.querySelector('button[title="上移"]')!);const reordered=editor.state.doc;expect(editor.propertyPreviewActive).toBe(false);expect(editor.state.version).toBe(2);expect(reordered.nodes[targetId].fills.map(p=>p.id)).toEqual([original.nodes[targetId].fills[1].id,fillId]);expect(reordered.nodes[targetId].fills[0].color).toBe('#112233');expect(reordered.nodes[untouchedId]).toEqual(original.nodes[untouchedId])
 const movedSolid=mount.querySelectorAll<HTMLElement>('.paint-editor')[0];await click(movedSolid.closest('.property-card')!.querySelector('button[title="下移"]')!);expect(editor.state.version).toBe(3);expect(editor.state.doc).toEqual(preview)
 const input=await chooseImage('prior-owner.png');await completeRead(0);const waiting=editor.state.doc,revision=editor.state.version,generation=editor.sessionGeneration;expect(waiting.nodes[targetId].fills[0].image).toBeUndefined()
 const replacement=structuredClone(waiting);replacement.name='C06 replacement';replacement.nodes[targetId].fills[0].fit='stretch';replacement.nodes[untouchedId].name='New owner sentinel'
 await act(async()=>{expect(editor.load(replacement,true)).toBe(true);await microtasks()});const adopted=editor.state.doc,adoptedVersion=editor.state.version;expect(editor.sessionGeneration).toBe(generation+1);expect(adoptedVersion).toBe(revision+1);expect(fileInput()).toBe(input);expect(editor.canUndo).toBe(false);expect(editor.canRedo).toBe(false)
 await completeDecode(0);expect(editor.state.doc).toBe(adopted);expect(editor.state.version).toBe(adoptedVersion);expect(editor.state.selection).toEqual([targetId]);expect(alertCalls).not.toHaveBeenCalled()
 expect(await chooseImage('current-owner.png')).toBe(input);await completeRead(1);expect(editor.state.doc).toBe(adopted);await completeDecode(1);const imageDoc=editor.state.doc;expect(imageDoc.nodes[targetId].fills[0].image).toBe(PNG_DATA);expect(imageDoc.nodes[targetId].fills[1]).toEqual(adopted.nodes[targetId].fills[1]);expect(editor.state.version).toBe(adoptedVersion+1)
 const imagePanel=fileInput().closest('.paint-editor')!,alpha=imagePanel.querySelector<HTMLInputElement>('input[aria-label="不透明度 %"]')!;expect(alpha).not.toBeNull();await draft(alpha,'25');await act(async()=>alpha.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));console.log('C06 numeric ownership diagnostic', JSON.stringify({value:alpha.value,validationMessage:alpha.validationMessage,customError:alpha.validity.customError,generationBefore:generation,generationNow:editor.sessionGeneration,version:editor.state.version,expectedVersion:adoptedVersion+2,focused:document.activeElement===alpha,opacity:editor.state.doc.nodes[targetId].fills[0].opacity}));const final=editor.state.doc;expect(final.nodes[targetId].fills[0].opacity).toBe(.25);expect(final.nodes[targetId].fills[0].image).toBe(PNG_DATA);expect(final.nodes[untouchedId]).toEqual(adopted.nodes[untouchedId]);expect(editor.state.version).toBe(adoptedVersion+2)
 await historyKey();expect(editor.state.doc).toEqual(imageDoc);await historyKey();expect(editor.state.doc).toEqual(adopted);expect(editor.canUndo).toBe(false);await historyKey(true);expect(editor.state.doc).toEqual(imageDoc);await historyKey(true);expect(editor.state.doc).toEqual(final);expect(editor.canRedo).toBe(false)
 const bytes=encodeDocumentBinary(final),dir=mkdtempSync(join(tmpdir(),'c06-fd-'));let restored:DesignDocument;try{const path=join(dir,'c06.fd');writeFileSync(path,bytes);const actual=readFileSync(path);expect([...actual]).toEqual([...bytes]);restored=decodeDocumentBinary(new Uint8Array(actual)) as DesignDocument}finally{rmSync(dir,{recursive:true,force:true})}expect(restored!).toEqual(final);const reopened=new Editor(restored as DesignDocument);try{expect(reopened.state.doc).toEqual(final);expect(reopened.state.doc.nodes[targetId].fills[0].image).toBe(PNG_DATA);expect(reopened.canUndo).toBe(false);expect(reopened.state.selection).toEqual([])}finally{reopened.dispose()}
})

// Diagnostic positive control: same authored document generation, fresh real panel.
test('C06 diagnostic fresh Inspector remount accepts 25 percent after same-ID document replacement',async()=>{
 await mountFixture(); const before=editor.state.doc,generation=editor.sessionGeneration;
 await act(async()=>{expect(editor.load(structuredClone(before),true)).toBe(true);await microtasks()});
 expect(editor.sessionGeneration).toBe(generation+1);expect(editor.canUndo).toBe(false);
 await act(async()=>{root.render(null);await microtasks()});
 await act(async()=>{root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor}/><Inspector editor={editor}/></PendingEditContext.Provider>);await microtasks()});
 const alpha=fileInput().closest('.paint-editor')!.querySelector<HTMLInputElement>('input[aria-label="不透明度 %"]')!;expect(alpha).not.toBeNull();
 await draft(alpha,'25');expect(alpha.value).toBe('25');
 await act(async()=>{alpha.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await microtasks()});
 console.log('C06 fresh mount control',JSON.stringify({value:alpha.value,validationMessage:alpha.validationMessage,customError:alpha.validity.customError,generation:editor.sessionGeneration,opacity:editor.state.doc.nodes[targetId].fills[0].opacity}));
 expect(alpha.validity.customError).toBe(false);expect(editor.state.doc.nodes[targetId].fills[0].opacity).toBe(.25);expect(editor.state.doc.nodes[targetId].fills[1]).toEqual(before.nodes[targetId].fills[1]);expect(editor.state.doc.nodes[untouchedId]).toEqual(before.nodes[untouchedId]);expect(editor.canUndo).toBe(true);
 await historyKey();expect(editor.state.doc).toEqual(before);await historyKey(true);expect(editor.state.doc.nodes[targetId].fills[0].opacity).toBe(.25);
})
