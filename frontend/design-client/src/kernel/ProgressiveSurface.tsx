import { initializeKernelModule } from './module'
import { shouldUseExactCpuFallback } from './cpu-fallback'
import { allowsResidentSdr } from './render-policy'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SurfaceProps } from './Surface'
import { KernelClient, renderExecutionPolicy, type TileDamage, type TileResult } from './client'
import { paintDamageIntersects } from './paint-damage'
import { recordRenderDiagnostic, renderDiagnosticError, renderDiagnostics } from './render-diagnostics'
import type { BackendPreference } from './gpu/types'
import type { ColorPresenter } from './color-presenter'
import { TILE_SIDE, budgetTileLimit, displayTileBudget, tilesCoverBounds, type RasterTile } from './tile-cache'
import { planTilesAligned, planTilesWithPrefetchRim, tilePrefetchRingsFromHost } from './tile-plan-aligned'
import { preservesNativePanPhase, canvasLodScale, canvasRasterPlan, canvasRasterPhaseMatches, canvasSamplingScale, motionRasterScale } from './canvas-raster-plan'
import { pageHasFilteredContent } from './canvas-effect-sampling'
import { frameTransform, useDevicePixelRatio, useDisplayCapability } from './presentation'
import { LodSnapshotCache } from './lod-snapshot-cache'
import { tileIntersectsView, tilePlacementAtView, tilePreviewContractMatches } from './tile-preview'
import { useRasterDensity } from './use-raster-density'
import { useZoomActivity, useCameraActivity } from './use-zoom-activity'
import { useNavigationZoom } from './use-navigation-zoom'
import { navigationPreviewDensity } from './navigation-zoom'
import { RenderMailbox } from './render-mailbox'
import { scheduleRasterMaintenance } from './idle-raster-maintenance'
import { panPrefetch } from './pan-prefetch'
import { tilePrepareViewport, tileBatchPrepareViewport } from './tile-prepare-viewport'
import { TileCompositeSurface } from './TileCompositeSurface'
import { ResidentCompositeSurface } from './ResidentCompositeSurface'
import { PresentationOwnership } from './presentation-ownership'
import { PageResidencyCache } from './page-residency-cache'
import { isDisplayBudgetError } from './gpu/display-budget'
import { progressiveTileLayer } from './progressive-quality'
import { hasRetainedOverview } from './overview-coverage'
import { allowsReducedSampling } from './render-quality'
import { CoverageRetention } from './coverage-retention'
import { prioritizeUncoveredTiles } from './coverage-priority'
import {
  prioritizeTileFill,
  TileFillScheduler,
  tileFrameBudgetOptionsFromHost,
  type TileFillCounters,
} from './tile-scheduler'
import { patternCameraPeriod, snapPatternAxis, tileComputationDependsOnCamera, tileComputationKey } from './tile-computation-key'

let nextTerminalQualitySequence = 0

type PaintedTile = TileResult & {
  revision: number
  serial: number
  document?: SurfaceProps['document']
  color: SurfaceProps['document']['colorManagement']
  /** Transient coarse-layer tile (Sketch drawTiles-style LOD pre-layer):
   * rendered at a bucket scale below the exact camera, displayed upscaled
   * until the exact tiles of the active plan commit. */
  lod?: boolean
  overview?: boolean
}
// Count both pending CPU payload and the resident display surface. Once copied
// to an immutable canvas, CPU pixels can be released; keeping both duplicates
// every HDR frame and prevents atomic Retina swaps within the existing budget.
function tileResidentBytes(tile: PaintedTile) {
  return tile.bytes.byteLength + (tile.linear?.byteLength || 0) + tile.width * tile.height * (tile.color ? 8 : 4)
}
/** Every resident pixel participates in display, including overlap gutters. */
export function tileWorldRect(tile: RasterTile) {
  return {
    x: (tile.x - (tile.phaseX || 0)) / tile.zoom,
    y: (tile.y - (tile.phaseY || 0)) / tile.zoom,
    width: tile.width / tile.zoom,
    height: tile.height / tile.zoom,
  }
}
type DisplayFrame = {
  key: string
  revision: number
  document: SurfaceProps['document']
  view: SurfaceProps['view']
  dpr: number
  rasterScale: number
  samplingDensity: number
  samplingMode: 'native' | 'density-cache'
  width: number
  height: number
  pageId: string
  epoch: number
  checkerboard?: boolean
  grid: boolean
  pixelPreview: SurfaceProps['pixelPreview']
  rasterProfile: SurfaceProps['rasterProfile']
  managed: boolean
  computeBackend: BackendPreference
  displayCapability?: string
  ids: Set<string>
  /** Hold the actual mounted canvases through same-key pixel replacement.
   * Key equality alone cannot identify a completed document's pixels. */
  residents: Map<string, PaintedTile>
}
type DisplayOwner = {
  acquire: (canvas: HTMLCanvasElement) => Promise<ColorPresenter>
  dispose: () => void
}
function displayOwner(): DisplayOwner {
  let root: Promise<ColorPresenter> | undefined,
    disposed = false
  return {
    async acquire(canvas) {
      if (disposed) throw new Error('Display closed')
      root ??= import('./color-presenter').then(async ({ ColorPresenter }) => {
        const presenter = await ColorPresenter.create(document.createElement('canvas'))
        if (disposed) {
          presenter.dispose()
          throw new Error('Display closed')
        }
        return presenter
      })
      const pending = root
      try {
        return (await pending).fork(canvas)
      } catch (error) {
        // A rejected creation or lost shared device must not poison every
        // later request. Published forks keep their own reference while this
        // owner's failed root is retired; the current request still fails.
        if (root === pending) root = undefined
        void pending.then((presenter) => presenter.dispose(), () => {})
        throw error
      }
    },
    dispose() {
      disposed = true
      void root?.then(
        (p) => p.dispose(),
        () => {},
      )
    },
  }
}
const Tile = memo(function Tile({
  tile,
  color,
  owner,
  onReady,
  onGone,
  onError,
  frame,
  active,
  layer,
  placement,
  underlay,
  publishLod,
}: {
  tile: PaintedTile
  color: SurfaceProps['document']['colorManagement']
  owner: DisplayOwner
  onReady: (id: string, serial: number, managed: boolean) => void
  onGone: (id: string, serial: number) => void
  onError: (id: string, serial: number, message: string) => void
  frame: DisplayFrame | null
  active: boolean
  /** Completed-frame base, coarse fill, and current precision respectively. */
  layer?: number
  /** Temporary CSS geometry for completed or refining pixels, computed from
   * the live camera independently of the last committed exact frame. */
  placement?: { left: number; top: number; width: number; height: number }
  /** Per-tile coarse underlay (blitFromSourceTexture equivalent): the exact
   * tile shows its covering coarse bitmap until its own bytes land. */
  underlay?: { canvas: HTMLCanvasElement; sx: number; sy: number; sw: number; sh: number }
  /** The owner copies this producer canvas synchronously into an immutable
   * revision-scoped snapshot before the tile can unmount. */
  publishLod?: (revision: number, key: string, canvas: HTMLCanvasElement) => void
}) {
  const sdr = useRef<HTMLCanvasElement>(null),
    under = useRef<HTMLCanvasElement>(null),
    hdr = useRef<HTMLCanvasElement>(null)
  // Mipmap exact tiles carry pixels at their bucket scale, which can sit above
  // the committed frame's camera: committed placement maps tile device pixels
  // into the frame's CSS space by that ratio (identity when they match).
  const frameRatio = frame ? (frame.view.zoom * frame.dpr) / tile.zoom : 1
  const [ready, setReady] = useState<'sdr' | 'hdr' | null>(null)
  useEffect(() => {
    if (!underlay) return
    const canvas = under.current
    if (!canvas) return
    canvas.width = tile.width
    canvas.height = tile.height
    const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
    if (!context) return
    context.imageSmoothingEnabled = false
    context.drawImage(
      underlay.canvas,
      underlay.sx, underlay.sy, underlay.sw, underlay.sh,
      0, 0, tile.width, tile.height,
    )
  }, [underlay, tile.width, tile.height])
  useEffect(() => {
    let alive = true,
      presenter: ColorPresenter | undefined
    const releasePresenter = () => {
      presenter?.dispose()
      presenter = undefined
    }
    void (async () => {
      try {
        let managed = false
        if (color) {
          if (!tile.linear) throw new Error('缺少浮点瓦片数据')
          presenter = await owner.acquire(hdr.current!)
          if (!alive) return
          await presenter.present(tile.linear, tile.width, tile.height, color)
          managed = true
        }
        if (!alive) return
        if (!managed) {
          const canvas = sdr.current!
          canvas.width = tile.width
          canvas.height = tile.height
          const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
          if (!context) throw new Error('无法创建瓦片表面')
          // Worker-decoded bitmaps keep the main thread to a GPU blit; the
          // byte fallback covers workers without ImageBitmap decoding.
          if (tile.bitmap) context.drawImage(tile.bitmap, 0, 0)
          else
            context.putImageData(
              new ImageData(new Uint8ClampedArray(tile.bytes), tile.width, tile.height),
              0,
              0,
            )
        }
        if (alive) {
          if (tile.lod === true && !managed && publishLod)
            publishLod(tile.revision, tile.key, sdr.current!)
          setReady(managed ? 'hdr' : 'sdr')
          onReady(tile.key, tile.serial, managed)
        }
      } catch (error) {
        releasePresenter()
        if (alive) onError(tile.key, tile.serial, color
          ? `精确浮点瓦片显示失败，保留上一完整画布：${String(error)}`
          : String(error))
      } finally {
        if (!alive) releasePresenter()
      }
    })()
    return () => {
      alive = false
      onGone(tile.key, tile.serial)
      releasePresenter()
    }
  }, [tile, color, owner, onReady, onGone, onError, publishLod])
  return (
    <>
      {underlay && (
        <canvas
          ref={under}
          className="kernel-tile kernel-tile-underlay"
          aria-hidden={ready !== null}
          data-tile-underlay={tile.key}
          style={{
            position: 'absolute',
            ...(placement ?? {
              // Completed exact placement. Pending camera reprojection uses
              // the explicit preview placement without changing raster input.
              left: frame ? ((tile.x - (tile.phaseX || 0)) * frameRatio + frame.view.x * frame.dpr) / frame.dpr : 0,
              top: frame ? ((tile.y - (tile.phaseY || 0)) * frameRatio + frame.view.y * frame.dpr) / frame.dpr : 0,
              width: frame ? (tile.width * frameRatio) / frame.dpr : 0,
              height: frame ? (tile.height * frameRatio) / frame.dpr : 0,
            }),
            zIndex: (layer ?? 1) - 0.5,
            pointerEvents: 'none',
            visibility: active && ready === null ? 'visible' : 'hidden',
          }}
        />
      )}
      {(['sdr', 'hdr'] as const).map((kind) => (
        <canvas
          key={kind}
          ref={kind === 'sdr' ? sdr : hdr}
          className="kernel-tile"
          aria-hidden={ready !== kind}
          aria-label={kind === 'hdr' ? '广色域 HDR 显示瓦片' : '自研矢量渲染瓦片'}
          data-tile-key={tile.key}
          data-tile-revision={tile.revision}
          data-tile-serial={tile.serial}
          data-tile-zoom={tile.zoom}
          data-tile-x={tile.x}
          data-tile-y={tile.y}
          data-tile-phase-x={tile.phaseX || 0}
          data-tile-phase-y={tile.phaseY || 0}
          data-renderer={tile.backend}
          data-hybrid-effects={tile.hybridEffects || 0}
          data-tile-ms={(tile.milliseconds || 0).toFixed(2)}
          data-tile-compile-ms={tile.compileMs?.toFixed(2)}
          data-tile-graph-ms={tile.graphMs?.toFixed(2)}
          data-tile-finish-ms={tile.finishMs?.toFixed(2)}
          data-tile-checkpoint-ms={tile.checkpointMs?.toFixed(2)}
          data-lod={tile.lod ? 'coarse' : 'exact'}
          data-frame-visible={String(active && ready === kind)}
          style={{
            position: 'absolute',
            // Explicit placement can temporarily rescale completed pixels.
            // Final exact tiles retain the renderer's original camera input.
            ...(placement ?? {
              left: frame ? ((tile.x - (tile.phaseX || 0)) * frameRatio + frame.view.x * frame.dpr) / frame.dpr : 0,
              top: frame ? ((tile.y - (tile.phaseY || 0)) * frameRatio + frame.view.y * frame.dpr) / frame.dpr : 0,
              width: frame ? (tile.width * frameRatio) / frame.dpr : 0,
              height: frame ? (tile.height * frameRatio) / frame.dpr : 0,
            }),
            zIndex: layer ?? (tile.lod ? 0 : 1),
            pointerEvents: 'none',
            visibility: active && ready === kind ? 'visible' : 'hidden',
          }}
        />
      ))}
    </>
  )
}, (prev, next) => {
  // Value comparison: tile objects are stable residents (mutated only to drop
  // their CPU payload); placement/underlay are rebuilt per render, so their
  // geometry fields and source identity are compared instead of identity.
  if (
    prev.tile !== next.tile || prev.color !== next.color || prev.owner !== next.owner ||
    prev.onReady !== next.onReady || prev.onGone !== next.onGone ||
    prev.onError !== next.onError || prev.publishLod !== next.publishLod ||
    prev.active !== next.active || prev.layer !== next.layer
  )
    return false
  const f = prev.frame, g = next.frame
  const frameEqual =
    (f === g) || (!!f && !!g && f.view.x === g.view.x && f.view.y === g.view.y &&
      f.view.zoom === g.view.zoom && f.dpr === g.dpr &&
      f.ids.has(next.tile.key) === g.ids.has(next.tile.key))
  if (!frameEqual) return false
  const p = prev.placement, q = next.placement
  const placementEqual = (p === q) || (!!p && !!q && p.left === q.left && p.top === q.top &&
    p.width === q.width && p.height === q.height)
  if (!placementEqual) return false
  const u = prev.underlay, v = next.underlay
  return (u === v) || (!!u && !!v && u.canvas === v.canvas && u.sx === v.sx && u.sy === v.sy &&
    u.sw === v.sw && u.sh === v.sh)
})

/** Keep an immutable completed frame as a camera-reprojected preview while
 * current tiles refine above it. Only a complete, synchronized plan certifies
 * the requested exact frame; temporary CSS transforms never change sampling. */
export function ProgressiveSurfaceImpl(
  props: SurfaceProps & {
    backend: BackendPreference
    onFallback: (message: string) => void
    paused?: boolean
    visible?: boolean
  },
) {
  const { document: doc, pageId, view, width, height, backend } = props
  const capability = useDisplayCapability()
  // HDR presentation follows the pinned host policy (default off). Managed
  // computation remains linear; with HDR off its final tiles arrive as encoded
  // SDR bytes, so no float display payload or managed presenter is requested.
  const hdrCompositing = renderExecutionPolicy.hdrCompositing
  const singleCanvas = typeof WebGL2RenderingContext !== 'undefined' && !(hdrCompositing && doc.colorManagement)
  const displayCapability = hdrCompositing && doc.colorManagement ? capability : undefined
  const latestContext = useRef(props)
  latestContext.current = props
  const client = useRef<KernelClient | null>(null)
  const [rasterClient, setRasterClient] = useState<KernelClient | null>(null)
  const residentDisplay = singleCanvas && allowsResidentSdr(renderExecutionPolicy, backend) && !!navigator.gpu &&
    import.meta.env.VITE_DESIGN_RESIDENT_DISPLAY !== '0'
  const [mailbox] = useState(() => new RenderMailbox())
  const rasterOwner = useRef<object | null>(null)
  const fillOwner = useRef<{ contract: object; key: string } | null>(null)
  const previousFillView = useRef<SurfaceProps['view'] | undefined>(undefined)
  const previewAdmission = useRef<{ contract?: object; key?: string; active: boolean }>({ active: false })
  const startupPreviewAttempt = useRef<object | null>(null)
  const [owner] = useState(displayOwner)
  const [tiles, setTiles] = useState<Map<string, PaintedTile>>(() => new Map())
  const tileRef = useRef(tiles),
    ready = useRef(new Set<string>())
  const presentationOwnership = useRef(new PresentationOwnership())
  const [pageResidency] = useState(() => new PageResidencyCache<PaintedTile>(32 * 1024 * 1024, 3, tile => {
    tile.bitmap?.close(); tile.bitmap = undefined
  }))
  const pageOwner = useRef({ document: doc, pageId, scope: '' })
  const desired = useRef<string[]>([])
  const activePlanKey = useRef('')
  const overviewKeys = useRef(new Set<string>())
  const overviewReuses = useRef(0)
  const protectedKeys = useRef(new Set<string>())
  const coverageRetention = useRef(new CoverageRetention())
  const coverageBootstrap = useRef(0)
  const revision = useRef(0),
    serial = useRef(0),
    navigation = useRef(0)
  const navigationTiming = useRef<{ key: string; started: number; firstDetailMs?: number; completeMs?: number }>({ key: '', started: 0 })
  const rasterTrace = useRef<{ kind: string; scale: number; cameraFallback?: boolean; tiles?: number; total: number; compile: number; graph: number; finish: number; checkpoint: number }[]>([])
  /** Document whose patch the worker has most recently applied (confirmed by
   * a damage report or a clean render). Residents are trusted until then. */
  const syncedDoc = useRef<SurfaceProps['document'] | null>(null)
  // Immutable coarse canvases are borrowed by mounted Tiles. Cache eviction
  // never invalidates a render-selected source before its effect can draw it.
  const [lodSnapshots] = useState(() => new LodSnapshotCache())
  const [stats, setStats] = useState({
    actualBackend: '' as TileResult['backend'] | '',
    rendered: 0,
    viewportRendered: 0,
    hits: 0,
    coarseHits: 0,
    ms: 0, compileMs: 0, graphMs: 0, finishMs: 0, checkpointMs: 0,
    pipelineWallMs: 0, preparationWaitMs: 0, overlappedPreparations: 0, compiledPacketHits: 0, compiledPacketBytes: 0,
    cacheBytes: 0,
    managed: false,
    complete: false,
    completeKey: '',
  })
  const [failure, setFailure] = useState('')
  const [displayRetry, setDisplayRetry] = useState(0)
  const displayRetries = useRef<{ key: string; attempts: number; timer?: ReturnType<typeof setTimeout> }>({ key: '', attempts: 0 })
  const [displayed, setDisplayed] = useState<DisplayFrame | null>(null)
  const acknowledged = useRef<{view:SurfaceProps['view'];width:number;height:number;dpr:number;interaction:boolean;ids:Set<number>} | undefined>(undefined)
  const activePlan = useRef<DisplayFrame | null>(null)
  /** Active viewport-distance/frame-budget fill scheduler (tile-scheduler).
   * Replaced per render request; cancelled when the plan is superseded. */
  const activeFill = useRef<TileFillScheduler | null>(null)
  /** Last scheduler counter snapshot for the telemetry data attributes. */
  const scheduleCounters = useRef<TileFillCounters | null>(null)
  /** Failed payloads remain incomplete. Keep the previous complete frame until
   * a retry or another backend supplies every requested tile. */
  const failedTiles = useRef(new Set<string>())
  const commitReady = () => {
    const plan = activePlan.current
    const actual=acknowledged.current
    const presented = !residentDisplay || !!plan && !!actual && !actual.interaction && actual.width===plan.width &&
      actual.height===plan.height && actual.dpr===plan.dpr && actual.view.x===plan.view.x && actual.view.y===plan.view.y &&
      actual.view.zoom===plan.view.zoom && [...plan.ids].every(key=>actual.ids.has(tileRef.current.get(key)?.gpuTile || -1))
    if (!navigationZoom.active && !latestContext.current.paused && syncedDoc.current === doc && plan && plan.key === frameKey && plan.document === doc &&
        presented && plan.ids.size && [...plan.ids].every((key) => ready.current.has(key))) {
      if (navigationTiming.current.key === plan.key && navigationTiming.current.completeMs === undefined)
        navigationTiming.current.completeMs = performance.now() - navigationTiming.current.started
      const residents = new Map([...plan.ids].flatMap((key) => {
        const tile = tileRef.current.get(key)
        return tile ? [[key, tile] as const] : []
      }))
      setDisplayed(previous => previous?.key === plan.key && previous.document === doc &&
        [...residents].every(([key, value]) => previous.residents.get(key) === value)
        ? previous : { ...plan, residents })
      // After an atomic resize/DPR swap the old full frame no longer needs
      // protection. Retire history now, rather than retaining a large-monitor
      // allocation above the new viewport's allowance until another delivery.
      const budget = displayTileBudget(plan.width, plan.height, plan.samplingDensity, plan.managed)
      coverageRetention.current.retain({ revision: plan.revision,
        bounds: { x: -plan.view.x / plan.view.zoom, y: -plan.view.y / plan.view.zoom,
          width: plan.width / plan.view.zoom, height: plan.height / plan.view.zoom },
        keys: plan.ids, bytes: [...residents.values()].reduce((sum, tile) => sum + tileResidentBytes(tile), 0),
      }, budget)
      let bytes = [...tileRef.current.values()].reduce((sum, tile) => sum + tileResidentBytes(tile), 0)
      const evicted = new Set<string>()
      for (const [key, tile] of tileRef.current) {
        if (bytes <= budget) break
        if (plan.ids.has(key) || coverageRetention.current.has(key)) continue
        if (tile.overview && tile.document === doc) continue
        bytes -= tileResidentBytes(tile)
        evicted.add(key)
      }
      if (evicted.size) dropTiles(key => evicted.has(key))
    }
  }
  const commitRef = useRef(commitReady)
  commitRef.current = commitReady
  const rasterProfile = props.rasterProfile || doc.rasterProfile || (doc.colorManagement ? 'figma' : 'analytic')
  const cameraDependent = tileComputationDependsOnCamera({ rasterProfile,
    pixelPreview: props.pixelPreview, grid: props.grid, checkerboard: props.checkerboard }, !!doc.colorManagement)
  // Raster options can change without an authored document patch. They own
  // separate residents; a world key alone must not reuse another contract.
  const identity = JSON.stringify([doc.id, pageId, props.presentationEpoch || 0, backend,
    !!props.grid, !!props.checkerboard, props.pixelPreview || 0, rasterProfile, displayCapability, hdrCompositing])
  const pageScope = JSON.stringify([doc.id, props.presentationEpoch || 0, backend,
    !!props.grid, !!props.checkerboard, props.pixelPreview || 0, rasterProfile, displayCapability, hdrCompositing])
  const navigationZoom = useNavigationZoom(view, identity, singleCanvas && !props.paused && props.visible !== false &&
    !props.interaction?.active && !props.grid && !props.checkerboard && !props.pixelPreview && !hdrCompositing)
  const latestNavigationZoom = useRef(navigationZoom)
  latestNavigationZoom.current = navigationZoom
  const zooming=useZoomActivity(view.zoom,identity)
  const cameraMoving = useCameraActivity(view, identity)
  const motionPreview=residentDisplay&&zooming&&!props.interaction?.active&&!props.grid&&!props.checkerboard&&!props.pixelPreview&&
    import.meta.env.VITE_DESIGN_VIEWPORT_PREVIEW!=='0'
  const lastIdentity = useRef(identity)
  const contract = useMemo(
    () => ({ revision: ++revision.current }),
    [
      // Names do not affect pixels. Preserve the raster epoch, but publish a
      // new document reference only after its worker synchronization completes.
      doc.id, doc.schemaVersion, doc.nodes, doc.pages, doc.fonts,
      doc.designSystem, doc.colorManagement, doc.rasterProfile, doc.animations,
      pageId,
      backend,
      props.grid,
      props.checkerboard,
      props.pixelPreview,
      props.rasterProfile,
      props.presentationEpoch,
      displayCapability,
    ],
  )
  useLayoutEffect(() => {
    lodSnapshots.beginRevision(contract.revision)
  }, [contract.revision, lodSnapshots])
  const dpr = useDevicePixelRatio()
  const detailLevel = view.zoom * dpr
  const stableDensity = useRasterDensity(detailLevel, identity)
  // Camera motion starts useful raster work now. During zoom, a small density
  // headroom keeps completed work sharp across adjacent input frames. The
  // exact requested density replaces it once the camera settles.
  const nativeSampling = !!(props.pixelPreview || props.grid || props.checkerboard)
  // Filter support grows with density as well as viewport area. Rendering a
  // speculative larger density can cross the surface limit before the exact
  // requested density is even scheduled. Keep full screen density for these
  // documents, without oversampling a future camera that may never be used.
  const filteredContent = useMemo(() => pageHasFilteredContent(doc, pageId), [doc.nodes, doc.pages, pageId])
  const samplingScale = nativeSampling || filteredContent ? detailLevel : zooming && !cameraDependent && singleCanvas
    ? motionRasterScale(view, dpr, width, height)
    : canvasSamplingScale(view, dpr, width, height, stableDensity, hdrCompositing && !!doc.colorManagement)
  const samplingDpr = nativeSampling ? dpr : samplingScale / view.zoom
  const priorRasterPlan = activePlan.current
  // contract.revision includes node/font/resource/color/profile changes; the
  // remaining fields prevent cross-page/session/backend/presentation reuse.
  const retainNativePanPhase = !zooming && priorRasterPlan?.document === doc &&
    priorRasterPlan.revision === contract.revision && priorRasterPlan.pageId === pageId &&
    priorRasterPlan.epoch === (props.presentationEpoch || 0) &&
    priorRasterPlan.computeBackend === backend && priorRasterPlan.displayCapability === displayCapability &&
    priorRasterPlan.managed === (hdrCompositing && !!doc.colorManagement) &&
    preservesNativePanPhase(view, dpr, samplingScale, cameraDependent, priorRasterPlan)
  const rasterPlan = canvasRasterPlan(view, samplingDpr, width, height, {
    rasterProfile, pixelPreview: props.pixelPreview, checkerboard: props.checkerboard,
    grid: props.grid, hdr: hdrCompositing && !!doc.colorManagement,
    samplingScale: nativeSampling ? undefined : samplingScale,
    exactPhase: (!cameraMoving && !zooming) || retainNativePanPhase,
  })
  const renderScale = rasterPlan.scale
  const renderCamera = rasterPlan.camera
  const renderPhase = rasterPlan.phase
  // Budget the sampled pixels, including density headroom and a held frame.
  const displayBudget = (() => {
    try {
      return Math.max(displayTileBudget(width, height, rasterPlan.density, hdrCompositing && !!doc.colorManagement),
        displayed ? displayTileBudget(displayed.width, displayed.height, displayed.samplingDensity || displayed.dpr, displayed.managed) : 0)
    }
    catch { return 128 * 1024 * 1024 }
  })()
  // Both density and coverage are measured in world units. A high zoom alone
  // does not increase the number of device pixels needed to cover the screen.
  const maxTiles = budgetTileLimit(displayBudget, hdrCompositing && !!doc.colorManagement)
  const lodScale = canvasLodScale(view.zoom, dpr, width, height, maxTiles)
  // The coarse LOD layer quantizes onto its own bucket's pattern period; the
  // effect's render pass and the per-tile underlay key must share one value
  // or the snapshot borrow misses.
  const coarsePeriod = patternCameraPeriod(lodScale, {
    pixelPreview: props.pixelPreview, grid: props.grid, checkerboard: props.checkerboard, cameraDependent: cameraDependent,
  })
  const coarseCamera = { x: snapPatternAxis(Math.floor(view.x * dpr * (lodScale / detailLevel)), coarsePeriod),
    y: snapPatternAxis(Math.floor(view.y * dpr * (lodScale / detailLevel)), coarsePeriod), zoom: lodScale }
  const lodActive = detailLevel / lodScale >= 1.02
  const frameKey = JSON.stringify([
    contract.revision,
    width,
    height,
    view.x,
    view.y,
    view.zoom,
    dpr,
    renderScale,
    renderPhase.x,
    renderPhase.y,
  ])
  if (navigationTiming.current.key !== frameKey)
    navigationTiming.current = { key: frameKey, started: performance.now() }
  const requestedView = props.requestedView || view
  const phaseExact = canvasRasterPhaseMatches(view, dpr, renderScale, renderPhase)
  const complete = !navigationZoom.active && phaseExact && displayed?.key === frameKey && displayed.document === doc &&
    stableDensity === detailLevel &&
    syncedDoc.current === doc && view.x === requestedView.x &&
    view.y === requestedView.y && view.zoom === requestedView.zoom
  const terminalQualityState = useRef({ key: '', complete: false, sequence: 0 })
  if (complete && (!terminalQualityState.current.complete || terminalQualityState.current.key !== frameKey))
    terminalQualityState.current.sequence = ++nextTerminalQualitySequence
  terminalQualityState.current.complete = complete; terminalQualityState.current.key = frameKey
  const diagnosticPage = useRef({id:pageId,token:1})
  if(diagnosticPage.current.id!==pageId)diagnosticPage.current={id:pageId,token:diagnosticPage.current.token+1}
  const diagnosticContent = useRef({frame:displayed,at:performance.now()})
  if(diagnosticContent.current.frame!==displayed)diagnosticContent.current={frame:displayed,at:performance.now()}
  useEffect(()=>{
    rasterClient?.recordViewportDiagnostic({pageToken:diagnosticPage.current.token,
      phase:navigationZoom.suspended?3:navigationZoom.active?1:complete?4:2,
      navigating:navigationZoom.active,targetDensity:detailLevel,effectiveDensity:renderScale,
      phaseX:renderPhase.x,phaseY:renderPhase.y,finalComplete:complete,
      retainNativePanPhase:!!retainNativePanPhase,cameraDependent,samplingMode:rasterPlan.mode==='native'?1:2,
      qualityRevision:contract.revision,dpr,
      oldContentAgeMs:displayed?performance.now()-diagnosticContent.current.at:0,
      state:displayed?1:0,x:view.x,y:view.y,zoom:view.zoom,width,height,
      sceneReady:syncedDoc.current===doc})
  },[rasterClient,pageId,view.x,view.y,view.zoom,width,height,navigationZoom.active,navigationZoom.suspended,complete,detailLevel,renderScale,renderPhase.x,renderPhase.y,displayed,doc,retainNativePanPhase,cameraDependent,rasterPlan.mode,contract.revision,dpr])
  const requestedContract = {
    document: doc, pageId, epoch: props.presentationEpoch || 0, view: requestedView,
    width, height, pixelRatio: dpr, grid: props.grid, checkerboard: props.checkerboard,
    pixelPreview: props.pixelPreview, rasterProfile: props.rasterProfile,
    displayCapability, computeBackend: backend, managed: hdrCompositing && !!doc.colorManagement,
  }
  const reusableFrame = tilePreviewContractMatches(displayed ? {
    ...displayed, pixelRatio: displayed.dpr,
  } : null, requestedContract)
  const readyHandler = useRef((id: string, serial: number, managed: boolean) => {
    if (tileRef.current.get(id)?.serial !== serial) return
    const tile = tileRef.current.get(id)!
    tile.bytes = new Uint8Array(0)
    tile.linear = undefined
    ready.current.add(id)
    failedTiles.current.delete(id)
    setTiles(new Map(tileRef.current))
    commitRef.current()
    setStats((s) => ({
      ...s,
      managed,
      completeKey: activePlanKey.current,
      complete:
        desired.current.length > 0 && desired.current.every((key) => ready.current.has(key)),
    }))
  }).current
  const goneHandler = useRef((id: string, serial: number) => {
    if (tileRef.current.get(id)?.serial !== serial) return
    ready.current.delete(id)
    if (desired.current.includes(id)) setStats((s) => ({ ...s, complete: false }))
  }).current
  const publishLod = useRef((revision: number, key: string, canvas: HTMLCanvasElement) => {
    lodSnapshots.publish(revision, key, canvas)
  }).current
  const dropTiles = useRef((evict: (key: string, tile: PaintedTile) => boolean) => {
    const victims = [...tileRef.current].filter(([key, tile]) => evict(key, tile))
    if (!victims.length) return false
    const map = new Map(tileRef.current)
    for (const [key, tile] of victims) {
      map.delete(key)
      ready.current.delete(key)
      tile.bitmap?.close()
      tile.bitmap = undefined
    }
    tileRef.current = map
    setTiles(map)
    return true
  }).current
  const errorHandler = useRef((id: string, serial: number, message: string) => {
    if (tileRef.current.get(id)?.serial !== serial) return
    recordRenderDiagnostic({ kind: 'error', errorCode: renderDiagnosticError(message) })
    // Failed display payloads cannot be considered resident cache hits on a
    // subsequent request for the same camera. Unrelated old work cannot label
    // a newer completed frame as failed.
    dropTiles((_key, tile) => tile.key === id)
    if (desired.current.includes(id)) {
      // A missing display tile cannot certify a complete frame. Retain the
      // published residents and report the failure without publishing a hole.
      failedTiles.current.add(id)
      setStats((s) => ({
        ...s,
        complete: false,
      }))
      setFailure(message)
      latestContext.current.onRenderFailure?.()
      if (shouldUseExactCpuFallback(latestContext.current.backend, message)) {
        clearTimeout(displayRetries.current.timer)
        latestContext.current.onFallback(String(message))
        return
      }
      const key = activePlanKey.current
      if (displayRetries.current.key !== key) {
        clearTimeout(displayRetries.current.timer)
        displayRetries.current = { key, attempts: 0 }
      }
      const retry = displayRetries.current, token = navigation.current
      if (retry.attempts < 2 && retry.timer === undefined) {
        retry.attempts++
        retry.timer = setTimeout(() => {
          retry.timer = undefined
          if (navigation.current === token && client.current && failedTiles.current.size)
            setDisplayRetry(value => value + 1)
        }, 250)
      }
    }
  }).current
  const damageHandler = useRef((damage: TileDamage) => {
    // Patch damage arrives before the request's tiles: evict stale residents
    // so replacements are accepted and untouched ones keep their pixels.
    if (damage.full) { pageResidency.clear(); coverageRetention.current.clear(); dropTiles(() => true) }
    else dropTiles((_key, tile) => { const r=tileWorldRect(tile);return paintDamageIntersects(damage,[r.x,r.y,r.width,r.height]) })
  }).current
  useEffect(() => {
    client.current = new KernelClient()
    setRasterClient(client.current)
    client.current.onDamage = damageHandler
    return () => {
      clearTimeout(displayRetries.current.timer)
      client.current?.dispose()
      client.current = null
      presentationOwnership.current.clear()
      owner.dispose()
      lodSnapshots.clear()
      pageResidency.clear()
    }
  }, [owner, lodSnapshots, damageHandler])
  useEffect(() => {
    if (rasterClient && props.navigationInputOwner && !props.paused && props.visible !== false)
      return rasterClient.bindNavigationInput(props.navigationInputOwner)
  }, [rasterClient, props.navigationInputOwner, props.paused, props.visible])
  useLayoutEffect(() => {
    const old = pageOwner.current
    const invalidated = pageResidency.synchronize(doc, pageScope)
    if (lastIdentity.current !== identity) {
      // Take the destination first: admitting the outgoing page must not evict
      // the very page being revisited. No content edit or resource replacement
      // can reuse old pixels, even when document/page IDs are unchanged.
      const restored = pageResidency.take(pageId)
      const retain = !invalidated && old.document === doc && old.scope === pageScope && syncedDoc.current === doc
        ? [...tileRef.current.values()].filter(tile => ready.current.has(tile.key) && tile.document === doc) : []
      if (retain.length) pageResidency.store(old.pageId, retain,
        retain.reduce((sum, tile) => sum + tileResidentBytes(tile), 0))
      const retained = new Set(pageResidency.values())
      coverageRetention.current.clear()
      dropTiles((_key, tile) => !retained.has(tile))
      const map = new Map((restored || []).map(tile => {
        // Pixels and serial stay unchanged, preserving the existing compositor
        // upload. Only the new active raster contract's bookkeeping changes.
        tile.revision = contract.revision
        return [tile.key, tile] as const
      }))
      tileRef.current = map
      ready.current = new Set(map.keys())
      activePlan.current = null
      acknowledged.current = undefined
      syncedDoc.current = restored?.length ? doc : null
      setTiles(map)
      setDisplayed(null)
      lastIdentity.current = identity
    }
    pageOwner.current = { document: doc, pageId, scope: pageScope }
  }, [identity, doc, pageScope, contract.revision, dropTiles, pageResidency])
  useEffect(() => {
    const c = client.current
    if (!c || width <= 0 || height <= 0) return
    const token = ++navigation.current
    coverageRetention.current.trim(contract.revision, displayBudget)
    const previousView = previousFillView.current
    previousFillView.current = view
    let cancelOverview: (() => void) | undefined
    // Panning within a density does not invalidate world pixels. Finish the
    // running batch; discard queued old plans and admit the latest view.
    const fillKey = navigationZoom.active ? `navigation-preview:${width}:${height}:${dpr}` :
      JSON.stringify([renderScale, renderCamera.x, renderCamera.y, width, height, dpr, !!props.paused])
    if (fillOwner.current?.contract !== contract || fillOwner.current.key !== fillKey) {
      c.cancelTileFill()
      fillOwner.current = { contract, key: fillKey }
    }
    activePlanKey.current = frameKey
    if (rasterOwner.current !== contract) {
      c.cancelPreview()
      rasterOwner.current = contract
    }
    if (previewAdmission.current.active && !navigationZoom.active) c.cancelPreview()
    previewAdmission.current.active = navigationZoom.active
    desired.current = []
    if (!navigationZoom.active) activePlan.current = null
    setStats((s) => ({ ...s, complete: false }))
    if (props.paused || navigationZoom.suspended) return
    setFailure('')
    recordRenderDiagnostic({ kind: 'request', zoom: view.zoom, dpr,
      requestedDensity: view.zoom * dpr, sampledDensity: renderScale })
    const viewport = {
      x: -view.x / view.zoom,
      y: -view.y / view.zoom,
      width: width / view.zoom,
      height: height / view.zoom,
    }
    const sameContent = () =>
      !latestContext.current.paused &&
      rasterOwner.current === contract &&
      client.current === c &&
      latestContext.current.document === doc &&
      latestContext.current.pageId === pageId &&
      latestContext.current.presentationEpoch === props.presentationEpoch &&
      latestContext.current.backend === backend
    const current = () => sameContent() && navigation.current === token
    // A new document with no pixels gets one complete viewport preview before
    // progressive detail. Revisited cameras and edits with retained coverage
    // do not pay for a second full-scene render.
    const needsStartupPreview = singleCanvas && !hdrCompositing && !props.grid && !props.checkerboard &&
      !props.pixelPreview && !reusableFrame && startupPreviewAttempt.current !== contract &&
      ![...tileRef.current.values()].some(tile => tile.document === doc && tile.revision === contract.revision &&
        ready.current.has(tile.key) && tileIntersectsView(tile, requestedView, { width, height }))
    const render = (...args: Parameters<KernelClient['render']>) => mailbox.run(current, () => c.render(...args))
    const receive = (tile: TileResult) => {
      if (!sameContent()) {
        tile.bitmap?.close()
        if (tile.gpuTile) c.releasePresented([tile.gpuTile])
        return
      }
      presentationOwnership.current.track(tile.gpuTile)
      recordRenderDiagnostic({ kind: 'tile', zoom: view.zoom, dpr,
        requestedDensity: view.zoom * dpr, sampledDensity: tile.zoom,
        cacheHits: tile.cached ? 1 : 0, cacheMisses: tile.cached ? 0 : 1,
        totalMs: tile.milliseconds, compileMs: tile.compileMs, graphMs: tile.graphMs,
        finishMs: tile.finishMs, checkpointMs: tile.checkpointMs })
      if (import.meta.env.DEV) {
        rasterTrace.current.push({kind:tile.viewportPreview?'preview':tile.prefetch?'prefetch':'tile',scale:tile.zoom,cameraFallback:tile.cameraFallback,
          total:tile.milliseconds||0,compile:tile.compileMs||0,graph:tile.graphMs||0,finish:tile.finishMs||0,checkpoint:tile.checkpointMs||0})
        if(rasterTrace.current.length>256)rasterTrace.current.shift()
      }
      const entry: PaintedTile = {
        ...tile,
        overview: overviewKeys.current.has(tile.key),
        revision: contract.revision,
        serial: ++serial.current,
        document: doc,
        // Without the HDR policy bit the worker returns encoded SDR bytes,
        // including after managed linear computation; claiming color here would
        // make the painter demand float data that cannot arrive.
        color: hdrCompositing ? doc.colorManagement : undefined,
        ...(tile.viewportPreview || tile.zoom !== renderScale ? { lod: true } : {}),
      }
      if (!tile.viewportPreview && !tile.prefetch && tile.zoom === renderScale && navigationTiming.current.firstDetailMs === undefined)
        navigationTiming.current.firstDetailMs = performance.now() - navigationTiming.current.started
      setStats((s) => ({
        ...s,
        actualBackend: tile.backend,
        rendered: s.rendered + (tile.cached ? 0 : 1),
        viewportRendered: s.viewportRendered + (tile.cached || tile.prefetch || entry.lod ? 0 : 1),
        hits: s.hits + (tile.cached ? 1 : 0),
      }))
      const map = new Map(tileRef.current)
      // World-canonical keys are stable across edits: a re-delivery replaces
      // the resident (patch-damaged) content rather than being skipped.
      map.get(tile.key)?.bitmap?.close()
      ready.current.delete(tile.key)
      failedTiles.current.delete(tile.key)
      // m5.makeLeastRecent clears the generation stamp and puts prefetch at
      // the LRU tail. Merely omitting protection left fresh prefetch ahead of
      // hot history and evicted the zoom level the user was returning to.
      map.delete(tile.key)
      if (tile.prefetch) {
        const rest = [...map]
        map.clear(); map.set(tile.key, entry)
        for (const [key, value] of rest) map.set(key, value)
      } else map.set(tile.key, entry)
      const held = displayed ? [...displayed.residents.values()].filter((tile) => map.get(tile.key) !== tile) : []
      let bytes = [...map.values(), ...held].reduce(
        (n, t) => n + tileResidentBytes(t),
        0,
      )
      // Inactive pages are lower priority than the active viewport. Their
      // bytes are not an extra allowance above the existing display ceiling.
      pageResidency.trim(displayBudget - bytes)
      // Keep current visible tiles, evict oldest offscreen/history entries first.
      for (const [key, old] of map) {
        if (bytes <= displayBudget) break
        if (protectedKeys.current.has(key) || displayed?.ids.has(key) || coverageRetention.current.has(key)) continue
        if (old.overview && old.document === doc) continue
        bytes -= tileResidentBytes(old)
        map.delete(key)
        ready.current.delete(key)
        old.bitmap?.close()
      }
      if (bytes > displayBudget) throw new Error('显示瓦片缓存预算超限')
      tileRef.current = map
      setTiles(map)
    }
    const request = async (plan: RasterTile[], prefetch: { rim: RasterTile[]; cacheLimitSkipped: number; protect?: boolean } = { rim: [], cacheLimitSkipped: 0 },
      bootstrapCoverage?: () => Promise<void>) => {
      protectedKeys.current = new Set([...plan, ...(prefetch.protect ? prefetch.rim : [])].map((t) => t.key))
      // Idle prefetch stays evictable. During pan, the bounded leading edge is
      // briefly protected too, so cache pressure cannot evict each new tile
      // just before it enters the viewport.
      const isResident = (t: RasterTile) => !!tileRef.current.has(t.key) && !!ready.current.has(t.key)
      const resident = plan.filter(isResident)
      // Touch on-screen residents, not prefetch hits. Insertion-only eviction
      // otherwise discards frequently revisited zoom levels before cold rim tiles.
      if (resident.length) {
        const touched = new Map(tileRef.current)
        for (const tile of resident) {
          const value = touched.get(tile.key)!
          touched.delete(tile.key)
          touched.set(tile.key, value)
        }
        tileRef.current = touched
        setTiles(touched)
      }
      const missing = plan.filter((t) => !isResident(t))
      recordRenderDiagnostic({ kind: 'cache', zoom: view.zoom, dpr,
        requestedDensity: view.zoom * dpr, sampledDensity: renderScale,
        cacheHits: resident.length, cacheMisses: missing.length })
      const rimMissing = prefetch.rim.filter((t) => !isResident(t))
      const rimResident = prefetch.rim.length - rimMissing.length
      if (resident.length + rimResident)
        setStats((s) => ({ ...s, hits: s.hits + resident.length + rimResident }))
      // Camera revisits with an unchanged document and full residency (plan
      // and rim) commit from existing pixels alone; no worker round trip is
      // needed. Rim tiles warmed by an earlier prefetch count as hits.
      if (!missing.length && !rimMissing.length && !prefetch.cacheLimitSkipped) {
        commitRef.current()
        return
      }
      if (!missing.length) commitRef.current()
      const submitChunk = async (chunk: RasterTile[]) => {
        // A prefetch-only chunk is best-effort cache warming, like the coarse
        // LOD layer: a failed off-screen raster must not fail the canvas
        // whose on-screen tiles are the certification path. Cancellation
        // rejections land here too and are absorbed once the superseding plan
        // has already cancelled this scheduler.
        const prefetchOnly = chunk.length > 0 && chunk.every((t) => t.prefetch === true)
        let result: Awaited<ReturnType<typeof c.render>> | undefined
        try {
          result = await mailbox.run(current, () => {
            // A previous in-flight batch may have delivered these tiles while
            // this latest plan waited for the worker. Do not rasterize twice.
            const pending = chunk.filter(tile => !isResident(tile))
            if (!pending.length) return Promise.resolve(undefined)
            const ordered = prioritizeUncoveredTiles(pending,
              [...tileRef.current.values()].filter(tile => tile.document === doc &&
                tile.revision === contract.revision && ready.current.has(tile.key)), viewport)
            return c.render(
            doc,
            {
              pageId,
              width: Math.ceil(width * dpr),
              height: Math.ceil(height * dpr),
              view: renderCamera,
              transparent: false,
              grid: props.grid, checkerboard: props.checkerboard,
              pixelPreview: props.pixelPreview || undefined,
              rasterProfile,
              tileViewport: ordered,
              tilePrepareViewport: import.meta.env.VITE_DESIGN_PREPARE_CACHE === '0' ? undefined :
                tileBatchPrepareViewport(plan, prefetch.rim, ordered, renderCamera),
              renderIntent: 'canvas',
              ...(props.presentationEpoch === undefined ? {} : {
                tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
              }),
            },
            false,
            backend,
            false,
            false,
            undefined,
            receive,
          )
          })
        } catch (error) {
          if (prefetchOnly) {
            console.debug('[tile-scheduler] prefetch chunk dropped', error)
            return
          }
          throw error
        }
        if (current() && result) {
          syncedDoc.current = doc
          commitRef.current()
          setStats((s) => ({
            ...s,
            ms: result.milliseconds,
            compileMs: result.compileMs, graphMs: result.graphMs || 0,
            pipelineWallMs: result.pipelineWallMs || 0, preparationWaitMs: result.preparationWaitMs || 0,
            overlappedPreparations: s.overlappedPreparations + (result.overlappedPreparations || 0), compiledPacketHits: s.compiledPacketHits + (result.compiledPacketHits || 0),
            compiledPacketBytes: result.compiledPacketBytes || 0,
            finishMs: result.finishMs || 0, checkpointMs: result.checkpointMs || 0,
            cacheBytes: result.tileCacheBytes || 0,
          }))
        }
      }
      // When the visible view is already ready, finish its bounded leading
      // edge in one interruptible worker batch. Submitting only one offscreen
      // tile per superseded camera plan can starve the other edge rows.
      if (prefetch.protect && !missing.length) {
        if (rimMissing.length) await submitChunk(rimMissing)
        return
      }
      // Viewport-distance priority + per-frame budget (Figma viewer scheduler
      // alignment, see tile-scheduler.ts): on-screen tiles submit in full,
      // exempt from the budget; off-screen tiles defer frame by frame under
      // the 16 ms / 2-rasterization budget without ever dropping a request.
      // The fill set is viewport misses plus prefetch-rim misses — the rim is
      // geometrically outside the viewport, so the scheduler's two phases
      // deliver every on-screen tile first and pace the rim with the budget.
      activeFill.current?.cancel()
      const scheduler = new TileFillScheduler({
        submit: async tiles => {
          // Batch protocol/serialization overhead. The worker yields at every
          // completed tile for latest poses and cancellation of stale cameras.
          const batch = import.meta.env.VITE_DESIGN_TILE_BATCH === '1' ? 1 : cameraMoving && !zooming ? 4 : 32
          // Rank the full center-out queue before slicing: a visible hole in
          // a later batch must beat already-covered center refinement. Keep
          // the submit-time residency check for tiles delivered while waiting
          // on the mailbox, and leave the shared prepare/halo extent intact.
          const ordered = prioritizeUncoveredTiles(tiles,
            [...tileRef.current.values()].filter(tile => tile.document === doc &&
              tile.revision === contract.revision && ready.current.has(tile.key)), viewport)
          for (let i = 0; i < ordered.length && current(); i += batch)
            await submitChunk(ordered.slice(i, i + batch))
        },
        viewport,
        budget: tileFrameBudgetOptionsFromHost(),
        onCutoff: (reason, counters) => {
          scheduleCounters.current = { ...counters, cutoffs: { ...counters.cutoffs } }
          // TODO(telemetry): no centralized telemetry sink exists on this
          // surface yet; counters surface through the .kernel-tiles data
          // attributes below until one is wired.
          console.debug('[tile-scheduler]', reason, {
            frames: counters.frames,
            deferred: counters.deferredTiles,
            cacheSkipped: counters.cacheSkippedTiles,
          })
        },
      })
      activeFill.current = scheduler
      try {
        // Rim tiles the planner dropped for the cache allowance are accounted
        // once per plan (Figma offscreenHitCacheLimit_ parity); the event is
        // recorded even when no tile is left to fill.
        if (prefetch.cacheLimitSkipped) scheduler.recordOffscreenCacheLimitSkips(prefetch.cacheLimitSkipped)
        if (missing.length || rimMissing.length)
          await scheduler.fill(bootstrapCoverage ? missing : [...missing, ...rimMissing])
      } finally {
        scheduleCounters.current = {
          ...scheduler.counters,
          cutoffs: { ...scheduler.counters.cutoffs },
        }
        if (activeFill.current === scheduler) activeFill.current = null
      }
      // Cover the viewport once at its native lattice before spending the
      // serialized queue on a page backing. The former native-band detour
      // rasterized these same pixels twice and delayed visible tile completion.
      // Ready tiles are already published as they arrive; the backing remains
      // interruptible coverage maintenance for later uncached navigation.
      if (current() && bootstrapCoverage) await bootstrapCoverage()
    }
    const failed = (error: unknown) => {
      if (!current()) return
      if (/device lost|GPU device|has been lost|设备已丢失|上下文已丢失|worker.*(?:failed|error)/i.test(String(error))) {
        pageResidency.clear()
        setTiles(new Map(tileRef.current))
      }
      recordRenderDiagnostic({ kind: 'error', zoom: view.zoom, dpr,
        requestedDensity: view.zoom * dpr, errorCode: renderDiagnosticError(error) })
      if (String(error).includes('PREVIEW_CANCELLED')) return
      // Recovery changes the renderer, not the fact that this GPU request failed.
      // Keep failure observers informed before handing off to the CPU surface.
      latestContext.current.onRenderFailure?.()
      if (shouldUseExactCpuFallback(backend, error))
        props.onFallback(String(error))
      else setFailure(String(error))
    }
    let runAttempts = 0
    let navigationRequest: string | undefined
    const run = async () => {
      try {
        if (navigationZoom.active) {
          const sample = navigationZoom.sample
          if (!sample) return
          const ratio = navigationPreviewDensity(dpr, width, height), scale = sample.view.zoom * ratio
          // A coarse overview supplies continuity, not navigation-tier detail.
          // Skip expensive filtered captures only when retained pixels cover
          // the viewport at the sampling density this sample would produce.
          // Keep low-density pixels visible while that bounded refresh runs.
          const retained = filteredContent ? [...tileRef.current.values()].filter(tile =>
            tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key)) : []
          if (retained.length && tilesCoverBounds(retained, viewport, scale)) {
            if (previewAdmission.current.key !== 'covered-navigation') c.cancelPreview()
            previewAdmission.current = { contract, key: 'covered-navigation', active: true }
            return
          }
          // Continuous zoom owns a separate transient lane. Do not plan,
          // compile or rasterize intermediate native-density tile levels.
          navigationRequest = JSON.stringify([sample.sequence, width, height, dpr])
          if (previewAdmission.current.contract === contract && previewAdmission.current.key === navigationRequest) return
          previewAdmission.current = { contract, key: navigationRequest, active: true }
          const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio))
          const requested = () => sameContent() && latestNavigationZoom.current.active &&
            latestNavigationZoom.current.sample?.sequence === sample.sequence &&
            previewAdmission.current.contract === contract && previewAdmission.current.key === navigationRequest
          activePlan.current = {
            key: frameKey, revision: contract.revision, document: doc, view: { ...sample.view }, dpr, width, height,
            rasterScale: scale, samplingDensity: ratio, samplingMode: 'native', pageId,
            epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
            rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
            ids: new Set(), residents: new Map(),
          }
          const result = await mailbox.run(requested, () => c.render(doc, {
            pageId, width: w, height: h,
            view: { x: sample.view.x * ratio, y: sample.view.y * ratio, zoom: scale },
            transparent: false, grid: false, rasterProfile, livePreview: true, renderIntent: 'preview',
          }, false, backend, false))
          if (!sameContent() || !latestNavigationZoom.current.active) {
            result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile]); return
          }
          syncedDoc.current = doc
          // Every sampled viewport owns distinct pixels and an independent upload.
          // Do not replace the last acknowledged preview while the new one is
          // importing: provisional previews are not held by displayed.residents.
          // The ordinary byte-budgeted LRU bounds this compatible history.
          receive({ key: `navigation-preview:${contract.revision}:${serial.current + 1}`, x: -sample.view.x * ratio,
            y: -sample.view.y * ratio, width: w, height: h, zoom: scale, gutter: 0, viewportPreview: true,
            bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile, backend: result.backend,
            description: result.description || '', milliseconds: result.milliseconds, cached: false })
          return
        }
        // Planning now calls Rust on the main thread. Its module must be
        // initialized before the first blank frame, independently of the worker.
        await initializeKernelModule()
        if (!current()) return
        const budget = displayTileBudget(width, height, rasterPlan.density, hdrCompositing && !!doc.colorManagement)
        // Prefetch rim (Figma off-screen prefetch parity, see tile-plan-aligned
        // .ts): the exact plan keeps its viewport-only semantics for frame
        // completion; rim tiles ride the same request as budget-gated
        // off-screen work. rings=0 reproduces the pre-rim plan byte-for-byte.
        const planned = planTilesWithPrefetchRim(viewport, renderScale, budgetTileLimit(
          budget, hdrCompositing && !!doc.colorManagement), renderPhase, tilePrefetchRingsFromHost())
        // Stable world samples reuse pixels within a density level; native
        // pixel/chrome paths retain their explicit camera phase.
        const rekey = (tile: RasterTile) => ({ ...tile, key: tileComputationKey(tile, renderCamera, cameraDependent) })
        const plan = planned.viewport.map(rekey)
        const rim = planned.rim.map(rekey)
        const prefetch = props.interaction?.selection.length || zooming ? {rim:[],cacheLimitSkipped:0} :
          cameraMoving ? { rim: cameraDependent ? [] : panPrefetch(rim, previousView, view, viewport), cacheLimitSkipped: 0, protect: true } :
          { rim, cacheLimitSkipped: planned.cacheLimitSkipped }
        desired.current = plan.map((t) => t.key)
        failedTiles.current.clear()
        activePlan.current = {
          key: frameKey, revision: contract.revision, document: doc, view: { ...view }, dpr, width, height,
          rasterScale: renderScale, samplingDensity: rasterPlan.density, samplingMode: rasterPlan.mode,
          pageId, epoch: props.presentationEpoch || 0, grid: props.grid, checkerboard: props.checkerboard,
          pixelPreview: props.pixelPreview, rasterProfile: props.rasterProfile,
          managed: hdrCompositing && !!doc.colorManagement, displayCapability, computeBackend: backend,
          ids: new Set(desired.current),
          residents: new Map(),
        }
        commitRef.current()
        // Apply and acknowledge the patch before selecting resident misses.
        // Damage messages precede this zero-tile completion, including when
        // earlier cancelled requests had already applied their patches. Thus
        // stale resident keys captured before damage never skip real work.
        if (syncedDoc.current !== doc) {
          const synchronized = await render(doc, { pageId, width: Math.ceil(width * dpr), height: Math.ceil(height * dpr),
            view: renderCamera, transparent: false, grid: props.grid, checkerboard: props.checkerboard,
            pixelPreview: props.pixelPreview || undefined, rasterProfile, tileViewport: [], renderIntent: 'canvas',
            ...(props.presentationEpoch === undefined ? {} : {
              tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
            }),
          }, false, backend, false, false, undefined, receive)
          if (!current()) return
          syncedDoc.current = doc
          if (synchronized.retainedCommit) {
            const committed = [...tileRef.current.values()].find(tile => tile.committedViewport &&
              tile.document === doc && tile.revision === contract.revision && tile.zoom >= detailLevel * .999 &&
              tilesCoverBounds([tile], viewport))
            if (committed && activePlan.current?.key === frameKey) {
              desired.current = [committed.key]
              activePlan.current.ids = new Set(desired.current)
              setStats(s => ({ ...s, ms: synchronized.milliseconds, compileMs: 0, completeKey: frameKey }))
              commitRef.current()
              return
            }
          }
          commitRef.current()
        }
        if (needsStartupPreview) {
          startupPreviewAttempt.current = contract
          const ratio = navigationPreviewDensity(dpr, width, height), scale = view.zoom * ratio
          const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio))
          try {
            const result = await render(doc, { pageId, width: w, height: h,
              view: { x: view.x * ratio, y: view.y * ratio, zoom: scale },
              transparent: false, grid: false, rasterProfile, livePreview: true, renderIntent: 'preview',
            }, false, backend, false)
            if (!sameContent()) {
              result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile]); return
            }
            receive({ key: `startup-preview:${contract.revision}`, x: -view.x * ratio, y: -view.y * ratio,
              width: w, height: h, zoom: scale, gutter: 0, viewportPreview: true,
              bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile, backend: result.backend,
              description: result.description || '', milliseconds: result.milliseconds, cached: false })
          } catch (error) {
            if (/device lost|GPU device|has been lost|设备已丢失|recovery failed/i.test(String(error)) ||
              !/PREVIEW_BUDGET|GPU.*(?:budget|预算)|Invalid GPU viewport|GPU 区域超过安全限制/i.test(String(error))) throw error
            // The worker preserves existing residents on this optional failure.
            // Keep the UI placeholder until the atomic exact frame is ready.
          }
          if (!current()) return
        }
        // Existing same-revision pixels already follow the camera. Spend the
        // serialized render queue on native detail instead of a second blurry
        // full-screen sample; the overview below still supplies uncovered areas.
        const hasVisibleResidents = [...tileRef.current.values()].some(tile => tile.document === doc &&
          tile.revision === contract.revision && ready.current.has(tile.key) &&
          tileIntersectsView(tile, requestedView, { width, height }))
        // Partial coverage still requests native tiles, with uncovered areas
        // first. A second full-scene preview must not delay that repair.
        if(!needsStartupPreview&&allowsReducedSampling(view.zoom)&&motionPreview&&!hasVisibleResidents&&!plan.every(tile=>tileRef.current.has(tile.key)&&ready.current.has(tile.key))){
          // This is a screen-space, full-viewport preview, not the page's
          // fixed-size overview. It remains transient until exact tiles land.
          const density=Math.min(dpr,1.5,Math.sqrt(2_097_152/Math.max(1,width*height)),4096/Math.max(width,height))
          const key=`motion:${contract.revision}:${JSON.stringify([view,width,height,density])}`
          const stillRequested=()=>{
            const next=latestContext.current.requestedView||latestContext.current.view
            return sameContent()&&next.x===view.x&&next.y===view.y&&next.zoom===view.zoom
          }
          for(const factor of tileRef.current.has(key)&&ready.current.has(key) ? [] : [1,.8,.5,.25]){
            const ratio=density*factor,scale=view.zoom*ratio,w=Math.max(1,Math.ceil(width*ratio)),h=Math.max(1,Math.ceil(height*ratio))
            try{
              const result=await mailbox.run(stillRequested,()=>c.render(doc,{pageId,width:w,height:h,
                view:{x:view.x*ratio,y:view.y*ratio,zoom:scale},transparent:false,grid:false,rasterProfile,
                livePreview:true,renderIntent:'preview'},false,backend,false))
              receive({key,x:-view.x*ratio,y:-view.y*ratio,width:w,height:h,zoom:scale,gutter:0,viewportPreview:true,
                bytes:result.bytes,bitmap:result.bitmap,gpuTile:result.gpuTile,backend:result.backend,
                description:result.description||'',milliseconds:result.milliseconds,cached:false})
              break
            }catch(error){
              if(String(error).includes('PREVIEW_CANCELLED'))return
              if(!/PREVIEW_BUDGET|GPU.*(?:budget|预算)/i.test(String(error)))throw error
              if(!stillRequested())return
            }
          }
          // A covering preview never replaces exact work. Continue into the
          // native tile plan in the same request instead of waiting for the
          // gesture's next React effect to start refinement.
        }
        // A bounded page overview covers large zoom-outs and previously unseen
        // portions of a board. It owns real world pixels, not a viewport crop.
        // Preserve it through cache pressure until its content is invalidated.
        const currentCoverage = () => tilesCoverBounds([...tileRef.current.values()].filter(tile =>
          tile.document === doc && ready.current.has(tile.key)), viewport)
        // A committed drag keeps its kernel-rendered interaction layer above
        // the previous complete page until exact tiles take over. That is
        // already a covering preview; don't queue an overview and another LOD
        // ahead of the missing detail. Other edits need normal coverage.
        const movement = props.interaction
        const gestureCoverage = !!movement && movement.document === doc && !!movement.control.current?.isActive() &&
          movement.control.current.covers(doc,movement.selection,view) && !!displayed &&
          displayed.document.id===doc.id && displayed.pageId===pageId && displayed.epoch===(props.presentationEpoch||0) &&
          tilesCoverBounds([...displayed.residents.values()],viewport)
        const hasCoverage = currentCoverage() || gestureCoverage
        const extent = props.overview
        const pageFitsView = !!extent && viewport.x <= extent.x && viewport.y <= extent.y &&
          viewport.x + viewport.width >= extent.x + extent.width &&
          viewport.y + viewport.height >= extent.y + extent.height
        const warmOverview = () => {
          const overview = props.overview
          if (overview && overview.width > 0 && overview.height > 0) {
            const scale = Math.min(1, 512 / Math.max(overview.width, overview.height))
            // Startup already retained a sharper, tiled page backing. Do not
            // compile the entire page again just to create a lower-density key.
            // Only pinned, ready, current-content overview residents qualify;
            // incidental viewport coverage may be evicted during the next pan.
            if (hasRetainedOverview(tileRef.current.values(), ready.current, doc, contract.revision, overview, scale)) {
              overviewReuses.current++
              return
            }
            const overviewCamera = { x: 0, y: 0, zoom: scale }
            const overviewPlan = planTilesAligned(overview, scale, 9).map(tile => ({ ...tile,
              key: `overview:${tileComputationKey(tile, overviewCamera, cameraDependent)}` }))
            overviewKeys.current = new Set(overviewPlan.map(tile => tile.key))
            const missing = overviewPlan.filter(tile => !tileRef.current.has(tile.key) || !ready.current.has(tile.key))
            cancelOverview = scheduleRasterMaintenance(missing, tile =>
              render(doc, { pageId, width: Math.ceil(width * dpr), height: Math.ceil(height * dpr),
                view: overviewCamera, transparent: false, grid: props.grid, checkerboard: props.checkerboard,
                rasterProfile, renderIntent: 'preview', tileViewport: [tile],
                tilePrepareViewport: tilePrepareViewport(overviewPlan, overviewCamera),
                ...(props.presentationEpoch === undefined ? {} : {
                  tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
                }),
              }, false, backend, false, false, undefined, receive),
              () => current() && plan.every(tile => ready.current.has(tile.key)),
              error => console.debug('[overview] optional maintenance dropped', error))
          }
        }
        // Visible pixels always start before whole-page maintenance. Retained
        // residents and progressive exact deliveries remain on screen while
        // cold areas fill; never clear them to wait for an overview.
        if (!current()) return
        // A retained frame already covering the new viewport is the preview.
        // Do not rasterize another coarse frame before starting missing detail.
        const retainedCoverage = reusableFrame && displayed &&
          tilesCoverBounds([...displayed.residents.values()], viewport, displayed.rasterScale)
        if (displayed && allowsReducedSampling(view.zoom) && lodActive && !retainedCoverage && !hasCoverage && !currentCoverage()) {
          try {
            // Coarse bucket layer first: a world-aligned grid (phase 0) whose
            // camera view is rescaled into the bucket's pixel space, so the
            // per-tile compile stays self-consistent at the coarse zoom.
            const coarse = planTilesAligned(viewport, lodScale, budgetTileLimit(
              budget, hdrCompositing && !!doc.colorManagement), { x: 0, y: 0 })
              .map(tile => ({ ...tile, key: tileComputationKey(tile, coarseCamera, cameraDependent) }))
            const coarseResident = coarse.filter(
              (t) => tileRef.current.has(t.key) && ready.current.has(t.key),
            )
            // The transient coarse layer shares the exact layer's viewport-distance
            // order (on-screen first, nearest first); it stays one request.
            const coarseRank = prioritizeTileFill(
              coarse.filter((t) => !tileRef.current.has(t.key) || !ready.current.has(t.key)),
              viewport,
            )
            const coarseMissing = coarseRank.onScreen
            if (coarseResident.length)
              setStats((s) => ({ ...s, coarseHits: s.coarseHits + coarseResident.length }))
            if (coarseMissing.length && current())
              await render(
                doc,
                {
                  pageId,
                  width: Math.ceil(width * dpr),
                  height: Math.ceil(height * dpr),
                  view: coarseCamera,
                  transparent: false,
                  grid: props.grid, checkerboard: props.checkerboard,
                  pixelPreview: props.pixelPreview || undefined,
                  rasterProfile,
                  // The worker streams and checks cancellation after each
                  // tile. One batch shares preparation across the whole view.
                  tileViewport: coarseMissing,
                  tilePrepareViewport: tilePrepareViewport(coarseMissing, coarseCamera),
                  renderIntent: 'preview',
                  ...(props.presentationEpoch === undefined ? {} : {
                    tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
                  }),
                },
                false,
                backend,
                false,
                false,
                undefined,
                receive,
              )
          } catch {
            // The coarse layer is transient acceleration; only the exact
            // plan may fail the canvas.
          }
        }
        if (!current()) return
        const bootstrap = !displayed && residentDisplay && !cameraDependent && extent && !pageFitsView &&
          !props.interaction?.active && coverageBootstrap.current !== contract.revision ? async () => {
          coverageBootstrap.current = contract.revision
          const scale = Math.min(renderScale, 2046 / Math.max(extent.width, extent.height))
          if (!Number.isFinite(scale) || scale < .001 || extent.width <= 0 || extent.height <= 0) return
          const w = Math.ceil(extent.width * scale) + 2, h = Math.ceil(extent.height * scale) + 2
          const camera = { x: 1 - extent.x * scale, y: 1 - extent.y * scale, zoom: scale }
          const phase = { x: camera.x - Math.floor(camera.x), y: camera.y - Math.floor(camera.y) }
          const backing = planTilesAligned(extent, scale, 32, phase).map(tile => ({ ...tile,
            key: `overview:startup:${contract.revision}:${tileComputationKey(tile, camera, cameraDependent)}` }))
          for (const tile of backing) overviewKeys.current.add(tile.key)
          try {
            // Keep the same scale and sample phase as the former monolithic
            // backing. Regional compilation bounds GPU passes and lets newer
            // input run between tiles; preparation is shared across the batch.
            await mailbox.run(current, () => c.render(doc, { pageId, width: w, height: h,
              view: camera, transparent: false, grid: false, rasterProfile, renderIntent: 'preview',
              coverageTiles: true, tileViewport: backing, tilePrepareViewport: tilePrepareViewport(backing,camera),
              ...(props.presentationEpoch === undefined ? {} : {
                tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
              }),
            }, false, backend, false, false, undefined, receive))
          } catch (error) {
            // Preserve visible native work when the optional backing exceeds
            // scene/GPU limits; ordinary exact tile repair remains authoritative.
            console.debug('[coverage] startup backing unavailable', String(error))
          }
        } : undefined
        await request(plan, prefetch, bootstrap)
        // A selected object is about to move (or is warming its live scene).
        // A monolithic overview tile cannot be preempted inside WASM, so do
        // not put it behind selection warm-up and ahead of the first pose.
        if (!pageFitsView && !cameraMoving && !props.interaction?.selection.length && current()) warmOverview()
        if (current()) {
          setStats((s) => ({
            ...s,
            completeKey: activePlanKey.current,
            complete: desired.current.every((key) => ready.current.has(key)),
          }))
        }
      } catch (error) {
        if (navigationRequest && previewAdmission.current.contract === contract && previewAdmission.current.key === navigationRequest)
          previewAdmission.current.key = undefined
        // A bounded navigation preview is optional. Preserve current resident
        // pixels under pressure; only final exact refinement is authoritative.
        if (navigationZoom.active && !/device lost|GPU device|has been lost|设备已丢失|recovery failed/i.test(String(error)) &&
          /PREVIEW_BUDGET|GPU.*(?:budget|预算)|Invalid GPU viewport|GPU 区域超过安全限制/i.test(String(error))) return
        // Cached pages are expendable under device pressure, before retiring
        // current-page coverage or retrying an exact visible request.
        const retiredPages = current() && isDisplayBudgetError(error) && pageResidency.size > 0
        if (retiredPages) { pageResidency.clear(); setTiles(new Map(tileRef.current)) }
        // Reclaim only history; the last displayed frame and incoming visible
        // tiles stay pinned. Retry once after React has presented/released the
        // retired handles, without increasing the device budget.
        if (current() && isDisplayBudgetError(error) && runAttempts++ < 1 &&
          (retiredPages || dropTiles((key, tile) => !protectedKeys.current.has(key) && !displayed?.ids.has(key) &&
            !coverageRetention.current.has(key) && !tile.overview))) {
          requestAnimationFrame(() => { if (current()) void run() })
          return
        }
        failed(error)
        // A transient worker/GPU failure must not pin the canvas on the
        // previous document's pixels until the next camera move; retry the
        // same plan a bounded number of times before leaving the error up.
        if (current() && /device lost|GPU device|设备已丢失|上下文已丢失|worker.*(?:failed|error)/i.test(String(error)) && runAttempts++ < 2)
          setTimeout(() => { if (current()) void run() }, 500)
      }
    }
    // Figma mP defers density changes by two observed frames. Translation
    // does not reset that countdown and exposed tiles start immediately.
    void run()
    return () => {
      navigation.current++
      cancelOverview?.()
      activeFill.current?.cancel()
      // Already submitted same-content tiles remain useful across navigation.
      // The mailbox drops superseded queued requests before worker execution.
    }
  }, [
    doc,
    pageId,
    backend,
    contract,
    width,
    height,
    view.x,
    view.y,
    view.zoom,
    props.grid,
    props.checkerboard,
    props.pixelPreview,
    props.rasterProfile,
    props.maxPixelRatio,
    props.paused,
    props.interaction?.active,
    props.interaction?.selection.join(','),
    motionPreview,
    cameraMoving,
    displayRetry,
    dpr,
    stableDensity,
    // Zoom may settle while panning stays active and density admission has
    // already caught up. The final exact-scale plan still needs scheduling,
    // including bitmap/WebGL paths whose motionPreview flag never changes.
    renderScale,
    renderPhase.x,
    renderPhase.y,
    navigationZoom.active,
    navigationZoom.sample?.sequence,
    navigationZoom.suspended,
    mailbox,
    props.overview?.x,
    props.overview?.y,
    props.overview?.width,
    props.overview?.height,
  ])
  // Cached canvases stay mounted offscreen, so a revisit does not repaint pixels.
  const activeResidents = [...new Set([...tiles.values(), ...(displayed?.residents.values() || [])])]
  const inactiveResidents = pageOwner.current.document === doc && pageOwner.current.scope === pageScope
    ? pageResidency.values() : []
  const inactiveSet = new Set(inactiveResidents)
  const visible = [...new Set([...activeResidents, ...inactiveResidents])]
  useLayoutEffect(() => {
    if (pageResidency.trim(displayBudget - activeResidents.reduce((sum, tile) => sum + tileResidentBytes(tile), 0)))
      setTiles(new Map(tileRef.current))
  })
  useLayoutEffect(() => {
    // Child layout effects have already queued their new display frame. Keep
    // both rendered residents and deliveries newer than this React render.
    const retired = presentationOwnership.current.retireExcept(
      [...visible, ...tileRef.current.values()].map(tile => tile.gpuTile),
    )
    if (retired.length) client.current?.releasePresented(retired)
  })
  const plan = activePlan.current
  const currentPlan = !!plan && plan.key === frameKey && plan.document === doc &&
    plan.pageId === pageId && plan.epoch === (props.presentationEpoch || 0)
  // A document edit cannot interleave old and new revisions. Camera-only
  // refinement may mix precision levels because every level owns the same doc.
  const fullPlanReady = currentPlan && !!plan?.ids.size && [...plan.ids].every(key=>ready.current.has(key)) && syncedDoc.current===doc
  const canRefine = !displayed || reusableFrame || fullPlanReady
  const startupPreview = !displayed && visible.some(tile => tile.viewportPreview &&
    tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key))
  const fineTile = (tile: PaintedTile) => tileRef.current.get(tile.key) === tile && canRefine && currentPlan &&
    (!startupPreview || fullPlanReady) &&
    !!plan?.ids.has(tile.key) && ready.current.has(tile.key) &&
    (syncedDoc.current === doc || tile.document === doc)
  const coarseTile = (tile: PaintedTile) => tileRef.current.get(tile.key) === tile && canRefine && !complete &&
    tile.lod === true && tile.document === doc && tile.revision === contract.revision &&
    lodActive && tile.zoom === lodScale && tileIntersectsView(tile, requestedView, { width, height })
  // Residents at previously visited exact scales also cover a zoom gesture.
  // Keep their real sampling keys: reprojection supplies temporary coverage,
  // while only a fully covered plan at or above screen density can publish a sharp frame.
  const cachedPreviewTile = (tile: PaintedTile) => !complete && canRefine &&
    (!startupPreview || !plan?.ids.has(tile.key)) &&
    tileRef.current.get(tile.key) === tile && tile.document === doc &&
    tile.revision === contract.revision && ready.current.has(tile.key) &&
    !fineTile(tile) && !coarseTile(tile) && tileIntersectsView(tile, requestedView, { width, height })
  const lodVisibleCount = visible.filter((tile) => coarseTile(tile) && ready.current.has(tile.key)).length
  const fineVisibleCount = visible.filter((tile) => fineTile(tile) &&
    tileIntersectsView(tile, requestedView, { width, height })).length
  const cachedPreviewCount = visible.filter(cachedPreviewTile).length
  const baseVisibleCount = visible.filter((tile) => displayed?.residents.get(tile.key) === tile).length
  // Camera reprojection is a CSS placement of already-sampled pixels: it does
  // not depend on the frame matching the requested document contract. Without
  // the base-resident term, any edit/resize/dpr change froze the published
  // camera on the old frame until a full exact plan committed — the "zoom has
  // no effect" regression. Stale-document pixels reprojected at the live
  // camera are strictly closer to intent than a frozen viewport.
  const cameraPreview = props.visible !== false && !props.paused && !complete &&
    (reusableFrame || lodVisibleCount > 0 || fineVisibleCount > 0 || cachedPreviewCount > 0 || baseVisibleCount > 0)
  const visual = cameraPreview && plan ? (reusableFrame ? displayed : plan) : displayed
  // Keep child layout anchored to the completed camera. A gesture changes one
  // compositor transform, instead of every resident canvas's layout rectangle.
  const placementView = displayed?.view || view
  const cameraTransform = frameTransform(requestedView, placementView)
  const presentation = visual ? {
    view: cameraPreview ? requestedView : visual.view,
    document: visual.document, pageId: visual.pageId, epoch: visual.epoch,
    width: visual.width, height: visual.height, pixelRatio: visual.dpr, managed: visual.managed,
    grid: visual.grid, checkerboard: visual.checkerboard, pixelPreview: visual.pixelPreview, rasterProfile: visual.rasterProfile,
    displayCapability: visual.displayCapability, computeBackend: visual.computeBackend, preview: !!cameraPreview,
  } : null
  useLayoutEffect(() => {
    // Offscreen GPU submission is asynchronous. Only its reply can publish
    // the camera; synchronous CSS/WebGL placement keeps this immediate path.
    if (!residentDisplay) props.onPresentation?.(presentation)
  }, [visual, cameraPreview, requestedView, props.onPresentation, residentDisplay])
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: doc.pages.find((p) => p.id === pageId)?.background || '#eeeff3',
          visibility: props.visible === false ? 'hidden' : 'visible',
        }}
      />
      <div
        className="kernel-tiles" data-raster-planner="rust" data-checkerboard={String(!!props.checkerboard)}
        aria-hidden="true"
        data-sampling-mode={displayed?.samplingMode ?? rasterPlan.mode}
        data-raster-profile={rasterProfile}
        data-sampling-scale={displayed?.rasterScale ?? renderScale}
        data-sampling-density={displayed?.samplingDensity ?? rasterPlan.density}
        data-native-pixel-ready={String(complete && rasterPlan.mode === 'native')}
        data-raster-phase-exact={String(phaseExact)}
        data-startup-preview={String(startupPreview)}
        data-renderer={stats.actualBackend || 'initializing'}
        data-tile-count={tiles.size}
        data-page-cache-bytes={pageResidency.bytes}
        data-page-cache-pages={pageResidency.size}
        data-page-cache-hits={pageResidency.hits}
        data-cache-hits={stats.hits}
        data-tiles-rendered={stats.rendered}
        data-viewport-tiles-rendered={stats.viewportRendered}
        data-cache-bytes={stats.cacheBytes}
        data-tile-schedule-frames={scheduleCounters.current?.frames ?? 0}
        data-tile-schedule-onscreen={scheduleCounters.current?.onScreenSubmitted ?? 0}
        data-tile-schedule-offscreen={scheduleCounters.current?.offScreenSubmitted ?? 0}
        data-tile-schedule-deferred={scheduleCounters.current?.deferredTiles ?? 0}
        data-tile-budget-cutoffs={scheduleCounters.current?.cutoffs.offscreenHitBudget ?? 0}
        data-tile-budget-completions={scheduleCounters.current?.cutoffs.completedScreenTiles ?? 0}
        data-tile-budget-cache-cutoffs={scheduleCounters.current?.cutoffs.offscreenHitCacheLimit ?? 0}
        data-tile-cache-skipped-tiles={scheduleCounters.current?.cacheSkippedTiles ?? 0}
        data-tile-prefetch-rings={tilePrefetchRingsFromHost()}
        data-resident-bytes={visible.reduce(
          (n, t) => n + tileResidentBytes(t),
          0,
        )}
        data-resident-budget={displayBudget}
        data-refine-ms={stats.ms.toFixed(2)}
        data-raster-trace={import.meta.env.DEV ? JSON.stringify(rasterTrace.current) : undefined}
        data-navigation-ms={navigationTiming.current.completeMs?.toFixed(2)}
        data-first-detail-ms={navigationTiming.current.firstDetailMs?.toFixed(2)}
        data-compile-ms={stats.compileMs.toFixed(2)}
        data-pipeline-wall-ms={stats.pipelineWallMs.toFixed(2)}
        data-preparation-wait-ms={stats.preparationWaitMs.toFixed(2)}
        data-overlapped-preparations={stats.overlappedPreparations}
        data-compiled-packet-hits={stats.compiledPacketHits}
        data-compiled-packet-bytes={stats.compiledPacketBytes}
        data-graph-ms={stats.graphMs.toFixed(2)}
        data-finish-ms={stats.finishMs.toFixed(2)}
        data-checkpoint-ms={stats.checkpointMs.toFixed(2)}
        data-detail-ready={String(!props.paused && complete)}
        data-frame-publication={displayed ? 'complete' : 'pending'}
        data-retained-commit={String(!!displayed && [...displayed.residents.values()].some(tile => tile.committedViewport))}
        data-lod-scale={lodActive ? lodScale : 0}
        data-lod-tiles={lodVisibleCount}
        data-lod-cache-bytes={lodSnapshots.bytes}
        data-lod-cache-budget={lodSnapshots.maxBytes}
        data-lod-cache-hits={stats.coarseHits}
        data-preview-active={String(cameraPreview)}
        data-progressive-tiles={fineVisibleCount}
        data-failed-tiles={failedTiles.current.size}
        data-cached-preview-tiles={cachedPreviewCount}
        data-overview-tiles={visible.filter(tile => tile.overview && ready.current.has(tile.key)).length}
        data-overview-reuses={overviewReuses.current}
        data-resident-eligible={String(residentDisplay)}
        data-resident-reason={!singleCanvas ? 'single-canvas-unavailable' : !allowsResidentSdr(renderExecutionPolicy, backend) ? 'policy-or-backend' : !navigator.gpu ? 'webgpu-unavailable' : import.meta.env.VITE_DESIGN_RESIDENT_DISPLAY === '0' ? 'disabled' : 'eligible'}
        data-motion-preview={String(motionPreview)}
        data-motion-raster-scale={renderScale}
        data-camera-moving={String(cameraMoving)}
        data-navigation-pending-age-ms={navigationZoom.pendingAgeMs}
        data-navigation-zoom-active={String(navigationZoom.active)}
        data-navigation-zoom-sequence={navigationZoom.sample?.sequence || 0}
        data-viewport-preview-tiles={visible.filter(tile=>tile.viewportPreview&&cachedPreviewTile(tile)).length}
        data-native-capture-tiles={visible.filter(tile=>tile.nativeCapture&&ready.current.has(tile.key)).length}
        data-display-mode={singleCanvas ? 'single-gpu-canvas' : 'managed-tiles'}
        data-revision={displayed?.revision || 0}
        data-camera-x={displayed?.view.x ?? view.x}
        data-camera-y={displayed?.view.y ?? view.y}
        data-camera-zoom={displayed?.view.zoom ?? view.zoom}
        data-requested-camera-x={requestedView.x}
        data-requested-camera-y={requestedView.y}
        data-requested-camera-zoom={requestedView.zoom}
        data-requested-revision={contract.revision}
        data-pixel-ratio={displayed?.dpr || dpr}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: singleCanvas ? undefined : `translate(${cameraTransform.x}px,${cameraTransform.y}px) scale(${cameraTransform.scale})`,
          // Upload/acknowledge tiles while hidden. The first visible canvas
          // must have a complete acknowledged viewport, including on a page
          // change. Later camera previews keep the previous complete frame.
          visibility: props.visible === false || !displayed && cachedPreviewCount === 0 ? 'hidden' : 'visible',
          pointerEvents: 'none',
        }}
      >
        {singleCanvas ? (() => {
          const CompositeSurface = residentDisplay && rasterClient ? ResidentCompositeSurface : TileCompositeSurface
          return <CompositeSurface key={residentDisplay && rasterClient ? 'resident' : 'bitmap'} client={rasterClient!}
          items={visible.map(tile => {
            const fine = !inactiveSet.has(tile) && fineTile(tile), base = !inactiveSet.has(tile) && displayed?.residents.get(tile.key) === tile,
              coarse = !inactiveSet.has(tile) && coarseTile(tile), cached = !inactiveSet.has(tile) && cachedPreviewTile(tile)
            // CSS hides a replacement backend until it is ready. It must
            // still compose/acknowledge its real frame before that handoff.
            return { tile, gutter:tile.gutter??1,active: fine || base || coarse || cached,
              layer: progressiveTileLayer({ fine, cached, coarse, refining: !complete && canRefine, cameraDependent,
                sameContent: tile.document === doc && tile.revision === contract.revision }) }
          })}
          view={requestedView} width={width} height={height} dpr={dpr}
          presentation={presentation}
          terminalQuality={complete ? { qualitySequence: terminalQualityState.current.sequence,
            qualityRevision: contract.revision, pageToken: diagnosticPage.current.token } : undefined}
          overlay={props.overlay}
          sourceDocument={doc} translationItems={visible.filter(tile=>syncedDoc.current===doc&&tile.revision===contract.revision&&ready.current.has(tile.key))
            .map(tile=>({tile,active:true,layer:0}))} allowPageTranslation={!props.grid&&!props.checkerboard&&!props.pixelPreview}
          interaction={navigationZoom.active ? undefined : props.interaction} pageId={pageId} rasterProfile={rasterProfile} backend={backend}
          settledDocument={fullPlanReady ? doc : undefined}
          onPresented={(frame,source)=>{
            if (renderDiagnostics.recording) {
              const ids = new Set(frame.ids)
              // These are acknowledged texture sampling densities, not a
              // pixel-quality oracle. A received tile is not yet published.
              const densities = [...tileRef.current.values()]
                .filter(tile => tile.gpuTile !== undefined && ids.has(tile.gpuTile))
                .map(tile => tile.zoom)
              recordRenderDiagnostic({ kind: 'present', zoom: frame.view.zoom, dpr: frame.dpr,
                requestedDensity: requestedView.zoom * dpr,
                publishedDensity: densities.length ? Math.min(...densities) : undefined })
            }
            acknowledged.current={...frame,ids:new Set(frame.ids)};commitRef.current()
            if(source)props.onPresentation?.(source)
          }}
          onReady={readyHandler} onGone={goneHandler} onError={errorHandler}
          onFailure={message => {
            const errorCode = renderDiagnosticError(message)
            recordRenderDiagnostic({ kind: 'error', zoom: requestedView.zoom, dpr,
              requestedDensity: requestedView.zoom * dpr, errorCode })
            if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile') console.debug('DESIGN_PRESENTATION_FAILURE '+errorCode)
            setFailure(message); props.onRenderFailure?.();
            if (residentDisplay || backend === 'auto') props.onFallback(`PREVIEW_CPU_FALLBACK: ${message}`) }}
        /> })() : visible.map((tile) => {
          const fineVisible = !inactiveSet.has(tile) && fineTile(tile)
          const baseVisible = !inactiveSet.has(tile) && displayed?.residents.get(tile.key) === tile
          const lodVisible = !inactiveSet.has(tile) && coarseTile(tile)
          const cachedVisible = !inactiveSet.has(tile) && cachedPreviewTile(tile)
          // Per-tile coarse underlay: map this exact tile's device rect into
          // its covering coarse bitmap (same world, TILE_SIDE grid at the
          // bucket scale, minus the one-pixel gutter).
          let underlay: { canvas: HTMLCanvasElement; sx: number; sy: number; sw: number; sh: number } | undefined
          // The LOD layer already previews this world region while its coarse
          // tiles are visible; a second nearest-neighbor copy under the fine
          // tile doubles the same content with a different resampling kernel
          // (half-pixel ghosting during refinement). Underlays only fill when
          // the coarse layer itself has nothing on screen.
          if (tile.lod !== true && tile.revision === contract.revision && lodActive && !stats.complete && !tile.color && lodVisibleCount === 0) {
            const r = lodScale / renderScale
            const lx = Math.floor((tile.x * r) / TILE_SIDE)
            const ly = Math.floor((tile.y * r) / TILE_SIDE)
            const coarseKey = tileComputationKey({ ...tile,
              key: `${lodScale}:0:0:${lx}:${ly}` }, coarseCamera, cameraDependent)
            const canvas = lodSnapshots.borrow(tile.revision, coarseKey)
            if (canvas) {
              const sx = tile.x * r - (lx * TILE_SIDE - 1)
              const sy = tile.y * r - (ly * TILE_SIDE - 1)
              underlay = { canvas, sx, sy, sw: tile.width * r, sh: tile.height * r }
            }
          }
          return (
            <Tile
              key={`${tile.key}/${tile.serial}`}
              tile={tile}
              color={tile.color}
              owner={owner}
              onReady={readyHandler}
              onGone={goneHandler}
              onError={errorHandler}
              frame={displayed}
              active={props.visible !== false && (fineVisible || baseVisible || lodVisible || cachedVisible)}
              layer={fineVisible ? 3 : cachedVisible ? 2 : lodVisible ? 1 : 0}
              placement={fineVisible || lodVisible || baseVisible || cachedVisible
                ? tilePlacementAtView(tile, placementView) : undefined}
              underlay={underlay}
              publishLod={tile.lod === true ? publishLod : undefined}
            />
          )
        })}
      </div>
      {!props.paused && <div
        className={`kernel-status ${failure ? 'error' : ''}`}
        role="status"
        title={failure || '画布高清显示'}
        style={{
          position: 'absolute',
          right: 14,
          top: 'var(--kernel-status-top, 12px)',
          fontSize: 10,
          color: failure ? '#bd3b54' : '#777c8e',
          pointerEvents: 'auto',
          zIndex: 4,
        }}
      >
        {failure ||
          `${stats.actualBackend === 'webgl2' ? 'WebGL 2' : 'WebGPU'} · ${complete ? '清晰' : '计算中'}${stats.managed ? ' · 浮点' : ''}`}

      </div>}
    </>
  )
}

/** Memoized: pointer/hover churn in the hosting canvas must not re-render
 * the tile layer, and tile commits must not re-render through changed props. */
export const ProgressiveSurface = memo(ProgressiveSurfaceImpl, (prev, next) =>
  prev.document === next.document &&
  prev.pageId === next.pageId &&
  prev.width === next.width &&
  prev.height === next.height &&
  prev.view.x === next.view.x &&
  prev.view.y === next.view.y &&
  prev.view.zoom === next.view.zoom &&
  prev.grid === next.grid &&
  prev.checkerboard === next.checkerboard &&
  prev.pixelPreview === next.pixelPreview &&
  prev.rasterProfile === next.rasterProfile &&
  prev.animation === next.animation &&
  prev.interaction === next.interaction &&
  prev.overlay === next.overlay &&
  prev.presentationEpoch === next.presentationEpoch &&
  prev.paused === next.paused &&
  prev.visible === next.visible &&
  prev.backend === next.backend &&
  prev.maxPixelRatio === next.maxPixelRatio &&
  prev.onPresentation === next.onPresentation &&
  prev.onFallback === next.onFallback &&
  prev.onRenderFailure === next.onRenderFailure &&
  prev.navigationInputOwner === next.navigationInputOwner &&
  (prev.requestedView || prev.view).x === (next.requestedView || next.view).x &&
  (prev.requestedView || prev.view).y === (next.requestedView || next.view).y &&
  (prev.requestedView || prev.view).zoom === (next.requestedView || next.view).zoom &&
  (prev.overview?.x ?? 0) === (next.overview?.x ?? 0) &&
  (prev.overview?.y ?? 0) === (next.overview?.y ?? 0) &&
  (prev.overview?.width ?? 0) === (next.overview?.width ?? 0) &&
  (prev.overview?.height ?? 0) === (next.overview?.height ?? 0)
)
