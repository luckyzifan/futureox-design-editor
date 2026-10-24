import type { CanvasCamera } from '../../canvas-camera'
import { presentationQuality } from './presentation-quality'
import { compositeDrawPlan, compositeRasterQuad } from './composite-draw-plan'
import type { RasterTile } from '../tile-cache'
import { physicalPixelCoverage } from './physical-coverage'

export type CompositeTile = RasterTile & { serial: number; bytes: Uint8Array; bitmap?: ImageBitmap; gpuTile?: number }
export type TilePlacement = { left: number; top: number; width: number; height: number }
export type CompositeItem = { tile: CompositeTile; active: boolean; layer: number; placement?: TilePlacement; clip?: TilePlacement; gutter?: number; blend?: boolean }

const vertex = `#version 300 es
precision highp float;
uniform vec4 box; uniform vec4 uvBox; uniform vec2 viewport;
out vec2 uv;
void main(){
  vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  vec2 p=corners[gl_VertexID]; uv=uvBox.xy+p*uvBox.zw;
  vec2 screen=(box.xy+p*box.zw)/viewport;
  gl_Position=vec4(screen.x*2.-1.,1.-screen.y*2.,0.,1.);
}`
const fragment = `#version 300 es
precision highp float; uniform sampler2D pixels; in vec2 uv; out vec4 color;
void main(){color=texture(pixels,uv);}`

/** Persistent display textures, independent from raster work and React tiles.
 * ImageBitmap transport crosses the raster/display device boundary once per
 * new tile; camera frames only sample resident textures. No pixel readback.
 * SDR compositor; HDR keeps its existing managed presenter contract. */
export class TileCompositor {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly box: WebGLUniformLocation
  private readonly uvBox: WebGLUniformLocation
  private readonly viewport: WebGLUniformLocation
  private textures = new Map<number, { texture: WebGLTexture; bytes: number }>()
  private disposed = false
  bytes = 0
  uploads = 0
  frames = 0

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true,
      antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('无法创建 GPU 画布合成器')
    this.gl = gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('无法创建画布合成着色器')
      gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(String(error))
      }
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment)
    const program = gl.createProgram()!
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    gl.deleteShader(vs); gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program); gl.deleteProgram(program); throw new Error(String(message))
    }
    this.program = program
    this.vao = gl.createVertexArray()!
    this.box = gl.getUniformLocation(program, 'box')!
    this.uvBox = gl.getUniformLocation(program, 'uvBox')!
    this.viewport = gl.getUniformLocation(program, 'viewport')!
    gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'pixels'), 0)
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND)
  }

  has(tile: CompositeTile) { return this.textures.has(tile.serial) }

  upload(tile: CompositeTile) {
    if (this.disposed || this.gl.isContextLost()) throw new Error('画布合成设备已丢失')
    if (this.has(tile)) return
    if (!tile.bitmap && tile.bytes.byteLength !== tile.width * tile.height * 4)
      throw new Error('缺少显示瓦片像素')
    const gl = this.gl, texture = gl.createTexture()
    if (!texture) throw new Error('无法分配显示瓦片')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    if (tile.bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.bitmap)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tile.width, tile.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, tile.bytes)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error(`显示瓦片上传失败 (${error})`) }
    const bytes = tile.width * tile.height * 4
    this.textures.set(tile.serial, { texture, bytes }); this.bytes += bytes; this.uploads++
  }

  retain(serials: Set<number>) {
    for (const [serial, entry] of this.textures) if (!serials.has(serial)) {
      this.gl.deleteTexture(entry.texture); this.bytes -= entry.bytes; this.textures.delete(serial)
    }
  }

  draw(items: readonly CompositeItem[], view: CanvasCamera, width: number, height: number, dpr: number, allowEmpty = false) {
    const gl = this.gl
    if (this.disposed || gl.isContextLost()) throw new Error('画布合成设备已丢失')
    const w = Math.max(1, Math.ceil(width * dpr)), h = Math.max(1, Math.ceil(height * dpr))
    if (w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || h > gl.getParameter(gl.MAX_TEXTURE_SIZE))
      throw new Error('画布合成尺寸超限')
    const available = items.filter(item => this.textures.has(item.tile.serial))
    const rows = compositeDrawPlan(available, view, width, height).flatMap(planned => {
      const entry = this.textures.get(planned.item.tile.serial)
      if (!planned.item.active || !entry) return []
      const raster = compositeRasterQuad(planned.placement, planned.clip, width, height, dpr)
      return raster ? [{ item: planned.item, entry, raster }] : []
    })
    if (!allowEmpty && !physicalPixelCoverage(rows.map(row => ({ ...row.raster, blend: row.item.blend })), w, h)) {
      this.canvas.dataset.coverageDeferred = 'true'
      return false
    }
    this.canvas.dataset.coverageDeferred = 'false'
    // Admission precedes any backing-store change, including resize clears.
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    gl.viewport(0, 0, w, h); gl.useProgram(this.program); gl.bindVertexArray(this.vao)
    gl.uniform2f(this.viewport, width, height)
    gl.disable(gl.SCISSOR_TEST);gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    for (const { item, entry, raster } of rows) {
      const { blend = false } = item
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.enable(gl.SCISSOR_TEST);gl.scissor(raster.x,h-raster.y-raster.height,raster.width,raster.height)
      if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) }
      else gl.disable(gl.BLEND)
      gl.uniform4f(this.box, ...raster.box)
      gl.uniform4f(this.uvBox, ...raster.uv)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.disable(gl.SCISSOR_TEST)
    gl.flush(); this.frames++
    this.canvas.dataset.compositorFrames = String(this.frames)
    this.canvas.dataset.compositorUploads = String(this.uploads)
    this.canvas.dataset.compositorBytes = String(this.bytes)
    this.canvas.dataset.compositorTiles = String(this.textures.size)
    if (import.meta.env.DEV) {
      const quality = presentationQuality(available, view, width, height, dpr)
      this.canvas.dataset.coverage = String(quality.coverage)
      this.canvas.dataset.sharpCoverage = String(quality.sharpCoverage)
      this.canvas.dataset.nativePhaseCoverage = String(quality.nativePhaseCoverage)
      this.canvas.dataset.maxUpscale = quality.maxUpscale.toFixed(3)
    }
    return true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true; this.retain(new Set())
    this.gl.deleteVertexArray(this.vao); this.gl.deleteProgram(this.program)
    // React refresh/strict-effect replay may reuse this very same canvas.
    // Only retire the browser context after its DOM owner has really gone.
    queueMicrotask(() => {
      if (!this.canvas.isConnected) this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    })
  }
}
