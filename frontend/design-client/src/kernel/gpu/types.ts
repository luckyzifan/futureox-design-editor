import type { Paint, Effect, Matrix } from '../../model'
import type { ColorSettings } from '../../color'
export type BackendPreference = 'auto' | 'webgpu' | 'webgl2' | 'cpu'
export type GpuPassTiming = { mode: number; radius: number; width: number; height: number; count: number; ms: number; blend?: number; paint?: number; integerCentres?: boolean }
export type Rect = { x: number; y: number; w: number; h: number }
export type GlassCaptureReplay = {
  parentMatrix: Matrix
  parentWorldTransform: Matrix
  cameraMatrix: Matrix
  parentSize: [number, number]
  lensRect: Rect
  lensBounds: [number, number, number, number]
  primitives: {
    transform: Matrix
    size: [number, number]
    color: [number, number, number, number]
  }[]
  effectiveFrost: number
  support: number
  side: 512 | 1024
}
export type GlassCaptureTile = {
  region: Rect
  filter: {
    downRect: Rect
    blurRect: Rect
    origin: [number, number]
    gradient: [number, number]
    sourceOrigin: [number, number]
  }
  plan: {
    side: 512 | 1024
    origin: [number, number]
    density: number
    kernelCount: number
    bounds: [number, number, number, number]
    primitives: { rect: Rect; color: [number, number, number, number] }[]
  }
}
export type TextureReplay = {
  parentMatrix: Matrix
  parentWorldTransform: Matrix
  cameraMatrix: Matrix
  parentSize: [number, number]
  nodeTransform: Matrix
  nodeSize: [number, number]
  paint: Paint
  radius: number
  noiseSize: [number, number]
  clipped: boolean
}
export type TextureSourcePlan = {
  side: number
  coverage: Rect
  quad: { pixels: [number, number, number, number]; coverage: Rect }
  paint: Paint
  direction: number
}
export type TextureReplayPlan = {
  origin: [number, number]
  capture: {
    clipped: boolean
    capturePixels: number
    originalPixels: number | null
    scale: number
    nodeToTile: [number, number, number, number, number, number]
    effectRect: [number, number, number, number]
    useExpandedOnly: boolean
  }
  expanded: TextureSourcePlan
  original: TextureSourcePlan | null
  copybackRegion: Rect
}
export type TextureReplayTile = {
  origin: [number, number]
  region: Rect
  outcome:
    | { kind: 'empty' | 'passthrough' | 'unsupported' }
    | { kind: 'capture'; plan: TextureReplayPlan }
}
export type PathMesh = {
  opaqueRect?: Rect
  area?: { first: number; count: number; fingerprint?: [number,number] }
  analytic?: { first: number; count: number; bands?: number }
  sampleCount?: 4 | 16
  analyticRect?: [number, number, number, number]
  rect: Rect
  first: number
  count: number
  rule: 'evenodd' | 'nonzero' | 'union'
}
export type GpuNode = {
  /** Worker-local transient placement identity; never serialized by the kernel. */
  previewSource?: GpuNode
  /** A nested edit changes this container's contents on every pose. Compose
   * it in the live damage window instead of recapturing a full cached image. */
  previewDynamic?: boolean
  opaqueCoverage?: boolean
  passthrough?: boolean
  backdropBox?: [number, number, number, number]
  id: string
  rect: Rect
  matrix: Matrix
  inverse: Matrix
  size: [number, number]
  glassShape?: { size: [number, number]; radius: number }
  captureReplay?: GlassCaptureReplay
  textureReplay?: TextureReplay
  fill: PathMesh
  fills: GpuPaint[]
  strokes: { path: PathMesh; paint: GpuPaint; align: 'center' | 'inside' | 'outside' }[]
  children: string[]
  maskType?: 'alpha' | 'luminance'
  mask: boolean
  maskId?: string
  clip: boolean
  opacity: number
  blend: string
  effects: Effect[]
}
export type GpuPaint = Paint & {
  constantColor?: string
  figmaGradient?: boolean
  gradientPlane?: [number, number, number]
  fixedGradient?: { bits: number; words: number[][] }
}
export type GpuScene = {
  /** Transient viewport inside a larger geometry capture. Never exported. */
  interactionWindow?: Rect
  compactImageFields?: boolean
  pairedDisplayFilters?: boolean
  /** Only explicitly transient whole-scene interactions can retain root paint. */
  interactionRetained?: boolean
  nativeInteraction?: boolean
  disableSparseGlass?: boolean
  /** Worker-local proof owner for transform-only recompiles; never a document field. */
  interactionLease?: object
  interactionSelection?: string[]
  /** Transient web-canvas filter reduction. Never set by export/readback. */
  displayFilters?: boolean
  softwareRaster?: boolean
  output?: Rect
  floatCompositing?: boolean
  colorManagement?: ColorSettings
  colors?: Record<string, [number, number, number, number]>
  backdropSamples?: boolean
  coherentSamples?: boolean
  integratedBlur?: boolean
  curves?: number[] | Float32Array<ArrayBuffer>
  resolve?: PreviewPresentation
  presentation?: PreviewPresentation
  version: 7 | 8
  width: number
  height: number
  extent: Rect
  background: string
  transparent: boolean
  grid: boolean
  checkerboard?: boolean
  checkerboardSize?: number
  view: { x: number; y: number; zoom: number }
  roots: string[]
  nodes: Record<string, GpuNode>
  vertices: number[] | Float32Array<ArrayBuffer>
}
export type Texture = {
  /** Lossless storage for proven 0/1 sample coverage; never a color target. */
  binaryCoverage?: true
  /** One lossless f32 coverage channel, expanded to RGBA by the sampler. */
  scalarCoverage?: true
  /** Immutable transparent input. Its logical bounds live on Surface; drivers
   * advertising zeroTextureSampling return +0 before loading any texel. */
  transparentZero?: true
  /** A one-texel immutable color, sampled within Surface's original bounds. */
  uniformColor?: true
  width: number
  height: number
  resource: GPUTexture | WebGLTexture
  framebuffer?: WebGLFramebuffer
  bytes: number
}
export type ImageTexture = { texture: Texture; rect: Rect }
export type PreviewPresentation = {
  width: number
  height: number
  offsetX: number
  offsetY: number
  scale: number
}
export function previewUniforms(
  u: Float32Array,
  p: PreviewPresentation | undefined,
  screen = false,
) {
  if (p) {
    u[16] = 18
    u[17] = screen ? 1 : 0
    u.set([p.offsetX, p.offsetY, p.scale, 0], 36)
  }
}
export interface Driver {
  /** Submit encoded work in queue order without waiting or freeing resources.
   * Used at CPU task yields so display and raster submissions can interleave. */
  submitPending?(): void
  captureDisplay?: boolean
  attachPresenter?(canvas: OffscreenCanvas, report: (stats: Record<string, unknown>) => void): void
  presentFrame?(frame: import('./resident-presenter').ResidentFrame): void
  releasePresented?(ids: number[]): void
  replacePresented?(slot:number,next:number):void
  snapshotPresented?(): { gpuTile: number; frame: import('./resident-presenter').ResidentFrame } | undefined
  readContentPixel?(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement):Promise<{contentPixel:number[];contentFrame:import('../resident-presentation').ResidentAcknowledgement}>
  captureContentBitmap?():Promise<{bitmap:ImageBitmap;contentFrame:import('../resident-presentation').ResidentAcknowledgement}>
  importPresented?(bitmap: ImageBitmap): number
  readonly displayMath?: boolean
  readonly pairedFilterPasses?: number
  readonly supportsDisplayFilters?: boolean
  readonly zeroTextureSampling?: boolean
  readonly constantTextureSampling?: boolean
  /** Materialize each step of meanFourRN without changing its operation order. */
  readonly sequentialSampleResolve?: boolean
  readonly scalarAlphaFilter?: boolean
  readonly exactShadowOver?: boolean
  readonly scratchBytes?: number
  readonly frameScratchBytes?: number
  /** Aggregate device-side ledger. finishTransientBytes covers the finish()
   * output copy, readback target and MAP_READ staging that live outside the
   * renderer's pool budget; gates read it to reason about the true footprint. */
  stats?(): {
    passTimings?: GpuPassTiming[]
    textureBytes: number
    displayTextureBytes?: number
    transientBytes: number
    finishTransientBytes: number
    frameScratchBytes: number
    scratchBytes: number
    vertexBufferBytes: number
    curveBufferBytes: number
    geometryUploadBytes?: number
    residentProgramHits?: number
    residentProgramHitBytes?: number
    geometryMirrorBytes?: number
    solidBufferBytes: number
    uniformBufferBytes: number
    textureViewCreates?: number
    bindGroupCreates?: number
    bindGroupHits?: number
    bindGroupCacheSize?: number
    deviceLost: boolean
  }
  prepareFilterPass?(target: Texture, uniforms: Float32Array, inputs: Texture[], channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number): void
  abortFrameAndReleaseFilterScratch?(): Promise<void>
  readonly certifiedFilter?: boolean
  readonly exactSolidPaintOver?: boolean
  readonly managed?: boolean
  readonly linearLight?: boolean
  readonly hdr?: boolean
  readonly name: 'webgpu' | 'webgl2'
  readonly canvas: OffscreenCanvas
  readonly description: string
  readonly lost: boolean
  drawCalls: number
  triangles: number
  commandSubmissions?: number
  prepareScene?(scene: GpuScene): Promise<void>
  prepareFilters?(prefixUseful?: boolean): Promise<void>
  begin(vertices: Float32Array, curves?: Float32Array): void
  /** Complete prior commands before reclaiming frame-local scratch textures. */
  checkpoint?(): Promise<void>
  /** Raw premultiplied storage; used by exact Rust f64 effect composition. */
  readSurface?(source: Texture): Promise<Float32Array>
  create(width: number, height: number): Texture
  createBinaryCoverage?(width: number, height: number): Texture
  createScalarCoverage?(width: number, height: number): Texture
  destroy(texture: Texture): void
  upload(bitmap: ImageBitmap): Texture
  uploadRgba8?(bytes: Uint8Array, width: number, height: number): Texture
  uploadLinear?(values: Float32Array, width: number, height: number): Texture
  /** Write a sub-rect of an existing texture (atlas slot). The rect stays
   * inside the texture; zero padding around slots reproduces standalone
   * out-of-bounds fetches exactly. */
  uploadAtlasRgba8?(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ): void
  uploadAtlasLinear?(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    values: Float32Array,
  ): void
  uploadParameters?(values: Float32Array, width: number, height: number): Texture
  /** Reuse one bounded 1024² float metadata texture, submitting prior reads before overwrite. */
  uploadReplayParameters?(
    values: Float32Array,
    width: number,
    height: number,
    target?: Texture,
  ): Texture
  clear(target: Texture): void
  mask(path: PathMesh, target: Texture, sampleIndex?: number): void
  /** Rasterize an integer crop without rebasing the interval program. */
  maskRegion?(path: PathMesh, target: Texture, sampleIndex: number, region: Rect): void
  /** channels is only used by exact separable filters; all other passes write RGBA. */
  pass(target: Texture, uniforms: Float32Array, inputs: Texture[], region?: Rect, channels?: number, filter?: {kind: 'tent'; radius: number}, clearOutside?: boolean): void
  over(target: Texture, uniforms: Float32Array, inputs: Texture[], region: Rect): void
  solidBatch?(
    target: Texture,
    uniforms: Float32Array,
    instances: Float32Array,
    clip?: Texture,
  ): void
  finish(
    source: Texture,
    sourceRect: Rect,
    width: number,
    height: number,
    readback: boolean,
    preview?: PreviewPresentation,
    present?: boolean,
    output?: Rect,
  ): Promise<{
    gpuTile?: number
    bitmap?: ImageBitmap
    rgba?: Uint8Array
    straightRgba?: Uint8Array
    linear?: Float32Array
  }>
  dispose(): void
  loseDeviceForTesting(): Promise<void>
}
export const blends = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'linear-burn',
  'linear-dodge',
]
export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y)
  return rect(
    x,
    y,
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  )
}
export function parameters(
  output: Rect,
  a: Rect = output,
  b: Rect = output,
  c: Rect = output,
): Float32Array {
  const u = new Float32Array(256)
  ;[output, a, b, c].forEach((r, i) => u.set([r.x, r.y, r.w, r.h], i * 4))
  return u
}
