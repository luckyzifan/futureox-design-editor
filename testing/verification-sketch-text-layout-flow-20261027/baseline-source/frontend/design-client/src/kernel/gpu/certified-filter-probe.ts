// Execute the production integer certificate on actual GPU backends; no copied model.
import samplingWgsl from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import samplingGlsl from './sampling.glsl?raw'
import certifiedWgsl from '../../../../../design-studio/crates/design-kernel/shaders/certified-rational.wgsl?raw'
import certifiedGlsl from './certified-rational.glsl?raw'
import corpus from '../../../../../testing/fixtures/design/certified-filter-vectors.json'
import { certified_tent_kernel_rgba, certified_box_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { initializePicking } from '../picking'

type ProbeRow = { kernel: number; values: number[]; expected: number; mustDecline?: boolean }
function compare(values: Uint32Array, rows: ProbeRow[], stride: number) {
  let accepted = 0, declined = 0
  const errors: { index: number; actual: number; expected: number; accepted: number }[] = []
  if (values.length < rows.length * stride) throw new Error('Incomplete Q48 readback')
  for (const [index, row] of rows.entries()) {
    const bits = values[index * stride], flag = values[index * stride + 1]
    if (flag === 0) declined++
    else if (flag === 1) accepted++
    if (flag > 1 || (flag === 1 && (row.mustDecline || bits !== row.expected))) errors.push({ index, actual: bits, expected: row.expected, accepted: flag })
  }
  return { checks: rows.length, accepted, declined, failures: errors.length, examples: errors.slice(0, 16) }
}

export async function checkCertifiedFilter() {
  await initializePicking()
  const tentHalf = corpus.kernels.findIndex((kernel) => kernel.kind === 'tent' && kernel.radiusBits === '3fe0000000000000')
  const rows: ProbeRow[] = [...corpus.cases, ...[0x7fc00000, 0x7f800000, 0xff800000].map((value) => ({ kernel: tentHalf, values: [0, value, 0], expected: 0, mustDecline: true }))]
  const words = new Array<number>(rows.length * 4).fill(0)
  for (const [index, row] of rows.entries()) {
    const kernel = corpus.kernels[row.kernel], radius = new DataView(new ArrayBuffer(8))
    radius.setBigUint64(0, BigInt('0x' + kernel.radiusBits), true)
    const packet = kernel.kind === 'box' ? certified_box_kernel_rgba(radius.getFloat64(0, true)) : certified_tent_kernel_rgba(radius.getFloat64(0, true))
    const data = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    // The WASM-generated coefficients also have an independent exact oracle.
    for (const [distance, expected] of kernel.q48.entries()) {
      const raw = BigInt(data.getUint32(16 + distance * 8, true)) | (BigInt(data.getUint32(20 + distance * 8, true)) << 32n)
      const wide = data.getUint32(12, true) === 64
      const actual = wide ? raw >> 16n : raw
      if (wide && raw !== BigInt(kernel.q64[distance])) throw new Error(`Q64 coefficient mismatch case=${index} distance=${distance}`)
      if (actual !== BigInt(expected)) throw new Error(`Q48 coefficient mismatch case=${index} distance=${distance}`)
    }
    words[index * 4] = words.length
    for (let i = 0; i < packet.length; i += 4) words.push(data.getUint32(i, true))
    words[index * 4 + 1] = words.length
    words[index * 4 + 2] = (row.values.length - 1) / 2
    words.push(...row.values)
  }
  const input = new Uint32Array(words)
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('Q48 certificate probe requires WebGPU')
  const device = await adapter.requestDevice()
  const webgpu = await (async () => {
    try {
      const code = samplingWgsl.slice(0, samplingWgsl.indexOf('fn bsParts')) +
        certifiedWgsl.slice(0, certifiedWgsl.indexOf('fn rfCertifiedLoad')) + `
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
var<private> caseIndex:u32;
fn rfCertifiedLoad(index:u32)->u32{return inputs[inputs[caseIndex*4u]+index];}
fn rfCertifiedSource(p:vec2<f32>)->vec4<f32>{let at=u32(i32(p.x)+i32(inputs[caseIndex*4u+2u]));return vec4<f32>(bitcast<f32>(inputs[inputs[caseIndex*4u+1u]+at]));}
` + certifiedWgsl.slice(certifiedWgsl.indexOf('fn cfAdd')) + `
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=${rows.length}u){return;}caseIndex=id.x;
 let value=rfCertifiedChannel(vec2<f32>(0),vec2<f32>(1,0),0u);outputs[id.x*2u]=value.x;outputs[id.x*2u+1u]=value.y;
}`
      const module = device.createShaderModule({ code })
      const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error')
      if (errors.length) throw new Error(errors.map((error) => `${error.lineNum}:${error.message}`).join('\n'))
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
      const source = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(source, 0, input)
      const size = rows.length * 8
      const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
      const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: output } },
      ] })
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass()
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(rows.length / 32)); pass.end()
      encoder.copyBufferToBuffer(output, 0, readback, 0, size); device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const result = compare(new Uint32Array(readback.getMappedRange()), rows, 2)
      readback.unmap()
      return result
    } finally { device.destroy() }
  })()
  const canvas = new OffscreenCanvas(256, Math.ceil(rows.length / 256)), gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('Q48 certificate probe requires WebGL2')
  const webgl2 = (() => {
    try {
      const shader = (type: number, code: string) => {
        const value = gl.createShader(type)!
        gl.shaderSource(value, code); gl.compileShader(value)
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) || 'Q48 GLSL compile error')
        return value
      }
      const program = gl.createProgram()!
      gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`))
      const fragment = `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D inputs;
layout(location=0) out highp uvec4 result;
uint caseIndex;
uint word(uint i){uint texel=i/4u;return texelFetch(inputs,ivec2(int(texel%256u),int(texel/256u)),0)[i%4u];}
uint rfCertifiedLoad(uint i){return word(word(caseIndex*4u)+i);}
vec4 rfCertifiedSource(vec2 p){uint at=uint(int(p.x)+int(word(caseIndex*4u+2u)));return vec4(uintBitsToFloat(word(word(caseIndex*4u+1u)+at)));}
` + samplingGlsl.slice(0, samplingGlsl.indexOf('uvec3 bsParts')) +
        certifiedGlsl.slice(0, certifiedGlsl.indexOf('uint rfCertifiedLoad')) +
        certifiedGlsl.slice(certifiedGlsl.indexOf('uint cfAdd')) + `
void main(){caseIndex=uint(int(gl_FragCoord.y)*256+int(gl_FragCoord.x));if(caseIndex>=${rows.length}u){result=uvec4(0);return;}
uvec2 value=rfCertifiedChannel(vec2(0),vec2(1,0),0u);result=uvec4(value,0u,0u);}`
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Q48 GLSL link error')
      gl.useProgram(program); gl.bindVertexArray(gl.createVertexArray())
      const texture = gl.createTexture()!, inputHeight = Math.ceil(input.length / (canvas.width * 4))
      const data = new Uint32Array(canvas.width * inputHeight * 4); data.set(input)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, canvas.width, inputHeight, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data)
      const target = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, target); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, canvas.width, canvas.height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer()); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Q48 framebuffer incomplete')
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(program, 'inputs'), 0)
      gl.viewport(0, 0, canvas.width, canvas.height); gl.drawArrays(gl.TRIANGLES, 0, 3)
      const readback = new Uint32Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, readback)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Q48 WebGL readback failed')
      return compare(readback, rows, 4)
    } finally { gl.getExtension('WEBGL_lose_context')?.loseContext() }
  })()
  return { webgpu, webgl2 }
}
