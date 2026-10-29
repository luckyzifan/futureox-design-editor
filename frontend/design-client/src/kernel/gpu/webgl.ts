import { textureByteLength } from './texture-byte-length'
import { validateLinearImageDimensions, writeLinearImageRows } from './linear-image-rows'
import vectorFragment from './vector.glsl?raw'
import { minifiedPreviewRgba8 } from './rgba8'
import sampling from './sampling.glsl?raw'
import { exactFilterGlsl, rationalStubGlsl } from './exact-filter'
import { compositorModes } from './compositor-modes'
import { areaShaderGlsl } from './area-shader'
import type { Driver, Texture, PathMesh, Rect, GpuScene } from './types'
import { parameters, previewUniforms, type PreviewPresentation } from './types'
import { MAX_SOLID_INSTANCES, SOLID_INSTANCE_FLOATS } from './solid-batch'
const byteSampling =
  'vec4 bsBilinear4(vec4 a,vec4 b,vec4 c,vec4 d,vec2 k,uint wordLimit,uint termCount){return mix(mix(a,b,k.x),mix(c,d,k.x),k.y);}' +
  'vec2 bsBilinearChannelAlpha(vec4 a,vec4 b,vec4 c,vec4 d,vec2 k,uint channel,uint wordLimit,uint termCount){vec4 value=bsBilinear4(a,b,c,d,k,wordLimit,termCount);return vec2(value[channel],value.w);}'
const solidVertex = `#version 300 es
precision highp float;precision highp int;layout(std140) uniform Params {vec4 u[64];};uniform highp sampler2D sourceInstances;flat out int solidItem;
vec4 item(int i){ivec2 size=textureSize(sourceInstances,0);return texelFetch(sourceInstances,ivec2(i%size.x,i/size.x),0);}
void main(){vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));solidItem=gl_InstanceID*5;vec4 r=item(solidItem+4);vec2 p=(r.xy+corners[gl_VertexID]*r.zw-u[0].xy)/u[0].zw;gl_Position=vec4(p*2.-1.,0.,1.);}`
const quad = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`
const mesh = `#version 300 es
precision highp float;layout(location=0) in vec2 point;layout(std140) uniform Params {vec4 u[64];};void main(){gl_Position=vec4((point-u[1].xy)/u[0].zw*2.-1.,0.,1.);}`
const white = `#version 300 es
precision highp float;out vec4 color;void main(){color=vec4(1);}`
export class WebGlDriver implements Driver {
  private softwareRaster = false
  readonly name = 'webgl2' as const
  readonly canvas = new OffscreenCanvas(1, 1)
  readonly description: string
  lost = false
  drawCalls = 0
  triangles = 0
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private presentProgram: WebGLProgram
  private compileMode?: (mode: number) => WebGLProgram
  private modePrograms = new Map<number, WebGLProgram>()
  private allowedModes = new Set<number>()
  private areaProgram?: WebGLProgram
  private filterProgram?: WebGLProgram
  private createFilter?: () => WebGLProgram
  readonly certifiedFilter: boolean
  private meshProgram: WebGLProgram
  private whiteProgram: WebGLProgram
  private solidProgram: WebGLProgram
  private solidTexture: WebGLTexture
  private lastSolid?: Float32Array
  private uniforms: WebGLBuffer
  private vertices: WebGLBuffer
  private curves: WebGLTexture
  private vao: WebGLVertexArrayObject
  private quadVao: WebGLVertexArrayObject
  private textures = new Set<Texture>()
  private replayParameterTextures = new Set<Texture>()
  private blank: Texture
  private msaa = new Map<
    string,
    {
      fb: WebGLFramebuffer
      color: WebGLRenderbuffer
      depth: WebGLRenderbuffer
      high: Texture
      low: Texture
    }
  >()
  private msaaBytes = 0
  private disposed = false
  readonly hdr = false
  constructor(
    readonly managed = false,
    readonly linearLight = managed,
    certified = true,
  ) {
    this.certifiedFilter = managed && certified && import.meta.env.VITE_DESIGN_CERTIFIED_FILTER !== '0'
    const fragment = vectorFragment.replace(
      'out vec4 color;',
      `const bool BYTE_SURFACE=${!managed};\n` +
        (managed
          ? sampling + '\n' + rationalStubGlsl
          : byteSampling + '\nvec4 rationalBlur(vec2 point,vec2 axis){return vec4(0);}') +
        '\nout vec4 color;',
    )
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      depth: false,
      stencil: false,
    })
    if (!gl) throw new Error('WebGL 2 不可用')
    this.gl = gl
    if (managed && !gl.getExtension('EXT_color_buffer_float'))
      throw new Error('WebGL2 缺少 EXT_color_buffer_float，不能渲染 HDR')
    this.description = String(gl.getParameter(gl.RENDERER))
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, source)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(s)
        gl.deleteShader(s)
        throw new Error(`GLSL 编译失败：${error}`)
      }
      return s
    }
    const program = (v: string, f: string) => {
      const p = gl.createProgram()!,
        vs = shader(gl.VERTEX_SHADER, v),
        fs = shader(gl.FRAGMENT_SHADER, f)
      gl.attachShader(p, vs)
      gl.attachShader(p, fs)
      gl.linkProgram(p)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p) || 'WebGL 链接失败')
      const block = gl.getUniformBlockIndex(p, 'Params')
      if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, block, 0)
      gl.useProgram(p)
      ;['sourceA', 'sourceB', 'sourceC', 'sourceCurves', 'sourceD', 'sourceInstances'].forEach(
        (name, i) => {
          const loc = gl.getUniformLocation(p, name)
          if (loc) gl.uniform1i(loc, i)
        },
      )
      return p
    }
    if (managed) {
      this.compileMode = (mode) => program(quad, fragment.replace('#version 300 es', `#version 300 es\n#define COMPOSITOR_MODE ${mode}`))
      this.program = this.compileMode(12)
      this.modePrograms.set(12, this.program)
      this.modePrograms.set(0, this.compileMode(0))
      this.presentProgram = this.compileMode(14)
    } else {
      this.program = this.presentProgram = program(quad, fragment)
      this.compileMode = mode => program(quad, fragment.replace(byteSampling, sampling)
        .replace('#version 300 es', `#version 300 es\n#define COMPOSITOR_MODE ${mode}`))
    }
    if (managed) this.createFilter = () => program(quad, exactFilterGlsl(this.certifiedFilter))
    this.areaProgram = program(quad, areaShaderGlsl)
    this.meshProgram = program(mesh, white)
    this.whiteProgram = program(quad, white)
    this.solidProgram = program(
      solidVertex,
      fragment.replace('#version 300 es', '#version 300 es\n#define SOLID_BATCH'),
    )
    this.solidTexture = gl.createTexture()!
    this.uniforms = gl.createBuffer()!
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniforms)
    gl.bufferData(gl.UNIFORM_BUFFER, 1024, gl.DYNAMIC_DRAW)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.uniforms)
    this.curves = gl.createTexture()!
    this.vertices = gl.createBuffer()!
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    this.quadVao = gl.createVertexArray()!
    this.blank = this.create(1, 1)
    this.clear(this.blank)
    gl.disable(gl.DITHER)
  }
  async prepareScene(scene: GpuScene) {
    this.softwareRaster = !!scene.softwareRaster && !this.managed
    const modes = this.managed ? compositorModes(scene) : new Set([...compositorModes(scene)].filter(mode => mode === 61 || mode === 62))
    if (Object.keys(scene.nodes).length) modes.add(3)
    this.allowedModes = modes
  }
  private compositorProgram(mode: number) {
    let program = this.modePrograms.get(mode)
    if (!program && this.allowedModes.has(mode)) {
      // WebGL compilation is synchronous. Compile only a dispatch mode that
      // this frame actually submits, then retain its identical shader program.
      program = this.compileMode!(mode)
      this.modePrograms.set(mode, program)
    }
    if (!program) throw new Error(`Exact compositor pipeline ${mode} not prepared`)
    return program
  }
  async prepareFilters() {
    this.filterProgram ??= this.createFilter?.()
  }
  begin(vertices: Float32Array, curves = new Float32Array(0)) {
    this.lastSolid = undefined
    this.releaseMsaa()
    if (this.disposed || this.lost) throw new Error('WebGL 上下文已丢失')
    const gl = this.gl
    this.drawCalls = 0
    this.triangles = 0
    const texels = Math.max(1, Math.ceil(curves.length / 4)),
      width = Math.min(1024, texels),
      height = Math.ceil(texels / width),
      data = new Float32Array(width * height * 4)
    data.set(curves)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.curves)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
  }
  create(width: number, height: number): Texture {
    const gl = this.gl
    if (
      width < 1 ||
      height < 1 ||
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE)
    )
      throw new Error('WebGL 纹理尺寸不受支持')
    const bytes = textureByteLength(width, height, this.managed ? 16 : 4)
    const resource = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, resource)
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.managed ? gl.RGBA32F : gl.RGBA8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('WebGL 离屏缓冲创建失败')
    const t = {
      width,
      height,
      resource,
      framebuffer,
      bytes,
    }
    this.textures.add(t)
    return t
  }
  destroy(t: Texture) {
    this.replayParameterTextures.delete(t)
    if (!this.textures.delete(t)) return
    if (t.framebuffer) this.gl.deleteFramebuffer(t.framebuffer)
    this.gl.deleteTexture(t.resource as WebGLTexture)
  }
  upload(bitmap: ImageBitmap) {
    const t = this.create(bitmap.width, bitmap.height)
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.resource as WebGLTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    return t
  }
  uploadLinearRows(width:number,height:number,rows:import('../image-row-source').LinearImageRows){
    if(!this.managed)throw Error('PNG float rows require managed textures')
    validateLinearImageDimensions(width,height)
    const texture=this.create(width,height)
    try{
      writeLinearImageRows(width,height,rows,(y,h,values)=>this.uploadAtlasLinear(texture,0,y,width,h,values))
      return texture
    }catch(error){this.destroy(texture);throw error}
  }
  uploadLinear(values: Float32Array, width: number, height: number) {
    if (!this.managed || values.length !== width * height * 4) throw new Error('无效的浮点纹理')
    const t = this.create(width, height),
      gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.resource as WebGLTexture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, values)
    return t
  }
  uploadParameters(values: Float32Array, width: number, height: number) {
    const gl = this.gl
    if (
      width < 1 ||
      height < 1 ||
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      values.length !== width * height * 4 ||
      values.some((v) => !Number.isFinite(v))
    )
      throw new Error('无效的材质参数纹理')
    // Metadata is sampled only: no float framebuffer extension is needed.
    const resource = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, resource)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, values)
    const t = { width, height, resource, bytes: width * height * 16 }
    this.textures.add(t)
    return t
  }
  uploadReplayParameters(values: Float32Array, width: number, height: number, target?: Texture) {
    const gl = this.gl
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024 ||
      values.length !== width * height * 4 ||
      values.some((v) => !Number.isFinite(v))
    )
      throw new Error('无效的纹理重放参数')
    if (target) {
      if (!this.textures.has(target) || !this.replayParameterTextures.has(target))
        throw new Error('无效的纹理重放参数缓冲区')
      // GL commands and the following sub-image update are ordered. Keep the
      // one allocation alive instead of allocating a new field for each tile.
      gl.flush()
    } else {
      if (1024 > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('纹理参数尺寸超限')
      const resource = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, resource)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1024, 1024)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      target = { width: 1024, height: 1024, resource, bytes: 1024 * 1024 * 16 }
      this.textures.add(target)
      this.replayParameterTextures.add(target)
    }
    gl.bindTexture(gl.TEXTURE_2D, target.resource as WebGLTexture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, values)
    return target
  }
  uploadRgba8(bytes: Uint8Array, width: number, height: number) {
    if (this.managed)
      return this.uploadLinear(
        Float32Array.from(bytes, (v) => v / 255),
        width,
        height,
      )
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理')
    const t = this.create(width, height),
      gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.resource as WebGLTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    return t
  }
  uploadAtlasLinear(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    values: Float32Array,
  ) {
    if (values.length !== width * height * 4) throw new Error('无效的浮点纹理写入')
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture.resource as WebGLTexture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.FLOAT, values)
  }
  uploadAtlasRgba8(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ) {
    if (this.managed) {
      this.uploadAtlasLinear(
        texture,
        x,
        y,
        width,
        height,
        Float32Array.from(bytes, (v) => v / 255),
      )
      return
    }
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理写入')
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture.resource as WebGLTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
  }
  clear(t: Texture) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer!)
    gl.colorMask(true, true, true, true)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  private set(u: Float32Array) {
    u[240] = this.managed ? 1 : 0
    u[253] = this.softwareRaster ? 1 : 0
    u[254] = 9
    u[255] = 19 // Exact sampler limb count; keep compiler loops bounded.
    const gl = this.gl
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniforms)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u)
  }
  private releaseMsaa() {
    for (const { fb, color, depth, high, low } of this.msaa.values()) {
      this.gl.deleteFramebuffer(fb)
      this.gl.deleteRenderbuffer(color)
      this.gl.deleteRenderbuffer(depth)
      this.destroy(high)
      this.destroy(low)
    }
    this.msaa.clear()
    this.msaaBytes = 0
  }
  private maskBuffer(width: number, height: number, density = 2) {
    const gl = this.gl,
      key = `${density}:${width}:${height}`,
      existing = this.msaa.get(key)
    if (existing) return existing
    const required = width * height * 4 * (density * density * 9 + 1)
    if (this.msaaBytes + required > 64 * 1024 * 1024) this.releaseMsaa()
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES))
    if (samples < 4) throw new Error('WebGL 2 需要 4x MSAA 支持 16 样本覆盖')
    const high = this.create(width * density, height * density),
      low = this.create(width, height),
      fb = gl.createFramebuffer()!,
      color = gl.createRenderbuffer()!,
      depth = gl.createRenderbuffer()!
    const buffer = { fb, color, depth, high, low }
    this.msaa.set(key, buffer)
    this.msaaBytes += required
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.bindRenderbuffer(gl.RENDERBUFFER, color)
    gl.renderbufferStorageMultisample(
      gl.RENDERBUFFER,
      samples,
      this.managed ? gl.RGBA32F : gl.RGBA8,
      width * density,
      height * density,
    )
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorageMultisample(
      gl.RENDERBUFFER,
      samples,
      gl.DEPTH24_STENCIL8,
      width * density,
      height * density,
    )
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('WebGL MSAA 缓冲不完整')
    return buffer
  }
  mask(path: PathMesh, target: Texture, sampleIndex?: number) {
    if (path.area) {
      if (!this.areaProgram) throw new Error('Coverage program unavailable')
      const u = parameters(path.rect)
      u[16] = 31
      u[36] = path.area.first
      u[38] = sampleIndex === undefined ? 0 : sampleIndex + 1
      this.pass(target, u, [])
      this.triangles++
      return
    }
    if (path.analytic) {
      const u = parameters(path.rect)
      u[16] = 20
      u.set(
        [
          path.analytic.first,
          path.analytic.count,
          path.rule === 'evenodd' ? 1 : 0,
          sampleIndex === undefined ? 0 : sampleIndex + 1,
        ],
        36,
      )
      if (path.analytic.bands !== undefined)
        u.set([path.analytic.bands, Math.ceil(path.rect.h / 16), 0, 0], 40)
      this.pass(target, u, [])
      this.triangles++
      return
    }

    if (path.analyticRect) {
      const u = parameters(path.rect),
        b = path.analyticRect
      u[16] = 17
      u.set([b[0] - path.rect.x, b[1] - path.rect.y, b[2] - path.rect.x, b[3] - path.rect.y], 36)
      this.pass(target, u, [])
      this.triangles++
      return
    }
    const gl = this.gl
    const density = path.sampleCount === 4 ? 1 : 2
    try {
      for (let y = 0; y < target.height; y += 512)
        for (let x = 0; x < target.width; x += 512) {
          const w = Math.min(512, target.width - x),
            h = Math.min(512, target.height - y),
            { fb, high, low } = this.maskBuffer(w, h, density),
            u = parameters({ x: 0, y: 0, w, h })
          u.set([x, y], 4)
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
          gl.viewport(0, 0, w * density, h * density)
          gl.stencilMask(255)
          gl.colorMask(true, true, true, true)
          gl.clearColor(0, 0, 0, 0)
          gl.clearStencil(0)
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
          gl.enable(gl.STENCIL_TEST)
          gl.colorMask(false, false, false, false)
          this.set(u)
          gl.useProgram(this.meshProgram)
          gl.bindVertexArray(this.vao)
          if (path.rule === 'union') {
            gl.stencilFunc(gl.ALWAYS, 1, 255)
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
          } else if (path.rule === 'evenodd') {
            gl.stencilMask(1)
            gl.stencilFunc(gl.ALWAYS, 0, 1)
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT)
          } else {
            gl.stencilFunc(gl.ALWAYS, 0, 255)
            gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP)
            gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP)
          }
          gl.drawArrays(gl.TRIANGLES, path.first, path.count)
          this.drawCalls++
          this.triangles += path.count / 3
          gl.colorMask(true, true, true, true)
          gl.stencilMask(0)
          gl.stencilFunc(gl.NOTEQUAL, 0, path.rule === 'evenodd' ? 1 : 255)
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
          gl.useProgram(this.whiteProgram)
          gl.bindVertexArray(this.quadVao)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          this.drawCalls++
          gl.disable(gl.STENCIL_TEST)
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb)
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, high.framebuffer!)
          gl.blitFramebuffer(
            0,
            0,
            w * density,
            h * density,
            0,
            0,
            w * density,
            h * density,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
          )
          const down = parameters(
            { x: 0, y: 0, w, h },
            { x: 0, y: 0, w: w * density, h: h * density },
          )
          down[16] = density === 2 ? 19 : 0
          const single = target.width <= 512 && target.height <= 512
          this.pass(single ? target : low, down, [high])
          if (!single) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, low.framebuffer!)
            gl.bindTexture(gl.TEXTURE_2D, target.resource as WebGLTexture)
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x, y, 0, 0, w, h)
          }
        }
    } finally {
      gl.colorMask(true, true, true, true)
      gl.disable(gl.STENCIL_TEST)
    }
  }
  pass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect, channels = 15) {
    const gl = this.gl
    if (inputs.includes(target)) throw new Error('GPU texture feedback loop')
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer!)
    gl.viewport(0, 0, target.width, target.height)
    const program = u[16] === 31 ? this.areaProgram : this.managed && u[16] === 22 ? this.filterProgram : (this.managed || u[16] === 61 || u[16] === 62) ? this.compositorProgram(u[16]) : this.program
    if (!program) throw new Error(`Exact compositor pipeline ${u[16]} not prepared`)
    gl.useProgram(program)
    gl.bindVertexArray(this.quadVao)
    this.set(u)
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + (i === 3 ? 4 : i))
      gl.bindTexture(gl.TEXTURE_2D, (inputs[i] || this.blank).resource as WebGLTexture)
    }
    if (region) {
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(region.x, region.y, region.w, region.h)
    }
    try {
      if (this.managed && u[16] === 22) {
        const channelLocation = gl.getUniformLocation(this.filterProgram!, 'filterChannel')
        let draws = 0
        for (let channel = 0; channel < 4; channel++) {
          if (!(channels & (1 << channel))) continue
          gl.colorMask(channel === 0, channel === 1, channel === 2, channel === 3)
          gl.uniform1i(channelLocation, channel)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          draws++
        }
        gl.colorMask(true, true, true, true)
        this.drawCalls += draws - 1
      } else gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === '1' && this.managed) {
        const values = new Float32Array(target.width * target.height * 4)
        gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, values)
        let lo = Infinity,
          hi = -Infinity,
          nonfinite = 0
        for (let i = 3; i < values.length; i += 4) {
          lo = Math.min(lo, values[i])
          hi = Math.max(hi, values[i])
          if (!Number.isFinite(values[i])) nonfinite++
        }
        console.debug(
          'DESIGN_PASS',
          JSON.stringify({
            pass: this.drawCalls,
            mode: u[16],
            size: [target.width, target.height],
            first: Array.from(values.slice(0, 4)),
            alpha: [lo, hi],
            nonfinite,
          }),
        )
      }
    } finally {
      gl.colorMask(true, true, true, true)
      if (region) gl.disable(gl.SCISSOR_TEST)
    }
    this.drawCalls++
  }
  over(target: Texture, u: Float32Array, inputs: Texture[], region: Rect) {
    if (this.managed) throw new Error('RGBA32F 合成必须使用显式着色器混合')
    const gl = this.gl
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(region.x, region.y, region.w, region.h)
    try {
      this.pass(target, u, inputs)
    } finally {
      gl.disable(gl.BLEND)
      gl.disable(gl.SCISSOR_TEST)
    }
  }
  // GL uploads each batch independently; its existing bound is per call.
  solidBatchRemaining() { return MAX_SOLID_INSTANCES }
  solidBatch(target: Texture, u: Float32Array, data: Float32Array, clip?: Texture) {
    if (clip === target) throw new Error('GPU texture feedback loop')
    if (data.length > MAX_SOLID_INSTANCES * SOLID_INSTANCE_FLOATS)
      throw new Error('GPU solid instance budget exceeded')
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_2D, this.solidTexture)
    if (this.lastSolid !== data) {
      const width = Math.min(256, data.length / 4),
        height = Math.ceil(data.length / 4 / width),
        padded = new Float32Array(width * height * 4)
      padded.set(data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padded)
      this.lastSolid = data
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, (clip || this.blank).resource as WebGLTexture)
    // Other samplers are part of the common layout; keep their bindings valid.
    for (const unit of [0, 1, 4]) {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, this.blank.resource as WebGLTexture)
    }
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.curves)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer!)
    gl.viewport(0, 0, target.width, target.height)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.useProgram(this.solidProgram)
    gl.bindVertexArray(this.quadVao)
    this.set(u)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, data.length / SOLID_INSTANCE_FLOATS)
    this.drawCalls++
    this.triangles += (data.length / SOLID_INSTANCE_FLOATS) * 2
  }
  async readSurface(source: Texture): Promise<Float32Array> {
    const gl=this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER,source.framebuffer!)
    const count=source.width*source.height*4
    const floating=source.bytes===count*4
    const values=floating?new Float32Array(count):new Uint8Array(count)
    gl.readPixels(0,0,source.width,source.height,gl.RGBA,floating?gl.FLOAT:gl.UNSIGNED_BYTE,values)
    const error=gl.getError();if(error!==gl.NO_ERROR)throw Error(`读取精确效果表面失败 0x${error.toString(16)}`)
    return values instanceof Float32Array?values:Float32Array.from(values,v=>v/255)
  }
  async checkpoint() {
    this.gl.finish()
    if (this.lost) throw new Error('GPU 设备已丢失')
  }
  async finish(
    source: Texture,
    r: Rect,
    width: number,
    height: number,
    readback: boolean,
    preview?: PreviewPresentation,
    present = true,
    outputRect?: Rect,
  ) {
    const gl = this.gl
    const bytePreview = !!preview && this.managed && !this.linearLight
    let rgba: Uint8Array | undefined,
      linear: Float32Array | undefined,
      straightRgba: Uint8Array | undefined
    if (readback) {
      const t = this.create(width, height)
      const u = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
      previewUniforms(u, preview)
      if (bytePreview) u[16] = 33
      this.pass(t, u, [source])
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer!)
      if (this.managed) {
        linear = new Float32Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, linear)
        if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'final')
          console.debug(
            'DESIGN_PASS',
            JSON.stringify({ readback: true, first: Array.from(linear.slice(0, 8)) }),
          )
      } else {
        rgba = new Uint8Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
      }
      this.destroy(t)
    }
    if (present) {
    this.canvas.width = width
    this.canvas.height = height
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.bindVertexArray(this.quadVao)
    const u = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
    u[16] = 14
    u[242] = this.linearLight ? 1 : 0
    u[244] = this.managed && !this.linearLight ? 1 : 0
    previewUniforms(u, preview, true)
    if (bytePreview) u[16] = 33
    const presentProgram = this.managed && preview ? this.compositorProgram(u[16]) : this.presentProgram
    if (!presentProgram) throw new Error('Exact presentation pipeline not prepared')
    gl.useProgram(presentProgram)
    this.set(u)
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + (i === 3 ? 4 : i))
      gl.bindTexture(gl.TEXTURE_2D, (i === 0 ? source : this.blank).resource as WebGLTexture)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.drawCalls++
    }
    gl.flush()
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`WebGL 渲染错误 0x${error.toString(16)}`)
    if (bytePreview && linear) {
      straightRgba = Uint8Array.from(linear, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255))
      linear = undefined
    }
    if (rgba && preview && preview.scale < 1) {
      straightRgba = minifiedPreviewRgba8(rgba)
      rgba = undefined
    }
    return { bitmap: present ? this.canvas.transferToImageBitmap() : undefined, rgba, linear, straightRgba }
  }
  async loseDeviceForTesting() {
    if (!import.meta.env.DEV) throw new Error('Development check only')
    const extension = this.gl.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('Context loss extension unavailable')
    await new Promise<void>((resolve) => {
      this.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true })
      extension.loseContext()
    })
    if (!this.lost) throw new Error('WebGL context loss was not observed')
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.releaseMsaa()
    for (const t of [...this.textures]) this.destroy(t)
    const gl = this.gl
    for (const program of new Set([this.program, this.presentProgram, ...this.modePrograms.values()])) gl.deleteProgram(program)
    if (this.areaProgram) gl.deleteProgram(this.areaProgram)
    if (this.filterProgram) gl.deleteProgram(this.filterProgram)
    gl.deleteProgram(this.meshProgram)
    gl.deleteProgram(this.whiteProgram)
    gl.deleteProgram(this.solidProgram)
    gl.deleteTexture(this.solidTexture)
    gl.deleteTexture(this.curves)
    gl.deleteBuffer(this.vertices)
    gl.deleteBuffer(this.uniforms)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.quadVao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
