// Test harness: execute the production helpers, not a copied shader model.
import wgsl from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import glsl from './sampling.glsl?raw'
import corpus from '../../../../../testing/fixtures/design/sampling-vectors.json'
import boundedCorpus from '../../../../../testing/fixtures/design/bounded-sampling-vectors.json'

type Failure = { index: number; input: number[]; actual: number; path?: string }
function compare(values: Uint32Array, rows: number[][], stride: number) {
  const failures: Failure[] = []
  let accepted = 0, declined = 0
  if (values.length < rows.length * stride) throw new Error('Incomplete sampling readback')
  for (const [index, input] of rows.entries()) {
    const actual = values[index * stride], bounded = values[index * stride + 1], flag = values[index * stride + 2]
    if (actual !== input[6]) failures.push({ index, input, actual })
    if (flag === 1) accepted++; else declined++
    if (flag > 1 || (flag === 1 && bounded !== input[6])) failures.push({ index, input, actual: bounded, path: 'bounded bits' })
    if (input.length > 7 && flag !== input[7]) failures.push({ index, input, actual: flag, path: 'bounded domain' })
  }
  return {
    checks: rows.length,
    boundedAccepted: accepted,
    boundedDeclined: declined,
    failures: failures.length,
    examples: failures.slice(0, 16),
  }
}
export async function checkSampling() {
  const rows = [...corpus.vectors, ...boundedCorpus.vectors,
    [0x80000000, 0, 0, 0, 0, 0, 0],
    [0x3f800000, 0x7fc01234, 0x7fc05678, 0, 0, 0, 0x7fc01234],
    [0xff800000, 0x7fc01234, 0, 0, 0, 0, 0xff800000],
  ]
  const input = new Uint32Array(rows.flatMap((r) => [...r.slice(0, 6), 0, 0]))
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('Sampling probe requires a WebGPU adapter')
  const device = await adapter.requestDevice()
  const webgpu = await (async () => {
    try {
      const code =
        wgsl +
        `
@group(0) @binding(0) var<storage,read> inputs:array<vec4<u32>>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)/3u){return;}let a=inputs[id.x*2u];let b=inputs[id.x*2u+1u];
 let p=bitcast<vec4<f32>>(a);let k=bitcast<vec2<f32>>(b.xy);
 outputs[id.x*3u]=bitcast<u32>(bsBilinear4(vec4<f32>(p.x),vec4<f32>(p.y),vec4<f32>(p.z),vec4<f32>(p.w),k,19u,9u).x);
 let bounded=bsBounded(p,k.x,k.y);outputs[id.x*3u+1u]=bounded.x;outputs[id.x*3u+2u]=bounded.y;
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
      const size = rows.length * 12
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
      const result = compare(new Uint32Array(readback.getMappedRange()), rows, 3)
      readback.unmap()
      return result
    } finally {
      device.destroy()
    }
  })()
  const canvas = new OffscreenCanvas(256, Math.ceil(rows.length / 256))
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('Sampling probe requires WebGL2')
  const webgl2 = (() => {
    try {
      const makeShader = (type: number, code: string) => {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'Sampling shader compilation failed')
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
` +
        glsl +
        `
void main(){int index=(int(gl_FragCoord.y)*256+int(gl_FragCoord.x))*2;
 uvec4 a=texelFetch(inputs,ivec2(index%256,index/256),0),b=texelFetch(inputs,ivec2((index+1)%256,(index+1)/256),0);
 vec4 p=uintBitsToFloat(a);vec2 k=uintBitsToFloat(b.xy);float value=bsBilinear4(vec4(p.x),vec4(p.y),vec4(p.z),vec4(p.w),k,19u,9u).x;
 uvec2 bounded=bsBounded(p,k.x,k.y);result=uvec4(floatBitsToUint(value),bounded,0u);}`
      gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, code))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'Sampling shader link failed')
      gl.useProgram(program)
      gl.bindVertexArray(gl.createVertexArray())
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      const data = new Uint32Array(canvas.width * canvas.height * 8)
      data.set(input)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        canvas.width,
        canvas.height * 2,
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
        throw new Error('Sampling framebuffer incomplete')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(gl.getUniformLocation(program, 'inputs'), 0)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data)
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw new Error(`Sampling GL error: ${error}`)
      return compare(data, rows, 4)
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })()
  return { webgpu, webgl2 }
}
