import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { beginImportDiagnostic, importFailureCode, ImportFailure, ImportStage } from './import-diagnostics'
import { sanitizeFields } from '../../design-desktop/src/render-terminal-diagnostics.mjs'
const rows = vi.hoisted(() => [] as Array<Record<string, number>>)
vi.mock('../../design-desktop/src/render-terminal-diagnostics.mjs', async importOriginal => ({
 ...(await importOriginal<Record<string, unknown>>()),
 createRenderDiagnostics: () => ({record: (_kind: string, values: Record<string, number>) => rows.push(values)}),
}))
beforeEach(() => { rows.length = 0; vi.stubGlobal('window', {coreDesktop:{renderDiagnostics:true}}) })
afterEach(()=>vi.unstubAllGlobals())
test('classification is exact, content-free and does not read payload getters',()=>{
 expect(importFailureCode(new Error('文件超过 32 MB'),230)).toBe(ImportFailure.size)
 expect(importFailureCode(new Error('请选择 .fd、Sketch、JSON、SVG、FIG 或 PDF 文件'),230)).toBe(ImportFailure.unsupportedFormat)
 expect(importFailureCode(new Error('private path: 文件超过 32 MB'),230)).toBe(ImportFailure.unknown)
 expect(importFailureCode(new SyntaxError('private authored text'),233)).toBe(ImportFailure.syntax)
 expect(importFailureCode(new Error('private schema'),234)).toBe(ImportFailure.validation)
 expect(importFailureCode(new Error('unknown codec'),233)).toBe(ImportFailure.unknown)
 const get=vi.fn(()=>{throw Error('must not invoke')});const value=Object.defineProperty({},'message',{get})
 expect(importFailureCode(value,230)).toBe(0);expect(get).not.toHaveBeenCalled()
})
test('terminal sanitizer retains bounded import identity but not private payloads',()=>{
 const fields=sanitizeFields({importBytes:50*1024**2,importFormat:6,importMode:2,actionOwner:123,actionId:5,requestId:8,methodCode:230,phase:3,reasonCode:3,name:'private',message:'private',stack:'private',path:'private'})
 expect(fields).toMatchObject({importBytes:50*1024**2,importFormat:6,importMode:2,actionOwner:123,actionId:5,requestId:8,methodCode:230,phase:3,reasonCode:3})
 expect(JSON.stringify(fields)).not.toContain('private')
 expect(sanitizeFields({importBytes:2**32+1,importFormat:99,importMode:99})).toEqual({})
})
test('disabled diagnostic preserves return and exact thrown object',async()=>{
 const diag=beginImportDiagnostic({name:'private.sketch',size:5},'open',{actionId:1,actionOwner:2})
 const error=Error('private')
 expect(diag.run(ImportStage.validate,()=>3)).toBe(3)
 await expect(diag.wait(ImportStage.read,async()=>{throw error})).rejects.toBe(error)
})

function deferredRead() {
 let reject!: (error: unknown) => void
 const pending = new Promise<ArrayBuffer>((_, fail) => { reject = fail })
 const file = new File(['{}'], 'private.json')
 Object.defineProperty(file, 'arrayBuffer', { value: () => pending })
 return { file, reject }
}
for (const retirement of ['abort', 'supersede'] as const) {
 test(`deferred File.arrayBuffer rejection after ${retirement} remains cancelled`, async () => {
  const read = deferredRead(), controller = new AbortController()
  let current = true
  const diag = beginImportDiagnostic(read.file, 'open', {actionId: 3, actionOwner: 4})
  diag.bindRequest({signal: controller.signal, isCurrent: () => current})
  const error = Error('private read failure')
  const result = diag.wait(ImportStage.read, () => read.file.arrayBuffer())
  const rejected = expect(result).rejects.toBe(error)
  if (retirement === 'abort') controller.abort(); else current = false
  read.reject(error)
  await rejected
  expect(diag.fail(error, true)).toBe(ImportFailure.cancelled)
  expect(rows.filter(row => row.phase === 3)).toHaveLength(1)
  expect(rows.find(row => row.phase === 3)).toMatchObject({reasonCode: ImportFailure.cancelled, actionId: 3, actionOwner: 4})
  expect(rows.filter(row => row.phase === 4)).toHaveLength(1)
  expect(rows.find(row => row.phase === 4)).toMatchObject({reasonCode: ImportFailure.read, count: 1})
  expect(rows.find(row => row.phase === 4)?.requestId).toBe(rows.find(row => row.phase === 3)?.requestId)
 })
}
test('a genuine read failure stays first terminal outcome if request retires later', async () => {
 const read = deferredRead(), controller = new AbortController()
 const diag = beginImportDiagnostic(read.file, 'open', {actionId: 5, actionOwner: 6})
 diag.bindRequest({signal: controller.signal, isCurrent: () => true})
 const error = Error('private read failure')
 const result = diag.wait(ImportStage.read, () => read.file.arrayBuffer())
 const rejected = expect(result).rejects.toBe(error)
 read.reject(error)
 await rejected
 controller.abort()
 expect(diag.fail(error, true)).toBe(ImportFailure.read)
 expect(rows.filter(row => row.phase === 3)).toHaveLength(1)
 expect(rows.find(row => row.phase === 3)?.reasonCode).toBe(ImportFailure.read)
 expect(rows.filter(row => row.phase === 4)).toHaveLength(0)
})
