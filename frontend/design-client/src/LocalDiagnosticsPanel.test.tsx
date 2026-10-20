// Real React DOM in jsdom; download/storage APIs are boundary doubles. No GUI/GPU/socket claim.
// @ts-expect-error jsdom is test-only.
import { JSDOM } from 'jsdom'
import React, {act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect, test, vi} from 'vitest'

test('shared local error panel shows safe rows and exports only on user click', async()=>{
 const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://diagnostics.invalid/'})
 for(const name of ['window','document','localStorage','HTMLElement'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const create=vi.fn((_blob:Blob)=> 'blob:local-diagnostic'), revoke=vi.fn(), click=vi.spyOn(dom.window.HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 class TestURL extends URL { static createObjectURL = create; static revokeObjectURL = revoke }
 vi.stubGlobal('URL',TestURL)
 const {localDiagnostics, recordLocalError}=await import('./local-diagnostics')
 const {LocalDiagnosticsPanel}=await import('./LocalDiagnosticsPanel')
 const root=createRoot(document.getElementById('root')!)
 try{
  await localDiagnostics.ready
  recordLocalError('storage',{name:'QuotaExceededError', message:'/private/document token=secret'})
  await localDiagnostics.flush()
  await act(async()=>root.render(<LocalDiagnosticsPanel />))
  expect(document.body.textContent).toContain('QUOTA_EXCEEDED');expect(document.body.textContent).toContain('日志已保存到本地')
  expect(document.body.textContent).not.toContain('/private/document');expect(create).not.toHaveBeenCalled()
  act(()=>document.querySelector('button')!.click());expect(click).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce()
  const blob=create.mock.calls[0][0] as Blob
  const exported=JSON.parse(await blob.text());expect(exported.records[0].component).toBe('storage');expect(JSON.stringify(exported)).not.toContain('secret')
 }finally{await act(async()=>root.unmount());dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals()}
})
