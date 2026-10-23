import { expect, test, vi } from 'vitest'
import { assertImportInputBytes, IMPORT_INPUT_MAX_BYTES, importInputStatus } from './import-input-policy'
import { readDesignFile } from './persistence'
import { figArchive } from './import-fig-archive'
import { decodeFig } from './import-fig'
import { operationStatusText } from './operation-status-messages'
const admitted=[0,32*1024**2-1,32*1024**2,32*1024**2+1,1024**3-1,1024**3]
test.each(admitted)('encoded input policy admits %s bytes without allocating that payload',bytes=>{
 expect(()=>assertImportInputBytes(bytes)).not.toThrow()
})
test.each([1024**3+1,-1,Infinity,NaN,1.5])('encoded input policy rejects invalid/overlimit %s',bytes=>{
 expect(()=>assertImportInputBytes(bytes)).toThrow()
})
test.each(admitted)('actual Sketch picker admission reaches read at %s declared bytes',async size=>{
 const sentinel=Error('intentional read stop, no large buffer allocated'),arrayBuffer=vi.fn(async()=>{throw sentinel})
 await expect(readDesignFile({name:'fixture.SKETCH',size,arrayBuffer} as unknown as File)).rejects.toBe(sentinel)
 expect(arrayBuffer).toHaveBeenCalledOnce()
})
test.each([IMPORT_INPUT_MAX_BYTES+1,Infinity,NaN,-1])('actual picker rejects %s before read',async size=>{
 const arrayBuffer=vi.fn()
 await expect(readDesignFile({name:'fixture.sketch',size,arrayBuffer} as unknown as File)).rejects.toThrow()
 expect(arrayBuffer).not.toHaveBeenCalled()
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
