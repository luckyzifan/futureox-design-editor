/** Pure execution policy. No browser, storage, WASM, or graphics imports here.
 * The desktop host supplies cpuOnly before application code starts; callers
 * copy that bit once rather than consulting mutable editor preferences.
 * hdrCompositing opts into float display payloads/presenters. Color-managed documents always retain linear
 * computation, whose float intermediates use ~4x the bytes per surface. The
 * default display payload is SDR RGBA8. Enabling HDR is a host configuration
 * decision (env/localStorage), never inferred from document content alone.
 * imageMips opts image fills into deterministic mip-chain sampling on
 * minification (Sketch's offline MSImageDataMipMap equivalent). Off by
 * default because level selection changes minified image bytes; the CPU
 * reference and GPU paths derive the level from the same kernel geometry.
 */
export type RenderPolicy = Readonly<{ cpuOnly: boolean; hdrCompositing: boolean; imageMips: boolean; imageAtlas: boolean;
  desktopFullMath: boolean; desktopDisplay: boolean; gpuWorkingBudgetMiB?: number }>
/** Explicit host admission budget, not preallocation or an adapter-memory
 * query. Never derive it from documents or individual render requests. */
export function validGpuWorkingBudgetMiB(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 256 && value <= 4096
}
export type RenderBackend = 'auto' | 'webgpu' | 'webgl2' | 'cpu'
export type DisplayRenderRequest = {
  renderIntent?: string; png?: boolean; readback?: boolean; exportFormat?: unknown;
  exportRegion?: unknown; pixelPreview?: number; rasterProfile?: string
}
/** Desktop display quality is independent of effect admission. It never
 * authorizes skipped effects, single-plane coverage or changed authored data.
 * Explicit exact output keeps its requested sampling/arithmetic contract. */
export function usesDesktopDisplay(policy: RenderPolicy, request: DisplayRenderRequest): boolean {
  return policy.desktopDisplay && policy.desktopFullMath && !policy.cpuOnly && !policy.hdrCompositing &&
    (request.renderIntent === 'canvas' || request.renderIntent === 'preview') &&
    !request.png && !request.readback && !request.exportFormat && !request.exportRegion && !request.pixelPreview &&
    request.rasterProfile !== 'figmaSoftware'
}
/** Presentation residency does not select arithmetic, sampling or effects.
 * Exact desktop frames can stay on the same WebGPU device just like Web frames.
 * HDR and CPU/WebGL transports keep their existing independent paths. */
export function allowsResidentSdr(policy: RenderPolicy, backend: RenderBackend = 'auto'): boolean {
  return !policy.cpuOnly && !policy.hdrCompositing && (backend === 'auto' || backend === 'webgpu')
}
/** Completed native regions replace their same-owner backing immediately.
 * Raster math and final readiness stay unchanged; other navigation modes
 * retain their explicit admission and an explicit zero restores the old path. */
export function usesProgressiveNativeRepair(policy: RenderPolicy, backend: RenderBackend,
  flag: unknown, ordinaryNavigation = true): boolean {
  if (flag === '0') return false
  if (flag === '1') return true
  return ordinaryNavigation && policy.desktopFullMath && policy.desktopDisplay &&
    allowsResidentSdr(policy, backend) && backend === 'webgpu'
}
/** Input windows are in the current device lattice. HQ resolve and pixel
 * preview use another output lattice and retain their ordinary exact graph. */
export function allowsInteractionWindow(requested:boolean,scene:{resolve?:unknown;presentation?:unknown}) {
  return requested && !scene.resolve && !scene.presentation
}
type SamplingProfile = 'analytic' | 'figma' | 'figmaSubpixel' | 'figmaSoftware'
/** The browser display keeps four correlated coverage samples at screen
 * density. The file's Figma export profile additionally doubles both axes;
 * that supersampling belongs to export/exact reference, not every camera move.
 * The separately admitted desktop display tier can use that same screen AA,
 * while retaining desktop effect admission and four correlated samples. */
export function canvasSamplingProfile(policy: RenderPolicy, profile: SamplingProfile,
  backend: RenderBackend, managed: boolean, pixelPreview = 0,
  request: DisplayRenderRequest = { renderIntent: 'canvas' }): SamplingProfile {
  const display = { ...request, rasterProfile: profile, pixelPreview: pixelPreview || request.pixelPreview }
  const screenRequest = (request.renderIntent === 'canvas' || request.renderIntent === 'preview') &&
    !request.png && !request.readback && !request.exportFormat && !request.exportRegion && !display.pixelPreview
  return !policy.cpuOnly && !policy.hdrCompositing && screenRequest &&
    (!policy.desktopFullMath || usesDesktopDisplay(policy, display)) &&
    backend !== 'cpu' && managed && profile === 'figma'
    ? 'figmaSubpixel' : profile
}
/** Full-density canvas filters use the same integrated coefficients with
 * compensated f32 accumulation. Exact readbacks/exports retain rational
 * accumulation; the screen path does not reduce geometry or AA samples. */
export function usesCanvasDisplayFilters(policy: RenderPolicy, request: DisplayRenderRequest) {
  return !policy.cpuOnly && !policy.desktopFullMath && !policy.hdrCompositing && request.renderIntent === 'canvas' &&
    !request.png && !request.readback && !request.exportFormat && !request.exportRegion && !request.pixelPreview
}
/** A transient scene can travel as bytes without becoming an exact export.
 * This also covers whole-scene interaction snapshots, which don't use the
 * viewport-tile transport. Explicit reference/settled/export paths stay exact. */
export function usesTransientDisplayFilters(policy: RenderPolicy, request: DisplayRenderRequest) {
  return !policy.cpuOnly && !policy.desktopFullMath && !policy.hdrCompositing &&
    request.renderIntent === 'preview' && !request.png && !request.exportFormat && !request.exportRegion && !request.pixelPreview
}
/** Opt-in desktop-native backend preference (`forma-render-backend=native`).
 * It is deliberately not a RenderBackend: native frames route through the
 * Electron design-render bridge (Metal/wgpu serve mode, see
 * kernel/native-render-session.ts) instead of an in-worker rasterizer, so
 * effectiveBackend/rasterCandidates never see it and the worker keeps its
 * previous fallback. Desktop-only; web hosts ignore it. */
export type NativeBackendPreference = 'native'
export function prefersNativeBackend(preference: unknown): preference is NativeBackendPreference {
  return preference === 'native'
}

export function createRenderPolicy(cpuOnly: boolean, hdrCompositing = false, imageMips = false, imageAtlas = false,
  desktopFullMath = false, desktopDisplay = false, gpuWorkingBudgetMiB?: number): RenderPolicy {
  if (gpuWorkingBudgetMiB !== undefined && !validGpuWorkingBudgetMiB(gpuWorkingBudgetMiB))
    throw Error('Invalid GPU working budget; expected an integer from 256 to 4096 MiB')
  return Object.freeze({ cpuOnly, hdrCompositing, imageMips, imageAtlas, desktopFullMath, desktopDisplay,
    ...(gpuWorkingBudgetMiB === undefined ? {} : { gpuWorkingBudgetMiB }) })
}

// Older/malformed desktop bridges fail safely; ordinary web use still defaults
// to auto. Only an explicit trusted false opts a desktop into GPU preference.
export function hostRenderPolicy(
  desktopPresent: boolean,
  cpuOnly: unknown,
  hdrCompositing = false,
  imageMips = false,
  imageAtlas = false,
  desktopDisplay = false,
  gpuWorkingBudgetMiB?: number,
): RenderPolicy {
  // Desktop continues to require complete effects/correlated coverage. Its
  // optional screen-density/arithmetic capability is a separate launch bit;
  // it must not inherit the browser's effect-skipping policy.
  return createRenderPolicy(desktopPresent && cpuOnly !== false, hdrCompositing, imageMips, imageAtlas, desktopPresent,
    desktopPresent && desktopDisplay, desktopPresent ? gpuWorkingBudgetMiB : undefined)
}

export function effectiveBackend(
  policy: RenderPolicy,
  preference: unknown,
  png = false,
): RenderBackend {
  if (policy.cpuOnly || png) return 'cpu'
  return preference === 'cpu' || preference === 'webgpu' || preference === 'webgl2'
    ? preference
    : 'auto'
}

export function allowsColorPresentation(policy: RenderPolicy, backend: RenderBackend): boolean {
  return effectiveBackend(policy, backend) !== 'cpu'
}

/** Document color conversion and premultiplied compositing are computation
 * semantics. Disabling HDR output must not quantize scene inputs or
 * send their images to the byte-only asset decoder. The scene compiler owns
 * arithmetic precision; the host flag controls only display transport. */
export function requiresFloatCompositing(
  _policy: RenderPolicy,
  scene: { colorManagement?: unknown; floatCompositing?: boolean },
): boolean {
  return !!scene.colorManagement || !!scene.floatCompositing
}

/** Native GPU arithmetic is a display tier, never an exact-output shortcut. */
export function usesDisplayArithmetic(policy: RenderPolicy, request: DisplayRenderRequest) {
  return request.rasterProfile !== 'figmaSoftware' &&
    (usesDesktopDisplay(policy, request) || usesCanvasDisplayFilters(policy, request) || usesTransientDisplayFilters(policy, request))
}

export function rasterCandidates(
  policy: RenderPolicy,
  preference: unknown,
  png = false,
): ('webgpu' | 'webgl2')[] {
  const backend = effectiveBackend(policy, preference, png)
  return backend === 'cpu' ? [] : backend === 'auto' ? ['webgpu', 'webgl2'] : [backend]
}

/** A worker is private to one client. Its first envelope pins the host policy;
 * later envelopes may neither relax nor change it, including debug commands.
 * Structured clone does not preserve Object.freeze, so freeze a fresh copy.
 * A missing hdrCompositing or imageMips bit fails safe toward the SDR byte
 * path without mip sampling.
 */
export function pinRenderPolicy(current: RenderPolicy | undefined, incoming: unknown): RenderPolicy {
  if (!incoming || typeof incoming !== 'object' ||
      typeof (incoming as { cpuOnly?: unknown }).cpuOnly !== 'boolean')
    throw new Error('Missing or invalid render execution policy')
  const cpuOnly = (incoming as { cpuOnly: boolean }).cpuOnly
  const hdrRaw = (incoming as { hdrCompositing?: unknown }).hdrCompositing
  const hdrCompositing = hdrRaw === true
  const mipsRaw = (incoming as { imageMips?: unknown }).imageMips
  const imageMips = mipsRaw === true
  const atlasRaw = (incoming as { imageAtlas?: unknown }).imageAtlas
  const imageAtlas = atlasRaw === true
  const desktopFullMath = (incoming as { desktopFullMath?: unknown }).desktopFullMath === true
  const desktopDisplay = (incoming as { desktopDisplay?: unknown }).desktopDisplay === true
  const budgetRaw = (incoming as { gpuWorkingBudgetMiB?: unknown }).gpuWorkingBudgetMiB
  if (budgetRaw !== undefined && !validGpuWorkingBudgetMiB(budgetRaw))
    throw Error('Invalid GPU working budget in render execution policy')
  const gpuWorkingBudgetMiB = budgetRaw as number | undefined
  if (current && (current.cpuOnly !== cpuOnly || current.hdrCompositing !== hdrCompositing ||
      current.imageMips !== imageMips || current.imageAtlas !== imageAtlas || current.desktopFullMath !== desktopFullMath ||
      current.desktopDisplay !== desktopDisplay || current.gpuWorkingBudgetMiB !== gpuWorkingBudgetMiB))
    throw new Error('Render execution policy cannot change within a worker')
  return current ?? createRenderPolicy(cpuOnly, hdrCompositing, imageMips, imageAtlas, desktopFullMath, desktopDisplay, gpuWorkingBudgetMiB)
}
