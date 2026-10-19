// Test harness: execute the production helpers, not a copied shader model.
import wgsl from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import glsl from './vector.glsl?raw'
import corpus from '../../../../../testing/fixtures/design/arithmetic-vectors.json'

type Failure = { index: number; input: number[]; actual: number }
function compare(values: Uint32Array) {
  const failures: Failure[] = []
  if (values.length < corpus.vectors.length) throw new Error('Incomplete arithmetic readback')
  for (const [index, input] of corpus.vectors.entries())
    if (values[index] !== input[4]) failures.push({ index, input, actual: values[index] })
  return {
    checks: corpus.vectors.length,
    failures: failures.length,
    examples: failures.slice(0, 16),
  }
}
function helpers(source: string, fixed: string, scaled: string, end: string) {
  return (
    source.slice(0, source.indexOf(fixed)) +
    source.slice(source.indexOf(scaled), source.indexOf(end))
  )
}

export async function checkArithmetic() {
  const rows = corpus.vectors
  const input = new Uint32Array(rows.flatMap((r) => r.slice(0, 4)))
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('Arithmetic probe requires a WebGPU adapter')
  const device = await adapter.requestDevice()
  const webgpu = await (async () => {
    try {
      const code =
        helpers(wgsl, 'fn fixedLinear', 'fn scaledPositive64', 'fn paintUV') +
        wgsl.slice(wgsl.indexOf('fn tentWeight'), wgsl.indexOf('fn blurAt')) +
        wgsl.slice(wgsl.indexOf('fn matPower5'), wgsl.indexOf('fn materialSample')) +
        `
@group(0) @binding(0) var<storage,read> inputs:array<vec4<u32>>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&inputs)){return;}let v=inputs[id.x];var result=0.;
 if(v.x==0u){result=divideRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==1u){result=colourMix(f32(v.y),f32(v.z),bitcast<f32>(v.w));}
 else if(v.x==2u){result=scaledPositive64(v.yz,v.w);}
 else if(v.x==3u){result=addRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==4u){result=mulRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==5u){result=sqrtRN(bitcast<f32>(v.y));}
 else if(v.x==7u){result=materialRoot5(bitcast<f32>(v.y));}
 else if(v.x==8u){result=positiveFmaRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else if(v.x==9u){result=constantColorBlendRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else if(v.x==10u){result=fmaRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else{result=tentWeight(bitcast<f32>(v.y),f32(v.z));}outputs[id.x]=bitcast<u32>(result);
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
  if (!gl) throw new Error('Arithmetic probe requires WebGL2')
  const webgl2 = (() => {
    try {
      const makeShader = (type: number, code: string) => {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'Arithmetic shader compilation failed')
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
      const source = glsl.slice(glsl.indexOf('uvec2 wideMultiply'))
      const code =
        `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D inputs;
layout(location=0) out highp uvec4 result;
` +
        helpers(source, 'float fixedLinear', 'float scaledPositive64', 'vec2 paintUV') +
        glsl.slice(glsl.indexOf('float tentWeight'), glsl.indexOf('vec4 blurAt')) +
        'uint materialSelect(uint a,uint b,bool s){return s?b:a;}' +
        glsl.slice(glsl.indexOf('uvec4 matPower5'), glsl.indexOf('vec4 materialSample')) +
        `
void main(){uvec4 v=texelFetch(inputs,ivec2(gl_FragCoord.xy),0);float value;
 if(v.x==0u)value=divideRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z));
 else if(v.x==1u)value=colourMix(float(v.y),float(v.z),uintBitsToFloat(v.w));
 else if(v.x==2u)value=scaledPositive64(v.yz,v.w);
 else if(v.x==3u)value=addRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z));
 else if(v.x==4u)value=mulRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z));
 else if(v.x==5u)value=sqrtRN(uintBitsToFloat(v.y));
 else if(v.x==7u)value=materialRoot5(uintBitsToFloat(v.y));
 else if(v.x==8u)value=positiveFmaRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z),uintBitsToFloat(v.w));
 else if(v.x==9u)value=constantColorBlendRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z),uintBitsToFloat(v.w));
 else if(v.x==10u)value=fmaRN(uintBitsToFloat(v.y),uintBitsToFloat(v.z),uintBitsToFloat(v.w));
 else value=tentWeight(uintBitsToFloat(v.y),float(v.z));result=uvec4(floatBitsToUint(value),0,0,0);}`
      gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, code))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'Arithmetic shader link failed')
      gl.useProgram(program)
      gl.bindVertexArray(gl.createVertexArray())
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      const data = new Uint32Array(canvas.width * canvas.height * 4)
      data.set(input)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        canvas.width,
        canvas.height,
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
        throw new Error('Arithmetic framebuffer incomplete')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(gl.getUniformLocation(program, 'inputs'), 0)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data)
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw new Error(`Arithmetic GL error: ${error}`)
      return compare(data.filter((_, i) => i % 4 === 0))
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })()
  return { webgpu, webgl2 }
}
