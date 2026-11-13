/** Same-target check: the source image layer samples straight RGBA8 as rgba8uint.
 * The fragment is the production `sourceImageLayerWgsl` entry `imageLayer`.
 * Headless Chrome 157 does not expose navigator.gpu. This uses the headed
 * SwiftShader fallback adapter when DISPLAY is set. SwiftShader is not a
 * hardware GPU and is not Metal. No /dev/dri is reported, not treated as a pass.
 */
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { straightImageUploadRows } from '../src/kernel/gpu/source-bitmap-grid'

const root = resolve(import.meta.dir, '..')
const built = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/kernel/gpu/source-layer-shader.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [{
    name: 'wgsl-raw',
    setup(build) {
      build.onResolve({ filter: /\.wgsl\?raw$/ }, args => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
        namespace: 'wgsl-raw',
      }))
      build.onLoad({ filter: /.*/, namespace: 'wgsl-raw' }, args => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
        loader: 'js',
      }))
    },
  }],
})
const bundle = built.outputFiles[0]?.text
if (!bundle) throw Error('Source image layer shader did not bundle')
const bundlePath = '/tmp/source-image-layer-shader.mjs'
writeFileSync(bundlePath, bundle)
const shaderModule = await import(pathToFileURL(bundlePath).href) as { sourceImageLayerWgsl: string }
const shader = shaderModule.sourceImageLayerWgsl
if (!shader.includes('texture_2d<u32>') || !shader.includes('textureLoad(sourceBytes,local,0)') || shader.includes('round(value*255.)'))
  throw Error('Production source image layer shader is not sampling rgba8uint')

const kernel = await import('../src/generated/design-kernel/design_kernel.js') as {
  default: (input: { module_or_path: WebAssembly.Module }) => Promise<unknown>
  straight_srgb8_table: () => Uint8Array
}
const wasmBytes = readFileSync(resolve(root, 'src/generated/design-kernel/design_kernel_bg.wasm'))
await kernel.default({ module_or_path: await WebAssembly.compile(wasmBytes) })
const tableBytes = Uint8Array.from(kernel.straight_srgb8_table())
if (tableBytes.byteLength !== 2048) throw Error('Invalid sRGB transfer table')
const tableView = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength)
const transfer = Float32Array.from({ length: 512 }, (_, i) => tableView.getFloat32(i * 4, true))

const outW = 8
const outH = 3
function pattern(x: number, y: number) {
  return [(x * 17 + y * 3) & 255, (x * 9 + 40) & 255, (y * 13 + x) & 255, x === 2 && y === 1 ? 0 : (160 + ((x + y * 5) & 95))]
}
function premul(r: number, g: number, b: number, a: number) {
  const alpha = transfer[256 + a]
  return [Math.fround(transfer[r] * alpha), Math.fround(transfer[g] * alpha), Math.fround(transfer[b] * alpha), alpha]
}
function presented(color: number[]) {
  return color[3] <= 0 ? [0, 0, 0, 0] : color
}
interface Column { srcX: number, fx: number, valid: number }
interface Row { srcY: number, fy: number, valid: number }
function caseFor(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4)
  const linear = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgba = pattern(x, y)
    pixels.set(rgba, (y * width + x) * 4)
    linear.set(premul(rgba[0], rgba[1], rgba[2], rgba[3]), (y * width + x) * 4)
  }
  const packed = straightImageUploadRows(pixels, width, height)
  const columns: Column[] = [
    { srcX: 0, fx: 0, valid: 1 },
    { srcX: 1, fx: 0, valid: 1 },
    { srcX: 2, fx: 0, valid: 1 },
    { srcX: 3, fx: 0.25, valid: 1 },
    { srcX: 255, fx: 0, valid: 1 },
    { srcX: width - 1, fx: 0, valid: 1 },
    { srcX: width - 1, fx: 0.5, valid: 1 },
    { srcX: -1, fx: 0, valid: 1 },
  ]
  const rows: Row[] = [
    { srcY: 0, fy: 0, valid: 1 },
    { srcY: 1, fy: 0, valid: 1 },
    { srcY: 1, fy: 0.5, valid: 1 },
  ]
  if (columns.length !== outW || rows.length !== outH) throw Error('Source layer sample grid changed')
  const field = new Float32Array(outW * 2 * 4)
  columns.forEach((column, x) => field.set([column.srcX, column.fx, column.valid, 0], x * 4))
  rows.forEach((row, y) => field.set([row.srcY, row.fy, row.valid, 0], (outW + y) * 4))
  const fieldBytes = new Uint8Array(256 * 2)
  const packedField = new Uint8Array(field.buffer)
  for (let y = 0; y < 2; y++) fieldBytes.set(packedField.subarray(y * outW * 16, (y + 1) * outW * 16), y * 256)
  const expectExact: Array<[number, number, number, number] | null> = []
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const column = columns[x], row = rows[y]
    if (column.fx !== 0 || row.fy !== 0) { expectExact.push(null); continue }
    if (!column.valid || !row.valid || column.srcX < 0 || row.srcY < 0 || column.srcX >= width || row.srcY >= height) {
      expectExact.push([0, 0, 0, 0])
      continue
    }
    const rgba = pattern(column.srcX, row.srcY)
    expectExact.push(presented(premul(rgba[0], rgba[1], rgba[2], rgba[3])) as [number, number, number, number])
  }
  const uniforms = new Float32Array(256)
  uniforms.set([0, 0, outW, outH], 0)
  uniforms.set([0, 0, 0, 0], 4)
  uniforms.set([0, 0, width, height], 8)
  uniforms.set([77, 0, 0, 0], 16)
  uniforms.set([0, 0, outW, outH], 20)
  uniforms.set([0, 0, outW, outH], 24)
  uniforms.set([-2, 1, 1, 0], 28)
  return {
    width, height,
    image: Buffer.from(packed.bytes).toString('base64'),
    bytesPerRow: packed.bytesPerRow,
    linear: Buffer.from(linear.buffer).toString('base64'),
    linearBytesPerRow: width * 16,
    field: Buffer.from(fieldBytes).toString('base64'),
    table: Buffer.from(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength).toString('base64'),
    uniforms: Buffer.from(uniforms.buffer).toString('base64'),
    expectExact,
  }
}
const cases = [caseFor(256, 4), caseFor(272, 4)]
const shaderHash = createHash('sha256').update(shader).digest('hex')

const page = `<!doctype html><body><pre id="o">pending</pre><script>
const b64=s=>{const b=atob(s);const o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o}
async function readFloat(device, texture, width, height){
  const bytesPerRow=Math.ceil(width*16/256)*256
  const buffer=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
  const encoder=device.createCommandEncoder()
  encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow},[width,height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const copy=new Uint8Array(buffer.getMappedRange()).slice()
  buffer.unmap()
  const out=new Float32Array(width*height*4)
  const view=new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  for(let y=0;y<height;y++)for(let x=0;x<width*4;x++)out[y*width*4+x]=view.getFloat32(y*bytesPerRow+x*4,true)
  return out
}
async function draw(device, pipeline, layout, curves, uniforms, textures, byte){
  const group=device.createBindGroup({layout,entries:[
    {binding:0,resource:{buffer:uniforms}},
    {binding:1,resource:textures.dst.createView()},
    {binding:2,resource:textures.floatImage.createView()},
    {binding:3,resource:textures.field.createView()},
    {binding:4,resource:{buffer:curves}},
    {binding:5,resource:textures.blank.createView()},
    {binding:6,resource:byte.createView()},
  ]})
  const target=device.createTexture({size:[${outW},${outH}],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})
  const encoder=device.createCommandEncoder()
  const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
  pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end()
  device.queue.submit([encoder.finish()])
  return readFloat(device,target,${outW},${outH})
}
(async()=>{
  const report=async text=>{document.getElementById('o').textContent=text;await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:text})}
  try{
    if(!navigator.gpu){await report(JSON.stringify({status:'BLOCKED',reason:'navigator.gpu missing'}));return}
    const adapter=await navigator.gpu.requestAdapter()
    if(!adapter){await report(JSON.stringify({status:'BLOCKED',reason:'no adapter'}));return}
    const device=await adapter.requestDevice()
    const shader=device.createShaderModule({code:await (await fetch('/shader')).text()})
    const compiled=await shader.getCompilationInfo()
    const errors=compiled.messages.filter(m=>m.type==='error')
    if(errors.length){await report(JSON.stringify({status:'FAIL',reason:errors.map(e=>e.lineNum+':'+e.message).join('\\n')}));return}
    const layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:1024}},
      ...[1,2,3,5].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float'}})),
      {binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage',minBindingSize:16}},
      {binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'uint'}},
    ]})
    device.pushErrorScope('validation')
    const pipeline=device.createRenderPipeline({
      layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),
      vertex:{module:shader,entryPoint:'quad'},
      fragment:{module:shader,entryPoint:'imageLayer',targets:[{format:'rgba32float'}]},
      primitive:{topology:'triangle-list'},
    })
    const pipelineError=await device.popErrorScope()
    if(pipelineError){await report(JSON.stringify({status:'FAIL',reason:pipelineError.message}));return}
    const curves=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    device.queue.writeBuffer(curves,0,new Uint8Array(16))
    const blank=device.createTexture({size:[1,1],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
    device.queue.writeTexture({texture:blank},new Float32Array(4),{bytesPerRow:256},[1,1])
    const dst=device.createTexture({size:[1,1],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
    device.queue.writeTexture({texture:dst},new Float32Array(4),{bytesPerRow:256},[1,1])
    const cases=await (await fetch('/cases')).json()
    const results=[]
    for(const item of cases){
      const imageBytes=b64(item.image), linearBytes=b64(item.linear), fieldBytes=b64(item.field), table=b64(item.table)
      const uintTex=device.createTexture({size:[item.width,item.height+2],format:'rgba8uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC})
      device.queue.writeTexture({texture:uintTex},imageBytes,{bytesPerRow:item.bytesPerRow},[item.width,item.height])
      device.queue.writeTexture({texture:uintTex,origin:[0,item.height]},table,{bytesPerRow:1024},[256,2])
      const floatTex=device.createTexture({size:[item.width,item.height],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
      device.queue.writeTexture({texture:floatTex},linearBytes,{bytesPerRow:item.linearBytesPerRow},[item.width,item.height])
      const field=device.createTexture({size:[${outW},2],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
      device.queue.writeTexture({texture:field},fieldBytes,{bytesPerRow:256},[${outW},2])
      const base=new Float32Array(b64(item.uniforms).buffer)
      const floatU=device.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
      const byteU=device.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
      base[18]=0;device.queue.writeBuffer(floatU,0,base)
      base[18]=1;device.queue.writeBuffer(byteU,0,base)
      const textures={blank,dst,floatImage:floatTex,field}
      device.pushErrorScope('validation')
      const floatPixels=await draw(device,pipeline,layout,curves,floatU,textures,device.createTexture({size:[1,1],format:'rgba8uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}))
      const bytePixels=await draw(device,pipeline,layout,curves,byteU,{...textures,floatImage:blank},uintTex)
      const error=await device.popErrorScope()
      if(error){await report(JSON.stringify({status:'FAIL',reason:error.message,width:item.width}));return}
      results.push({width:item.width,float:[...floatPixels],byte:[...bytePixels]})
    }
    const info=adapter.info||{}
    await report(JSON.stringify({status:'RAN',adapter:{vendor:info.vendor,architecture:info.architecture,description:info.description,fallback:!!info.isFallbackAdapter,device:info.device},results}))
  }catch(error){await report(JSON.stringify({status:'FAIL',reason:String(error)}))}
})()
</script>`

function serve(shaderSource: string): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/shader') { res.setHeader('content-type', 'text/plain'); res.end(shaderSource); return }
    if (req.url === '/cases') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(cases)); return }
    if (req.method === 'POST' && req.url === '/result') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => { res.end(); server.emit('result', Buffer.concat(chunks).toString('utf8')) })
      return
    }
    res.setHeader('content-type', 'text/html'); res.end(page)
  })
  return new Promise(resolveListen => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No local port')
    resolveListen({ server, port: address.port })
  }))
}

function bitsOf(values: number[]) {
  const raw = new Float32Array(values)
  return new Uint32Array(raw.buffer.slice(0))
}

async function main() {
  const dri = existsSync('/dev/dri')
  if (!process.env.DISPLAY) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'DISPLAY is unset; headed SwiftShader WebGPU is unavailable and headless Chrome has no navigator.gpu', dri, shaderHash }))
    process.exitCode = 2
    return
  }
  const { server, port } = await serve(shader)
  const result = new Promise<string>((resolveResult, reject) => {
    const timer = setTimeout(() => reject(Error('Source image layer byte check timed out')), 120000)
    server.once('result', text => { clearTimeout(timer); resolveResult(text) })
  })
  const chrome = spawn('/opt/google/chrome/chrome', [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu-sandbox', '--disable-extensions',
    `--user-data-dir=/tmp/chrome-source-layer-byte-${process.pid}`,
    '--enable-unsafe-webgpu', '--enable-blink-features=WebGPU', '--enable-features=WebGPU',
    '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader',
    `http://127.0.0.1:${port}/`,
  ], { env: { ...process.env }, stdio: 'ignore' })
  let payload: { status: string, reason?: string, adapter?: Record<string, unknown>, results?: Array<{ width: number, float: number[], byte: number[] }> }
  try {
    payload = JSON.parse(await result)
  } finally {
    chrome.kill('SIGKILL')
    server.close()
  }
  if (payload.status === 'BLOCKED') {
    console.log(JSON.stringify({ ...payload, dri, shaderHash }))
    process.exitCode = 2
    return
  }
  if (payload.status !== 'RAN' || !payload.results) throw Error(payload.reason || 'Source image layer byte check failed')
  const mismatches: unknown[] = []
  payload.results.forEach((row, index) => {
    const spec = cases[index]
    const floatBits = bitsOf(row.float)
    const byteBits = bitsOf(row.byte)
    for (let i = 0; i < floatBits.length; i++) if (floatBits[i] !== byteBits[i]) mismatches.push({ width: spec.width, index: i, float: floatBits[i], byte: byteBits[i] })
    spec.expectExact.forEach((expected, pixel) => {
      if (!expected) return
      const got = row.byte.slice(pixel * 4, pixel * 4 + 4)
      expected.forEach((value, channel) => {
        if (got[channel] !== value) mismatches.push({ width: spec.width, pixel, channel, expected: value, byte: got[channel] })
      })
    })
  })
  const summary = {
    status: mismatches.length ? 'FAIL' : 'PASS',
    dri,
    shaderHash,
    adapter: payload.adapter,
    cases: payload.results.map(row => row.width),
    comparedFloats: payload.results.reduce((sum, row) => sum + row.float.length, 0),
    exactPixels: cases.reduce((sum, item) => sum + item.expectExact.filter(Boolean).length, 0),
    mismatches: mismatches.slice(0, 12),
    mismatchCount: mismatches.length,
  }
  console.log(JSON.stringify(summary))
  if (mismatches.length) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
