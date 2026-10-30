/** Real worker/GPU presentation acceptance. Faults pause real requests or reject
 * display only; no computed pixels, shader, or geometry is replaced. */
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), `forma-preview-${randomUUID()}-`))
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw Error('Refusing nonempty evidence output')
console.log(JSON.stringify({ evidenceOutput: output }))
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
async function sources() {
  const out: Record<string, string> = {}
  async function walk(dir: string, label: string, parents = new Set<string>()) {
    const real = await realpath(dir)
    if (parents.has(real)) return
    const next = new Set(parents).add(real)
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name), key = `${label}/${item.name}`
      if (item.isDirectory() || item.isSymbolicLink()) {
        const { stat } = await import('node:fs/promises')
        if ((await stat(path)).isDirectory()) { await walk(path, key, next); continue }
      }
      out[key] = hash(await readFile(path))
    }
  }
  await walk(join(root, 'src'), 'src')
  await walk(join(root, 'public/kernel'), 'public/kernel')
  await walk(resolve(root, '../../design-studio/crates/design-kernel/shaders'), 'shaders')
  for (const path of ['package.json', 'vite.config.ts', 'scripts/check-preview-contract.ts']) out[path] = hash(await readFile(join(root, path)))
  return out
}
const before = await sources()
await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2))
const server = await createServer({ root, plugins: [{ name: 'preview-probe-deps',
  configureServer(server) { server.middlewares.use('/__preview-host', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    void server.transformIndexHtml('/__preview-host', '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body></body></html>').then(html => response.end(html)).catch(error => { response.statusCode = 500; response.end(String(error)) })
  }) },
  resolveId(id) { if (id === '/__preview-deps') return id },
  load(id) { if (id === '/__preview-deps') return `export {default as React} from 'react'; export {createRoot} from 'react-dom/client'; export {flushSync} from 'react-dom'` },
}], server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let currentPage: import('@playwright/test').Page | undefined
const errors: string[] = [], cases: unknown[] = [], matrixProgress: unknown[] = []
try {
  await server.listen()
  const base = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = currentPage = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.text().startsWith('PREVIEW_MATRIX ')) { matrixProgress.push(JSON.parse(m.text().slice(15))); console.log(m.text()) } })
  await page.goto(`${base}__preview-host`)
  if (!process.argv.includes('--matrix-only')) {
  await page.evaluate(async () => {
    const { React, createRoot, flushSync } = await import('/__preview-deps')
    const { initializePicking } = await import('/src/kernel/picking.ts')
    await initializePicking()
    const { KernelSurface } = await import('/src/kernel/Surface.tsx')
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { ColorPresenter } = await import('/src/kernel/color-presenter.ts')
    const { blank, node, paint } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    const fixture = blank('Preview contract real worker')
    fixture.schemaVersion = 3; fixture.colorManagement = defaultColorSettings(); fixture.rasterProfile = 'figmaSoftware'
    const rect = node('rectangle', 17.25, 22.5, 91.5, 71.25)
    rect.fills = [paint('#3787cf')]; rect.radii = [12, 12, 12, 12]
    fixture.nodes[rect.id] = rect; fixture.pages[0].children = [rect.id]
    const host = document.createElement('div'); host.id = 'preview-probe'
    Object.assign(host.style, { position: 'relative', width: '240px', height: '180px', overflow: 'hidden' })
    document.body.replaceChildren(host)
    const root = createRoot(host)
    const probe: any = (window as any).__preview = { hold: false, gates: [], failures: 0, failDisplay: false, samples: [], recording: false,
      props: { document: fixture, pageId: fixture.pages[0].id, width: 240, height: 180, view: { x: 0, y: 0, zoom: 1 }, grid: false },
      set(change: any) { this.props = { ...this.props, ...change }; flushSync(() => root.render(React.createElement(KernelSurface, this.props))) },
      release() { this.hold = false; for (const resolve of this.gates.splice(0)) resolve() },
      destroy() { flushSync(() => root.unmount()) },
    }
    const originalRender = KernelClient.prototype.render
    KernelClient.prototype.render = async function(...args: any[]) {
      if (probe.hold) await new Promise(resolve => probe.gates.push(resolve))
      return originalRender.apply(this, args as any)
    }
    const originalPresent = ColorPresenter.prototype.present
    ColorPresenter.prototype.present = async function(...args: any[]) {
      if (probe.failDisplay) { probe.failures++; throw Error('INJECTED_DISPLAY_FAILURE: actual renderer pixels retained') }
      return originalPresent.apply(this, args as any)
    }
    const originalMedia = window.matchMedia.bind(window), listeners = new Set<() => void>()
    probe.p3 = originalMedia('(color-gamut: p3)').matches
    window.matchMedia = (query: string) => query === '(color-gamut: p3)' ? {
      media: query, get matches() { return probe.p3 }, onchange: null,
      addEventListener(_: string, fn: () => void) { listeners.add(fn) },
      removeEventListener(_: string, fn: () => void) { listeners.delete(fn) },
      addListener(fn: () => void) { listeners.add(fn) }, removeListener(fn: () => void) { listeners.delete(fn) }, dispatchEvent() { return true },
    } as any : originalMedia(query)
    probe.changeCapability = () => { probe.p3 = !probe.p3; for (const listener of listeners) listener() }
    probe.snapshot = () => {
      const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible=true]')]
        .filter(c => c.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
      const bounds = host.getBoundingClientRect()
      const boxes = canvases.map(c => c.getBoundingClientRect())
      let uncovered = 0
      for (const fx of [.05, .3, .7, .95]) for (const fy of [.05, .4, .8, .95]) {
        const x = bounds.x + fx * bounds.width, y = bounds.y + fy * bounds.height
        if (!boxes.some(b => x >= b.x && x < b.right && y >= b.y && y < b.bottom)) uncovered++
      }
      return { presentation: { ...(host.querySelector<HTMLElement>('.kernel-presentation')?.dataset || {}) }, uncovered,
        canvases: canvases.map(c => ({ key: c.dataset.tileKey || 'reference', serial: c.dataset.tileSerial, label: c.getAttribute('aria-label'),
          width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width, cssHeight: c.getBoundingClientRect().height,
          pixels: c.toDataURL(), renderer: c.dataset.renderer, transport: c.dataset.transport })) }
    }
    function tick() { if (probe.recording) probe.samples.push(probe.snapshot()); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    probe.set({})
  })
  const ready = () => page.waitForFunction(() => document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready') === 'true', undefined, { timeout: 60000 })
  const snapshot = () => page.evaluate(() => (window as any).__preview.snapshot())
  const record = async (name: string, value: any) => {
    for (const canvas of value.canvases || []) { canvas.sha256 = hash(canvas.pixels); delete canvas.pixels }
    cases.push({ name, ...value })
    console.log(JSON.stringify({ stage: name, visible: value.canvases?.length }))
  }
  await ready(); const initial = await snapshot(); expect(initial.uncovered).toBe(0)
  expect(initial.canvases.every((c: any) => c.width === c.cssWidth * 2 && c.height === c.cssHeight * 2 && c.label.includes('HDR'))).toBe(true)
  await record('initial-real-GPU-DPR2', structuredClone(initial))
  for (const pixelPreview of [1, 2, 0]) {
    const old = await snapshot()
    await page.evaluate(pixelPreview => { const p = (window as any).__preview; p.hold = true; p.set({ pixelPreview }) }, pixelPreview)
    await page.waitForFunction(() => (window as any).__preview.gates.length > 0)
    const held = await snapshot(); expect(held.canvases).toEqual(old.canvases); expect(held.uncovered).toBe(0)
    expect(held.presentation.presentationReady).toBe('false')
    await record(`pixelPreview-${pixelPreview}-held-real-request`, held)
    await page.evaluate(() => (window as any).__preview.release()); await ready()
    const done = await snapshot(); expect(done.uncovered).toBe(0)
    expect(done.canvases.every((c: any) => c.width === c.cssWidth * 2 && c.height === c.cssHeight * 2)).toBe(true)
    await record(`pixelPreview-${pixelPreview}-complete`, done)
  }
  for (const backend of ['webgl2', 'webgpu']) {
    const previous = await snapshot()
    await page.evaluate(backend => {
      const p = (window as any).__preview; p.hold = true
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="渲染后端"]')!
      select.value = backend; select.dispatchEvent(new Event('change', { bubbles: true }))
    }, backend)
    await page.waitForFunction(() => (window as any).__preview.gates.length > 0)
    const held = await snapshot(); expect(held.canvases).toEqual(previous.canvases)
    expect(held.presentation.presentationReady).toBe('false'); await record(`backend-${backend}-held`, held)
    await page.evaluate(() => (window as any).__preview.release()); await ready()
    const done = await snapshot(); expect(done.uncovered).toBe(0)
    expect(done.canvases.every((c: any) => c.renderer === backend)).toBe(true)
    await record(`backend-${backend}-complete`, done)
  }
  const beforeProfile = await snapshot()
  await page.evaluate(() => { const p = (window as any).__preview; p.hold = true; p.set({ rasterProfile: 'figma' }) })
  await page.waitForFunction(() => (window as any).__preview.gates.length > 0)
  const profileHeld = await snapshot(); expect(profileHeld.canvases).toEqual(beforeProfile.canvases)
  expect(profileHeld.presentation.presentationReady).toBe('false'); await record('profile-change-held', profileHeld)
  await page.evaluate(() => (window as any).__preview.release()); await ready()
  await record('profile-change-complete', await snapshot())
  const previous = await snapshot()
  await page.evaluate(() => { const p = (window as any).__preview; p.failDisplay = true; p.set({ view: { x: .375, y: -.625, zoom: 1.25 } }) })
  await page.waitForFunction(() => (window as any).__preview.failures > 0)
  await page.waitForTimeout(100)
  const failed = await snapshot(); expect(failed.canvases).toEqual(previous.canvases); expect(failed.uncovered).toBe(0)
  expect(failed.presentation.presentationReady).toBe('false'); await record('injected-HDR-display-failure-retains-complete-float-frame', failed)
  await page.evaluate(() => { const p = (window as any).__preview; p.failDisplay = false; p.set({ grid: true }) }); await ready()
  await record('HDR-recovery-next-real-request', await snapshot())
  const oldCapability = await snapshot()
  await page.evaluate(() => { const p = (window as any).__preview; p.hold = true; p.changeCapability() })
  await page.waitForFunction(() => (window as any).__preview.gates.length > 0)
  const capabilityHeld = await snapshot(); expect(capabilityHeld.canvases).toEqual(oldCapability.canvases)
  expect(capabilityHeld.presentation.presentationReady).toBe('false'); await record('emulated-display-gamut-change-pending', capabilityHeld)
  await page.evaluate(() => (window as any).__preview.release()); await ready()
  await record('emulated-display-gamut-change-real-presenter-complete', await snapshot())
  await page.screenshot({ path: join(output, 'preview-complete.png') })
  await page.evaluate(() => (window as any).__preview.destroy())
  }
  await writeFile(join(output, 'presentation-results.json'), JSON.stringify(cases, null, 2))
  const matrix = await page.evaluate(async ({ coordinateOnly, shaderSource }) => {
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { initializePicking } = await import('/src/kernel/picking.ts')
    const { VectorEngine, encode_png_rgba, color_encode_png } = await import('/src/generated/design-kernel/design_kernel.js')
    const { blank, node, paint, effect } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { planTiles, devicePixelPhase } = await import('/src/kernel/tile-cache.ts')
    await initializePicking()
    const rows = []
    const image = document.createElement('canvas'); image.width = 4; image.height = 4
    const context = image.getContext('2d')!; context.fillStyle = '#ff000080'; context.fillRect(0, 0, 3, 3)
    context.fillStyle = '#0000ff'; context.fillRect(2, 2, 2, 2)
    for (const profile of ['analytic', 'figma', 'figmaSubpixel', 'figmaSoftware'] as const) for (const managed of [false, true]) for (const variant of (managed || coordinateOnly ? ['original'] : ['original', 'fractional-alpha-transform'])) for (const backend of (managed || coordinateOnly ? ['webgpu'] : ['webgpu', 'webgl2']) as ('webgpu'|'webgl2')[]) {
      if (coordinateOnly && (profile !== 'figma' || managed)) continue
      const doc = blank(`${profile}-${managed ? 'HDR' : 'SDR'}-material-preview`)
      doc.schemaVersion = 5
      doc.rasterProfile = profile === 'figmaSubpixel' ? 'figma' : profile
      if (managed) doc.colorManagement = defaultColorSettings()
      const base = node('rectangle', 4, 8, 142, 103)
      base.fills = [paint(managed ? 'color(srgb-linear 1.7 0.18 0.07)' : '#d65425')]
      const lens = node('rectangle', 39.25, 27.5, 61, 49)
      lens.radii = [9, 9, 9, 9]; lens.fills = [{ ...paint('#ffffff'), opacity: .13 }]
      lens.effects = [{ ...effect('glass'), radius: 2, glass: { depth: 3, refraction: .5, dispersion: .2, lightAngle: 30, lightIntensity: .75 } }]
      const texture = node('rectangle', 86.5, 71.25, 42, 31)
      texture.fills = [{ ...paint('#7bcfa8'), opacity: .65 }]
      texture.effects = [{ ...effect('texture'), radius: 1, amount: 1 }]
      const bitmap = node('rectangle', 11.25, 79.5, 30, 22)
      bitmap.fills = [{ ...paint(), kind: 'image', image: image.toDataURL(), fit: 'stretch' }]
      doc.nodes = Object.fromEntries([base, lens, texture, bitmap].map(n => [n.id, n]))
      doc.pages[0].children = [base.id, lens.id, texture.id, bitmap.id]
      if (variant !== 'original') {
        const raw = new Uint8Array(64)
        for (let i=0;i<16;i++) { const x=i%4,y=Math.floor(i/4); raw.set(x>=2&&y>=2?[0,0,255,255]:x<3&&y<3?[255,0,0,128]:[0,0,0,0],i*4) }
        raw.set([75,123,181,80],0)
        bitmap.fills[0].image = 'data:image/png;base64,'+btoa(String.fromCharCode(...encode_png_rgba(4,4,raw)))
        bitmap.transform = [.93,.17,-.22,1.07,14.25,76.5]
        bitmap.fills[0].transform = [.9,.1,.08,1.12,.07,-.03]
        bitmap.fills[0].fit = 'contain'
      }
      if (managed && profile !== 'analytic') {
        const engine = new VectorEngine(); engine.load_document(JSON.stringify(doc))
        let rejected = ''
        try { engine.image_rgba8(bitmap.fills[0].image!) } catch (error) { rejected = String(error) }
        finally { engine.free() }
        if (!rejected.includes('Managed image assets require image_linear')) throw Error('Managed image_rgba8 did not reject loss of precision')
      }

      if (profile === 'figma' && !managed && variant === 'original' && backend === 'webgpu') {
        const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
        const kernel = new VectorEngine(); kernel.load_document(JSON.stringify(doc))
        const original = kernel.image_rgba8(bitmap.fills[0].image!)
        const decoded = await createImageBitmap(await (await fetch(bitmap.fills[0].image!)).blob(), {
          premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none', imageOrientation: 'none',
        })
        const driver: any = await WebGpuDriver.create(false)
        try {
          const texture = driver.upload(decoded), device = driver.device
          const read = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
          const encoder = device.createCommandEncoder()
          encoder.copyTextureToBuffer({ texture: texture.resource }, { buffer: read, bytesPerRow: 256 }, [4, 4])
          device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ)
          const mapped = new Uint8Array(read.getMappedRange()), bytes = new Uint8Array(64)
          for (let y = 0; y < 4; y++) bytes.set(mapped.subarray(y * 256, y * 256 + 16), y * 16)
          const row = { status: 'resource-upload-diagnostic', profile, managed,
            differences: bytes.reduce((n, value, i) => n + Number(value !== original[i]), 0),
            rustPremultiplied: [...original], browserUploaded: [...bytes] }
          rows.push(row); console.log('PREVIEW_MATRIX ' + JSON.stringify(row))
          read.unmap(); read.destroy(); driver.destroy(texture)
        } finally { driver.dispose(); decoded.close(); kernel.free() }
      }
      const client = new KernelClient()
      try {
        for (const view of [{ x: .375, y: -.625, zoom: 1 }, { x: -19.25, y: -14.75, zoom: 1.25 }]) {
          if (coordinateOnly && view.zoom !== 1.25) continue
          const options = { pageId: doc.pages[0].id, width: 300, height: 272, view, grid: false,
            transparent: true, rasterProfile: profile }
          if (managed && profile === 'analytic') {
            let reason = ''
            try { await client.render(doc, options, false, backend, true) } catch (error) { reason = String(error) }
            if (!reason.includes('Managed documents require fine coverage')) throw Error(`Invalid managed analytic contract was not rejected: ${reason}`)
            const row = { profile, managed, view, status: 'unsupported-contract-rejected', reason }
            rows.push(row); console.log('PREVIEW_MATRIX ' + JSON.stringify(row)); continue
          }
          const full = await client.render(doc, options, false, backend, true)
          if (full.backend !== backend) throw Error(`Unexpected fallback ${full.backend}: ${full.reason}`)
          const plan = planTiles({ x: -view.x / view.zoom, y: -view.y / view.zoom,
            width: options.width / view.zoom, height: options.height / view.zoom }, view.zoom, 64,
            { x: devicePixelPhase(view.x, 1), y: devicePixelPhase(view.y, 1) })
          const bytes = new Uint8Array(full.bytes.length), bits = full.linear && new Uint32Array(full.linear.length)
          const covered = new Uint8Array(options.width * options.height)
          let cached = 0
          const gather = (tile: any) => {
            cached += Number(tile.cached)
            const source = tile.linear && new Uint32Array(tile.linear.buffer, tile.linear.byteOffset, tile.linear.length)
            for (let y = 1; y < tile.height - 1; y++) for (let x = 1; x < tile.width - 1; x++) {
              const dx = tile.x + Math.floor(view.x) + x, dy = tile.y + Math.floor(view.y) + y
              if (dx < 0 || dy < 0 || dx >= options.width || dy >= options.height) continue
              const target = dy * options.width + dx, offset = y * tile.width + x
              covered[target]++; bytes.set(tile.bytes.subarray(offset * 4, offset * 4 + 4), target * 4)
              if (bits) bits.set(source.subarray(offset * 4, offset * 4 + 4), target * 4)
            }
          }
          await client.render(doc, { ...options, tileViewport: plan }, false, backend, true, false, undefined, gather)
          const fullBits = full.linear && new Uint32Array(full.linear.buffer, full.linear.byteOffset, full.linear.length)
          const byteDifferences = bytes.reduce((n, x, i) => n + Number(x !== full.bytes[i]), 0)
          const floatDifferences = bits?.reduce((n, x, i) => n + Number(x !== fullBits![i]), 0) || 0
          const coverageErrors = covered.reduce((n, x) => n + Number(x !== 1), 0)
          const revisit = await client.render(doc, { ...options, tileViewport: plan }, false, backend, true, false, undefined, () => {})
          const cpu = await client.render(doc, options, false, 'cpu', true)
          const cpuDifferences = bytes.reduce((n, x, i) => n + Number(x !== cpu.bytes[i]), 0)
          const differenceExamples = Array.from(bytes).flatMap((x, i) => x === cpu.bytes[i] ? [] : [{ x: (i >> 2) % options.width, y: Math.floor((i >> 2) / options.width), channel: i % 4, gpu: x, cpu: cpu.bytes[i] }]).slice(0, 32)
          if (coordinateOnly && cpuDifferences) {
            const engine = new VectorEngine(); engine.load_document(JSON.stringify(doc))
            const scene = JSON.parse(engine.compile_gpu(JSON.stringify(options))), n = scene.nodes[bitmap.id]
            const first = differenceExamples[0], offsets = [[.375,.125],[.875,.375],[.125,.625],[.625,.875]]
            const resolve = scene.resolve, scale = resolve?.scale || 1
            const x0 = Math.floor((first.x + .5 - (resolve?.offsetX || 0)) / scale - .5)
            const y0 = Math.floor((first.y + .5 - (resolve?.offsetY || 0)) / scale - .5)
            const positions: number[][] = []
            for (let sample = 0; sample < 4; sample++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++)
              positions.push([x0 + x + offsets[sample][0], y0 + y + offsets[sample][1], sample, 0])
            const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw Error('No real coordinate GPU')
            const device = await adapter.requestDevice()
            try {
              const uniforms = new Float32Array(256); uniforms.set(n.inverse.slice(0,4),20); uniforms.set([...n.inverse.slice(4),...n.size],24)
              const local = shaderSource.split('\n').find(line => line.startsWith('fn local('))!
              const code = `struct Params{values:array<vec4<f32>,64>} @group(0) @binding(0) var<uniform> params:Params;
                @group(0) @binding(1) var<storage,read> points:array<vec4<f32>>;
                @group(0) @binding(2) var<storage,read_write> output:array<vec4<f32>>;
                fn u(i:u32)->vec4<f32>{return params.values[i];} ${local}
                @compute @workgroup_size(16) fn main(@builtin(global_invocation_id) id:vec3<u32>){
                  if(id.x>=16u){return;}let q=local(points[id.x].xy);let size=vec2<f32>(4);
                  let coord=(q*size-u(6).zw*0.5)/u(6).zw;output[id.x]=vec4<f32>(coord,q);}`
              const buffers = [device.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),
                device.createBuffer({size:256,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),
                device.createBuffer({size:256,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),
                device.createBuffer({size:256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})]
              device.queue.writeBuffer(buffers[0],0,uniforms);device.queue.writeBuffer(buffers[1],0,new Float32Array(positions.flat()))
              const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}})
              const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.slice(0,3).map((buffer,binding)=>({binding,resource:{buffer}}))})
              const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(1);pass.end()
              encoder.copyBufferToBuffer(buffers[2],0,buffers[3],0,256);device.queue.submit([encoder.finish()]);await buffers[3].mapAsync(GPUMapMode.READ)
              const actual = new Float32Array(buffers[3].getMappedRange().slice(0)), bytes=engine.image_rgba8(bitmap.fills[0].image!)
              const bit=(v:number)=>new Uint32Array(new Float32Array([v]).buffer)[0].toString(16)
              const texels=(q:number[])=>{const x=Math.floor(Math.max(0,Math.min(3,q[0]))),y=Math.floor(Math.max(0,Math.min(3,q[1])));return [[x,y],[x+1,y],[x,y+1],[x+1,y+1]].map(([x,y])=>x>3||y>3?[0,0,0,0]:[...bytes.slice((y*4+x)*4,(y*4+x+1)*4)])}
              const samples=positions.map((p,i)=>{const m=n.inverse;const local=[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]]
                const cpu=local.map((v,c)=>Math.fround(Math.max(0,Math.min(3,(v*4-n.size[c]*.5)/n.size[c]))))
                const gpu=[actual[i*4],actual[i*4+1]].map(v=>Math.max(0,Math.min(3,v)))
                return {position:p,cpu,gpu,cpuBits:cpu.map(bit),gpuBits:gpu.map(bit),cpuTexels:texels(cpu),gpuTexels:texels(gpu)}})
              const row={status:'coordinate-diagnostic',first,resolve,n:{matrix:n.matrix,inverse:n.inverse,size:n.size,rect:n.rect},samples,
                differingSamples:samples.filter(v=>v.cpuBits.join()!==v.gpuBits.join()).length}
              rows.push(row);console.log('PREVIEW_MATRIX '+JSON.stringify(row));buffers[3].unmap();buffers.forEach(buffer=>buffer.destroy())
            } finally { device.destroy();engine.free() }
          }
          const file = await client.render(doc, options, true, 'webgpu')
          if (file.backend !== 'cpu') throw Error('File export must use deterministic CPU')
          const encoded = bits ? color_encode_png(options.width, options.height, new Float32Array(bits.buffer),
            JSON.stringify(doc.colorManagement), JSON.stringify({ space: 'srgb', toneMap: 'clip' })) : encode_png_rgba(options.width, options.height, bytes)
          const pngDifferences = Math.abs(encoded.length - file.bytes.length) + encoded.reduce((n, x, i) => n + Number(x !== file.bytes[i]), 0)
          const row = { status: 'rendered', backend, profile, managed, variant, view, width: options.width, height: options.height, tiles: plan.length,
            byteDifferences, floatDifferences, coverageErrors, pngDifferences, cpuDifferences, differenceExamples, exportBackend: file.backend,
            revisitHits: revisit.tileCacheHits, floatPeak: full.linear ? full.linear.reduce((m, v) => Math.max(m, v), -Infinity) : null }
          rows.push(row); console.log('PREVIEW_MATRIX ' + JSON.stringify(row))
          full.bitmap?.close()
        }
      } finally { client.dispose() }
    }
    return rows
  }, { coordinateOnly: process.argv.includes('--coordinate-only'), shaderSource: await readFile(resolve(root, '../../design-studio/crates/design-kernel/shaders/vector.wgsl'), 'utf8') })
  await writeFile(join(output, 'tiles-export-results.json'), JSON.stringify(matrix, null, 2))
  expect(matrix.filter(r => r.status === 'rendered' && (r.byteDifferences || r.floatDifferences || r.coverageErrors || r.pngDifferences || r.revisitHits !== r.tiles))).toEqual([])
  expect(errors).toEqual([])
  const after = await sources()
  await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2))
  expect(after).toEqual(before)
  await writeFile(join(output, 'results.json'), JSON.stringify({ output, cases: cases.length, tilesExportCases: matrix.length, errors, sourceUnchanged: true,
    scope: 'Real worker/GPU at DPR2; request holds/display rejection and color-gamut media override are injected controls, not physical monitor/device failures.' }, null, 2))
  console.log(JSON.stringify({ output, passed: cases.length, errors }))
} catch (error) {
  await writeFile(join(output, 'source-after.json'), JSON.stringify(await sources(), null, 2))
  if (currentPage) await writeFile(join(output, 'failure-dom.html'), await currentPage.content().catch(() => 'page unavailable'))
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: (error as Error).stack, cases, matrixProgress, errors }, null, 2))
  throw error
} finally { await browser?.close(); await server.close() }
