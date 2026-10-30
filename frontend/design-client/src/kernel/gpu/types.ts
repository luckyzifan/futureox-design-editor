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
  gaussianRegion?:import('./gaussian-region').GaussianRegion
  /** Worker-local transient placement identity; never serialized by the kernel. */
  previewSource?: GpuNode
  /** A nested edit changes this container's contents on every pose. Compose
   * it in the live damage window instead of recapturing a full cached image. */
  previewDynamic?: boolean
  opaqueCoverage?: boolean
  passthrough?: boolean
  backdropBox?: [number, number, number, number]
  /** Native painter-dependency certificate, emitted only for the adopted
   * bounded scene. Includes downstream effect consumers; not a viewport hint. */
  backdropOutputBox?: [number, number, number, number]
  /** Native single outer-shadow consumption certificate; its filter output
   * is sampled after the unchanged authored shadow offset. */
  shadowOutputBox?: [number, number, number, number]
  /** Initial isolated child-bundle domain, certified by the native painter
   * walk. Leaf source/filter geometry remains in its own rect. */
  childrenInputBox?: [number, number, number, number]
  /** Entire parent suffix after this child, including old pixels outside its
   * shape. Never intersect this rectangle with the child's own geometry. */
  postCompositeBox?: [number, number, number, number]
  /** Native complete parent suffix demand; source/paint rectangles stay unchanged. */
  suffixBox?: [number, number, number, number]
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
  maskType?: 'alpha' | 'luminance' | 'outline'
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
  /** Worker-only SDR layer capture; original linear premultiplication survives. */
  linearRetainedCapture?: boolean
  pagePaintRects?: number[][];
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
  /** Worker-private tile-fill owner, attached after native packet decoding.
   * Never serialized into documents or accepted from a render request. */
  filterBatchLease?: object
  interactionSelection?: string[]
  /** Transient web-canvas filter reduction. Never set by export/readback. */
  displayFilters?: boolean
  /** Screen-only bounded filter tier. Larger radii retain exact reduction. */
  displayFilterRadiusLimit?: number
  /** Renderer-owned SDR blur arithmetic, cleared for every exact output. */
  canvasBlurApproximation?: boolean
  /** Worker-selected SDR display-only image sampler. Exact outputs overwrite it. */
  displayMaterialSource?: boolean
  /** Screen-only request for sequential sample accumulation, never exact output. */
  sequentialDisplay?: boolean
  displayImageSource?: boolean
  /** Worker-selected SDR display approximation; exact outputs overwrite it. */
  displayTentRadius?: boolean
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
  /** Initial root painter prefix. The global extent also includes independent
   * source/filter support and must not determine the root target allocation. */
  rootInputBox?: [number, number, number, number]
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
  /** Actual immutable rgba32float upload was checked after all CPU transforms.
   * Any render/partial upload write revokes this finite-pixel certificate. */
  finitePixels?: true
  /** Entire physical texture alpha is exactly +1; revoked on every write. */
  opaqueAlpha?: true
  /** Immutable rational coefficient metadata; exact prefix reason 4 only. */
  prefixRationalUnsupported?: boolean
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
/** Scalar admission snapshot captured BEFORE the queue wait; never reclaimed-byte totals. */
export type GpuAdmissionDiagnostic = Readonly<{
  /** 0=proactive cleanup, 1=known-allocation preflight. */
  admissionKind: 0 | 1
  admissionPressure: 0 | 1
  admissionRequiredBytes: number
  admissionWorkingBytes: number
  admissionBudgetBytes: number
  admissionReclaimableBytes: number
  admissionPoolBytes: number
  admissionPoolCount: number
  admissionUploadCount: number
  admissionImageCount: number
  /** Actual candidate families: pool=1, retired uploads=2, coordinates=4, forced images=8. */
  admissionRetiredKinds?: number
  admissionRetiredUploadCount?: number
  admissionCoordinateCount?: number
}>

export type ExactImageTable = { resource: unknown; width: number; height: number; bytes: number; opaqueAlpha?: true; nonnegativeResolved?: true }
export type OpaqueSolidBatch = Readonly<{count:number;pixels:number}>
export interface Driver {
  prepareOpaqueSolids?(nodes:readonly {path:PathMesh;bounds:Rect}[],target:Rect,color:readonly number[],region?:Rect):OpaqueSolidBatch|undefined
  drawOpaqueSolids?(batch:OpaqueSolidBatch,target:Texture,sample:number):boolean
  usesDisplayFilter?(radius: number, channels?: number): boolean
  /** True only for this driver's actual immutable finite image upload. */
  usesDisplayImageSource?(image: Texture): boolean
  imageTableRange?(image: Texture): import('./exact-image-x-table').ExactImageRange | undefined
  /** Immutable, driver-owned colour upload bound to its current GPU resource. */
  immutableImageRange?(image: Texture): import('./exact-image-x-table').ExactImageRange | undefined
  imageTableAxes?(field: Texture): Float32Array | undefined
  hasActiveImageTableSource?(image: Texture): boolean
  prepareImageTable?(image: Texture, plan: import('./exact-image-x-table').ExactImageXTablePlan, availableBytes: number): Promise<ExactImageTable | undefined>
  resolveImageTable?(target: Texture, table: ExactImageTable, offsetX: number, offsetY: number): void
  retireImageTable?(table: ExactImageTable): Promise<void>
  /** Synchronously collect completed image-table snapshots inside a scratch
   * ledger delta. Never interprets submission as completion. */
  collectCompletedImageTables?(): void
  readonly opaqueTentPasses?: number
  /** Submit encoded work in queue order without waiting or freeing resources.
   * Used at CPU task yields so display and raster submissions can interleave. */
  submitPending?(): void
  /** Pace canvas encoding against the already submitted queue without
   * retiring frame resources or treating presentation ACKs as completion. */
  yieldRasterQueue?(): Promise<void>
  captureDisplay?: boolean
  retainedSampleCapture?(): boolean
  attachPresenter?(canvas: OffscreenCanvas, report: (stats: Record<string, unknown>) => void): void
  presentFrame?(frame: import('./resident-presenter').ResidentFrame): void
  releasePresented?(ids: number[]): void
  replacePresented?(slot:number,next:number):void
  snapshotPresented?(): { gpuTile: number; frame: import('./resident-presenter').ResidentFrame } | undefined
  backgroundTile?(owner:object,contract:string,view:{x:number;y:number;zoom:number},output:Rect):number|undefined
  snapshotPageTranslation?(sourceOwner:object,targetOwner:object,offset:{x:number;y:number},width:number,height:number,scale:number,contract:string):
    {gpuTile:number;frame:import('./resident-presenter').ResidentFrame}|undefined
  readContentPixel?(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement):Promise<{contentPixel:number[];contentFrame:import('../resident-presentation').ResidentAcknowledgement}>
  captureContentBitmap?():Promise<{bitmap:ImageBitmap;contentFrame:import('../resident-presentation').ResidentAcknowledgement}>
  importPresented?(bitmap: ImageBitmap): number
  readonly displayMath?: boolean
  readonly pairedFilterPasses?: number
  readonly supportsDisplayFilters?: boolean
  readonly zeroTextureSampling?: boolean
  readonly constantTextureSampling?: boolean
  createConstantCoverage?():Texture
  /** Materialize each step of meanFourRN without changing its operation order. */
  readonly sequentialSampleResolve?: boolean
  /** Finite image paint + transparent normal blend + one exact resolve step. */
  readonly exactImageResolveStep?: boolean
  readonly scalarAlphaFilter?: boolean
  /** Read-only admission for a complete exact-filter source. Verifies this
   * driver's private allocation/format record and prepared exact pipelines;
   * grants no content, finite, opaque, domain or completion certificate. */
  supportsExactWholeTentSource?(source: Texture): boolean
  /** Actual live device limit only; absence must retain the old 1D refusal. */
  readonly exactFilterPacketMaxDimension?: number
  /** New whole-filter lane only. Input is the unpadded logical packet;
   * allocation uses the pre-admitted physical row layout, not logical bytes. */
  uploadExactFilterPacket?(bytes: Uint8Array, width: number, height: number): Texture
  readonly exactShadowOver?: boolean
  readonly scratchBytes?: number
  /** Logically retired table storage still owned until a real completion. */
  readonly retiredImageTableBytes?: number
  readonly frameScratchBytes?: number
  /** Monotonic driver-lifetime frame epochs. A completed epoch proves every
   * submitted read completed and every unsubmitted read was abandoned. A
   * mere finish() return does not imply completion. */
  readonly resourceEpoch?: number
  readonly completedResourceEpoch?: number
  /** Aggregate device-side ledger. finishTransientBytes covers the finish()
   * output copy, readback target and MAP_READ staging that live outside the
   * renderer's pool budget; gates read it to reason about the true footprint. */
  drawWorkSnapshot?():Record<string,number>
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
    dynamicUniformBindings?: boolean
    byteTentAlphaPasses?: number
    byteTentScratchBytes?: number
    queueWaits?: import('./queue-wait-stats').QueueWaitSnapshot
    deviceLost: boolean
  }
  supportsGaussianReduction?():boolean
  supportsGaussianRegions?():boolean
  prepareCanvasBoxPass?(target:Texture,u:Float32Array,inputs:Texture[],channels:number,availableBytes:number):void
  prepareFilterPass?(target: Texture, uniforms: Float32Array, inputs: Texture[], channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number): void
  /** Strict opt-in unmanaged RGBA8 shadow-alpha pipeline; preparation owns no scratch. */
  prepareByteTent?(): Promise<boolean>
  /** RGB-zero exact alpha tent. False allocates/records nothing. Throws abandon
   * the complete frame encoder; callers must abort/restart, never scalar-fallback.
   * Every successful job remains included in scratchBytes until covered completion. */
  encodeByteTentAlpha?(target: Texture, source: Texture, options: import('./byte-tent-prefix-plan').ByteTentOptions,
    availableBytes: number): boolean
  /** Opt-in bounded physical subrect for exact mode22 only. The logical source
   * remains uniforms[4..7]. False encodes nothing; callers retain their normal
   * small-texture path. No content/alpha proof or lifetime lease is granted. */
  passFilterWindow?(target: Texture, uniforms: Float32Array, inputs: Texture[], window: Readonly<Rect>,
    channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number): boolean
  abortFrameAndReleaseFilterScratch?(reason?: 'admission' | 'cancel'): Promise<void>
  readonly certifiedFilter?: boolean
  readonly exactSolidPaintOver?: boolean
  readonly exactGradientPaintOver?: boolean
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
  /** Render-call intent, never a document/scene capability. Omission is exact. */
  prepareScene?(scene: GpuScene, displayOnly?: boolean): Promise<void>
  prepareFilters?(prefixUseful?: boolean): Promise<void>
  /** Before begin, retire pending prior-frame image leases if geometry may
   * replace an in-flight buffer. Caller accounts scratch deltas across await. */
  prepareFrameResources?(vertices: Float32Array, curves?: Float32Array): Promise<void>
  begin(vertices: Float32Array, curves?: Float32Array): void
  /** Complete prior commands before reclaiming frame-local scratch textures. */
  /** Always submit encoded commands. completedPoolEpoch may omit the wait only
   * for a renderer-proven free-pool-only destruction batch entirely released
   * in already-completed prior frames; unknown/current epochs must wait. */
  checkpoint?(reason?: import('./queue-wait-stats').QueueWaitReason, admission?: GpuAdmissionDiagnostic, completedPoolEpoch?: number): Promise<void>
  /** Between frames only: wait for already-submitted work without finishing
   * or submitting the previous encoder. Does not grant a global frame epoch. */
  waitForSubmittedWork?(): Promise<void>
  /** Raw premultiplied storage; used by exact Rust f64 effect composition. */
  readSurface?(source: Texture): Promise<Float32Array>
  /** Bit-preserving physical RGBA32F copy. Coordinates are texture-local;
   * this enqueues a copy, without proving GPU completion. */
  copyRegion?(target: Texture, source: Texture, sourceRegion: Rect, targetOrigin: [number, number]): void
  /** Bit-preserving owned RGBA8/RGBA32F color crop for a certified painter
   * stage. No sampler, arithmetic conversion or completion claim. */
  copyColorRegion?(target: Texture, source: Texture, sourceRegion: Rect, targetOrigin: [number, number]): void
  create(width: number, height: number): Texture
  createBinaryCoverage?(width: number, height: number): Texture
  createScalarCoverage?(width: number, height: number): Texture
  destroy(texture: Texture): void
  upload(bitmap: ImageBitmap): Texture
  uploadRgba8?(bytes: Uint8Array, width: number, height: number): Texture
  uploadExactTentKernel?(bytes:Uint8Array,width:number,height:number,operator:'rational-tent'|'certified-tent',radius:number):Texture
  /** Private coefficient upload for bounded isolated shadows; never a scene flag. */
  readonly boundedShadowPacketMaxDimension?: number
  uploadBoundedShadowKernel?(bytes:Uint8Array,width:number,height:number,radius:number):Texture
  uploadLinear?(values: Float32Array, width: number, height: number): Texture
  uploadLinearRows?(width:number,height:number,rows:import('../image-row-source').LinearImageRows):Texture
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
  mask(path: PathMesh, target: Texture, sampleIndex?: number, region?:Rect): void
  /** Rasterize all four phases into four distinct owned targets in one pass. */
  maskAll?(path: PathMesh, targets: readonly Texture[], region?: Rect): boolean
  /** Rasterize an integer crop without rebasing the interval program. */
  maskRegion?(path: PathMesh, target: Texture, sampleIndex: number, region: Rect): void
  /** channels is only used by exact separable filters; all other passes write RGBA. */
  pass(target: Texture, uniforms: Float32Array, inputs: Texture[], region?: Rect, channels?: number, filter?: {kind: 'tent'; radius: number}, clearOutside?: boolean): void
  over(target: Texture, uniforms: Float32Array, inputs: Texture[], region: Rect): void
  /** Remaining unique instances in the driver's current upload arena.
   * Absence declines batching; a command submission is not a capacity reset. */
  solidBatchRemaining?(): number
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
    samples?: readonly {texture:Texture;rect:Rect}[],
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
