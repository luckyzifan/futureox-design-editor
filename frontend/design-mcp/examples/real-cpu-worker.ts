import { VectorEngine } from '../../design-client/src/generated/design-kernel/design_kernel'
/** In-process Worker transport adapter. Rendering/PNG encoding are real Rust/WASM. */
export class RealCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  private terminated = false
  postMessage(request: any) {
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const bytes = this.engine.render_region_png(JSON.stringify({pageId:request.options.pageId,...request.options.exportRegion,rasterProfile:request.options.rasterProfile,colorOutput:request.options.colorOutput}))
        this.onmessage?.({ data: { id:request.id,buffer:bytes.buffer,stats:JSON.parse(this.engine.stats()),backend:'cpu' } })
      } catch (error) { console.error('RealCpuWorker render failure',error); this.onmessage?.({ data: { id:request.id,error:String(error) } }) }
    })
  }
  terminate() { if (!this.terminated) { this.terminated=true; try { this.engine.free() } catch(error) { console.error('RealCpuWorker cleanup failure',error) } } }
}
