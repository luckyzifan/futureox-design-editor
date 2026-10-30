import { ResidentPresenter, type ResidentFrame } from './resident-presenter'
import { TileCompositor, type CompositeItem } from './tile-compositor'
import { rasterizeCanvasLabel } from './canvas-labels'

const output = document.querySelector('#results')!
const report: { status: string; cases: number; failures: unknown[]; error?: string } = {
  status: 'running', cases: 0, failures: [],
}
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const color = (size: number, pixel: number[]) => {
  const bytes = new Uint8Array(size * size * 4)
  for (let i = 0; i < bytes.length; i += 4) bytes.set(pixel, i)
  return bytes
}
let presenter: ResidentPresenter | undefined, compatibility: TileCompositor | undefined, device: GPUDevice | undefined
try {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw Error('WebGPU required for the resident seam regression')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror',event=>report.failures.push({name:'GPU validation error',error:event.error.message}))
  const canvas = document.querySelector<HTMLCanvasElement>('#display')!
  presenter = new ResidentPresenter(device, canvas as unknown as OffscreenCanvas, 'rgba8unorm', () => {})
  const context = canvas.getContext('webgpu')!
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST })
  const solid = color(514, [48, 64, 80, 255]), translucent = color(514, [80, 40, 20, 128])
  // GPU display textures are premultiplied. Bitmap/byte transport is straight
  // RGBA and TileCompositor premultiplies it at upload.
  const straightTranslucent = color(514, [159, 80, 40, 128])
  const a = presenter.capture(514, 514), b = presenter.capture(514, 514)
  device.queue.writeTexture({ texture: a.texture }, solid, { bytesPerRow: 514 * 4 }, [514, 514])
  device.queue.writeTexture({ texture: b.texture }, translucent, { bytesPerRow: 514 * 4 }, [514, 514])
  const compatCanvas = document.querySelector<HTMLCanvasElement>('#compatibility')!
  compatibility = new TileCompositor(compatCanvas)
  const gl = compatCanvas.getContext('webgl2')!
  const width = 703, height = 80
  for (const dpr of [1, 1.25, 2]) for (const zoom of [.6, .4834411811240878, 1.0222175785922658])
    for (const phase of [.2499, .25, .2501, .7499, .75, .7501]) for (const mode of ['opaque', 'mixed', 'blend']) {
      await new Promise(requestAnimationFrame)
      const view = { x: -1384 + phase, y: 0, zoom }, scale = zoom / 1.2
      const items: CompositeItem[] = [{ active: true, layer: 0, gutter: 0,
        placement: { left: 0, top: 0, width, height },
        tile: { key: 'base', serial: 1, gpuTile: a.id, bytes: solid, x: 0, y: 0, width: 514, height: 514, zoom: .1 } }]
      for (let x = Math.floor(-view.x / scale / 512); x < Math.ceil((width - view.x) / scale / 512); x++) {
        if (mode === 'mixed' && x % 2) continue
        items.push({ active: true, layer: 3, gutter: 1, blend: mode === 'blend',
          tile: { key: String(x), serial: mode === 'blend' ? 3 : 2, gpuTile: mode === 'blend' ? b.id : a.id,
            bytes: mode === 'blend' ? straightTranslucent : solid,
            x: x * 512 - 1, y: -1, width: 514, height: 514, zoom: 1.2 } })
      }
      presenter.draw({ items, view, width, height, dpr } as ResidentFrame)
      const w = Math.ceil(width * dpr), stride = Math.ceil(w * 4 / 256) * 256
      const buffer = device.createBuffer({ size: stride, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer({ texture: context.getCurrentTexture(), origin: [0, 20, 0] },
        { buffer, bytesPerRow: stride }, [w, 1, 1])
      device.queue.submit([encoder.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const pixels = new Uint8Array(buffer.getMappedRange().slice(0, w * 4))
      buffer.unmap(); buffer.destroy()
      for (const item of items) compatibility.upload(item.tile)
      compatibility.draw(items, view, width, height, dpr)
      const compatPixels = new Uint8Array(w * 4)
      gl.readPixels(0, Math.ceil(height * dpr) - 21, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, compatPixels)
      for (const [backend, row] of [['webgpu', pixels], ['webgl2', compatPixels]] as const) {
        // Uniform opaque colours expose holes between density layers; a
        // distinct translucent colour exposes missing AND duplicate blends.
        const failed: number[] = []
        const expected = mode === 'blend' ? [104, 72, 60, 255] : [48, 64, 80, 255]
        for (let x = 0; x < w; x++) if (expected.some((value, c) => Math.abs(row[x * 4 + c] - value) > 1)) failed.push(x)
        report.cases++
        if (failed.length) report.failures.push({ backend, dpr, zoom, phase, mode,
          count: failed.length, columns: failed.slice(0, 8), first: Array.from(row.slice(failed[0] * 4, failed[0] * 4 + 4)) })
      }
    }
  const before = presenter.residentBytes
  let rejected = false
  try { presenter.capture(16384, 16384) } catch (error) { rejected = String(error).includes('budget exceeded') }
  if (!rejected || presenter.residentBytes !== before) throw Error('Admission changed already resident textures')
  // An unavailable high-detail texture must not erase a valid cached layer.
  const base = { active: true, layer: 0, gutter: 0, placement: { left: 0, top: 0, width, height },
    tile: { key: 'base', serial: 1, gpuTile: a.id, bytes: solid, x: 0, y: 0, width: 514, height: 514, zoom: 1 } }
  presenter.draw({ view: { x: 0, y: 0, zoom: 1 }, width, height, dpr: 2, items: [base,
    { ...base, layer: 3, placement: { left: 250, top: 0, width: 200, height }, tile: { ...base.tile, gpuTile: 999999 } }] })
  const probe = device.createBuffer({ size: 5632, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const copy = device.createCommandEncoder()
  copy.copyTextureToBuffer({ texture: context.getCurrentTexture(), origin: [0, 20, 0] }, { buffer: probe, bytesPerRow: 5632 }, [1406, 1, 1])
  device.queue.submit([copy.finish()]); await probe.mapAsync(GPUMapMode.READ)
  const row = new Uint8Array(probe.getMappedRange())
  const missing = Array.from({ length: 1406 }, (_, x) => row[x * 4 + 3]).filter(alpha => alpha !== 255).length
  probe.unmap(); probe.destroy(); report.cases++
  if (missing) report.failures.push({ name: 'missing detail must preserve valid background', missing })
  // Upscaling cached glyph edges must not introduce intermediate grey pixels.
  // This checks the actual samplers on both display paths, not their settings.
  const stripes = new Uint8Array(16 * 16 * 4)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++)
    stripes.set([x % 2 * 255, x % 2 * 255, x % 2 * 255, 255], (y * 16 + x) * 4)
  const edgeTexture = presenter.capture(16, 16)
  device.queue.writeTexture({ texture: edgeTexture.texture }, stripes, { bytesPerRow: 64 }, [16, 16])
  const edge: CompositeItem = { active: true, layer: 0, gutter: 0,
    placement: { left: 0, top: 0, width: 64, height: 64 },
    tile: { key: 'edge', serial: 100, gpuTile: edgeTexture.id, bytes: stripes, x: 0, y: 0, width: 16, height: 16, zoom: 1 } }
  presenter.draw({ items: [edge], view: { x: 0, y: 0, zoom: 4 }, width: 64, height: 64, dpr: 1 } as ResidentFrame)
  const edgeBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const edgeCopy = device.createCommandEncoder()
  edgeCopy.copyTextureToBuffer({ texture: context.getCurrentTexture(), origin: [0, 20, 0] },
    { buffer: edgeBuffer, bytesPerRow: 256 }, [64, 1, 1])
  device.queue.submit([edgeCopy.finish()]); await edgeBuffer.mapAsync(GPUMapMode.READ)
  const gpuEdge = new Uint8Array(edgeBuffer.getMappedRange().slice(0))
  edgeBuffer.unmap(); edgeBuffer.destroy()
  compatibility.upload(edge.tile); compatibility.draw([edge], { x: 0, y: 0, zoom: 4 }, 64, 64, 1)
  const glEdge = new Uint8Array(256)
  gl.readPixels(0, 20, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, glEdge)
  for (const [backend, pixels] of [['webgpu', gpuEdge], ['webgl2', glEdge]] as const) {
    report.cases++
    if (Array.from({ length: 64 }, (_, x) => x).some(x => pixels[x * 4] !== Math.floor(x / 4) % 2 * 255 || pixels[x * 4 + 3] !== 255))
      report.failures.push({ name: 'magnified cache edge acquired filtering blur', backend })
  }
  const frozen = presenter.snapshot()
  if (!frozen) throw Error('Missing persistent displayed frame')
  presenter.draw({ view: { x: 0, y: 0, zoom: 1 }, width: 64, height: 64, dpr: 1,
    items: [{ ...base, placement: { left: 0, top: 0, width: 64, height: 64 } }] })
  presenter.draw({ view: { x: 0, y: 0, zoom: 1 }, width: 64, height: 64, dpr: 1,
    items: [{ active: true, layer: 0, gutter: 0, tile: { key: 'frozen', serial: 101,
      gpuTile: frozen.gpuTile, x: 0, y: 0, width: 64, height: 64, zoom: 1 } }] })
  const frozenBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const frozenCopy = device.createCommandEncoder()
  frozenCopy.copyTextureToBuffer({ texture: context.getCurrentTexture(), origin: [0, 20, 0] },
    { buffer: frozenBuffer, bytesPerRow: 256 }, [64, 1, 1])
  device.queue.submit([frozenCopy.finish()]); await frozenBuffer.mapAsync(GPUMapMode.READ)
  const frozenPixels = new Uint8Array(frozenBuffer.getMappedRange())
  report.cases++
  const sourceLabel=rasterizeCanvasLabel({anchor:{x:16,y:26},offset:{x:0,y:0},text:'A',size:11,color:'#ff0000'},1)
  const sourcePixels=sourceLabel.canvas.getContext('2d')!.getImageData(0,0,sourceLabel.width,sourceLabel.height).data
  if (frozenPixels.some((value, i) => value !== gpuEdge[i])) report.failures.push({ name: 'committed snapshot changed after another frame' })
  frozenBuffer.unmap(); frozenBuffer.destroy()
  const cleanFrame: ResidentFrame = { view: { x: 0, y: 0, zoom: 1 }, width: 64, height: 64, dpr: 1,
    items: [{ active: true, layer: 0, gutter: 0, tile: { key: 'clean', serial: 102,
      gpuTile: frozen.gpuTile, x: 0, y: 0, width: 64, height: 64, zoom: 1 } }] }
  presenter.draw({ ...cleanFrame, overlay: { pixelGrid: false,
    labels:[{anchor:{x:16,y:26},offset:{x:0,y:0},text:'A',size:11,color:'#ff0000'}],selection: { handles: false,
    corners: [{x:8,y:8},{x:56,y:8},{x:56,y:56},{x:8,y:56}] } } })
  const contentOnly = presenter.snapshot()
  if (!contentOnly) throw Error('Missing content snapshot with GPU chrome')
  const readDisplay = async () => {
    const buffer = device!.createBuffer({ size: 64*256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const copy = device!.createCommandEncoder()
    copy.copyTextureToBuffer({ texture: context.getCurrentTexture() }, { buffer, bytesPerRow:256 }, [64,64])
    device!.queue.submit([copy.finish()]); await buffer.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(buffer.getMappedRange().slice(0)); buffer.unmap(); buffer.destroy(); return pixels
  }
  const labelPixels=await readDisplay(),chromePixels=labelPixels.slice(20*256,21*256); report.cases++
  if (!(chromePixels[8*4+2] > chromePixels[8*4] + 80)) report.failures.push({name:'GPU selection chrome missing'})
  report.cases++
  const red:number[][]=[]
  for(let i=0;i<labelPixels.length;i+=4)if(labelPixels[i]>labelPixels[i+1]+20&&labelPixels[i]>labelPixels[i+2]+20)red.push([i/4%64,Math.floor(i/4/64)])
  if(red.length<3||red.some(([x,y])=>x<12||x>36||y<12||y>30))
    report.failures.push({name:'GPU text chrome missing',source:{width:sourceLabel.width,height:sourceLabel.height,left:sourceLabel.left,top:sourceLabel.top,alpha:sourcePixels.filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0)},redBounds:red.length?{minX:Math.min(...red.map(p=>p[0])),maxX:Math.max(...red.map(p=>p[0])),minY:Math.min(...red.map(p=>p[1])),maxY:Math.max(...red.map(p=>p[1]))}:null})
  const sampled=await presenter.readContentPixel(8.5/64,20.5/64);report.cases++
  if(sampled.contentPixel.some((v,i)=>v!==gpuEdge[8*4+i]))report.failures.push({name:'eyedropper sampled chrome instead of content'})
  let staleRejected=false
  try{await presenter.readContentPixel(.1,.1,{...sampled.contentFrame,view:{...sampled.contentFrame.view,x:1}})}catch{staleRejected=true}
  report.cases++;if(!staleRejected)report.failures.push({name:'stale eyedropper camera accepted'})
  const bitmapSnapshot=await presenter.captureContentBitmap(),bitmapProbe=document.createElement('canvas')
  bitmapProbe.width=bitmapProbe.height=64
  const bitmapContext=bitmapProbe.getContext('2d',{willReadFrequently:true})!
  bitmapContext.drawImage(bitmapSnapshot.bitmap,0,0);bitmapSnapshot.bitmap.close()
  const bitmapRow=bitmapContext.getImageData(0,20,64,1).data;report.cases++
  if(bitmapRow.some((v,i)=>v!==gpuEdge[i]))report.failures.push({name:'startup bitmap contains chrome'})
  presenter.draw({ ...cleanFrame, items: [{ ...cleanFrame.items[0], tile: { ...cleanFrame.items[0].tile, gpuTile: contentOnly.gpuTile } }] })
  const contentPixels = (await readDisplay()).slice(20*256,21*256); report.cases++
  if (contentPixels.some((value,i) => value !== gpuEdge[i])) report.failures.push({name:'GPU chrome leaked into document snapshot'})
  await new Promise(requestAnimationFrame)
  if (report.failures.length) throw Error(`${report.failures.length} seam or colour failures`)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error) }
finally { publish(); presenter?.dispose(); compatibility?.dispose(); device?.destroy() }
