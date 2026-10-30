import vectorWgsl from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import vectorGlsl from './vector.glsl?raw'
import coverageWgsl from '../../../../../design-studio/crates/design-kernel/shaders/coverage64.wgsl?raw'
import coverageGlsl from './coverage64.glsl?raw'
import corpus from '../../../../../testing/fixtures/design/coverage-vectors.json'
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
export async function checkCoverage() {
  const rows = corpus.cases
  const input = new Uint32Array(rows.flatMap((r) => r.words))
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('Coverage64 probe requires a WebGPU adapter')
  const device = await adapter.requestDevice()
  const webgpu = await (async () => {
    try {
      const code = vectorWgsl.slice(0,vectorWgsl.indexOf('fn fixedLinear'))
      + vectorWgsl.slice(vectorWgsl.indexOf('fn scaledPositive64'),vectorWgsl.indexOf('fn paintUV'))
      + coverageWgsl + `
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}let base=id.x*16u;
 let x=cvWidth(inputs[base+9u],vec2<u32>(inputs[base+1u],inputs[base+2u]),vec2<u32>(inputs[base+3u],inputs[base+4u]));
 var value=cvScaled(x.xy,x.z+3u);
 if(inputs[base]!=0u){let y=cvWidth(inputs[base+10u],vec2<u32>(inputs[base+5u],inputs[base+6u]),vec2<u32>(inputs[base+7u],inputs[base+8u]));value=cvProduct(x,y);}
 outputs[id.x]=bitcast<u32>(value);
}`
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
  if (!gl) throw new Error('Coverage64 probe requires WebGL2')
  const webgl2 = (() => {
    try {
      const makeShader = (type: number, code: string) => {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(
            gl.getShaderInfoLog(shader) || 'Coverage64 shader compilation failed',
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
      const code = `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D inputs;
layout(location=0) out highp uvec4 result;
uint word(uint i){uint texel=i/4u;return texelFetch(inputs,ivec2(int(texel%256u),int(texel/256u)),0)[i%4u];}
` + vectorGlsl.slice(vectorGlsl.indexOf('uvec2 wideMultiply'),vectorGlsl.indexOf('float fixedLinear'))
  + vectorGlsl.slice(vectorGlsl.indexOf('float scaledPositive64'),vectorGlsl.indexOf('vec2 paintUV'))
  + coverageGlsl + `
void main(){uint index=uint(int(gl_FragCoord.y)*256+int(gl_FragCoord.x));if(index>=${rows.length}u){result=uvec4(0);return;}uint base=index*16u;
 uvec3 x=cvWidth(word(base+9u),uvec2(word(base+1u),word(base+2u)),uvec2(word(base+3u),word(base+4u)));
 float value=cvScaled(x.xy,x.z+3u);
 if(word(base)!=0u){uvec3 y=cvWidth(word(base+10u),uvec2(word(base+5u),word(base+6u)),uvec2(word(base+7u),word(base+8u)));value=cvProduct(x,y);}
 result=uvec4(floatBitsToUint(value),0u,0u,0u);}`
      gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, code))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'Coverage64 shader link failed')
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
        throw new Error('Coverage64 framebuffer incomplete')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(gl.getUniformLocation(program, 'inputs'), 0)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const readback = new Uint32Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, readback)
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw new Error(`Coverage64 GL error: ${error}`)
      return compare(readback.filter((_, i) => i % 4 === 0))
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })()
  return { webgpu, webgl2 }
}
