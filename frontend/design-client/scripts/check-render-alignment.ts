/** Real WebGPU/WebGL worker pixels, material costs and settled presentation. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = await mkdtemp(join(tmpdir(), 'design-render-alignment-'))
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(server.resolvedUrls!.local[0] + 'gpu-check.html')
  const result = await page.evaluate(async (profileOnly) => {
    const { initializePicking } = await import('/src/kernel/picking.ts')
    await initializePicking()
    const wasm = await import('/src/generated/design-kernel/design_kernel.js')
    const { blank, node, paint, effect } = await import('/src/model.ts')
    const { KernelClient } = await import('/src/kernel/client.ts')
    const assert = (v: unknown, message: string) => { if (!v) throw Error(message) }
    const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      assert(a.length === b.length, 'Pixel dimensions differ')
      let max = 0, count = 0
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); max = Math.max(max, d); if (d) count++ }
      return { max, count }
    }
    const fieldRect = JSON.stringify({ x: 0, y: 0, w: 256, h: 256 })
    const matrix = new Float64Array([1, 0, 0, 1, 0, 0])
    const glass = effect('glass'), texture = effect('texture')
    const profile: unknown[] = []
    for (const [name, run] of [
      ['glass-field', () => wasm.glass_geometry_field(fieldRect, matrix, JSON.stringify({size:[256,256],radius:24}), JSON.stringify(glass), 0, false)],
      ['texture-field', () => wasm.texture_material_field(fieldRect, matrix, JSON.stringify(texture), 128, 128)],
    ] as const) {
      const times: number[] = []; let bytes = 0
      for (let i = 0; i < 6; i++) { const start = performance.now(); bytes = run().byteLength; times.push(performance.now() - start) }
      profile.push({ name, bytes, coldMs: times[0], warmMs: times.slice(1) })
    }
    if (profileOnly) return { profile, rows: [] }
    const rows: unknown[] = []
    const client = new KernelClient()
    try {
      for (const profileName of ['managed-figma', 'byte-figma', 'analytic'] as const) {
      for (const kind of ['checker', 'gradient-tight', 'gradient-smooth', 'gradient-degenerate', 'gradient-rotated', 'glass', 'texture'] as const) {
        const doc = blank(kind); doc.schemaVersion = 12; doc.rasterProfile = profileName === 'analytic' ? 'analytic' : 'figma'; doc.pages[0].background = '#ffffff'
        if (profileName === 'managed-figma') doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
        if (kind !== 'checker') {
          const back = node('rectangle', 0, 0, 64, 64); back.fills = [paint('#d1753a', 'linear')]
          back.fills[0].stops = [{offset:0,color:'#d1753a'}, {offset:1,color:'#2474c9'}]
          const shape = node('rectangle', 12, 12, 36, 36); shape.radii = [6,6,6,6]
          shape.fills = [paint('#3975e8')]
          const fx = effect(kind === 'glass' ? 'glass' : kind === 'texture' ? 'texture' : 'blur')
          fx.radius = 1.25
          if (kind.startsWith('gradient')) fx.gradientBlur = {start:[0,0],end:[32,19],startCount:0.25,endCount:3.5,smooth:kind==='gradient-smooth'}
          if (kind === 'gradient-degenerate') fx.gradientBlur!.end = [...fx.gradientBlur!.start]
          if (kind === 'gradient-rotated') shape.transform = [0.96,0.28,-0.28,0.96,18.25,8.5]
          if (kind === 'glass') { shape.fills = []; fx.glass!.depth = 4 }
          shape.effects = [fx]; doc.nodes[back.id] = back; doc.nodes[shape.id] = shape; doc.pages[0].children = [back.id, shape.id]
        }
        const options = {pageId:doc.pages[0].id,width:64,height:64,view:{x:0.25,y:0.5,zoom:1},
          transparent:false,grid:false,checkerboard:kind==='checker',rasterProfile:doc.rasterProfile,renderIntent:'settled' as const}
        const cpu = await client.render(doc, options, false, 'cpu', true)
        for (const backend of ['webgpu','webgl2'] as const) {
          const gpu = await client.render(doc, options, false, backend, true)
          assert(gpu.backend === backend, `${backend} must execute`)
          const comparison = diff(cpu.bytes, gpu.bytes)
          rows.push({profileName,kind,backend,comparison,hybridEffects:gpu.hybridEffects})
          assert(comparison.max === 0, `${profileName}/${kind}/${backend} CPU difference ${JSON.stringify(comparison)}`)
          assert(!gpu.hybridEffects, `${profileName}/${kind}/${backend} performed an effect readback`)
          let tile: any
          await client.render(doc, {...options,tileViewport:[{key:'shown',x:0,y:0,width:64,height:64,zoom:1,phaseX:0.25,phaseY:0.5}]},
            false,backend,false,false,{disableExactTileCache:true},value=>{tile=value})
          assert(tile, 'Missing display tile')
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
          const ctx = canvas.getContext('2d', {willReadFrequently:true})!
          if (tile.bitmap) ctx.drawImage(tile.bitmap,0,0)
          else ctx.putImageData(new ImageData(new Uint8ClampedArray(tile.bytes),64,64),0,0)
          tile.bitmap?.close()
          const shown = diff(gpu.bytes,ctx.getImageData(0,0,64,64).data)
          rows.push({profileName,kind,backend,display:shown})
          assert(shown.max === 0, `${profileName}/${kind}/${backend} settled display difference ${JSON.stringify(shown)}`)
          if (profileName === 'managed-figma' && (kind === 'glass' || kind === 'texture')) {
            const { createGpu } = await import('/src/kernel/gpu/factory.ts')
            const { decodeScenePacket } = await import('/src/kernel/gpu/scene-packet.ts')
            const cachedDoc = structuredClone(doc)
            const engine = new wasm.VectorEngine()
            const renderer = await createGpu(backend, true, false, doc.colorManagement)
            try {
              const compile = () => { engine.load_document(JSON.stringify(cachedDoc)); return decodeScenePacket(engine.compile_gpu_packet(JSON.stringify(options))) }
              const scene = compile()
              const cold = await renderer.render(scene, true, false)
              const warm = await renderer.render(scene, true, false)
              assert(cold.materialFieldBuilds > 0 && warm.materialFieldBuilds === 0 && warm.materialFieldUploadBytes === 0 && warm.materialFieldHits > 0,
                `${profileName}/${kind}/${backend} must reuse immutable fields without CPU generation or upload`)
              assert(diff(cold.linear!, warm.linear!).max === 0, 'Cache changed float pixels')
              cachedDoc.nodes[cachedDoc.pages[0].children[0]].fills[0].stops[0].color = '#76c223'
              const backdropEdit = await renderer.render(compile(), true, false)
              assert(backdropEdit.materialFieldBuilds === 0 && backdropEdit.materialFieldUploadBytes === 0,
                'Backdrop-only edits must retain geometry fields')
              assert(diff(warm.linear!, backdropEdit.linear!).max > 0, 'Cached fields must not cache backdrop colors')
              const shape = cachedDoc.nodes[cachedDoc.pages[0].children[1]]
              if (kind === 'glass') shape.effects[0].glass!.bevelSize = 2.5
              else shape.effects[0].texture!.noiseSize = [11, 7]
              const editedScene = compile()
              const edited = await renderer.render(editedScene, true, false)
              assert(edited.materialFieldBuilds > 0, 'Material edit reused a stale field')
              const editedCpu = engine.render_rgba(JSON.stringify(options))
              const editedGpu = wasm.color_encode_rgba8(edited.linear!, JSON.stringify(cachedDoc.colorManagement))
              assert(diff(editedCpu, editedGpu).max === 0, 'Edited material differs from CPU export arithmetic')
              const oracle = await createGpu(backend, false, false, doc.colorManagement)
              try {
                const fresh = await oracle.render(editedScene, true, false)
                assert(diff(edited.linear!, fresh.linear!).max === 0, 'Edited cached field differs from uncached render')
              } finally { oracle.dispose() }
              rows.push({profileName,kind,backend,cache:{coldBuildMs:cold.materialFieldBuildMs,coldUploadBytes:cold.materialFieldUploadBytes,
                warmBuildMs:warm.materialFieldBuildMs,warmUploadBytes:warm.materialFieldUploadBytes,hits:warm.materialFieldHits,
                residentBytes:warm.materialFieldCacheBytes,backdropEditHits:backdropEdit.materialFieldHits,editedBuilds:edited.materialFieldBuilds}})
            } finally { renderer.dispose(); engine.free() }
          }
        }
        if (kind === 'checker') {
          assert(cpu.bytes[(16*4)] === 238 && cpu.bytes[0] === 255, `Checker cells must remain 16 output pixels under supersampling: ${[0,8,16,32].map(x=>cpu.bytes[x*4])}`)
          const exported = await client.render(doc, options, true, 'cpu', true)
          const bitmap = await createImageBitmap(new Blob([exported.bytes],{type:'image/png'}))
          const canvas=document.createElement('canvas');canvas.width=canvas.height=64
          const ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0);bitmap.close()
          assert(ctx.getImageData(16,0,1,1).data[0]===255,'PNG must exclude canvas checkerboard')
        }
      }
      }
    } finally { client.dispose() }
    return {profile,rows}
  }, process.argv.includes('--profile'))
  await writeFile(join(output,'pixels.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({stage:'pixels-complete',rows:result.rows.length,output}))
  if (!process.argv.includes('--profile')) {
    await page.goto(server.resolvedUrls!.local[0] + 'canvas-check.html')
    const complete = page.locator('.kernel-tiles[data-detail-ready="true"]')
    await complete.waitFor({state:'attached',timeout:120_000})
    await page.locator('canvas[data-frame-visible="true"]').first().waitFor({timeout:120_000})
    await page.getByLabel('缩放与视图设置').click()
    await page.getByRole('checkbox',{name:'棋盘格背景'}).check()
    await page.locator('.kernel-tiles[data-checkerboard="true"][data-detail-ready="true"]').waitFor({state:'attached',timeout:120_000})
    await page.locator('canvas[data-frame-visible="true"]').first().waitFor({timeout:120_000})
    await page.screenshot({path:join(output,'canvas-checkerboard.png')})
    await page.getByRole('checkbox',{name:'棋盘格背景'}).uncheck()
    await page.locator('.kernel-tiles[data-checkerboard="false"][data-detail-ready="true"]').waitFor({state:'attached',timeout:120_000})
    result.rows.push({ui:'actual Canvas checkerboard toggle on/off completed'})
  }
  if (errors.length) throw Error(errors.join('\n'))
  await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',...result},null,2))
  console.log(JSON.stringify({status:'passed',output,rows:result.rows.length,profile:result.profile,cache:result.rows.filter((row:any)=>row.cache)}))
} catch (error) {
  await writeFile(join(output,'failure.txt'),String(error))
  console.error(JSON.stringify({status:'failed',output,error:String(error)}))
  process.exitCode=1
} finally { await browser?.close(); await server.close() }
