import { initializePicking } from '../../frontend/design-client/src/kernel/picking'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { createGpu } from '../../frontend/design-client/src/kernel/gpu/factory'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import { renderRuntimeEvidence } from '../../frontend/design-client/src/kernel/runtime-evidence'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report: any = { status: 'running', parentSuffix: import.meta.env.VITE_DESIGN_PARENT_SUFFIX === '1', transportImageSection: true, scope: 'same source/policy; legacy self-contained packet versus binary image-section packet, exact metadata and f32 words checked first; real-fixture hardware GPU target readback; first renderer frame is not guaranteed cold pipeline initialization because the production driver can revive a parked device', clampPrefix: import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1', cases: [] }
const publish = async () => { (window as any).__tileReport = report; document.querySelector('#results')!.textContent = JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error }); await fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) }) }
const compare = (a: Float32Array | Uint8Array, b: Float32Array | Uint8Array) => {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) throw Error('Output extent/type mismatch')
  const x = new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
  let mismatches = 0; for (let i = 0; i < x.length; i++) mismatches += Number(x[i] !== y[i])
  return { words: x.length, mismatches }
}
try {
  await initializePicking(); report.runtime = await renderRuntimeEvidence()
  const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
  const fixtures = await (await fetch('/fixtures.json')).json()
  for (const fixture of fixtures) {
    const document = await (await fetch('/' + fixture.file)).json(), kernel = new VectorEngine()
    let alive = true
    try {
      kernel.load_font(font)
      kernel.load_document(JSON.stringify(document))
      const settings = kernel.color_settings(), scope = decodedImageScope(createDecodedImageOwner(), settings)
      const context = { kernel, settings, scope, current: () => alive, ownerCurrent: () => alive }
      const imageLoader = managedSceneImageLoader(new DecodedImageCache(), () => context,
        { key: async () => undefined, read: async () => undefined, write() {} })
      for (const sample of fixture.samples) {
        const options = { pageId: document.pages[0].id, width: 1710, height: 1672, view: sample.view,
          transparent: false, grid: false, rasterProfile: fixture.rasterProfile || 'figmaSubpixel', gpuViewport: sample.region }
        const started = performance.now(), scene = decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify(options)))
        const record: any = { fixture: fixture.file, sample, compileMs: performance.now() - started,
          output: scene.output, extent: scene.extent, nodes: Object.keys(scene.nodes).length,
          certifiedNodes: Object.values(scene.nodes).filter((n: any) => n.suffixBox).map((n: any) => ({ id: n.id, input: n.rect, output: n.suffixBox })), runs: [] }
        report.cases.push(record); await publish()
        const backends = new URL(location.href).searchParams.get('backend') === 'webgpu' ? ['webgpu'] as const : ['webgpu', 'webgl2'] as const
        for (const backend of backends) {
          let expected: Float32Array | Uint8Array | undefined
          let emptyExpected: Float32Array | Uint8Array | undefined
          for (const enabled of [false, true]) {
            const packetStart = performance.now()
            const packet = kernel.compile_gpu_packet(JSON.stringify({ ...options, gpuPacketImages: enabled }))
            const scene = decodeScenePacket(packet), header = new DataView(packet.buffer, packet.byteOffset)
            const reference = JSON.parse(kernel.compile_gpu(JSON.stringify(options)))
            for (const key of ['vertices', 'curves'] as const) {
              const expected = new Float32Array(reference[key] || [])
              if (compare(scene[key] as Float32Array, expected).mismatches) throw Error('Packet changed geometry words')
              reference[key] = []; (scene as any)[key] ??= new Float32Array()
            }
            if (JSON.stringify({ ...scene, vertices: [], curves: [] }) !== JSON.stringify(reference))
              throw Error('Packet changed scene metadata')
            record.packets ??= []
            record.packets.push({backend, enabled, bytes:packet.length, metadataBytes:header.getUint32(8,true), imageBytes:header.getUint32(20,true), version:header.getUint32(4,true), elapsedMs:performance.now()-packetStart})
            const gpu = await createGpu(backend, true, true, scene.colorManagement, imageLoader, false,
              !!(scene.colorManagement || scene.floatCompositing)), internal = gpu as any
            
            
            if (!enabled && report.clampPrefix && backend === 'webgpu') {
              const driver = gpu.driver as any, prefix = driver.prefixPolicy.bind(driver)
              driver.prefixPolicy = (u: Float32Array, ...args: any[]) => u[38] > 0 ? false : prefix(u, ...args)
            }
            const pass = gpu.driver.pass.bind(gpu.driver), counts = new Map<string, { calls: number, pixels: number }>()
            gpu.driver.pass = (target, u, inputs, region, ...args) => {
              const key = `${u[16]}:${internal.activeNode}`, c = counts.get(key) || { calls: 0, pixels: 0 }
              c.calls++; c.pixels += region ? region.w * region.h : target.width * target.height; counts.set(key, c)
              return pass(target, u, inputs, region, ...args)
            }
            try {
              for (let iteration = 0; iteration < 3; iteration++) {
                counts.clear(); const start = performance.now(), result = await gpu.render(scene, true, false)
                const renderedAt = performance.now(), pixels = result.linear || result.bytes
                if (!pixels?.length) throw Error('Missing pixel result')
                expected ??= pixels.slice()
                const difference = compare(pixels, expected)
                record.runs.push({ backend, enabled, iteration, firstFrame: iteration === 0, wallMs: renderedAt - start,
                  graphMs: result.graphMs, finishMs: result.finishMs, pixels: result.passPixels,
                  passTimings: gpu.driver.stats?.().passTimings,
                  drawCalls: result.drawCalls, opaqueTentPasses: result.opaqueTentPasses, wholeFilterAxes: result.wholeFilterAxes,
                  workingBytes: result.workingTextureBytes, uploads: result.materialFieldUploadBytes,
                  imageAssets: { ...internal.imageAssetCounters }, ...difference,
                  passes: [...counts].sort((a, b) => b[1].pixels - a[1].pixels).slice(0, 16) })
                await publish(); if (difference.mismatches) throw Error('Packet image section changed output bits')
                if (iteration === 0 && import.meta.env.VITE_DESIGN_IMAGE_ASSET_RESIDENCY === '1') {
                  // A different regional packet omits all images. Revisit the
                  // original packet next, with the same private document owner.
                  const blank = await gpu.render({ ...scene, roots: [], nodes: {} }, true, false)
                  const pixels = blank.linear || blank.bytes
                  if (!pixels?.length) throw Error('Missing empty-region pixel result')
                  emptyExpected ??= pixels.slice()
                  const difference = compare(pixels, emptyExpected)
                  record.emptyRegions ??= []
                  record.emptyRegions.push({ backend, enabled, ...difference })
                  if (difference.mismatches) throw Error('Image residency changed empty-region output bits')
                }
              }
            } finally { gpu.dispose() }
          }
        }
      }
    } finally { alive = false; kernel.free() }
  }
  report.status = 'passed'; await publish()
} catch (error) { report.status = 'failed'; report.error = String(error); await publish() }
