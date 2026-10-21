/** Actual Sketch -> externally supplied imported document -> production WebGPU
 * readback -> source-geometry roundness oracle. No CPU raster is used. PNG is
 * encoded from actual GPU RGBA32F output, not from the UI's CPU PNG exporter.
 * Required env: DESIGN_CIRCLE_SKETCH, DESIGN_CIRCLE_DOCUMENT, DESIGN_CIRCLE_NAME.
 * The original node ID is discovered locally and is never hard-coded here. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { unzipSync } from 'fflate'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const sketchPath = process.env.DESIGN_CIRCLE_SKETCH, documentPath = process.env.DESIGN_CIRCLE_DOCUMENT
const circleName = process.env.DESIGN_CIRCLE_NAME, selectedId = process.env.DESIGN_CIRCLE_ID
if (!sketchPath || !documentPath || !circleName) throw Error('Set DESIGN_CIRCLE_SKETCH, DESIGN_CIRCLE_DOCUMENT and DESIGN_CIRCLE_NAME')
const sourcePath = resolve(sketchPath), importedPath = resolve(documentPath)
type Matrix = [number, number, number, number, number, number]
const identity: Matrix = [1, 0, 0, 1, 0, 0]
function concat(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]]
}
const point = (value: any): [number, number] => typeof value === 'string'
  ? value.replace(/[{}]/g, '').split(',').map(Number) as [number, number] : [value.x, value.y]

await runProof('futureox-real-sketch-circle', [sourcePath, importedPath], async proof => {
  const sourceBytes = await readFile(sourcePath), documentBytes = await readFile(importedPath)
  const files = unzipSync(sourceBytes), original: any[] = []
  const walk = (node: any) => { if (node?._class === 'shapePath' && node.name === circleName &&
    (!selectedId || node.do_objectID === selectedId)) original.push(node)
    for (const child of node.layers || []) walk(child)
  }
  for (const [file, bytes] of Object.entries(files)) if (file.startsWith('pages/') && file.endsWith('.json'))
    walk(JSON.parse(new TextDecoder().decode(bytes)))
  if (original.length !== 1) throw Error('Original shape selector must identify exactly one path; disambiguate with DESIGN_CIRCLE_ID')
  const source = original[0], sourceId = source.do_objectID, points = source.points
  const envelope = JSON.parse(documentBytes.toString()), document = envelope.document ?? envelope
  const node = document.nodes?.[sourceId]
  if (!node || node.name !== circleName || node.children.length || !node.network) throw Error('Imported original shape is missing or is not a vector leaf')
  if (source.isClosed !== true || points.length !== 5 || source.frame.width !== source.frame.height ||
      source.frame.width > 20 || source.frame.width <= 0 || node.width !== source.frame.width || node.height !== source.frame.height)
    throw Error('Oracle requires an unchanged <=20px closed five-anchor source circle')
  if ((node.effects || []).some((value: any) => value.visible) || (node.strokes || []).some((value: any) => value.visible) ||
      node.fills.filter((value: any) => value.visible).length !== 1 || node.fills.find((value: any) => value.visible)?.kind !== 'solid')
    throw Error('Alpha boundary oracle requires the original plain filled circle without strokes/effects')
  const parents = new Map<string, string>()
  for (const parent of Object.values(document.nodes) as any[]) for (const child of parent.children) {
    if (parents.has(child)) throw Error('Imported node has multiple parents')
    parents.set(child, parent.id)
  }
  const world = (id: string, seen = new Set<string>()): Matrix => {
    if (seen.has(id)) throw Error('Imported parent cycle')
    seen.add(id)
    const n = document.nodes[id], parent = parents.get(id)
    return concat(parent ? world(parent, seen) : identity, n.transform ?? identity)
  }
  const matrix = world(sourceId), aa = matrix[0]**2+matrix[1]**2, bb = matrix[2]**2+matrix[3]**2
  const dot = matrix[0]*matrix[2]+matrix[1]*matrix[3]
  if (Math.abs(aa-bb) > 1e-10 || Math.abs(dot) > 1e-10 || Math.abs(aa-1) > 1e-10) throw Error('Selected original circle has a non-rigid world transform')
  const normalized = node.bindings?.sketchNormalizedCoordinates === 'true'
  const axes = normalized ? [1, 1] : [node.width, node.height]
  const vertices = new Map(node.network.vertices.map((value: any) => [value.id, value]))
  const edges = new Map(node.network.edges.map((value: any) => [value.id, value]))
  let activeHandles = 0, mismatchedHandles = 0, inactiveHandlesInvented = 0, maximumCoordinateError = 0
  const compare = (actual: any, expected: [number, number]) => {
    if (!actual) return false
    const error = Math.max(Math.abs(actual.x-expected[0]*axes[0]), Math.abs(actual.y-expected[1]*axes[1]))
    maximumCoordinateError = Math.max(maximumCoordinateError, error)
    return error <= 1e-10
  }
  for (let i = 0; i < points.length; i++) {
    const vertex: any = vertices.get(`v${i}`), edge: any = edges.get(`e${i}`), next = (i+1)%points.length
    if (!vertex || !compare(vertex, point(points[i].point)) || !edge || edge.from !== `v${i}` || edge.to !== `v${next}`)
      throw Error('Imported original anchors/topology differ')
    for (const [actual, raw, side] of [[edge.c1, points[i], 'From'], [edge.c2, points[next], 'To']] as const) {
      if (raw[`hasCurve${side}`] === true) { activeHandles++; if (!compare(actual, point(raw[`curve${side}`]))) mismatchedHandles++ }
      else if (actual !== null && actual !== undefined) inactiveHandlesInvented++
    }
  }
  let sourceMaximumRadialError = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i+1)%points.length], p = point(a.point), q = point(b.point)
    const c1 = a.hasCurveFrom ? point(a.curveFrom) : p, c2 = b.hasCurveTo ? point(b.curveTo) : q
    for (let sample = 0; sample <= 1000; sample++) {
      const t = sample/1000, u = 1-t
      const x = u**3*p[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t**3*q[0]
      const y = u**3*p[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t**3*q[1]
      sourceMaximumRadialError = Math.max(sourceMaximumRadialError, Math.abs(Math.hypot(x-.5,y-.5)-.5)*node.width)
    }
  }
  if (sourceMaximumRadialError > node.width*.0002) throw Error('Original path is not the canonical round cubic circle; do not reinterpret authored geometry')
  const geometry = { passed: !mismatchedHandles && !inactiveHandlesInvented,
    activeHandles, mismatchedHandles, inactiveHandlesInvented, maximumCoordinateError, sourceMaximumRadialError,
    sourceIdSha256: sha256(sourceId), size: [node.width,node.height], sourcePoints: points.length,
    worldColumnSquaredDifference: Math.abs(aa-bb), worldColumnDot: dot }
  const page = document.pages.find((page: any) => {
    const visit = (id: string): boolean => id === sourceId || document.nodes[id].children.some(visit)
    return page.children.some(visit)
  })
  if (!page) throw Error('Original circle is outside imported pages')
  // export.rs selection roots carry their precomputed world transforms.
  // This leaf-only proof additionally prunes unreachable nodes/pages, so a
  // global parent map cannot rediscover the old parent and apply it twice.
  // Only this owned test clone changes; original geometry/paint stay exact.
  const isolated = structuredClone(document)
  isolated.pages = [{ ...isolated.pages.find((p: any) => p.id === page.id), children: [sourceId] }]
  isolated.nodes = { [sourceId]: isolated.nodes[sourceId] }
  isolated.nodes[sourceId].transform = matrix
  const withoutPlacement = (value: any) => { const { transform: _placement, ...geometryAndPaint } = value; return JSON.stringify(geometryAndPaint) }
  const geometryAndPaintPreserved = withoutPlacement(node) === withoutPlacement(isolated.nodes[sourceId])
  if (!geometryAndPaintPreserved || Object.values(isolated.nodes).some((value: any) => value.children.includes(sourceId)))
    throw Error('Selection isolation changed authored geometry or retained an old parent edge')
  const center = { x: matrix[0]*node.width/2+matrix[2]*node.height/2+matrix[4],
    y: matrix[1]*node.width/2+matrix[3]*node.height/2+matrix[5] }
  const radius = node.width/2, bounds = { x:center.x-radius,y:center.y-radius,width:node.width,height:node.height }
  const wasm = await readFile(join(project,'public/kernel/design_kernel_bg.wasm'))
  const manifest = { sourceFixtureSha256: sha256(sourceBytes), importedDocumentFileSha256: sha256(documentBytes),
    importedDocumentSha256: sha256(JSON.stringify(document)), isolatedSelectionSha256: sha256(JSON.stringify(isolated)),
    wasmSha256: sha256(wasm), geometry, physicalScale: 64, radialLimitPhysicalPixels: 1.75,
    selectionIsolation: { nodes: Object.keys(isolated.nodes).length, pages: isolated.pages.length,
      oldNodeParentEdges: 0, geometryAndPaintPreserved, worldTransformPreserved: true },
    request: { backend:'webgpu',png:false,readback:true,present:false,transparent:true,rasterProfile:'figmaSubpixel' },
    scope:'Original real Sketch shape and externally supplied real import; test-only leaf selection retains the export.rs world-transform semantics and prunes unreachable parent edges. Exact production WebGPU readback; PNG encoding only uses CPU. Not a UI export, motion, FPS or latency test.' }
  await proof.write('circle-input-summary.json',manifest)
  if (proof.prepareOnly) return { ...manifest, gpuExecuted:false }
  const measured = await proof.browser(browserPage => browserPage.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine, export_region_plan_json, color_encode_png, encode_float_rgba8, encode_png_rgba } = await import('/src/generated/design-kernel/design_kernel.js')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)))
      .map(value=>value.toString(16).padStart(2,'0')).join('')
    if (await digest(new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())) !== payload.manifest.wasmSha256)
      throw Error('Browser WASM differs from bound input')
    const engine = new VectorEngine(), color = payload.document.colorManagement
    if (!color) throw Error('This real-117 oracle requires its actual managed color settings')
    const gpu = await createGpu('webgpu',true,false,color,undefined,false,!!color)
    try {
      engine.load_document(JSON.stringify(payload.document))
      const plan = JSON.parse(export_region_plan_json(JSON.stringify(payload.bounds),64))
      if (plan.width !== payload.size*64 || plan.height !== payload.size*64) throw Error('Unexpected physical selection extent')
      const options = { pageId:payload.pageId,...plan,transparent:true,grid:false,rasterProfile:'figmaSubpixel' }
      const native = engine.compile_gpu(JSON.stringify(options)), scene = JSON.parse(native)
      if (!scene.nodes[payload.nodeId] || scene.roots.length !== 1 || scene.roots[0] !== payload.nodeId)
        throw Error('GPU compilation did not isolate the original selected shape')
      const result = await gpu.render(scene,true,false)
      if (result.backend !== 'webgpu' || gpu.driver.name !== 'webgpu' || gpu.driver.lost) throw Error('Actual WebGPU render was not completed')
      const { width,height } = plan, pixels = width*height, linear = result.linear, rgba = result.rgba
      if (!(linear instanceof Float32Array) && !(rgba instanceof Uint8Array)) throw Error('Actual GPU readback missing')
      if ((linear || rgba)!.length !== pixels*4) throw Error('Incomplete physical pixel readback')
      const alpha = (i: number) => linear ? linear[i*4+3] : rgba![i*4+3]/255
      let maximumAlpha=0, nonfinite=0
      if(linear)for(const value of linear)if(!Number.isFinite(value))nonfinite++
      for(let i=0;i<pixels;i++)maximumAlpha=Math.max(maximumAlpha,alpha(i))
      if(nonfinite || maximumAlpha<=0)throw Error('Invalid actual alpha output')
      const threshold=maximumAlpha/2, cx=width/2,cy=height/2,radius=payload.size*64/2, errors:number[]=[], observed:number[]=[]
      for(let direction=0;direction<720;direction++) {
        const angle=direction*Math.PI/360,dx=Math.cos(angle),dy=Math.sin(angle)
        let boundary:number|undefined
        for(let step=0;step<=Math.ceil((radius+4)*4);step++) {
          const r=step/4,x=Math.floor(cx+r*dx),y=Math.floor(cy+r*dy)
          if(x<0||y<0||x>=width||y>=height||alpha(y*width+x)<threshold){boundary=Math.max(0,r-.125);break}
        }
        if(boundary===undefined)throw Error('Filled circle did not reach a bounded radial edge')
        observed.push(boundary);errors.push(Math.abs(boundary-radius))
      }
      const radialMaximum=Math.max(...errors), sorted=[...errors].sort((a,b)=>a-b)
      const png = linear && color ? color_encode_png(width,height,linear,JSON.stringify(color),JSON.stringify({space:'srgb',toneMap:'clip'}))
        : encode_png_rgba(width,height,linear ? encode_float_rgba8(linear) : rgba!)
      const raw = linear ? new Uint8Array(linear.buffer,linear.byteOffset,linear.byteLength) : rgba!
      const stats = gpu.driver.stats?.() as (Record<string, any> | undefined)
      if (!stats || stats.deviceLost || !(stats.rasterReadbackBytes! >= raw.byteLength)) throw Error('Actual driver readback witness missing')
      let binary='';for(let i=0;i<png.length;i+=32768)binary+=String.fromCharCode(...png.subarray(i,i+32768))
      return { backend:result.backend,adapter:gpu.driver.description,width,height,rawComponents:raw.byteLength/(linear?4:1),
        rawFormat:linear?'RGBA32F':'RGBA8',nonfinite,maximumAlpha,alphaThreshold:threshold,radialDirections:720,
        expectedRadius:radius,observedMinimumRadius:Math.min(...observed),observedMaximumRadius:Math.max(...observed),
        radialMaximum,radialP99:sorted[Math.floor(sorted.length*.99)],radialPassed:radialMaximum<=payload.manifest.radialLimitPhysicalPixels,
        sceneSha256:await digest(new TextEncoder().encode(native)),rawSha256:await digest(raw),pngSha256:await digest(png),
        rasterReadbackBytes:stats.rasterReadbackBytes,isolatedSelectionPreserved:JSON.stringify(payload.document)===payload.isolatedJson,
        pngBase64:btoa(binary) }
    } finally {gpu.dispose();engine.free()}
  }, { document:isolated,isolatedJson:JSON.stringify(isolated),bounds,pageId:page.id,nodeId:sourceId,size:node.width,manifest }))
  const { pngBase64,...metrics } = measured
  const png = Buffer.from(pngBase64,'base64')
  if(sha256(png)!==metrics.pngSha256)throw Error('Transported original GPU PNG bytes changed')
  await writeFile(join(proof.output,'actual-gpu-circle.png'),png,{flag:'wx'})
  const result = { ...manifest,...metrics,gpuExecuted:true,png:'actual-gpu-circle.png' }
  await proof.write('circle-result.json',result)
  if(!geometry.passed || !metrics.radialPassed || !metrics.isolatedSelectionPreserved || sha256(JSON.stringify(document))!==manifest.importedDocumentSha256)
    throw Error('Original Sketch control/radial gate failed; see circle-result.json')
  return result
})
