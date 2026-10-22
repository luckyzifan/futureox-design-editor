// CPU-only final portable-WASM packet preflight. No browser/GPU is created.
// Arguments: DOCUMENT FONT REQUEST_ARRAY_JSON OUTPUT_JSON
// Real documents/requests/results must remain in an ignored private directory.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const [documentPath, fontPath, requestsPath, outputPath] = process.argv.slice(2)
if (!documentPath || !fontPath || !requestsPath || !outputPath)
  throw Error('Expected DOCUMENT FONT REQUEST_ARRAY_JSON OUTPUT_JSON')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const wasmUrl = new URL('../../frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm', import.meta.url)
const moduleUrl = new URL('../../frontend/design-client/src/generated/design-kernel/design_kernel.js', import.meta.url)
const sources = await Promise.all([documentPath,fontPath,requestsPath,fileURLToPath(wasmUrl),fileURLToPath(moduleUrl)].map(p=>readFile(p)))
const [documentBytes,fontBytes,requestBytes,wasmBytes,moduleBytes] = sources
const { initSync, VectorEngine } = await import(moduleUrl.href)
initSync({ module: new WebAssembly.Module(wasmBytes) })
const requests = JSON.parse(requestBytes.toString())
if (!Array.isArray(requests) || !requests.length || requests.length > 2000) throw Error('Expected 1..2000 explicit requests')
const result = {gpuExecuted:false,scope:'CPU-only portable WASM scene compilation; not pixels, memory or latency acceptance',
  documentSha256:sha(documentBytes),fontSha256:sha(fontBytes),requestsSha256:sha(requestBytes),
  wasmSha256:sha(wasmBytes),moduleSha256:sha(moduleBytes),rows:[]}
const engine = new VectorEngine()
try {
  engine.load_font(fontBytes); engine.load_document(documentBytes.toString())
  for (const [requestIndex,request] of requests.entries()) {
    const wire = JSON.stringify(request), started = performance.now()
    try {
      const compiled = engine.compile_gpu(wire), scene = JSON.parse(compiled)
      result.rows.push({requestIndex,requestSha256:sha(wire),success:true,compileMs:performance.now()-started,
        nativeSceneSha256:sha(compiled),extent:scene.extent,output:scene.output,
        painterSupportRequested:request.gpuPainterSupport??null,rootInputBox:scene.rootInputBox??null,
        pixels:scene.extent.w*scene.extent.h,nodeCount:Object.keys(scene.nodes).length,
        integratedBlur:scene.integratedBlur,floatCompositing:scene.floatCompositing,coherentSamples:scene.coherentSamples,
        filteredNodes:Object.values(scene.nodes).filter(n=>n.effects.length).map(n=>({id:n.id,rect:n.rect,matrix:n.matrix,
          backdropBox:n.backdropBox,backdropOutputBox:n.backdropOutputBox??null,shadowOutputBox:n.shadowOutputBox??null,effects:n.effects})),
        stagedNodes:Object.values(scene.nodes).filter(n=>n.childrenInputBox||n.postCompositeBox).map(n=>({id:n.id,rect:n.rect,
          fillRect:n.fill.rect,childrenInputBox:n.childrenInputBox??null,postCompositeBox:n.postCompositeBox??null}))})
    } catch(error) {
      result.rows.push({requestIndex,requestSha256:sha(wire),success:false,error:String(error),compileMs:performance.now()-started})
    }
  }
} finally { engine.free() }
result.wasmStable = sha(await readFile(wasmUrl))===result.wasmSha256
result.moduleStable = sha(await readFile(moduleUrl))===result.moduleSha256
await writeFile(resolve(outputPath),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({gpuExecuted:false,total:result.rows.length,passed:result.rows.filter(r=>r.success).length,
  wasmSha256:result.wasmSha256,wasmStable:result.wasmStable,moduleStable:result.moduleStable}))
if (!result.wasmStable || !result.moduleStable || result.rows.some(r=>!r.success)) process.exitCode=1
