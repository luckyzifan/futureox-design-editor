/** Bounded, opt-in stage attribution. Durations are wall-clock measurements,
 * not sampled JS stacks or input-to-photon latency. GPU waits belong to graph
 * time and must never be added to it a second time. */
export type RenderProfileSample = {
  kind: string; at: number; total: number; compile: number; load: number
  graph: number; finish: number; checkpoint: number; fields: number
  passPixels?: number; drawCalls?: number; textureBytes?: number
  fieldUploadBytes?: number; geometryUploadBytes?: number
}
export type ProfileBar = { name: string; ms: number; children?: ProfileBar[] }
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0
let recording = false
const samples: RenderProfileSample[] = []
export const renderProfile = {
  start() { samples.length = 0; recording = true },
  pause() { recording = false },
  get recording() { return recording },
  snapshot() { return samples.slice() },
}
export function recordRenderProfile(kind: string, result: Record<string, unknown>, elapsed?: number) {
  if (!recording) return
  samples.push({ kind, at: performance.now(), total: finite(elapsed ?? result.total ?? result.milliseconds),
    compile: finite(result.compileMs), load: finite(result.loadMs), graph: finite(result.graphMs),
    finish: finite(result.finishMs), checkpoint: finite(result.checkpointMs), fields: finite(result.materialFieldBuildMs ?? result.fieldMs),
    passPixels: typeof result.passPixels === 'number' ? result.passPixels : undefined,
    drawCalls: typeof result.drawCalls === 'number' ? result.drawCalls : undefined,
    textureBytes: typeof result.textureBytes === 'number' ? result.textureBytes : undefined,
    fieldUploadBytes: typeof (result.materialFieldUploadBytes ?? result.fieldUploadBytes) === 'number'
      ? finite(result.materialFieldUploadBytes ?? result.fieldUploadBytes) : undefined,
    geometryUploadBytes: typeof result.geometryUploadBytes === 'number' ? finite(result.geometryUploadBytes) : undefined })
  if (samples.length > 512) samples.splice(0, samples.length - 512)
}
export function profileBars(sample: RenderProfileSample): ProfileBar[] {
  const checkpoint = Math.min(sample.graph, sample.checkpoint)
  const fields = Math.min(sample.graph - checkpoint, sample.fields)
  return [
    { name: '文档准备', ms: sample.load }, { name: 'WASM 编译', ms: sample.compile },
    { name: '构图与编码', ms: sample.graph, children: [
      { name: '参数场 CPU', ms: fields }, { name: 'GPU checkpoint 等待', ms: checkpoint },
      { name: '其余构图与编码', ms: Math.max(0, sample.graph - checkpoint - fields) },
    ] }, { name: '提交与完成', ms: sample.finish },
  ].filter(bar => bar.ms > 0)
}
