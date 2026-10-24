import type { PayloadToken, PresenterPayloadLedger } from './presenter-payload-ledger'

// Verification only. Actual content-texture Alpha, never rectangle inference.
// Batched mapped reads use the existing byte budget and eight-readback limit.
const SLOTS = 64, STRIDE = 256, BYTES = SLOTS * STRIDE
const shader = `
struct Counts { minimum:atomic<u32>, nonOpaque:atomic<u32>, zero:atomic<u32>, count:atomic<u32> }
@group(0) @binding(0) var pixels:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> output:Counts;
var<workgroup> minimum:atomic<u32>;
var<workgroup> nonOpaque:atomic<u32>;
var<workgroup> zero:atomic<u32>;
var<workgroup> count:atomic<u32>;
@compute @workgroup_size(16,16) fn main(@builtin(global_invocation_id) p:vec3<u32>,@builtin(local_invocation_index) local:u32) {
 if(local==0u){atomicStore(&minimum,255u);atomicStore(&nonOpaque,0u);atomicStore(&zero,0u);atomicStore(&count,0u);}
 workgroupBarrier();
 let size=textureDimensions(pixels);
 if(p.x<size.x&&p.y<size.y){
  let a=u32(round(clamp(textureLoad(pixels,vec2<i32>(p.xy),0).a,0.,1.)*255.));
  atomicMin(&minimum,a);atomicAdd(&count,1u);
  if(a<255u){atomicAdd(&nonOpaque,1u);}if(a==0u){atomicAdd(&zero,1u);}
 }
 workgroupBarrier();
 if(local==0u){atomicMin(&output.minimum,atomicLoad(&minimum));atomicAdd(&output.nonOpaque,atomicLoad(&nonOpaque));
  atomicAdd(&output.zero,atomicLoad(&zero));atomicAdd(&output.count,atomicLoad(&count));}
}`
type Identity = Record<string, number | undefined>
type Batch = { output: GPUBuffer; read: GPUBuffer; token: PayloadToken; rows: Identity[]; queued: boolean; finished: boolean }
export class PresenterAlphaTrace {
  private pipeline?: GPUComputePipeline
  private current?: Batch
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(private device: GPUDevice, private payload: PresenterPayloadLedger,
    private report: (fields: Record<string, unknown>) => void) {}
  encode(encoder: GPUCommandEncoder, texture: GPUTexture, identity: Identity) {
    if (this.closed) return
    let batch: Batch | undefined, slot = -1
    try {
      this.pipeline ??= this.device.createComputePipeline({ layout: 'auto',
        compute: { module: this.device.createShaderModule({ code: shader }), entryPoint: 'main' } })
      batch = this.current
      if (!batch) {
        const token = this.payload.reserve(BYTES * 2, 'readback')
        let output: GPUBuffer | undefined, read: GPUBuffer | undefined
        try {
          output = this.device.createBuffer({ size: BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
          read = this.device.createBuffer({ size: BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        } catch (error) { output?.destroy(); read?.destroy(); this.payload.cancel(token); throw error }
        batch = this.current = { output, read, token, rows: [], queued: false, finished: false }
        this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 200)
      }
      slot = batch.rows.length
      const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: batch.output, offset: slot * STRIDE, size: 16 } },
      ] })
      batch.queued = true
      this.device.queue.writeBuffer(batch.output, slot * STRIDE, new Uint32Array([255, 0, 0, 0]))
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(texture.width / 16), Math.ceil(texture.height / 16)); pass.end()
      batch.rows.push(identity)
      const captured = batch
      return {
        submitted: () => { if (captured.rows.length === SLOTS) this.flush() },
        cancel: () => {
          if (captured.rows[slot] === identity && slot === captured.rows.length - 1) captured.rows.pop()
          this.report({ ...identity, alphaProbeCode: 4, alphaSubmitted: 0 })
        },
      }
    } catch {
      if (batch && !batch.rows.length) this.discard(batch)
      // A missing probe is explicit; it cannot count as verified Alpha.
      return { submitted: () => this.report({ ...identity, alphaProbeCode: 1, alphaSubmitted: 1 }),
        cancel: () => this.report({ ...identity, alphaProbeCode: 4, alphaSubmitted: 0 }) }
    }
  }
  private discard(batch: Batch) {
    if (batch.finished) return
    batch.finished = true
    if (this.current === batch) { this.current = undefined; clearTimeout(this.timer); this.timer = undefined }
    batch.output.destroy(); batch.read.destroy()
    if (batch.queued) this.payload.retire(batch.token); else this.payload.cancel(batch.token)
  }
  private flush() {
    const batch = this.current
    if (!batch || batch.finished) return
    this.current = undefined; clearTimeout(this.timer); this.timer = undefined
    if (!batch.rows.length) { this.discard(batch); return }
    batch.finished = true
    void (async () => {
      let completed = false
      try {
        const encoder = this.device.createCommandEncoder()
        encoder.copyBufferToBuffer(batch.output, 0, batch.read, 0, batch.rows.length * STRIDE)
        this.device.queue.submit([encoder.finish()]); batch.queued = true
        await batch.read.mapAsync(GPUMapMode.READ)
        this.payload.assertOpen()
        const values = new Uint32Array(batch.read.getMappedRange())
        for (const [i, row] of batch.rows.entries()) {
          const at = i * STRIDE / 4, count = values[at + 3]
          this.report({ ...row, alphaSubmitted: 1, alphaProbeCode: count === row.alphaWidth! * row.alphaHeight! ? 0 : 2,
            alphaMinimum: values[at], alphaNonOpaquePixels: values[at + 1], alphaZeroPixels: values[at + 2], alphaPixelCount: count })
        }
        batch.read.unmap(); completed = true
      } catch {
        for (const row of batch.rows) this.report({ ...row, alphaProbeCode: 3, alphaSubmitted: 1 })
      } finally {
        batch.output.destroy(); batch.read.destroy()
        if (completed && !this.payload.snapshot().closed) this.payload.complete(batch.token)
        else if (batch.queued) this.payload.retire(batch.token)
        else this.payload.cancel(batch.token)
      }
    })()
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined
    const batch = this.current
    if (batch) { for (const row of batch.rows) this.report({ ...row, alphaProbeCode: 4, alphaSubmitted: 1 }); this.discard(batch) }
  }
}
