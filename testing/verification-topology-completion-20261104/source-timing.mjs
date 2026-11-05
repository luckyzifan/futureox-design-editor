// Count native compile requests in an instrumented Electron host only.
// Do not serialize source records, packet contents or fingerprints into timing logs.
import {appendFileSync} from 'node:fs'
export function observeSourceCompiles(NativePreparation, destination) {
  const original = NativePreparation.prototype.request
  NativePreparation.prototype.request = function (input) {
    if (!['compile_gpu_packet','load_source_snapshot','load_document'].includes(input.method)) return original.call(this, input)
    const at = performance.timeOrigin + performance.now()
    const record = {at, lane:input.lane, method:input.method}
    const options=input.method==='compile_gpu_packet'?JSON.parse(input.args[0]):{}
    record.zoom=options.view?.zoom
    record.view=options.view
    record.capture=!!options.captureViewport
    record.viewport=options.gpuViewport ?? options.captureViewport
    record.options=Object.keys(options).sort()
    return original.call(this,input).then(reply=>{
      const end = performance.timeOrigin + performance.now()
      const d = reply.compileStats?.sourceDemand
      record.wallMs = end-at
      if(input.method==='compile_gpu_packet'){
        record.packetBytes=reply.value?.byteLength
        record.ackRanges=options.frameResources?.ranges?.length
      }
      record.mode = reply.error ? 'rejected' : d?.mode ?? (input.method==='compile_gpu_packet'?'ordinary':'load')
      if(reply.error)record.invalidViewport=String(reply.error).includes('Invalid GPU tile viewport')
      if (d?.reason) record.reason = d.reason
      if (d?.timingUs) record.timingUs = d.timingUs
      if (d?.scopeExpansions !== undefined) record.scopeExpansions = d.scopeExpansions
      appendFileSync(destination, JSON.stringify(record)+'\n')
      return reply
    },error=>{
      record.wallMs=performance.timeOrigin+performance.now()-at
      record.mode=String(error).includes('CANCEL')?'cancelled':'rejected'
      record.invalidViewport=String(error).includes('Invalid GPU tile viewport')
      appendFileSync(destination, JSON.stringify(record)+'\n')
      throw error
    })
  }
}
