// Test harness: execute the production helpers, not a copied shader model.
import wgsl from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import glsl from './sampling.glsl?raw'
import corpus from '../../../../../testing/fixtures/design/filter-vectors.json'
import filterWgsl from '../../../../../design-studio/crates/design-kernel/shaders/rational-filter.wgsl?raw'
import filterGlsl from './rational-filter.glsl?raw'
import { rational_tent_kernel_rgba, rational_box_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { initializePicking } from '../picking'

type Failure = { index: number; input: (typeof corpus.cases)[number]; actual: number }
function compare(values: Uint32Array) {
  const failures: Failure[] = []
  if (values.length < corpus.cases.length) throw new Error('Incomplete filter readback')
  for (const [index, input] of corpus.cases.entries())
    if (values[index] !== input.expected) failures.push({ index, input, actual: values[index] })
  return {
    checks: corpus.cases.length,
    failures: failures.length,
    examples: failures.slice(0, 16),
  }
}
export async function checkFilter() {
  const rows = corpus.cases
  await initializePicking()
  const words = new Array<number>(rows.length * 4).fill(0)
  for (const [index, row] of rows.entries()) {
    const bits = new DataView(new ArrayBuffer(8))
    bits.setBigUint64(0, BigInt('0x' + row.radiusBits), true)
    const bytes = row.kind === 'box' ? rational_box_kernel_rgba(bits.getFloat64(0,true)) : rational_tent_kernel_rgba(bits.getFloat64(0, true))
    const packet = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    words[index * 4] = words.length
    for (let i = 0; i < bytes.length; i += 4) words.push(packet.getUint32(i, true))
    words[index * 4 + 1] = words.length
    words[index * 4 + 2] = (row.values.length - 1) / 2
    words.push(...row.values)
  }
  const input = new Uint32Array(words)
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('Rational filter probe requires a WebGPU adapter')
  const device = await adapter.requestDevice()
  const webgpu = await (async () => {
    try {
      const code =
        wgsl.slice(0, wgsl.indexOf('fn bsParts')) +
        `
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
var<private> caseIndex:u32;
fn rfLoad(index:u32)->u32{return inputs[inputs[caseIndex*4u]+index];}
fn rfSource(p:vec2<f32>)->vec4<f32>{let index=u32(i32(p.x)+i32(inputs[caseIndex*4u+2u]));return vec4<f32>(bitcast<f32>(inputs[inputs[caseIndex*4u+1u]+index]));}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}caseIndex=id.x;
 outputs[id.x]=bitcast<u32>(rfChannel(vec2<f32>(0),vec2<f32>(1,0),0u));
}` +
        filterWgsl.slice(filterWgsl.indexOf('fn rfChannel'))
      const module = device.createShaderModule({ code })
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      })
      const source = device.createBuffer({
        size: input.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(source, 0, input)
      const size = rows.length * 4
      const output = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      })
      const readback = device.createBuffer({
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: output } },
        ],
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(rows.length / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, readback, 0, size)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const result = compare(new Uint32Array(readback.getMappedRange()))
      readback.unmap()
      return result
    } finally {
      device.destroy()
    }
  })()
  const canvas = new OffscreenCanvas(256, Math.ceil(rows.length / 256))
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('Rational filter probe requires WebGL2')
  const webgl2 = (() => {
    try {
      const makeShader = (type: number, code: string) => {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(
            gl.getShaderInfoLog(shader) || 'Rational filter shader compilation failed',
          )
        return shader
      }
      const program = gl.createProgram()!
      gl.attachShader(
        program,
        makeShader(
          gl.VERTEX_SHADER,
          `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
        ),
      )
      const code =
        `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D inputs;
layout(location=0) out highp uvec4 result;
uint caseIndex;
uint word(uint i){uint texel=i/4u;return texelFetch(inputs,ivec2(int(texel%256u),int(texel/256u)),0)[i%4u];}
uint rfLoad(uint i){return word(word(caseIndex*4u)+i);}
vec4 rfSource(vec2 p){uint index=uint(int(p.x)+int(word(caseIndex*4u+2u)));return vec4(uintBitsToFloat(word(word(caseIndex*4u+1u)+index)));}
` +
        glsl.slice(0, glsl.indexOf('uvec3 bsParts')) +
        filterGlsl.slice(0, filterGlsl.indexOf('uint rfLoad')) +
        filterGlsl.slice(filterGlsl.indexOf('float rfChannel')) +
        `
void main(){caseIndex=uint(int(gl_FragCoord.y)*256+int(gl_FragCoord.x));if(caseIndex>=${rows.length}u){result=uvec4(0);return;}
result=uvec4(floatBitsToUint(rfChannel(vec2(0),vec2(1,0),0u)),0u,0u,0u);}`
      gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, code))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'Rational filter shader link failed')
      gl.useProgram(program)
      gl.bindVertexArray(gl.createVertexArray())
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      const inputHeight = Math.ceil(input.length / (canvas.width * 4))
      const data = new Uint32Array(canvas.width * inputHeight * 4)
      data.set(input)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        canvas.width,
        inputHeight,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        data,
      )
      const target = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, target)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, canvas.width, canvas.height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer())
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Rational filter framebuffer incomplete')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(gl.getUniformLocation(program, 'inputs'), 0)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const readback = new Uint32Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, readback)
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw new Error(`Rational filter GL error: ${error}`)
      return compare(readback.filter((_, i) => i % 4 === 0))
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })()
  return { webgpu, webgl2 }
}
