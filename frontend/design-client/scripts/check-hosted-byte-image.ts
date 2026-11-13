/** Same-target check: hosted managed WebGPU samples straight RGBA8 as rgba8uint.
 * The shader is the production managed chain, plus one entry that calls
 * hostedStraightByteImage. Headless Chrome 157 does not expose navigator.gpu;
 * this uses the headed SwiftShader fallback adapter when DISPLAY is set.
 * SwiftShader is not a hardware GPU and is not Metal. */
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gradientPaintOverWgsl } from '../src/kernel/gpu/gradient-paint-over'
import { gradientWindowSource } from '../src/kernel/gpu/gradient-window-source'
import { hostedByteImageSource, imageCoordinateSource } from '../src/kernel/gpu/image-coordinate-source'
import { imageResolveStepWgsl } from '../src/kernel/gpu/image-resolve-step'
import { scalarCoverageSource } from '../src/kernel/gpu/scalar-coverage'
import { straightImageUploadRows } from '../src/kernel/gpu/source-bitmap-grid'

const root = resolve(import.meta.dir, '../../..')
const sampling = readFileSync(resolve(root, 'design-studio/crates/design-kernel/shaders/sampling.wgsl'), 'utf8')
const vector = readFileSync(resolve(root, 'design-studio/crates/design-kernel/shaders/vector.wgsl'), 'utf8')
const rationalStub = 'fn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}'
const integerSample = `fn integerSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{return bsCorner4(at(tex,p,r),at(tex,p+vec2<f32>(1.,0.),r),at(tex,p+vec2<f32>(0.,1.),r),at(tex,p+vec2<f32>(1.,1.),r));}\n`
const shader = hostedByteImageSource(scalarCoverageSource(gradientWindowSource(imageCoordinateSource(
  `const BYTE_SURFACE:bool=false;\n${sampling}\n${rationalStub}\n${vector}${integerSample}${imageResolveStepWgsl}${gradientPaintOverWgsl}`,
)))) + `
@fragment fn hostedByteImageProof(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
 return hostedStraightByteImage(p.xy+u(0).xy);
}
`
if (!shader.includes('texture_2d<u32>') || !shader.includes('textureLoad(sourceBytes,q,0)'))
  throw Error('Production hosted byte-image shader was not assembled')

const outW = 16
const outH = 1
function bitsToF32(bits: number) {
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, bits >>> 0, true)
  return view.getFloat32(0, true)
}
function tableWords() {
  const table = new Float32Array(512)
  for (let i = 0; i < 256; i++) {
    table[i] = bitsToF32(((118 + (i % 12)) << 23) | ((i * 0x1b3d) & 0x7fffff))
    table[256 + i] = i === 0 ? 0 : bitsToF32(((124 << 23) | ((i * 0x5d) & 0x7fffff)))
  }
  return table
}
const transfer = tableWords()
function pattern(x: number, y: number) {
  return [(x * 17 + y * 3) & 255, (x * 9 + 40) & 255, (y * 13 + x) & 255, x === 2 && y === 1 ? 0 : (160 + ((x + y * 5) & 95))]
}
function premul(r: number, g: number, b: number, a: number) {
  const alpha = transfer[256 + a]
  return [Math.fround(transfer[r] * alpha), Math.fround(transfer[g] * alpha), Math.fround(transfer[b] * alpha), alpha]
}
interface Sample { x: number, cellX: number, cellY: number, fx: number, fy: number, exact: boolean }
function samplesFor(width: number, height: number): Sample[] {
  return [
    { x: 0, cellX: 0, cellY: 0, fx: 0, fy: 0, exact: true },
    { x: 1, cellX: 1, cellY: 0, fx: 0, fy: 0, exact: true },
    { x: 2, cellX: 3, cellY: 0, fx: 0.25, fy: 0, exact: false },
    { x: 3, cellX: 4, cellY: 1, fx: 0.5, fy: 0.5, exact: false },
    { x: 4, cellX: 255, cellY: 0, fx: 0, fy: 0, exact: true },
    { x: 5, cellX: width - 1, cellY: 0, fx: 0, fy: 0, exact: true },
    { x: 6, cellX: Math.min(width - 2, 260), cellY: height - 2, fx: 0.125, fy: 0.375, exact: false },
    { x: 7, cellX: 0, cellY: height - 1, fx: 0, fy: 0, exact: true },
    { x: 8, cellX: 64, cellY: 2, fx: 0, fy: 0, exact: true },
    { x: 9, cellX: 100, cellY: 3, fx: 0.75, fy: 0.25, exact: false },
  ]
}
function caseFor(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4)
  const linear = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgba = pattern(x, y)
    pixels.set(rgba, (y * width + x) * 4)
    linear.set(premul(rgba[0], rgba[1], rgba[2], rgba[3]), (y * width + x) * 4)
  }
  const packed = straightImageUploadRows(pixels, width, height)
  const field = new Float32Array(outW * outH * 4)
  const expectExact: Array<[number, number, number, number] | null> = Array(outW).fill(null)
  for (const sample of samplesFor(width, height)) {
    const at = sample.x * 4
    field.set([sample.cellX, sample.cellY, sample.fx, sample.fy], at)
    if (sample.exact) {
      const rgba = pattern(sample.cellX, sample.cellY)
      expectExact[sample.x] = premul(rgba[0], rgba[1], rgba[2], rgba[3]) as [number, number, number, number]
    }
  }
  const uniforms = new Float32Array(256)
  uniforms[2] = outW
  uniforms[3] = outH
  uniforms[10] = width
  uniforms[11] = height
  uniforms[254] = 9
  uniforms[255] = 19
  return {
    width, height,
    image: Buffer.from(packed.bytes).toString('base64'),
    bytesPerRow: packed.bytesPerRow,
    linear: Buffer.from(linear.buffer).toString('base64'),
    linearBytesPerRow: width * 16,
    field: Buffer.from(field.buffer).toString('base64'),
    table: Buffer.from(transfer.buffer).toString('base64'),
    uniforms: Buffer.from(uniforms.buffer).toString('base64'),
    expectExact,
  }
}
const cases = [caseFor(256, 4), caseFor(272, 4)]

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
    {binding:1,resource:textures.blank.createView()},
    {binding:2,resource:textures.floatImage.createView()},
    {binding:3,resource:textures.blank.createView()},
    {binding:4,resource:{buffer:curves}},
    {binding:5,resource:textures.field.createView()},
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
      fragment:{module:shader,entryPoint:'hostedByteImageProof',targets:[{format:'rgba32float'}]},
      primitive:{topology:'triangle-list'},
    })
    const pipelineError=await device.popErrorScope()
    if(pipelineError){await report(JSON.stringify({status:'FAIL',reason:pipelineError.message}));return}
    const curves=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    device.queue.writeBuffer(curves,0,new Uint8Array(16))
    const blank=device.createTexture({size:[1,1],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
    device.queue.writeTexture({texture:blank},new Float32Array(4),{bytesPerRow:256},[1,1])
    const cases=await (await fetch('/cases')).json()
    const results=[]
    for(const item of cases){
      const imageBytes=b64(item.image), linearBytes=b64(item.linear), fieldBytes=b64(item.field), table=b64(item.table)
      const uintTex=device.createTexture({size:[item.width,item.height+2],format:'rgba8uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC})
      device.queue.writeTexture({texture:uintTex},imageBytes,{bytesPerRow:item.bytesPerRow},[item.width,item.height])
      device.queue.writeTexture({texture:uintTex,origin:[0,item.height]},table,{bytesPerRow:1024},[256,2])
      const floatTex=device.createTexture({size:[item.width,item.height],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
      device.queue.writeTexture({texture:floatTex},linearBytes,{bytesPerRow:item.linearBytesPerRow},[item.width,item.height])
      const field=device.createTexture({size:[${outW},${outH}],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
      device.queue.writeTexture({texture:field},fieldBytes,{bytesPerRow:256},[${outW},${outH}])
      const base=new Float32Array(b64(item.uniforms).buffer)
      const floatU=device.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
      const byteU=device.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
      base[207]=0;device.queue.writeBuffer(floatU,0,base)
      base[207]=1;device.queue.writeBuffer(byteU,0,base)
      const textures={blank,floatImage:floatTex,field}
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
  if (!process.env.DISPLAY) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'DISPLAY is unset; headed SwiftShader WebGPU is unavailable and headless Chrome has no navigator.gpu' }))
    process.exitCode = 2
    return
  }
  const { server, port } = await serve(shader)
  const result = new Promise<string>((resolveResult, reject) => {
    const timer = setTimeout(() => reject(Error('WebGPU byte-image check timed out')), 120000)
    server.once('result', text => { clearTimeout(timer); resolveResult(text) })
  })
  const chrome = spawn('/opt/google/chrome/chrome', [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu-sandbox', '--disable-extensions',
    `--user-data-dir=/tmp/chrome-hosted-byte-${process.pid}`,
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
    console.log(JSON.stringify(payload))
    process.exitCode = 2
    return
  }
  if (payload.status !== 'RAN' || !payload.results) throw Error(payload.reason || 'Hosted byte-image check failed')
  const mismatches: unknown[] = []
  payload.results.forEach((row, index) => {
    const spec = cases[index]
    const floatBits = bitsOf(row.float)
    const byteBits = bitsOf(row.byte)
    for (let i = 0; i < floatBits.length; i++) if (floatBits[i] !== byteBits[i]) mismatches.push({ width: spec.width, index: i, float: floatBits[i], byte: byteBits[i] })
    spec.expectExact.forEach((expected, x) => {
      if (!expected) return
      const got = row.byte.slice(x * 4, x * 4 + 4)
      expected.forEach((value, channel) => {
        if (got[channel] !== value) mismatches.push({ width: spec.width, pixel: x, channel, expected: value, byte: got[channel] })
      })
    })
  })
  const summary = {
    status: mismatches.length ? 'FAIL' : 'PASS',
    adapter: payload.adapter,
    cases: payload.results.map(row => row.width),
    comparedFloats: payload.results.reduce((sum, row) => sum + row.float.length, 0),
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
