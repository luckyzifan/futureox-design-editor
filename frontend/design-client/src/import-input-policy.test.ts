import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { assertImportInputBytes, IMPORT_INPUT_MAX_BYTES, importInputStatus } from './import-input-policy'
import { readDesignFile } from './persistence'
import { documentCapacity } from './document-capacity'
import { figArchive } from './import-fig-archive'
import { decodeFig } from './import-fig'
import { operationStatusText } from './operation-status-messages'
// Controlled message transport, but the file-reading handler below is the
// production import-worker. It stops at a sentinel read rejection, before a
// codec or any large allocation. This is not a real browser Worker test.
const workerScope: { onmessage?: (event: MessageEvent) => Promise<void>; postMessage(data: unknown): void } = {
 postMessage() {},
}
let readingInWorker = false
class PickerWorker {
 static instances: PickerWorker[] = []
 onmessage?: (event: { data: unknown }) => void
 onerror?: (event: { message: string }) => void
 onmessageerror?: () => void
 terminate = vi.fn()
 postMessage = vi.fn((data: unknown, _transfer: Transferable[]) => {
  queueMicrotask(async () => {
   workerScope.postMessage = reply => this.onmessage?.({ data: reply })
   readingInWorker = true
   try { await workerScope.onmessage!({ data } as MessageEvent) }
   finally { readingInWorker = false }
  })
 })
 constructor() { PickerWorker.instances.push(this) }
}
beforeAll(async () => {
 vi.stubGlobal('self', workerScope)
 await import('./import-worker')
})
beforeEach(() => {
 PickerWorker.instances = []
 readingInWorker = false
 vi.stubGlobal('self', workerScope)
 vi.stubGlobal('Worker', PickerWorker)
})
afterEach(() => vi.unstubAllGlobals())
const admitted=[0,32*1024**2-1,32*1024**2,32*1024**2+1,1024**3-1,1024**3]
test.each(admitted)('encoded input policy admits %s bytes without allocating that payload',bytes=>{
 expect(()=>assertImportInputBytes(bytes)).not.toThrow()
})
test.each([1024**3+1,-1,Infinity,NaN,1.5])('encoded input policy rejects invalid/overlimit %s',bytes=>{
 expect(()=>assertImportInputBytes(bytes)).toThrow()
})
test.each(admitted)('actual Sketch picker admits %s declared bytes to its worker-owned read',async size=>{
 const sentinel=Error('intentional read stop, no large buffer allocated')
 const arrayBuffer=vi.fn(async()=>{expect(readingInWorker).toBe(true);throw sentinel})
 const file={name:'fixture.SKETCH',size,arrayBuffer} as unknown as File
 const result=readDesignFile(file)
 // Reading must not happen on the picker/UI side before the worker dispatch.
 expect(arrayBuffer).not.toHaveBeenCalled()
 expect(PickerWorker.instances).toHaveLength(1)
 const worker=PickerWorker.instances[0]
 expect(worker.postMessage).toHaveBeenCalledWith({file,name:'fixture',format:'sketch',memoryBytes:documentCapacity().memoryBytes},[])
 // Worker messages preserve the error text, not cross-realm Error identity.
 await expect(result).rejects.toThrow(sentinel.message)
 expect(arrayBuffer).toHaveBeenCalledOnce()
 expect(worker.terminate).toHaveBeenCalledOnce()
})
test.each([IMPORT_INPUT_MAX_BYTES+1,Infinity,NaN,-1])('actual picker rejects %s before read',async size=>{
 const arrayBuffer=vi.fn()
 await expect(readDesignFile({name:'fixture.sketch',size,arrayBuffer} as unknown as File)).rejects.toThrow()
 expect(arrayBuffer).not.toHaveBeenCalled()
 expect(PickerWorker.instances).toHaveLength(0)
})
test.each([figArchive,decodeFig])('direct FIG entry rejects >1GiB before reading bytes',entry=>{
 const bytes={length:IMPORT_INPUT_MAX_BYTES+1} as Uint8Array
 expect(()=>entry(bytes)).toThrow(/1 GiB/)
})
test('fixed error is localizable without exposing filename or arbitrary exception text',()=>{
 let error:unknown;try{assertImportInputBytes(IMPORT_INPUT_MAX_BYTES+1)}catch(e){error=e}
 const status=importInputStatus(error)!,raw=(error as Error).message
 expect(operationStatusText(raw,{raw,status},'en')).toBe('Import file exceeds the 1 GiB (1,073,741,824 bytes) input limit')
 expect(operationStatusText(raw,{raw,status},'zh-CN')).toBe(raw)
 expect(importInputStatus(Error('private arbitrary message'))).toBeUndefined()
})
test.each([
 ['importInputInvalid','导入文件字节数无效','Invalid import file byte count'],
 ['openCanvasBeforeImageImport','请先打开画布，再导入图片','Open a canvas before importing an image'],
] as const)('literal Chinese/English contract %s', (key, raw, english)=>{
 expect(operationStatusText(raw,{raw,status:{key}},'zh-CN')).toBe(raw)
 expect(operationStatusText(raw,{raw,status:{key}},'en')).toBe(english)
})
