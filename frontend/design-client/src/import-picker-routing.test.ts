import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

/** Execute the actual checked-in App input handler, not a duplicate routing
 * implementation. This is a handler test, not mounted React/Electron coverage. */
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
function handler(showHome = false, mode = 'open', design = vi.fn(async (_file: File, _mode: string) => {}), images = vi.fn(async (_files: File[]) => {})) {
  const input = app.slice(app.indexOf('        ref={file}'))
  const body = input.match(/onChange=\{async \(e\) => \{([\s\S]*?)\n        \}\}/)?.[1]
  if (!body) throw Error('Actual file input handler not found')
  const notices = vi.fn()
  return { design, images, notices, change: new Function('importDesignFile', 'importImageFiles', 'importMode', 'showHome', 'editor', `return async function(e) {${body}}`)(design, images, { current: mode }, showHome, { notify: notices }) as (event: {currentTarget: {files: File[]; value: string}}) => Promise<void> }
}
test.each(['png','PNG','jpg','jpeg','WEBP'])('actual picker dispatches %s image to image import', async ext => {
  const h = handler(), f = new File(['opaque'], `input.${ext}`, {type:'image/png'})
  const target = {files:[f],value:'selected'}
  await h.change({currentTarget:target})
  expect(h.images).toHaveBeenCalledExactlyOnceWith([f]); expect(h.design).not.toHaveBeenCalled(); expect(target.value).toBe('')
})
test.each(['fd','json','svg','svgz','fig','sketch','PDF'])('actual picker keeps %s design and append mode', async ext => {
  const h = handler(false,'append'), f = new File(['opaque'], `input.${ext}`)
  await h.change({currentTarget:{files:[f],value:'selected'}})
  expect(h.design).toHaveBeenCalledExactlyOnceWith(f,'append');expect(h.images).not.toHaveBeenCalled()
})
test.each(['','text/plain','image/webp'])('routing preserves image MIME for downstream validation: %s', async type => {
  const h=handler(), f=new File(['opaque'],'input.png',{type})
  await h.change({currentTarget:{files:[f],value:'selected'}})
  expect(h.images.mock.calls[0][0][0]).toBe(f);expect(f.type).toBe(type)
})
test('cancelled picker is a no-op and repeated same file remains selectable',async()=>{
 const h=handler(), f=new File(['opaque'],'input.png'),target={files:[] as File[],value:''}
 await h.change({currentTarget:target});expect(h.images).not.toHaveBeenCalled();expect(h.design).not.toHaveBeenCalled()
 target.files=[f];target.value='selected';await h.change({currentTarget:target});expect(target.value).toBe('')
 target.value='selected';await h.change({currentTarget:target});expect(h.images).toHaveBeenCalledTimes(2)
})
test('home gives explicit feedback without opening or mutating a hidden document',async()=>{
 const h=handler(true);await h.change({currentTarget:{files:[new File(['opaque'],'a.png')],value:'selected'}})
 expect(h.images).not.toHaveBeenCalled();expect(h.design).not.toHaveBeenCalled()
 expect(h.notices).toHaveBeenCalledExactlyOnceWith('请先打开画布，再导入图片', { key: 'openCanvasBeforeImageImport' })
})
test('picker does not retry or switch route on downstream failure',async()=>{
 const error=new Error('opaque read failure'), images=vi.fn(async()=>{throw error}),h=handler(false,'open',vi.fn(),images)
 await expect(h.change({currentTarget:{files:[new File(['opaque'],'a.png')],value:'selected'}})).rejects.toBe(error)
 expect(images).toHaveBeenCalledOnce();expect(h.design).not.toHaveBeenCalled()
})

test.each([true,false])('actual image action maps locked diagnostic cancellation=%s without retry',async cancelled=>{
 const {stripTypeScriptTypes}=await import('node:module')
 const source=app.slice(app.indexOf('  async function importImageFiles('),app.indexOf('  const switchLifetime =', app.indexOf('  async function importImageFiles(')))
 const executable=stripTypeScriptTypes(source)
 const trace={result:vi.fn(),finish:vi.fn(),actionId:1,actionOwner:2}
 const diagnostic={fail:vi.fn(()=>cancelled ? 1 : 4)}
 const editor={interactionActive:false,notify:vi.fn()}
 const append=vi.fn(async(_editor:unknown,files:File[],_anchor:unknown,_decode:unknown,diagnose:(file:File)=>unknown)=>{
  diagnose(files[0]);throw Error('opaque')
 })
 const run=new Function('beginEditorAction','CanvasAction','ActionSource','ImportFailure','ActionOutcome','ActionReason','ready','editor','commitPendingEdits','document','captureImageImportAnchor','appendImageFiles','beginImportDiagnostic','StaleImageImport','importInputStatus',`${executable};return importImageFiles`)(
  ()=>trace,{import:1},{menu:1},{cancelled:1},{cancelled:2,rejected:3,blocked:4},{superseded:5,validation:6},true,editor,()=>true,{querySelector:()=>({clientWidth:10,clientHeight:10})},()=>({x:0,y:0}),append,()=>diagnostic,class Stale extends Error{},()=>undefined)
 await run([new File(['x'],'image.png')])
 expect(trace.result).toHaveBeenCalledExactlyOnceWith(cancelled?2:3,cancelled?5:6)
 expect(append).toHaveBeenCalledOnce();expect(trace.finish).toHaveBeenCalledOnce()
})
