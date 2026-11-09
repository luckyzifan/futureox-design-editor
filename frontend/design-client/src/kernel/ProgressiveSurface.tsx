import { navigationOverview, overviewWarmBatch } from './navigation-overview'
import { NavigationIntentOwner } from './navigation-intent-owner'
import { NativeNavigationHandoff, reusableNativeNavigationPreview, type NativeNavigationCapture } from './native-navigation-handoff'
import { NavigationBudgetLatch } from './navigation-budget-latch'
import { NavigationRefinementScheduler } from './navigation-refinement'
import { NavigationCost } from './navigation-cost'
import { initializeKernelModule } from './module'
import { shouldUseExactCpuFallback } from './cpu-fallback'
import { renderFailureFields } from './render-failure-telemetry'
import { isRecoverablePreviewBudget } from './preview-budget-recovery'
import { allowsResidentSdr, usesDesktopDisplay, usesProgressiveNativeRepair } from './render-policy'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SurfaceProps, PresentedFrame } from './Surface'
import { KernelClient, renderExecutionPolicy, type TileDamage, type TileResult } from './client'
import { paintDamageIntersects } from './paint-damage'
import { recordRenderDiagnostic, renderDiagnosticError, renderDiagnostics } from './render-diagnostics'
import type { BackendPreference } from './gpu/types'
import type { ColorPresenter } from './color-presenter'
import { TILE_SIDE, budgetTileLimit, displayTileBudget, tilesCoverBounds, type RasterTile } from './tile-cache'
import { planTilesAligned, planTilesWithPrefetchRim, tilePrefetchRingsFromHost } from './tile-plan-aligned'
import { preservesNativePanPhase, canvasLodScale, canvasRasterPlan, canvasRasterPhaseMatches, canvasSamplingScale, motionRasterScale, nativeTileMotionScale, gestureRasterScale, gestureViewportCapture } from './canvas-raster-plan'
import { pageHasFilteredContent } from './canvas-effect-sampling'
import { frameTransform, presentationMatches, useDevicePixelRatio, useDisplayCapability } from './presentation'
import { LodSnapshotCache } from './lod-snapshot-cache'
import { acceptNativeSample } from './frame-handoff'
import { previewCameraScaleWithinLimit, tileHasNativePhase, tileIntersectsView, tilePlacementAtView, tilePreviewContractMatches } from './tile-preview'
import { canvasStatusLabel } from '../canvas-status-label'
import { useRasterDensity } from './use-raster-density'
import { useZoomActivity, useCameraActivity } from './use-zoom-activity'
import { useSharpZoomActivity } from './use-sharp-zoom-activity'
import { useNavigationZoom } from './use-navigation-zoom'
import { navigationPreviewDensity } from './navigation-zoom'
import { navigationCoverageTiles, navigationHasCoverage, navigationCoverageFlight, navigationReadyDensity, previewUnderlayHides, retainedPressureError, type NavigationCoverageFlight } from './navigation-coverage'
import { RenderMailbox } from './render-mailbox'
import { scheduleRasterMaintenance } from './idle-raster-maintenance'
import { panPrefetch } from './pan-prefetch'
import { tilePrepareViewport, tileBatchPrepareViewport } from './tile-prepare-viewport'
import { TileCompositeSurface } from './TileCompositeSurface'
import { ResidentCompositeSurface } from './ResidentCompositeSurface'
import { PresentationOwnership } from './presentation-ownership'
import { PageResidencyCache, pageResidencyScope } from './page-residency-cache'
import { BitmapRetirement } from './bitmap-retirement'
import { estimatedTileResidencyBytes, TileResidencyLedger, PAGE_MEMORY_POLICIES, pageResidencyBudget } from './page-memory-policy'
import { useRenderMemoryTier } from '../page-memory-preference'
import { isDisplayBudgetError } from './gpu/display-budget'
import { progressiveTileLayer } from './progressive-quality'
import { hasRetainedOverview, completeViewportBacking } from './overview-coverage'
import { allowsReducedSampling } from './render-quality'
import { sharpZoomScale, usesSharpZoom } from './gpu/sharp-zoom-policy'
import { CoverageRetention } from './coverage-retention'
import { visibleCompositeContributors, touchCompositeContributors, type CompositeCacheFrame, type CompositeCacheOwner } from './composite-cache-use'
import { isTileAdmissionBudgetError, planTileAdmission, retireRejectedTile, HandledTileDeliveryError,
  replacementTileBudget, tileAdmissionDiagnostic, type TileAdmissionDiagnostic } from './tile-admission'
import { CompositeFrameWitness } from './composite-frame-witness'
import { prioritizeUncoveredTiles } from './coverage-priority'
import { selectCoverageUnderlay } from './coverage-stack'
import {
  prioritizeTileFill,
  TileFillScheduler,
  tileFrameBudgetOptionsFromHost,
  type TileFillCounters,
} from './tile-scheduler'
import { patternCameraPeriod, snapPatternAxis, tileComputationDependsOnCamera, tileComputationKey } from './tile-computation-key'
import { captureViewportPreview, reusableViewportPreview, viewportPreviewDeviceKey, viewportPreviewKey,
  type ViewportPreviewCacheEntry, type ViewportPreviewDevice, type ViewportPreviewIdentity } from './viewport-preview-cache'

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
  viewportCache?: ViewportPreviewCacheEntry
  /** A complete viewport result may atomically activate a new revision. This
   * records production ownership, not GPU completion or alpha opacity. */
  previewSource?: Readonly<{ contract: object; generation: number; client: KernelClient;
    view: Readonly<SurfaceProps['view']>; width: number; height: number; dpr: number; device?: string;
    precision: string; profile: string }>
  /** Native navigation may hand off only to the presenter known at capture. */
  nativeNavigationDevice?: string
  /** Stamped only for ready handles named by an actual presenter ACK. */
  residentDevice?: Readonly<{ client: object; key: string }>
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
  /** Preview activation preserves continuity, never certifies exact quality. */
  preview?: true
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
  const retainedEditing=(import.meta.env.VITE_DESIGN_RETAINED_INPUT_PRIORITY==='1'||
    import.meta.env.VITE_DESIGN_ACTIVE_GESTURE_PRIORITY!=='0'&&import.meta.env.VITE_DESIGN_RETAINED_INPUT_PRIORITY!=='0')&&!!props.interaction?.active&&
    props.interaction.document===doc&&!!props.interaction.control.current?.blocksCanvasRefinement?.(doc,props.interaction.selection,view)
  const capability = useDisplayCapability()
  // HDR presentation follows the pinned host policy (default off). Managed
  // computation remains linear; with HDR off its final tiles arrive as encoded
  // SDR bytes, so no float display payload or managed presenter is requested.
  const hdrCompositing = renderExecutionPolicy.hdrCompositing
  const previewPrecision = JSON.stringify([renderExecutionPolicy.desktopFullMath, renderExecutionPolicy.desktopDisplay,
    renderExecutionPolicy.hdrCompositing, renderExecutionPolicy.imageMips, renderExecutionPolicy.imageAtlas])
  const singleCanvas = typeof WebGL2RenderingContext !== 'undefined' && !(hdrCompositing && doc.colorManagement)
  const displayCapability = hdrCompositing && doc.colorManagement ? capability : undefined
  const latestContext = useRef(props)
  latestContext.current = props
  const client = useRef<KernelClient | null>(null)
  const [rasterClient, setRasterClient] = useState<KernelClient | null>(null)
  const residentDisplay = singleCanvas && allowsResidentSdr(renderExecutionPolicy, backend) && !!navigator.gpu &&
    import.meta.env.VITE_DESIGN_RESIDENT_DISPLAY !== '0'
  const [mailbox] = useState(() => new RenderMailbox())
  const [navigationRefinement] = useState(() => new NavigationRefinementScheduler(mailbox))
  const [translationRefinement] = useState(() => new NavigationRefinementScheduler(mailbox))
  type TranslationFill = {source:SurfaceProps['document'];offset:{x:number;y:number};sequence:number;failed:()=>void}
  const translationCoverage = useRef<((request:TranslationFill)=>boolean) | undefined>(undefined)
  const translationRequest = useRef<TranslationFill | undefined>(undefined)
  const rasterOwner = useRef<object | null>(null)
  const fillOwner = useRef<{ contract: object; key: string } | null>(null)
  const previousFillView = useRef<SurfaceProps['view'] | undefined>(undefined)
  const coverageDirection = useRef<{ contract?: object; zoomOut: boolean }>({ zoomOut: false })
  const coverageGeneration = useRef(0)
  const coverageFlight = useRef<NavigationCoverageFlight<PaintedTile> | null>(null)
  const previewAdmission = useRef<{ contract?: object; key?: string; active: boolean }>({ active: false })
  const [navigationIntentOwner] = useState(() => new NavigationIntentOwner())
  const [nativeNavigationHandoff] = useState(() => new NativeNavigationHandoff())
  const [navigationCost] = useState(() => new NavigationCost())
  const [navigationBudgetLatch] = useState(() => new NavigationBudgetLatch())
  const startupPreviewAttempt = useRef<object | null>(null)
  const [owner] = useState(displayOwner)
  const [tiles, setTiles] = useState<Map<string, PaintedTile>>(() => new Map())
  const tileRef = useRef(tiles),
    ready = useRef(new Set<string>())
  const presentationOwnership = useRef(new PresentationOwnership())
  const previewDevice = useRef<{ client: object | null; key?: string }>({ client: null })
  const previewReuseSequence = useRef(0)
  const [bitmapRetirement] = useState(() => new BitmapRetirement())
  // The last committed display can outlive same-key replacements in tileRef.
  // Keep its payload owners until React commits the successor display.
  const heldDisplay = useRef<DisplayFrame | null>(null)
  const memoryTier = useRenderMemoryTier()
  const memoryPolicy = PAGE_MEMORY_POLICIES[memoryTier]
  const [pageResidency] = useState(() => new PageResidencyCache<PaintedTile>(memoryPolicy.inactiveBytes, memoryPolicy.maxPages, tile => {
    bitmapRetirement.retire([tile], [...tileRef.current.values(), ...pageResidency.values(),
      ...(heldDisplay.current?.residents.values() || [])])
  }, estimatedTileResidencyBytes))
  const pageOwner = useRef({ document: doc, pageId, scope: '' })
  const desired = useRef<string[]>([])
  const activePlanKey = useRef('')
  const overviewKeys = useRef(new Set<string>())
  const nativePageBacking = useRef<{ contract: object; keys: Set<string> } | null>(null)
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
    pipelineWallMs: 0, preparationWaitMs: 0, overlappedPreparations: 0, frameResourceHits: 0, frameResourceBytes: 0,
    cacheBytes: 0,
    managed: false,
    complete: false,
    completeKey: '',
  })
  const [failure, setFailure] = useState('')
  const cacheAdmission = useRef({ reserveBytes: 0, admissionBudget: 0, activeHighWater: 0, totalHighWater: 0 })
  const [displayRetry, setDisplayRetry] = useState(0)
  const [sharpHeadroomBlocked, setSharpHeadroomBlocked] = useState<object | null>(null)
  const sequentialPending = useRef<{ contract: object; key: string; tile: RasterTile;
    scopeCurrent: () => boolean; cancel: () => void } | null>(null)
  const sequentialUnsupported = useRef<{ contract: object; captures: Set<string> } | null>(null)
  const sequentialRepair = useRef<{ contract: object; width: number; height: number; dpr: number; owner?: object } | null>(null)
  const displayRetries = useRef<{ key: string; attempts: number; timer?: ReturnType<typeof setTimeout> }>({ key: '', attempts: 0 })
  const [displayed, setDisplayed] = useState<DisplayFrame | null>(null)
  const [acceptedBacking, setAcceptedBacking] = useState<{ identity:string; client:KernelClient | null } | null>(null)
  useLayoutEffect(() => {
    const previous = heldDisplay.current
    heldDisplay.current = displayed
    if (previous && previous !== displayed)
      bitmapRetirement.retire(previous.residents.values(), [...tileRef.current.values(), ...pageResidency.values(),
        ...(displayed?.residents.values() || [])])
  }, [displayed, bitmapRetirement, pageResidency])
  const acknowledged = useRef<{view:SurfaceProps['view'];width:number;height:number;dpr:number;interaction:boolean;preview?:boolean;ids:Set<number>} | undefined>(undefined)
  const activePlan = useRef<DisplayFrame | null>(null)
  const [compositeCacheFrame] = useState(() => new CompositeFrameWitness<CompositeCacheFrame<PaintedTile> & {
    displayBudget: number; residencyBudget: number; displayed: DisplayFrame | null
  }>())
  const compositeCacheUse = useRef(() => {
    const frame = compositeCacheFrame.current, latest = latestContext.current
    if (!frame || frame.document !== latest.document || frame.pageId !== latest.pageId ||
        frame.epoch !== (latest.presentationEpoch || 0) || frame.backend !== latest.backend ||
        frame.client !== client.current || frame.resident &&
        (previewDevice.current.client !== frame.client || previewDevice.current.key !== frame.deviceKey)) return new Set<PaintedTile>()
    return visibleCompositeContributors(frame, frame, tileRef.current, ready.current)
  }).current
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
    const presented = !residentDisplay || !!plan && !!actual && !actual.preview && !actual.interaction && actual.width===plan.width &&
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
      const previousBacking = nativePageBacking.current
      if (previousBacking && (previousBacking.contract !== contract ||
          [...previousBacking.keys].some(key => !tileRef.current.has(key) || !ready.current.has(key)) ||
          estimatedTileResidencyBytes([...previousBacking.keys].flatMap(key => {
            const tile = tileRef.current.get(key); return tile ? [tile] : []
          })) > budget / 4)) {
        for (const key of previousBacking.keys) {
          const tile = tileRef.current.get(key); if (tile) tile.overview = false
        }
        nativePageBacking.current = null
      }
      if (nativePageBacking.current?.contract !== contract && props.overview &&
          props.overview.width > 0 && props.overview.height > 0 &&
          completeViewportBacking([...residents.values()], nativeVisibleTiles ? { x: -plan.view.x / plan.view.zoom, y: -plan.view.y / plan.view.zoom,
            width: plan.width / plan.view.zoom, height: plan.height / plan.view.zoom } : props.overview, plan.rasterScale,
            estimatedTileResidencyBytes(residents.values()), budget)) {
        // Keep at most one existing wide-view cohort for this content epoch.
        // It is not a whole-page certificate: overview reuse still checks the
        // actual world bounds, and presentation measures its real coverage.
        // Its pixels only fill gaps; current native tiles retain their normal
        // priority. Ordinary historical levels remain evictable as before.
        nativePageBacking.current = { contract, keys: new Set(residents.keys()) }
        for (const tile of residents.values()) tile.overview = true
      }
      coverageRetention.current.retain({ revision: plan.revision,
        bounds: { x: -plan.view.x / plan.view.zoom, y: -plan.view.y / plan.view.zoom,
          width: plan.width / plan.view.zoom, height: plan.height / plan.view.zoom },
        keys: plan.ids, bytes: estimatedTileResidencyBytes(residents.values()),
      }, budget)
      const used = estimatedTileResidencyBytes(tileRef.current.values()) > budget ? compositeCacheUse() : new Set<PaintedTile>()
      if (used.size) tileRef.current = touchCompositeContributors(tileRef.current, used)
      const ledger = new TileResidencyLedger(tileRef.current.values())
      const evicted = new Set<string>()
      for (const [key, tile] of tileRef.current) {
        if (ledger.bytes <= budget) break
        if (plan.ids.has(key) || coverageRetention.current.has(key) || used.has(tile)) continue
        if (tile.overview && tile.document === doc) continue
        evicted.add(key)
        ledger.remove(tile)
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
  const pageScope = pageResidencyScope({ documentId: doc.id, sessionEpoch: props.presentationEpoch || 0, backend,
    grid: !!props.grid, checkerboard: !!props.checkerboard, pixelPreview: props.pixelPreview || 0,
    rasterProfile, displayCapability, hdrCompositing })
  const filteredContent = useMemo(() => pageHasFilteredContent(doc, pageId), [doc.nodes, doc.pages, pageId])
  const sharpNavigation = import.meta.env.VITE_DESIGN_SHARP_ZOOM === '1' && usesSharpZoom(renderExecutionPolicy,
    { resident: residentDisplay, pixelPreview: props.pixelPreview, grid: props.grid, checkerboard: props.checkerboard }) &&
    rasterProfile !== 'figmaSoftware'
  const gestureHeadroom = import.meta.env.VITE_DESIGN_GESTURE_DENSITY_HEADROOM === '1' && residentDisplay && !cameraDependent &&
    !props.grid && !props.checkerboard && usesDesktopDisplay(renderExecutionPolicy,
      { renderIntent: 'canvas', rasterProfile, pixelPreview: props.pixelPreview })
  const nativeNavigation = import.meta.env.VITE_DESIGN_NATIVE_NAVIGATION === '1' &&
    import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' && residentDisplay && !sharpNavigation && !gestureHeadroom &&
    !props.interaction?.active && !props.grid && !props.checkerboard && usesDesktopDisplay(renderExecutionPolicy,
      { renderIntent: 'canvas', rasterProfile, pixelPreview: props.pixelPreview })
  // Scoped candidate: demand-driven physical-density tiles use the existing
  // regional compiler, mailbox, admission and presenter. Keep it opt-in until
  // real navigation/pressure acceptance; no old experimental math is enabled.
  const nativeVisibleTiles = import.meta.env.VITE_DESIGN_NATIVE_VISIBLE_TILES === '1' &&
    residentDisplay && !sharpNavigation && !gestureHeadroom && !nativeNavigation &&
    !hdrCompositing && !props.interaction?.active && !props.grid && !props.checkerboard && !props.pixelPreview &&
    usesDesktopDisplay(renderExecutionPolicy, { renderIntent: 'canvas', rasterProfile, pixelPreview: props.pixelPreview })
  const progressiveNativeRepair = usesProgressiveNativeRepair(renderExecutionPolicy, backend,
    import.meta.env.VITE_DESIGN_PROGRESSIVE_NATIVE_REPAIR,
    !nativeNavigation && !sharpNavigation && !gestureHeadroom && !nativeVisibleTiles)
  const latestNativeNavigation = useRef(nativeNavigation)
  latestNativeNavigation.current = nativeNavigation
  const navigationZoom = useNavigationZoom(view, identity, singleCanvas && !props.paused && props.visible !== false &&
    !sharpNavigation && !gestureHeadroom && !nativeVisibleTiles && !props.interaction?.active && !props.grid && !props.checkerboard && !props.pixelPreview && !hdrCompositing,
    residentDisplay && filteredContent, props.panGestureActive === true, nativeNavigation,
    import.meta.env.VITE_DESIGN_NAVIGATION_ADAPTIVE_QUIET!=='0' && residentDisplay && !filteredContent)
  const latestNavigationZoom = useRef(navigationZoom)
  latestNavigationZoom.current = navigationZoom
  const frameZooming=useZoomActivity(view.zoom,identity)
  const sharpZooming=useSharpZoomActivity(sharpNavigation?view.zoom:1,sharpNavigation?identity:'sharp-disabled')
  const zooming=sharpNavigation?sharpZooming:frameZooming
  const cameraMoving = useCameraActivity(view, identity)
  const motionPreview=!sharpNavigation&&!gestureHeadroom&&!nativeVisibleTiles&&residentDisplay&&zooming&&!props.interaction?.active&&!props.grid&&!props.checkerboard&&!props.pixelPreview&&
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
  const densityHeadroom = gestureHeadroom ? gestureRasterScale(view, dpr, width, height,
    { policy: renderExecutionPolicy, active: zooming && !props.interaction?.active,
      request: { renderIntent: 'canvas', rasterProfile, pixelPreview: props.pixelPreview } }) : undefined
  const samplingScale = nativeVisibleTiles ? zooming && !cameraDependent && sharpHeadroomBlocked !== contract
    ? nativeTileMotionScale(view, dpr, width, height) : detailLevel : densityHeadroom ?? (sharpNavigation ? zooming && !cameraDependent
    ? sharpZoomScale(view, dpr, width, height, { headroom: sharpHeadroomBlocked !== contract,
      hdr: hdrCompositing && !!doc.colorManagement }) : detailLevel
    : nativeSampling || filteredContent ? detailLevel : zooming && !cameraDependent && singleCanvas
    ? motionRasterScale(view, dpr, width, height)
    : canvasSamplingScale(view, dpr, width, height, stableDensity, hdrCompositing && !!doc.colorManagement))
  const samplingDpr = nativeSampling ? dpr : samplingScale / view.zoom
  // Pending work may temporarily clear activePlan. A completed frame still
  // owns the same exact sample lattice; don't switch that pan to phase zero.
  const panCandidates=import.meta.env.VITE_DESIGN_PAN_TILE_CONTINUATION==='1'?[activePlan.current,displayed]:[activePlan.current]
  // contract.revision includes node/font/resource/color/profile changes; the
  // remaining fields prevent cross-page/session/backend/presentation reuse.
  const retainNativePanPhase = panCandidates.some(prior=>!zooming&&prior?.document===doc&&
    prior.revision===contract.revision&&prior.pageId===pageId&&prior.epoch===(props.presentationEpoch||0)&&
    prior.computeBackend===backend&&prior.displayCapability===displayCapability&&
    prior.managed===(hdrCompositing&&!!doc.colorManagement)&&preservesNativePanPhase(view,dpr,samplingScale,cameraDependent,prior))
  const rasterPlan = canvasRasterPlan(view, samplingDpr, width, height, {
    rasterProfile, pixelPreview: props.pixelPreview, checkerboard: props.checkerboard,
    grid: props.grid, hdr: hdrCompositing && !!doc.colorManagement,
    samplingScale: nativeSampling ? undefined : samplingScale,
    // Pointer release already carries the flushed final camera. The separate
    // two-frame activity signal must not insert a provisional phase before it.
    exactPhase: (!cameraMoving && !zooming) || retainNativePanPhase ||
      (navigationZoom.panEnabled && !navigationZoom.active),
  })
  const renderScale = rasterPlan.scale
  const renderCamera = rasterPlan.camera
  const renderPhase = rasterPlan.phase
  const sequentialContext = useRef({ width, height, dpr, suspended: navigationZoom.suspended })
  sequentialContext.current = { width, height, dpr, suspended: navigationZoom.suspended }
  // Budget the sampled pixels, including density headroom and a held frame.
  const displayBudget = (() => {
    try {
      return Math.max(displayTileBudget(width, height, rasterPlan.density, hdrCompositing && !!doc.colorManagement),
        displayed ? displayTileBudget(displayed.width, displayed.height, displayed.samplingDensity || displayed.dpr, displayed.managed) : 0)
    }
    catch { return 128 * 1024 * 1024 }
  })()
  const residencyBudget = pageResidencyBudget(displayBudget, memoryTier)
  useLayoutEffect(() => {
    if (pageResidency.configure(memoryPolicy.inactiveBytes, memoryPolicy.maxPages)) setTiles(new Map(tileRef.current))
  }, [pageResidency, memoryPolicy])
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
  const lodActive = !sharpNavigation && !gestureHeadroom && !nativeVisibleTiles && detailLevel / lodScale >= 1.02
  const buildFrameKey = () => JSON.stringify([
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
  const frameKey = rasterClient?.traceMainThread?.(40,buildFrameKey) ?? buildFrameKey()
  // One running capture and one replaceable latest goal. Density changes do
  // not invalidate immutable same-content pixels already being generated.
  const sequentialGoal = useRef('')
  sequentialGoal.current = JSON.stringify([frameKey, zooming])
  if (navigationTiming.current.key !== frameKey)
    navigationTiming.current = { key: frameKey, started: performance.now() }
  const requestedView = props.requestedView || view
  const compositeOwner: CompositeCacheOwner & { displayBudget: number; residencyBudget: number; displayed: DisplayFrame | null } = {
    document: doc, revision: contract.revision, pageId,
    epoch: props.presentationEpoch || 0, backend, client: client.current, resident: residentDisplay,
    deviceKey: previewDevice.current.client === client.current ? previewDevice.current.key : undefined,
    visible: props.visible !== false && !props.paused,
    view: { ...requestedView }, width, height, dpr, displayBudget, residencyBudget, displayed }
  const phaseExact = canvasRasterPhaseMatches(view, dpr, renderScale, renderPhase)
  const complete = !navigationZoom.active && !displayed?.preview && phaseExact && displayed?.key === frameKey && displayed.document === doc &&
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
  // Scheduling evidence only: an acknowledged backing at the unchanged edit
  // viewport already supplies continuity. It remains the OLD document until
  // exact repair publishes the new one; it must never satisfy complete/ACK.
  const editBacking = displayed && !displayed.preview && displayed.document !== doc &&
    displayed.document.id === doc.id && displayed.document.rasterProfile === doc.rasterProfile &&
    displayed.document.colorManagement === doc.colorManagement &&
    tilePreviewContractMatches({ ...displayed, document: doc, pixelRatio: displayed.dpr }, requestedContract) &&
    displayed.view.x === requestedView.x && displayed.view.y === requestedView.y && displayed.view.zoom === requestedView.zoom
  const actualBacking = acknowledged.current, backingDevice = previewDevice.current
  const retainedEditViewport = residentDisplay && editBacking && actualBacking &&
    actualBacking.width === width && actualBacking.height === height && actualBacking.dpr === dpr &&
    actualBacking.view.x === requestedView.x && actualBacking.view.y === requestedView.y && actualBacking.view.zoom === requestedView.zoom &&
    backingDevice.client === client.current && !!backingDevice.key && displayed.residents.size > 0 &&
    [...displayed.residents.values()].every(tile => tile.gpuTile !== undefined &&
      tile.residentDevice?.client === client.current && tile.residentDevice.key === backingDevice.key)
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
    const capture = nativeNavigationHandoff.current
    if (capture?.state === 'delivered' && viewportPreviewKey(capture.identity) === id)
      nativeNavigationHandoff.finish(capture, false)
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
    }
    bitmapRetirement.retire(victims.map(([, tile]) => tile), [...map.values(), ...pageResidency.values(),
      ...(heldDisplay.current?.residents.values() || [])])
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
    const capture = nativeNavigationHandoff.current
    if (capture && viewportPreviewKey(capture.identity) === id) nativeNavigationHandoff.finish(capture, false)
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
    previewDevice.current = { client: client.current }
    navigationIntentOwner.reset(client.current)
    setRasterClient(client.current)
    client.current.onDamage = damageHandler
    return () => {
      clearTimeout(displayRetries.current.timer)
      nativeNavigationHandoff.invalidate()
      navigationIntentOwner.reset({})
      client.current?.dispose()
      client.current = null
      previewDevice.current = { client: null }
      presentationOwnership.current.clear()
      owner.dispose()
      lodSnapshots.clear()
      bitmapRetirement.retire([...tileRef.current.values(), ...pageResidency.values(),
        ...(heldDisplay.current?.residents.values() || [])], [])
      heldDisplay.current = null
      pageResidency.clear()
    }
  }, [owner, lodSnapshots, damageHandler, navigationIntentOwner, nativeNavigationHandoff])
  useEffect(() => {
    if (rasterClient && props.navigationInputOwner && !props.paused && props.visible !== false)
      return rasterClient.bindNavigationInput(props.navigationInputOwner)
  }, [rasterClient, props.navigationInputOwner, props.paused, props.visible])
  // A camera sample replaces only waiting work. Cancelling an already running
  // same-content capture at each sample can starve continuous navigation when
  // rendering takes longer than the sampling interval. Content/owner, extent,
  // visibility still invalidate its pixel ownership. Running captures retain
  // their original camera across quiet/release unless a narrower old zoom-out
  // capture is explicitly revoked. They never become exact ACKs.
  useEffect(() => {
    const c = client.current
    return () => {
      coverageGeneration.current++
      coverageFlight.current = null
      if (c && client.current === c) navigationIntentOwner.reset(c)
      nativeNavigationHandoff.invalidate()
      sequentialPending.current?.cancel()
      sequentialPending.current = null
      sequentialRepair.current = null
      if (previewAdmission.current.contract === contract && previewAdmission.current.active)
        previewAdmission.current.key = undefined
    }
  }, [contract, doc, width, height, dpr, navigationZoom.suspended,
    props.paused, props.visible, nativeNavigation, navigationIntentOwner, nativeNavigationHandoff])
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
        estimatedTileResidencyBytes(retain))
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
    navigationRefinement.update()
    translationRefinement.update()
    translationCoverage.current = undefined
    nativeNavigationHandoff.stopWaiting()
    coverageRetention.current.trim(contract.revision, displayBudget)
    const previousView = previousFillView.current
    previousFillView.current = view
    if (coverageDirection.current.contract !== contract) coverageDirection.current = { contract, zoomOut: false }
    if (previousView && previousView.zoom !== view.zoom) coverageDirection.current.zoomOut = view.zoom < previousView.zoom
    const zoomOutCoverage = coverageDirection.current.zoomOut
    const generation = coverageGeneration.current
    let cancelOverview: (() => void) | undefined
    // Panning within a density does not invalidate world pixels. Finish the
    // running batch; discard queued old plans and admit the latest view.
    const stableWorldFill=import.meta.env.VITE_DESIGN_PAN_TILE_CONTINUATION==='1'&&!cameraDependent&&!nativeSampling
    const fillKey = navigationZoom.active ? `navigation-preview:${width}:${height}:${dpr}` :
      JSON.stringify([renderScale,stableWorldFill?renderPhase.x:renderCamera.x,stableWorldFill?renderPhase.y:renderCamera.y,width,height,dpr,!!props.paused])
    const repair = sequentialRepair.current
    const repairScope = repair?.contract === contract && repair.width === width && repair.height === height && repair.dpr === dpr &&
      !props.paused && props.visible !== false && !navigationZoom.suspended
    if (repair && !repairScope) sequentialRepair.current = null
    if (fillOwner.current?.contract !== contract || fillOwner.current.key !== fillKey) {
      // A declined optional capture owes one real native batch a turn. Camera
      // changes may supersede its queued successors, not cancel that batch.
      if (!repairScope) c.cancelTileFill()
      fillOwner.current = { contract, key: fillKey }
    }
    activePlanKey.current = frameKey
    if (rasterOwner.current !== contract) {
      c.cancelPreview()
      rasterOwner.current = contract
    }
    const runningNavigation = nativeNavigationHandoff.current
    const retainNavigation = nativeNavigation && runningNavigation?.identity.client === c &&
      runningNavigation.identity.document === doc && runningNavigation.identity.revision === contract.revision
    if (previewAdmission.current.active && !navigationZoom.active) {
      const flight = coverageFlight.current
      if (flight?.contract === contract && flight.generation === generation)
        flight.cancelObsoleteZoomOut(requestedView, width, height)
      if (retainNavigation || coverageFlight.current?.contract === contract) mailbox.discardSuperseded()
      else if (navigationZoom.suspended || props.visible===false || props.paused) c.cancelPreview()
      else navigationIntentOwner.reset(c)
    }
    previewAdmission.current.active = navigationZoom.active
    desired.current = []
    if (!navigationZoom.active) activePlan.current = null
    setStats((s) => ({ ...s, complete: false }))
    // Complete independently retained pixels already own this gesture. Stop
    // the previous commit's CPU preparation/upload, not merely its next tile.
    // Releasing the gesture changes this dependency and resumes exact repair.
    if(retainedEditing){c.cancelTileFill();c.cancelPreview();return}
    if (props.paused || navigationZoom.suspended || props.visible === false && sharpNavigation &&
        (import.meta.env.VITE_DESIGN_SEQUENTIAL_DISPLAY === '1' ||
          import.meta.env.VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE === '1')) return
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
    const validCoverage = () => navigationCoverageTiles(tileRef.current.values(), ready.current, {
      document: doc, revision: contract.revision, resident: residentDisplay, client: c,
      device: previewDevice.current.client === c ? previewDevice.current.key : undefined,
    })
    const hasReadyCoverage = () => navigationHasCoverage(validCoverage(), requestedView, width, height,
      navigationReadyDensity(requestedView.zoom, dpr, width, height, nativeNavigation))
    // At quiet, a same-owner coarse image already supplies continuity. Spend
    // the next turn on exact detail, not a second intermediate-resolution copy.
    // This does not authorize skipping the sharper moving-camera preview.
    const hasRepairBacking = () => progressiveNativeRepair&&
      residentDisplay&&!navigationZoom.active&&syncedDoc.current===doc&&
      navigationHasCoverage(validCoverage(),requestedView,width,height)
    // A large reversal can leave a costly zoom-in capture occupying the sole
    // raster lane after its crop stopped covering the current view. Keep
    // accepted pixels, but revoke that optional job without waiting for quiet.
    // Cold views tolerate small reversals; a fourfold change makes the old
    // crop too narrow even before replacement coverage has arrived.
    if (navigationZoom.active && zoomOutCoverage) {
      const flight = coverageFlight.current
      if (flight?.contract === contract && flight.generation === generation)
        flight.cancelObsoleteZoomOut(requestedView, width, height, hasReadyCoverage() ? 2 : 4)
    }
    const pendingCoverage = () => {
      const flight = coverageFlight.current, tile = flight?.tile
      // Avoid duplicating an import already in flight, without marking it ready.
      return !!flight && flight.contract === contract && flight.generation === coverageGeneration.current && !!tile &&
        tileRef.current.get(tile.key) === tile && navigationHasCoverage([tile], requestedView, width, height)
    }
    const repairCurrent = () => {
      const repair = sequentialRepair.current, latest = sequentialContext.current
      return !!repair && repair.contract === contract && sameContent() && latestContext.current.visible !== false &&
        repair.width === latest.width && repair.height === latest.height && repair.dpr === latest.dpr && !latest.suspended
    }
    // A new document with no pixels gets one complete viewport preview before
    // progressive detail. Revisited cameras and edits with retained coverage
    // do not pay for a second full-scene render.
    const needsStartupPreview = !sharpNavigation && !nativeVisibleTiles && singleCanvas && !hdrCompositing && !props.grid && !props.checkerboard &&
      !props.pixelPreview && !reusableFrame && !retainedEditViewport && startupPreviewAttempt.current !== contract &&
      ![...tileRef.current.values()].some(tile => tile.document === doc && tile.revision === contract.revision &&
        ready.current.has(tile.key) && tileIntersectsView(tile, requestedView, { width, height }))
    // After high-zoom input stops, an unfinished optional filtered capture
    // would serialize ahead of the native tile plan, then be drawn again.
    // Keep cold-start/acknowledged pixels and the original completion fence.
    if (!needsStartupPreview && !nativeNavigation && residentDisplay && filteredContent &&
        renderExecutionPolicy.desktopFullMath && renderExecutionPolicy.desktopDisplay && backend === 'webgpu' &&
        !navigationZoom.active && !cameraMoving && !props.panGestureActive && !props.interaction?.active &&
        !hdrCompositing && !props.pixelPreview && !props.animation && requestedView.zoom >= 8) {
      const flight = coverageFlight.current
      if (flight?.contract === contract && flight.generation === generation) flight.cancelForNative()
    }
    const render = (...args: Parameters<KernelClient['render']>) => mailbox.run(current, () => c.render(...args))
    const receive = (tile: TileResult & { viewportCache?: ViewportPreviewCacheEntry; nativeNavigationDevice?: string; previewSource?: PaintedTile['previewSource'] }) => {
      if (!sameContent()) {
        try { retireRejectedTile(tile, [...tileRef.current.values(), ...pageResidency.values(),
          ...(heldDisplay.current?.residents.values() || [])], bitmapRetirement, ids => c.releasePresented(ids)) }
        catch (error) { throw new HandledTileDeliveryError(error) }
        return
      }
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
        overview: overviewKeys.current.has(tile.key) || nativePageBacking.current?.contract === contract && nativePageBacking.current.keys.has(tile.key),
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
      const cacheContext = compositeCacheFrame.current
      const cacheDisplayed = cacheContext?.displayed ?? displayed
      const cacheBudget = cacheContext?.displayBudget ?? displayBudget
      const cacheResidencyBudget = cacheContext?.residencyBudget ?? residencyBudget
      const used = compositeCacheUse()
      const capture = nativeNavigationHandoff.current
      const liveView = latestContext.current.requestedView || latestContext.current.view
      const awaitedNative = nativeNavigation && capture && nativeNavigationHandoff.waitingFor(capture) &&
        tile.key === viewportPreviewKey(capture.identity) &&
        Object.is(capture.identity.view.x, liveView.x * dpr) && Object.is(capture.identity.view.y, liveView.y * dpr) &&
        Object.is(capture.identity.view.zoom, liveView.zoom * dpr)
      const awaitedCoverage = tile.viewportPreview && coverageFlight.current?.contract === contract &&
        coverageFlight.current.generation === coverageGeneration.current &&
        navigationHasCoverage([tile], liveView, width, height)
      // Quiet/release changed the effect token, not the usefulness of a running
      // capture covering the latest target. Only that covering same-owner
      // result may borrow replacement headroom; a narrow old crop may not.
      const foreground = (current() || !!awaitedNative || !!awaitedCoverage) && !tile.prefetch &&
        (desired.current.includes(tile.key) || !!tile.viewportPreview)
      const allowance = replacementTileBudget(cacheBudget, cacheResidencyBudget,
        { width, height, dpr, bytesPerPixel: residentDisplay ? 4 : hdrCompositing && !!doc.colorManagement ? 28 : 8 }, foreground)
      const heldSources = [...(cacheDisplayed?.residents.values() || []), ...(heldDisplay.current?.residents.values() || [])]
      const reportAdmission = (detail: TileAdmissionDiagnostic, rejected: boolean, totalBytes = 0) => {
        cacheAdmission.current.reserveBytes = allowance.reserveBytes
        cacheAdmission.current.admissionBudget = allowance.budgetBytes
        try { c.recordViewportDiagnostic?.({ surfaceProposedBytes: detail.proposedBytes, surfaceBudgetBytes: detail.budgetBytes,
          surfaceSteadyBudgetBytes: cacheBudget, surfaceTotalBudgetBytes: cacheResidencyBudget,
          surfaceReserveBytes: detail.reserveBytes, surfaceHeldCount: detail.heldCount, surfaceUsedCount: detail.usedCount,
          surfacePinnedCount: detail.pinnedCount, surfaceIncomingBytes: detail.incomingBytes,
          surfaceRejected: Number(rejected), surfaceTotalBytes: totalBytes,
          surfaceHighWaterBytes: cacheAdmission.current.activeHighWater }) }
        catch { /* Optional numeric telemetry cannot change payload ownership. */ }
      }
      let admission: ReturnType<typeof planTileAdmission<PaintedTile>>
      try {
        admission = planTileAdmission(tileRef.current, entry, { budget: allowance.budgetBytes,
          reserveBytes: allowance.reserveBytes, used, held: heldSources,
          pinned: (key, old) => protectedKeys.current.has(key) || !!cacheDisplayed?.ids.has(key) ||
            coverageRetention.current.has(key) || !!old.overview && old.document === doc })
      } catch (error) {
        const detail = tileAdmissionDiagnostic(error)
        if (detail) reportAdmission(detail, true)
        // Both streamed tiles and completed viewport captures reach this
        // boundary. Keep all earlier successful deliveries intact and dispose
        // only unshared incoming resources; transport must not dispose again.
        let cleanupError: unknown
        try { retireRejectedTile(tile, [...tileRef.current.values(), ...pageResidency.values(),
          ...(heldDisplay.current?.residents.values() || [])], bitmapRetirement, ids => c.releasePresented(ids)) }
        catch (failure) { cleanupError = failure }
        // Optional old-camera/prefetch work cannot cancel the newer required
        // fill merely because it no longer fits its steady history allowance.
        if (detail && !foreground && cleanupError === undefined) return
        throw new HandledTileDeliveryError(error, cleanupError)
      }
      const { map, retired, held } = admission
      // World-canonical re-delivery and eviction become visible together only
      // after the entire protected set has passed the existing byte budget.
      presentationOwnership.current.track(tile.gpuTile)
      ready.current.delete(tile.key)
      failedTiles.current.delete(tile.key)
      for (const old of retired) if (map.get(old.key) !== old) ready.current.delete(old.key)
      tileRef.current = map
      const completionErrors: unknown[] = []
      // Inactive pages are lower priority than the active viewport. Their
      // estimates share a bounded surface ceiling, separate from the active planner.
      try { pageResidency.trim(pageResidency.limit, inactive =>
        estimatedTileResidencyBytes([...map.values(), ...held, ...inactive]) > cacheResidencyBudget) }
      catch (error) { completionErrors.push(error) }
      const totalBytes = estimatedTileResidencyBytes([...map.values(), ...held, ...pageResidency.values()])
      cacheAdmission.current.activeHighWater = Math.max(cacheAdmission.current.activeHighWater, admission.bytes)
      cacheAdmission.current.totalHighWater = Math.max(cacheAdmission.current.totalHighWater, totalBytes)
      reportAdmission(admission.diagnostic, false, totalBytes)
      try { bitmapRetirement.retire(retired, [...map.values(), ...pageResidency.values(),
        ...(heldDisplay.current?.residents.values() || [])]) }
      catch (error) { completionErrors.push(error) }
      // Retirement failure cannot leave React on the old map or authorize the
      // transport to destroy an incoming handle the surface now owns.
      try { setTiles(map) }
      catch (error) { completionErrors.push(error) }
      if (completionErrors.length) throw new HandledTileDeliveryError(completionErrors[0],
        completionErrors.length > 1 ? new AggregateError(completionErrors.slice(1), 'Additional tile retirement failures') : undefined)
      return map.get(entry.key) === entry ? entry : undefined
    }
    const previewSource = (camera: SurfaceProps['view']): PaintedTile['previewSource'] => Object.freeze({
      contract, generation, client: c, view: Object.freeze({ ...camera }), width, height, dpr,
      precision: previewPrecision, profile: rasterProfile,
      device: previewDevice.current.client === c ? previewDevice.current.key : undefined,
    })
    const previewIdentity = (lane: ViewportPreviewIdentity['lane'], camera: SurfaceProps['view'], w: number, h: number): ViewportPreviewIdentity => ({
      lane, client: c, document: doc, revision: contract.revision, pageId, sessionEpoch: props.presentationEpoch || 0,
      dpr, backend, profile: rasterProfile, capability: displayCapability,
      precision: JSON.stringify([renderExecutionPolicy.desktopFullMath, renderExecutionPolicy.desktopDisplay,
        renderExecutionPolicy.hdrCompositing, renderExecutionPolicy.imageMips, renderExecutionPolicy.imageAtlas]),
      width: w, height: h, view: camera,
    })
    const cachedPreview = (identity: ViewportPreviewIdentity) => {
      if (!residentDisplay || syncedDoc.current !== doc || previewDevice.current.client !== c) return
      const tile = tileRef.current.get(viewportPreviewKey(identity))
      return tile && reusableViewportPreview(tile, identity, ready.current.has(tile.key), previewDevice.current.key) ? tile : undefined
    }
    const touchPreviews = (reused: PaintedTile[]) => {
      const touched = new Map(tileRef.current)
      for (const tile of reused) { touched.delete(tile.key); touched.set(tile.key, tile) }
      tileRef.current = touched
      previewReuseSequence.current++
      setTiles(touched)
      setStats(value => ({ ...value, hits: value.hits + reused.length }))
      recordRenderDiagnostic({ kind: 'cache', zoom: view.zoom, dpr,
        requestedDensity: view.zoom * dpr, sampledDensity: Math.min(...reused.map(tile => tile.zoom)),
        cacheHits: reused.length, cacheMisses: 0 })
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
        const repair = !prefetchOnly && repairCurrent() && !sequentialRepair.current!.owner ? sequentialRepair.current : undefined
        const repairOwner = repair ? {} : undefined
        if (repair) repair.owner = repairOwner
        const ownsRepair = () => !!repair && sequentialRepair.current === repair && repair.owner === repairOwner && repairCurrent()
        let submittedRepair = false, completedRepair = false
        let result: Awaited<ReturnType<typeof c.render>> | undefined
        try {
          result = await mailbox.run(repair ? ownsRepair : current, () => {
            // A previous in-flight batch may have delivered these tiles while
            // this latest plan waited for the worker. Do not rasterize twice.
            const pending = chunk.filter(tile => !isResident(tile))
            if (!pending.length) return Promise.resolve(undefined)
            const priorities = new Map<RasterTile, import('./tile-cache').TileFillPriority>()
            const ordered = prioritizeUncoveredTiles(pending,
              [...tileRef.current.values()].filter(tile => tile.document === doc &&
                tile.revision === contract.revision && ready.current.has(tile.key)), viewport, priorities)
            if (repair) submittedRepair = true
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
              ...(prefetchOnly ? {} : { tileFillPriorities: ordered.map(tile => priorities.get(tile)!) }),
              tilePrepareViewport: import.meta.env.VITE_DESIGN_PREPARE_CACHE === '0' ? undefined :
                nativeVisibleTiles ? tilePrepareViewport(ordered, renderCamera) :
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
          completedRepair = true
        } catch (error) {
          if (prefetchOnly) {
            console.debug('[tile-scheduler] prefetch chunk dropped', error)
            return
          }
          throw error
        } finally {
          if (repair && sequentialRepair.current === repair && repair.owner === repairOwner) {
            delete repair.owner
            if (submittedRepair) {
              const wakeLatest = completedRepair && repairCurrent()
              sequentialRepair.current = null
              if (wakeLatest) setDisplayRetry(value => value + 1)
            }
          }
        }
        if (current() && result) {
          syncedDoc.current = doc
          commitRef.current()
          setStats((s) => ({
            ...s,
            ms: result.milliseconds,
            compileMs: result.compileMs, graphMs: result.graphMs || 0,
            pipelineWallMs: result.pipelineWallMs || 0, preparationWaitMs: result.preparationWaitMs || 0,
            overlappedPreparations: s.overlappedPreparations + (result.overlappedPreparations || 0), frameResourceHits: s.frameResourceHits + (result.frameResourceHits || 0),
            frameResourceBytes: result.frameResourceBytes || 0,
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
          const batch = import.meta.env.VITE_DESIGN_TILE_BATCH === '1' || nativeVisibleTiles && (cameraMoving || zooming) ? 1 : cameraMoving && !zooming ? 4 : 32
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
        coverageGeneration.current++
        coverageFlight.current = null
        previewDevice.current = { client: c }
        pageResidency.clear()
        setTiles(new Map(tileRef.current))
      }
      recordRenderDiagnostic({ kind: 'error', zoom: view.zoom, dpr,
        requestedDensity: view.zoom * dpr, errorCode: renderDiagnosticError(error) })
      if (String(error).includes('PREVIEW_CANCELLED')) return
      // A retained camera image may cover the request. An empty or unrelated
      // tile cannot hide a failed first frame or suppress backend recovery.
      if (retainedPressureError(error) && hasReadyCoverage()) return
      // Recovery changes the renderer, not the fact that this GPU request failed.
      // Keep failure observers informed before handing off to the CPU surface.
      latestContext.current.onRenderFailure?.()
      if (shouldUseExactCpuFallback(backend, error))
        props.onFallback(String(error))
      else setFailure(String(error))
    }
    translationCoverage.current = request => {
      if (!residentDisplay || cameraDependent || hdrCompositing || props.grid || props.checkerboard || props.pixelPreview ||
          request.source !== doc || !latestContext.current.interaction?.active || !current() ||
          ![request.offset.x*dpr*view.zoom,request.offset.y*dpr*view.zoom].every(value =>
            Number.isFinite(value) && Math.abs(value) < 4_000_000 &&
            (renderExecutionPolicy.desktopDisplay && rasterProfile === 'figmaSubpixel' || Number.isSafeInteger(value)))) return false
      translationRequest.current = request
      const scope = `${contract.revision}:${token}`
      translationRefinement.update({scope,sequence:request.sequence,current:()=>current()&&latestContext.current.interaction?.active===true,
        failed: error=>{recordRenderDiagnostic({kind:'error',errorCode:renderDiagnosticError(error)});request.failed()},
        run: async()=>{
          await initializeKernelModule()
          if(!current())return
          const target={x:-view.x/view.zoom-request.offset.x,y:-view.y/view.zoom-request.offset.y,
            width:width/view.zoom,height:height/view.zoom}
          const native=canvasRasterPlan(view,dpr,width,height,{rasterProfile,exactPhase:true})
          const plan=planTilesAligned(target,native.scale,budgetTileLimit(displayBudget,false),native.phase)
            .map(tile=>({...tile,key:tileComputationKey(tile,native.camera,false)}))
          const missing=plan.filter(tile=>{const resident=tileRef.current.get(tile.key)
            return !resident||resident.document!==doc||resident.revision!==contract.revision||!ready.current.has(tile.key)})
          if(!missing.length)return
          await c.render(doc,{pageId,width:Math.ceil(width*dpr),height:Math.ceil(height*dpr),view:native.camera,
            transparent:false,grid:false,checkerboard:false,rasterProfile,renderIntent:'canvas',tileViewport:missing,
            tilePrepareViewport:tilePrepareViewport(plan,native.camera),
            ...(props.presentationEpoch===undefined?{}:{tileOwner:{documentId:doc.id,sessionEpoch:props.presentationEpoch}})},
            false,backend,false,false,undefined,receive)
        }})
      void translationRefinement.request()
      return true
    }
    const pendingTranslation=translationRequest.current
    if(pendingTranslation&&!translationCoverage.current(pendingTranslation))translationRequest.current=undefined
    // Filtered navigation used to return after CSS-density continuity for the
    // entire held gesture. Give actual screen-density work a bounded turn,
    // without turning every intermediate camera into an unbounded tile fill.
    if (navigationZoom.active && view.zoom >= 1 && residentDisplay && filteredContent && !nativeNavigation &&
        dpr > navigationPreviewDensity(dpr, width, height) &&
        !hdrCompositing && !props.interaction?.active && navigationZoom.sample) {
      const refinementScope = JSON.stringify([contract.revision, width, height, dpr, generation,
        previewDevice.current.client === c ? previewDevice.current.key : undefined])
      navigationCost.reset(refinementScope)
      navigationRefinement.update({ continuous: true, budgetMs: 16, scope: refinementScope, sequence: navigationZoom.sample.sequence,
        current: () => current() && latestNavigationZoom.current.active && !latestNavigationZoom.current.suspended &&
          latestContext.current.visible !== false && coverageGeneration.current === generation,
        failed,
        run: async () => {
          await initializeKernelModule()
          if (!sameContent() || !latestNavigationZoom.current.active || latestNavigationZoom.current.suspended ||
              latestContext.current.visible === false || coverageGeneration.current !== generation ||
              sequentialContext.current.width !== width || sequentialContext.current.height !== height || sequentialContext.current.dpr !== dpr) return
          const target = latestContext.current.requestedView || latestContext.current.view
          if (target.zoom < 1) return
          // Native density, unchanged four-sample/render policy and canonical
          // moving-camera phase. Final native-phase certification stays below.
          const native = canvasRasterPlan(target, dpr, width, height, { rasterProfile, exactPhase: false })
          const bounds = { x: -target.x / target.zoom, y: -target.y / target.zoom,
            width: width / target.zoom, height: height / target.zoom }
          const plan = planTilesAligned(bounds, native.scale, budgetTileLimit(displayTileBudget(width, height, dpr, false), false), native.phase)
            .map(tile => ({ ...tile, key: tileComputationKey(tile, native.camera, cameraDependent) }))
          const resident = validCoverage()
          const missing = prioritizeTileFill(plan.filter(tile => {
            const existing = tileRef.current.get(tile.key)
            // Import-pending pixels already own this key. Do not duplicate
            // their raster work merely because presentation has not ACKed it.
            return !existing || existing.document !== doc || existing.revision !== contract.revision
          }), bounds).onScreen
          const priorities = new Map<RasterTile, import('./tile-cache').TileFillPriority>()
          const tile = navigationCost.choose(prioritizeUncoveredTiles(missing, resident.filter(tile => tile.zoom >= native.scale), bounds, priorities), priorities)
          if (!tile) return
          // Keep existing finite halo/preparation and GPU/cache admission. One
          // tile can still be expensive; this never promises a GPU time bound.
          const protectedAtStart = protectedKeys.current
          protectedAtStart.add(tile.key)
          const deviceAtStart = previewDevice.current.client === c ? previewDevice.current.key : undefined
          let delivered = false
          const receiveRefinement = (result: TileResult) => {
            if (sameContent() && coverageGeneration.current === generation &&
                (!deviceAtStart || previewDevice.current.client === c && previewDevice.current.key === deviceAtStart)) {
              navigationCost.record(refinementScope,result.key,result.milliseconds)
              receive(result)
              delivered ||= result.key === tile.key
              return
            }
            // Content, suspension and actual device replacement revoke late
            // delivery. A pan alone does not: its world tile remains history.
            try { retireRejectedTile(result, [...tileRef.current.values(), ...pageResidency.values(),
              ...(heldDisplay.current?.residents.values() || [])], bitmapRetirement, ids => c.releasePresented(ids)) }
            catch (error) { throw new HandledTileDeliveryError(error) }
          }
          try {
            await c.render(doc, { pageId, width: Math.ceil(width * dpr), height: Math.ceil(height * dpr),
              view: native.camera, transparent: false, grid: false, rasterProfile,
              tileViewport: [tile], tileFillPriorities: [priorities.get(tile)!],
              tilePrepareViewport: import.meta.env.VITE_DESIGN_PREPARE_CACHE === '0' ? undefined :
                tileBatchPrepareViewport(plan, [], [tile], native.camera),
              renderIntent: 'canvas',
              ...(props.presentationEpoch === undefined ? {} : {
                tileOwner: { documentId: doc.id, sessionEpoch: props.presentationEpoch },
              }),
            }, false, backend, false, false, undefined, receiveRefinement)
            if (sameContent() && coverageGeneration.current === generation) syncedDoc.current = doc
            // A completed request without an actual tile delivery must not
            // spend another turn re-requesting the same missing world pixels.
            return delivered && missing.length > 1
          } finally { protectedAtStart.delete(tile.key) }
        },
      })
    }
    if (!navigationZoom.active) navigationBudgetLatch.clear()
    let runAttempts = 0
    let navigationRequest: string | undefined
    let navigationIntent: string | undefined
    const run = async () => {
      let navigationAdmission: typeof previewAdmission.current | undefined
      let navigationCapture: NativeNavigationCapture | undefined
      let runningCoverage: NavigationCoverageFlight<PaintedTile> | undefined
      try {
        const extent = props.overview
        const baseOverview = extent && navigationOverview(extent, Math.min(1,renderScale), props.overviewNodes)
        const fillOverview = async (seed = false) => {
          if (!baseOverview || !current() || !extent) return
          const {tiles:baseTiles,view:camera} = baseOverview
          let missing = baseTiles.filter(tile => !ready.current.has(tile.key) || tileRef.current.get(tile.key)?.document !== doc)
          if (seed) {
            missing = overviewWarmBatch(missing,view,width,height,tile=>tileIntersectsView(tile,view,{width,height}))
            if (!missing.length) return
          }
          if (!missing.length) return
          if (hasRetainedOverview(tileRef.current.values(),ready.current,doc,contract.revision,extent,camera.zoom)) {
            overviewReuses.current++
            return
          }
          if (overviewKeys.current.size>128) {
            for (const key of overviewKeys.current) if (!tileRef.current.has(key)) overviewKeys.current.delete(key)
          }
          for (const tile of baseTiles) overviewKeys.current.add(tile.key)
          await render(doc,{pageId,width:Math.ceil(extent.width*camera.zoom)+2,height:Math.ceil(extent.height*camera.zoom)+2,
            view:camera,transparent:false,grid:props.grid,checkerboard:props.checkerboard,rasterProfile,renderIntent:'preview',
            coverageTiles:true,tileViewport:missing,tilePrepareViewport:tilePrepareViewport(missing,camera),
            ...(props.presentationEpoch === undefined ? {} : {tileOwner:{documentId:doc.id,sessionEpoch:props.presentationEpoch}})},
            false,backend,false,false,undefined,receive)
        }
        // The first ready frame can immediately be followed by a wheel burst.
        // Seed bounded local coverage before capture/viewport-cache early returns,
        // including the latest zoom-out target. Edits retain the settle lane and
        // do not pay for a page overview on pointer release.
        if (residentDisplay && !sharpNavigation && !nativeVisibleTiles && !props.grid && !props.checkerboard &&
            !props.pixelPreview && !props.interaction?.active && !retainedEditViewport && (!navigationZoom.active || zoomOutCoverage) &&
            (!displayed || (displayed.document === doc && displayed.revision === contract.revision && previousView &&
              (previousView.x !== view.x || previousView.y !== view.y || previousView.zoom !== view.zoom)))) {
          try { await fillOverview(true) }
          catch (error) { if (String(error).includes('PREVIEW_CANCELLED')) return }
          if (!current()) return
        }
        const nativeDevice=previewDevice.current.client===c?previewDevice.current.key:undefined
        // A previously ACKed exact frame can repair a pure device-pixel pan
        // with its existing native tile plan. A whole capture would evict
        // those reusable pixels, then raster the same viewport a second time.
        // Zoom, fractional phase, preview baselines and foreign owners retain
        // the existing capture path and complete-frame presentation gate.
        const nativePanRepair=residentDisplay&&!zooming&&cameraMoving&&reusableFrame&&
          !props.interaction?.active&&!props.grid&&!props.checkerboard&&!props.pixelPreview&&
          displayed&&!displayed.preview&&displayed.document===doc&&displayed.revision===contract.revision&&
          syncedDoc.current===doc&&!!nativeDevice&&displayed.residents.size>0&&
          preservesNativePanPhase(view,dpr,renderScale,cameraDependent,displayed)&&
          [...displayed.residents.values()].every(tile=>tile.zoom===detailLevel&&tileHasNativePhase(tile,view,dpr)&&ready.current.has(tile.key)&&
            Number.isSafeInteger(tile.gpuTile)&&tile.gpuTile!>0&&
            tile.residentDevice?.client===c&&tile.residentDevice.key===nativeDevice)
        if(nativePanRepair){navigationIntentOwner.reset(c);previewAdmission.current.active=false}
        if (navigationZoom.active&&!nativePanRepair) {
          const sample = navigationZoom.sample
          if (!sample) return
          const ratio = navigationPreviewDensity(dpr, width, height, nativeNavigation, sample.view.zoom), scale = sample.view.zoom * ratio
          const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio))
          const camera = { x: sample.view.x * ratio, y: sample.view.y * ratio, zoom: scale }
          const identity = previewIdentity('navigation-preview', camera, w, h), cached = cachedPreview(identity)
          if (cached) {
            // Keep the real acknowledged payload; resubmit its presentation at
            // the latest input instead of producing the same pixels again.
            navigationIntentOwner.reset(c)
            previewAdmission.current = { contract, key: cached.key, active: true }
            desired.current = [cached.key]
            protectedKeys.current = new Set(desired.current)
            activePlan.current = { key: frameKey, revision: contract.revision, document: doc, view: { ...sample.view },
              dpr, width, height, rasterScale: scale, samplingDensity: ratio, samplingMode: 'native', pageId,
              epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
              rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
              ids: new Set([cached.key]), residents: new Map() }
            touchPreviews([cached])
            void navigationRefinement.request()
            return
          }
          // A same-camera restart must not queue a second copy of the capture
          // which was allowed to finish over pointer release/quiet.
          const pendingNative = nativeNavigation ? nativeNavigationHandoff.forIdentity(identity) : undefined
          if (pendingNative && (pendingNative.state === 'running' || tileRef.current.has(viewportPreviewKey(identity)))) {
            const finishing = coverageFlight.current
            if (pendingNative.state === 'running' && finishing?.cancellationRequested &&
                finishing.contract === contract && finishing.generation === generation) {
              // A quiet zoom-out may revoke this capture before its rejection
              // settles. If input immediately returns to its camera, do not
              // suppress the latest goal forever behind that revoked owner.
              const device = previewDevice.current.key
              await finishing.done
              if (current() && coverageGeneration.current === generation && latestNativeNavigation.current &&
                  latestContext.current.visible !== false && !latestNavigationZoom.current.suspended &&
                  latestNavigationZoom.current.active && latestNavigationZoom.current.sample?.sequence === sample.sequence &&
                  previewDevice.current.client === c && previewDevice.current.key === device &&
                  nativeNavigationHandoff.current === pendingNative)
                setDisplayRetry(value => value + 1)
            }
            return
          }
          const currentDevice = previewDevice.current
          const nativeResidents = residentDisplay && currentDevice.client === c && currentDevice.key
            ? [...tileRef.current.values()].filter(tile =>
            tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key) &&
            tile.residentDevice?.client === c && tile.residentDevice.key === currentDevice.key &&
            tile.gpuTile !== undefined && tile.zoom >= detailLevel &&
            tileIntersectsView(tile, view, { width, height })) : []
          if (syncedDoc.current === doc && nativeResidents.length && tilesCoverBounds(nativeResidents, viewport, detailLevel)) {
            // A coarse refresh cannot improve already covering screen-density
            // pixels. Reproject those live residents and keep final native
            // phase repair on the ordinary settled path; this is no exact
            // certificate for another camera or a lower-density texture.
            navigationIntentOwner.reset(c)
            previewAdmission.current = { contract, key: 'native-covered-navigation', active: true }
            touchPreviews(nativeResidents)
            return
          }
          // A coarse overview supplies continuity, not navigation-tier detail.
          // Skip expensive filtered captures only when retained pixels cover
          // the viewport at the sampling density this sample would produce.
          // Keep low-density pixels visible while that bounded refresh runs.
          const retained = filteredContent && !nativeNavigation ? validCoverage() : []
          if (retained.length && tilesCoverBounds(retained, viewport,
              navigationReadyDensity(sample.view.zoom,dpr,width,height))) {
            // Only the optional continuity capture is superseded. A channel-
            // wide cancel also revokes the native tile currently filling this
            // same camera, repeatedly starving detail during continuous zoom.
            if (previewAdmission.current.key !== 'covered-navigation') navigationIntentOwner.reset(c)
            previewAdmission.current = { contract, key: 'covered-navigation', active: true }
            void navigationRefinement.request()
            return
          }
          // Continuous zoom and filtered pan keep bounded continuity captures;
          // native detail receives a separate single-tile fairness turn.
          navigationIntent = JSON.stringify([sample.view.x, sample.view.y, sample.view.zoom, width, height, dpr, ratio, rasterProfile])
          if (navigationBudgetLatch.blocked(contract, navigationIntent, displayRetry)) {
            // Refusing the optional full-frame capture must not consume the
            // sampled camera's independent bounded native-detail turn.
            void navigationRefinement.request()
            return
          }
          navigationRequest = JSON.stringify([sample.sequence, width, height, dpr])
          if (previewAdmission.current.contract === contract && previewAdmission.current.key === navigationRequest) return
          const admission = { contract, key: navigationRequest, active: true }
          navigationAdmission = admission
          previewAdmission.current = admission
          const ownsScope = () => sameContent() && latestContext.current.visible !== false &&
            (nativeNavigation ? latestNativeNavigation.current && (!navigationCapture?.device ||
              previewDevice.current.client === c && previewDevice.current.key === navigationCapture.device) :
              coverageGeneration.current === generation) && !latestNavigationZoom.current.suspended &&
            sequentialContext.current.width === width && sequentialContext.current.height === height &&
            sequentialContext.current.dpr === dpr
          const requested = () => ownsScope() && latestNavigationZoom.current.active && latestNavigationZoom.current.sample?.sequence === sample.sequence &&
            previewAdmission.current === admission
          activePlan.current = {
            key: frameKey, revision: contract.revision, document: doc, view: { ...sample.view }, dpr, width, height,
            rasterScale: scale, samplingDensity: ratio, samplingMode: 'native', pageId,
            epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
            rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
            ids: new Set(), residents: new Map(),
          }
          const options = {
            pageId, width: w, height: h,
            view: camera,
            transparent: false, grid: false, rasterProfile, livePreview: true, renderIntent: 'preview' as const,
            // Keep the same physical camera when a whole-frame halo cannot
            // fit: the worker already assembles bounded regions privately.
            ...(nativeNavigation || ratio === dpr && residentDisplay &&
              usesDesktopDisplay(renderExecutionPolicy,{renderIntent:'preview',rasterProfile})
              ? { previewTileFallback: true } : {}),
          }
          // Begin ownership only when the latest queued goal actually starts.
          // An intermediate sample must not abort the useful capture ahead of
          // it merely by joining the mailbox. Settle before the mailbox starts
          // its successor, while retaining this completion's own camera below.
          const result = await mailbox.run(requested, async () => {
            const intent = navigationIntentOwner.begin(c, { sequence: sample.sequence }, options)!
            runningCoverage = navigationCoverageFlight<PaintedTile>(contract, generation, {
              zoom: sample.view.zoom, bounds: { x: -camera.x / scale, y: -camera.y / scale,
                width: w / scale, height: h / scale }, cancel: intent.cancel,
            })
            coverageFlight.current = runningCoverage
            if (nativeNavigation) navigationCapture = nativeNavigationHandoff.start(identity,
              previewDevice.current.client === c ? previewDevice.current.key : undefined)
            try {
              const result = await c.render(doc, options, false, backend, false, false, undefined, undefined, intent.signal)
              if (!intent.current()) {
                result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile])
                throw Error('PREVIEW_CANCELLED')
              }
              return result
            }
            finally { intent.settle() }
          })
          if (!ownsScope()) {
            if (navigationCapture) nativeNavigationHandoff.finish(navigationCapture, false)
            result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile]); return
          }
          syncedDoc.current = doc
          // A completed older sample remains real same-content cache history,
          // with its own sampling camera/density. It never takes ownership of
          // the latest active plan or certifies its native-phase readiness.
          // Keep the last acknowledged preview while the new one imports; the
          // ordinary byte-budgeted LRU bounds this compatible history.
          const delivered = receive({ key: residentDisplay ? viewportPreviewKey(identity) : `navigation-preview:${contract.revision}:${serial.current + 1}`, x: -sample.view.x * ratio,
            y: -sample.view.y * ratio, width: w, height: h, zoom: scale, gutter: 0, viewportPreview: true,
            previewSource: previewSource(sample.view),
            ...(residentDisplay ? { viewportCache: captureViewportPreview(identity) } : {}),
            ...(navigationCapture?.device && result.backend === 'webgpu' ? { nativeNavigationDevice: navigationCapture.device } : {}),
            bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile, backend: result.backend,
            description: result.description || '', milliseconds: result.milliseconds, cached: false })
          if (runningCoverage && delivered) runningCoverage.tile = delivered
          if (navigationCapture) nativeNavigationHandoff.finish(navigationCapture, !!delivered && result.backend === 'webgpu')
          if (delivered) void navigationRefinement.request()
          return
        }
        if (nativeNavigation && phaseExact && renderScale === detailLevel &&
            Object.is(view.x, requestedView.x) && Object.is(view.y, requestedView.y) && Object.is(view.zoom, requestedView.zoom)) {
          const camera = { x: view.x * dpr, y: view.y * dpr, zoom: detailLevel }
          const identity = previewIdentity('navigation-preview', camera, Math.ceil(width * dpr), Math.ceil(height * dpr))
          const device = previewDevice.current.client === c ? previewDevice.current.key : undefined
          const tile = cachedPreview(identity)
          if (tile && reusableNativeNavigationPreview(tile, identity, ready.current.has(tile.key), device)) {
            // This is the very same physical camera, sample phase and actual
            // presenter owner, not a density/coverage approximation. Keep the
            // original payload/key and native sampling mode through the ACK.
            desired.current = [tile.key]
            protectedKeys.current = new Set(desired.current)
            activePlan.current = { key: frameKey, revision: contract.revision, document: doc, view: { ...view },
              dpr, width, height, rasterScale: detailLevel, samplingDensity: dpr, samplingMode: 'native', pageId,
              epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
              rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
              ids: new Set(desired.current), residents: new Map() }
            touchPreviews([tile])
            commitRef.current()
            return
          }
          const pending = nativeNavigationHandoff.matching(identity, device)
          if (pending && (pending.state === 'running' || tileRef.current.has(viewportPreviewKey(identity)))) {
            // Only an exact current-camera job may defer a duplicate native
            // fill. Different cameras continue the normal serialized plan.
            nativeNavigationHandoff.wait(pending, () => {
              const latest = latestContext.current.requestedView || latestContext.current.view
              if (current() && Object.is(view.x, latest.x) && Object.is(view.y, latest.y) && Object.is(view.zoom, latest.zoom))
                setDisplayRetry(value => value + 1)
            })
            return
          }
        }
        let sequentialCapture: { ratio: number; w: number; h: number; x: number; y: number; key: string;
          camera: SurfaceProps['view']; identity: ViewportPreviewIdentity } | undefined
        if (sharpNavigation && zooming && !repairCurrent() && (import.meta.env.VITE_DESIGN_SEQUENTIAL_DISPLAY === '1' ||
            import.meta.env.VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE === '1')) {
          if (gestureHeadroom && syncedDoc.current === doc && previewDevice.current.client === c && previewDevice.current.key) {
            const resident = [...tileRef.current.values()].filter(tile => tile.document === doc && tile.revision === contract.revision &&
              ready.current.has(tile.key) && tile.gpuTile !== undefined && tile.residentDevice?.client === c &&
              tile.residentDevice.key === previewDevice.current.key && tile.zoom >= renderScale &&
              tileIntersectsView(tile, view, { width, height }))
            if (resident.length && tilesCoverBounds(resident, viewport, renderScale)) {
              // A completed world window already owns every requested sample
              // at this prospective density. Do not recapture it because the
              // screen-space camera or viewport pixel size changed within a rung.
              sequentialPending.current?.cancel(); sequentialPending.current = null
              navigationIntentOwner.reset(c)
              desired.current = resident.map(tile => tile.key)
              protectedKeys.current = new Set(desired.current)
              activePlan.current = { key: frameKey, revision: contract.revision, document: doc, view: { ...view },
                dpr, width, height, rasterScale: renderScale, samplingDensity: renderScale / view.zoom, samplingMode: rasterPlan.mode,
                pageId, epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
                rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
                ids: new Set(desired.current), residents: new Map() }
              touchPreviews(resident); commitRef.current()
              return
            }
          }
          const worldCapture = gestureHeadroom ? gestureViewportCapture(view, dpr, width, height, renderScale) : undefined
          const ratio = renderScale / view.zoom
          const w = worldCapture?.tile.w ?? Math.ceil(width * ratio), h = worldCapture?.tile.h ?? Math.ceil(height * ratio)
          const camera = worldCapture?.camera ?? { x: view.x * ratio, y: view.y * ratio, zoom: renderScale }
          const x = worldCapture?.tile.x ?? -view.x * ratio, y = worldCapture?.tile.y ?? -view.y * ratio
          const identity = previewIdentity('sequential-viewport', camera, w, h), cached = cachedPreview(identity)
          if (cached) {
            sequentialPending.current?.cancel(); sequentialPending.current = null
            navigationIntentOwner.reset(c)
            desired.current = [cached.key]
            protectedKeys.current = new Set(desired.current)
            activePlan.current = { key: frameKey, revision: contract.revision, document: doc, view: { ...view },
              dpr, width, height, rasterScale: cached.zoom, samplingDensity: ratio, samplingMode: 'native',
              pageId, epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
              rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
              ids: new Set(desired.current), residents: new Map() }
            touchPreviews([cached]); commitRef.current()
            return
          }
          sequentialCapture = { ratio, w, h, x, y, camera, identity,
            key: JSON.stringify([renderScale, camera.x, camera.y, w, h, width, height, dpr]) }
        }
        if (sequentialCapture && !(sequentialUnsupported.current?.contract === contract &&
            sequentialUnsupported.current.captures.has(sequentialCapture.key))) {
          const { ratio, w, h, x, y, camera, identity, key: captureKey } = sequentialCapture
          const workKey = JSON.stringify([width, height, dpr])
          const capturedGoal = sequentialGoal.current
          const pending = sequentialPending.current
          const sameScope = pending?.contract === contract && pending.key === workKey && pending.scopeCurrent()
          const tile: RasterTile = sameScope ? pending.tile : {
            key: viewportPreviewKey(identity), x, y, width: w, height: h, zoom: renderScale, gutter: 0,
          }
          // A pending capture retains its own immutable camera. Keep the live
          // plan on the latest camera, and certify it only if those pixels can
          // actually cover that camera. Reprojection cannot create detail.
          const useful = tilesCoverBounds([tile], viewport, detailLevel)
          desired.current = useful ? [tile.key] : []
          // Replace the native plan's old protection even when this running
          // capture cannot cover the latest camera. Keep its one immutable
          // payload protected until completion hands off to the latest goal.
          protectedKeys.current = new Set([tile.key])
          activePlan.current = { key: frameKey, revision: contract.revision, document: doc, view: { ...view },
            dpr, width, height, rasterScale: tile.zoom, samplingDensity: tile.zoom / view.zoom, samplingMode: 'native',
            pageId, epoch: props.presentationEpoch || 0, grid: false, pixelPreview: props.pixelPreview,
            rasterProfile: props.rasterProfile, managed: false, displayCapability, computeBackend: backend,
            ids: new Set(desired.current), residents: new Map() }
          if (sameScope) return
          const options = { pageId, width: w, height: h,
            view: camera,
            transparent: false, grid: false, rasterProfile, livePreview: true, renderIntent: 'preview' as const,
            sequentialViewport: true }
          const intent = navigationIntentOwner.begin(c, { sequence: token }, options)!
          const admission = { contract, key: workKey, tile, cancel: intent.cancel, scopeCurrent: () => false as boolean }
          const requested = () => {
            const latest = sequentialContext.current
            return sameContent() && latestContext.current.visible !== false &&
              sequentialPending.current === admission && intent.current() &&
              latest.width === width && latest.height === height && latest.dpr === dpr && !latest.suspended
          }
          admission.scopeCurrent = requested
          sequentialPending.current = admission
          let wakeNativeFallback = false
          try {
            const result = await mailbox.run(requested,
              () => c.render(doc, options, false, backend, false, false, undefined, undefined, intent.signal))
            if (!requested()) { result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile]); return }
            syncedDoc.current = doc
            receive({ ...tile, viewportPreview: true, previewSource: previewSource(view), viewportCache: captureViewportPreview(identity), bytes: result.bytes, bitmap: result.bitmap,
              gpuTile: result.gpuTile, backend: result.backend, description: result.description || '',
              milliseconds: result.milliseconds, cached: false })
            return
          } catch (error) {
            if ((error instanceof Error ? error.message : error) !== 'SEQUENTIAL_DISPLAY_UNSUPPORTED') throw error
            if (!sameContent()) return
            if (!repairCurrent()) sequentialRepair.current = { contract, width, height, dpr }
            if (sequentialUnsupported.current?.contract !== contract)
              sequentialUnsupported.current = { contract, captures: new Set() }
            const rejected = sequentialUnsupported.current.captures
            rejected.add(captureKey)
            // Halo/source admission depends on the captured camera as well
            // as density. Remember only exact rejections, with bounded history.
            while (rejected.size > 64) rejected.delete(rejected.values().next().value!)
            // Only explicit capability rejection falls through to native
            // tiles. Budget, device and cancellation errors keep their normal
            // error/recovery handling and are never silently downgraded.
            if (!current()) { wakeNativeFallback = true; return }
          } finally {
            if (sequentialPending.current === admission) {
              sequentialPending.current = null
              // The last camera may have arrived while this capture was still
              // running, including the quiet transition. Wake once even when
              // no further wheel event will rerun the effect. A completed old
              // density remains useful history; it never certifies a newer
              // density unless the actual tile covers that native viewport.
              if (sameContent() && latestContext.current.visible !== false && intent.current() &&
                  (wakeNativeFallback || sequentialGoal.current !== capturedGoal))
                setDisplayRetry(value => value + 1)
            }
            intent.settle()
          }
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
        const planCurrentTiles = ()=>planTilesWithPrefetchRim(viewport, renderScale, budgetTileLimit(
          budget, hdrCompositing && !!doc.colorManagement), renderPhase, tilePrefetchRingsFromHost())
        const planned = c.traceMainThread?.(41,planCurrentTiles) ?? planCurrentTiles()
        // Stable world samples reuse pixels within a density level; native
        // pixel/chrome paths retain their explicit camera phase.
        const rekey = (tile: RasterTile) => ({ ...tile, key: tileComputationKey(tile, renderCamera, cameraDependent) })
        const plan = planned.viewport.map(rekey)
        const rim = planned.rim.map(rekey)
        const prefetch = props.interaction?.selection.length || zooming || nativeVisibleTiles && cameraMoving ? {rim:[],cacheLimitSkipped:0} :
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
              setStats(s => ({ ...s, ms: synchronized.milliseconds, compileMs: synchronized.compileMs || 0, completeKey: frameKey }))
              commitRef.current()
              return
            }
          }
          commitRef.current()
        }
        const finishingCoverage = coverageFlight.current
        if (finishingCoverage?.contract === contract && finishingCoverage.generation === generation) {
          await finishingCoverage.done
          if (!current()) return
        }
        if (needsStartupPreview && !pendingCoverage()) {
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
              previewSource: previewSource(view),
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
        // A tiny intersecting high-zoom crop cannot cover a newly exposed
        // zoom-out viewport. Admit one bounded continuity capture at any zoom,
        // distinct from low-zoom LOD and final/native sampling policy. No retry
        // ladder progressively degrades it; exact repair follows immediately.
        const continuityAllowed = !retainedEditViewport && !nativePanRepair && !sharpNavigation && !gestureHeadroom && !nativeNavigation && !nativeVisibleTiles && singleCanvas &&
          !hdrCompositing && !props.grid && !props.checkerboard && !props.pixelPreview && !props.interaction?.active
        if (!needsStartupPreview && continuityAllowed &&
            !hasReadyCoverage() && !hasRepairBacking() && !pendingCoverage() && !plan.every(tile => tileRef.current.has(tile.key) && ready.current.has(tile.key))) {
          const target = { ...requestedView }, ratio = navigationPreviewDensity(dpr, width, height)
          const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio))
          const stillRequested = () => {
            const next = latestContext.current.requestedView || latestContext.current.view
            return current() && next.x === target.x && next.y === target.y && next.zoom === target.zoom
          }
          try {
            const result = await mailbox.run(stillRequested, () => {
              runningCoverage = navigationCoverageFlight<PaintedTile>(contract, generation)
              coverageFlight.current = runningCoverage
              return c.render(doc, { pageId, width: w, height: h,
              view: { x: target.x * ratio, y: target.y * ratio, zoom: target.zoom * ratio },
              transparent: false, grid: false, rasterProfile, livePreview: true, renderIntent: 'preview',
            }, false, backend, false)
            })
            if (!sameContent() || coverageGeneration.current !== generation) {
              result.bitmap?.close(); if (result.gpuTile) c.releasePresented([result.gpuTile]); return
            }
            const delivered = receive({ key: `coverage-preview:${contract.revision}:${serial.current + 1}`, x: -target.x * ratio, y: -target.y * ratio,
              width: w, height: h, zoom: target.zoom * ratio, gutter: 0, viewportPreview: true,
              previewSource: previewSource(target),
              bytes: result.bytes, bitmap: result.bitmap, gpuTile: result.gpuTile, backend: result.backend,
              description: result.description || '', milliseconds: result.milliseconds, cached: false })
            if (runningCoverage && delivered) runningCoverage.tile = delivered
            runningCoverage?.finish()
          } catch (error) {
            runningCoverage?.finish()
            if (String(error).includes('PREVIEW_CANCELLED')) return
            if (/device lost|GPU device|has been lost|设备已丢失|recovery failed/i.test(String(error)) ||
                !isRecoverablePreviewBudget(error) && !isDisplayBudgetError(error) &&
                !/PREVIEW_BUDGET|GPU.*(?:budget|预算)/i.test(String(error))) throw error
          }
        }
        // A bounded page overview covers large zoom-outs and previously unseen
        // portions of a board. It owns real world pixels, not a viewport crop.
        // Preserve it through cache pressure until its content is invalidated.
        const currentCoverage = () => hasReadyCoverage() || pendingCoverage() || hasRepairBacking()
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
        const pageFitsView = !!extent && viewport.x <= extent.x && viewport.y <= extent.y &&
          viewport.x + viewport.width >= extent.x + extent.width &&
          viewport.y + viewport.height >= extent.y + extent.height
        const warmOverview = () => {
          if (baseOverview && baseOverview.tiles.some(tile=>!ready.current.has(tile.key))) {
            cancelOverview = scheduleRasterMaintenance([baseOverview],()=>fillOverview(),
              () => current() && plan.every(tile => ready.current.has(tile.key)),
              error => console.debug('[overview] optional maintenance dropped',error))
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
        const bootstrap = !sharpNavigation && !nativeVisibleTiles && !displayed && residentDisplay && !cameraDependent &&
          baseOverview && !pageFitsView && !props.interaction?.active && coverageBootstrap.current !== contract.revision ? async () => {
            try {
              await fillOverview()
              if (baseOverview.tiles.every(tile=>ready.current.has(tile.key))) coverageBootstrap.current = contract.revision
            } catch (error) {
              console.debug('[coverage] startup overview unavailable', String(error))
            }
          } : undefined
        await request(plan, prefetch, bootstrap)
        // A selected object is about to move (or is warming its live scene).
        // A monolithic overview tile cannot be preempted inside WASM, so do
        // not put it behind selection warm-up and ahead of the first pose.
        if (!sharpNavigation && !nativeVisibleTiles && !pageFitsView && !cameraMoving && !props.interaction?.selection.length && current()) warmOverview()
        if (current()) {
          setStats((s) => ({
            ...s,
            completeKey: activePlanKey.current,
            complete: desired.current.every((key) => ready.current.has(key)),
          }))
        }
      } catch (error) {
        if (navigationCapture) nativeNavigationHandoff.finish(navigationCapture, false)
        const headroomFailure = renderFailureFields(error)
        const speculativeLimit = headroomFailure.failureCategory === 2 &&
          [40, 41, 42].includes(headroomFailure.failureCode)
        if ((sharpNavigation || nativeVisibleTiles) && renderScale > detailLevel && sharpHeadroomBlocked !== contract &&
            current() && headroomFailure.failureCategory !== 1 && headroomFailure.failureCategory !== 4 &&
            !/device lost|GPU device|has been lost|设备已丢失|PREVIEW_CANCELLED/i.test(String(error)) &&
            (isDisplayBudgetError(error) || isRecoverablePreviewBudget(error) ||
              headroomFailure.failureCategory === 3 || speculativeLimit)) {
          // Speculation may exceed a filter's halo/working-set budget. Retry at
          // the current physical density, never at a low-resolution preview.
          setSharpHeadroomBlocked(contract)
          return
        }
        // An aborted A can reject after a newer A reused the same sample/size
        // key. Cleanup belongs to this admission object, even after finally
        // has settled its presentation intent.
        if (navigationAdmission && previewAdmission.current === navigationAdmission) {
          if (navigationIntent) navigationBudgetLatch.reject(contract, navigationIntent, displayRetry, error)
          previewAdmission.current.key = undefined
        }
        // A bounded navigation preview is optional. Preserve current resident
        // pixels under pressure; only final exact refinement is authoritative.
        if (navigationZoom.active && !/device lost|GPU device|has been lost|设备已丢失|recovery failed/i.test(String(error)) &&
          /PREVIEW_BUDGET|GPU.*(?:budget|预算)|Invalid GPU viewport|GPU 区域超过安全限制/i.test(String(error))) {
          // A whole-viewport halo can exceed admission while one regional
          // native tile still fits. Keep the same quality and byte budgets;
          // let the existing one-turn scheduler resolve the latest visible
          // miss instead of leaving continuity failure to starve detail.
          void navigationRefinement.request()
          return
        }
        // Cached pages are expendable under device pressure, before retiring
        // current-page coverage or retrying an exact visible request.
        const tileBudgetError = isDisplayBudgetError(error) || isTileAdmissionBudgetError(error)
        const retiredPages = current() && tileBudgetError && pageResidency.size > 0
        if (retiredPages) { pageResidency.clear(); setTiles(new Map(tileRef.current)) }
        // Reclaim only history; the last displayed frame and incoming visible
        // tiles stay pinned. Retry once after React has presented/released the
        // retired handles, without increasing the device budget.
        const used = compositeCacheUse()
        if (current() && tileBudgetError && runAttempts++ < 1 &&
          (retiredPages || dropTiles((key, tile) => !protectedKeys.current.has(key) && !(compositeCacheFrame.current?.displayed ?? displayed)?.ids.has(key) &&
            !coverageRetention.current.has(key) && !used.has(tile) && !tile.overview))) {
          requestAnimationFrame(() => { if (current()) void run() })
          return
        }
        failed(error)
        // A transient worker/GPU failure must not pin the canvas on the
        // previous document's pixels until the next camera move; retry the
        // same plan a bounded number of times before leaving the error up.
        if (current() && /device lost|GPU device|设备已丢失|上下文已丢失|worker.*(?:failed|error)/i.test(String(error)) && runAttempts++ < 2)
          setTimeout(() => { if (current()) void run() }, 500)
      } finally {
        runningCoverage?.finish()
      }
    }
    // Figma mP defers density changes by two observed frames. Translation
    // does not reset that countdown and exposed tiles start immediately.
    void run()
    return () => {
      navigationRefinement.update()
      translationRefinement.update()
      translationCoverage.current=undefined
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
    props.visible,
    props.interaction?.active,
    retainedEditing,
    props.interaction?.selection.join(','),
    motionPreview,
    nativeNavigation,
    nativeVisibleTiles,
    progressiveNativeRepair,
    sharpNavigation,
    zooming,
    cameraMoving,
    displayRetry,
    residencyBudget,
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
    navigationIntentOwner,
    navigationRefinement,
    translationRefinement,
    nativeNavigationHandoff,
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
    if (pageResidency.trim(pageResidency.limit, inactive =>
      estimatedTileResidencyBytes([...activeResidents, ...inactive]) > residencyBudget))
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
  // Publish the target lattice together, including on camera-only changes.
  const fullPlanReady = currentPlan && !!plan?.ids.size && [...plan.ids].every(key=>ready.current.has(key)) && syncedDoc.current===doc
  // A complete current viewport preview is an atomic replacement, including
  // continuous navigation; it never mixes partial tiles over another revision. The old
  // frame stays retained until the actual resident compositor ACK below.
  // Do not treat import-ready as displayed, or geometric coverage as quality.
  const previewReplacement = residentDisplay && !hdrCompositing && !fullPlanReady &&
    (!displayed || !reusableFrame || navigationZoom.active) && props.visible !== false && !props.paused && !navigationZoom.suspended
    ? [...visible].reverse().find(tile => {
      const capture = tile.previewSource, device = previewDevice.current
      return tile.viewportPreview && tile.backend === 'webgpu' && tileRef.current.get(tile.key) === tile &&
        tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key) &&
        Number.isSafeInteger(tile.gpuTile) && tile.gpuTile! > 0 && capture?.contract === contract &&
        capture.generation === coverageGeneration.current && capture.client === client.current &&
        device.client === capture.client && (!capture.device || capture.device === device.key) &&
        capture.width === width && capture.height === height && capture.dpr === dpr &&
        capture.precision === previewPrecision && capture.profile === rasterProfile &&
        Object.is(capture.view.x, requestedView.x) && Object.is(capture.view.y, requestedView.y) &&
        Object.is(capture.view.zoom, requestedView.zoom) &&
        navigationHasCoverage([tile], requestedView, width, height)
    }) : undefined
  const replacementFrame: DisplayFrame | undefined = previewReplacement ? {
    preview: true, key: `preview-frame:${contract.revision}:${previewReplacement.serial}`,
    revision: contract.revision, document: doc, view: { ...requestedView }, dpr, width, height,
    rasterScale: previewReplacement.zoom, samplingDensity: previewReplacement.zoom / requestedView.zoom,
    samplingMode: 'native', pageId, epoch: props.presentationEpoch || 0,
    grid: false, pixelPreview: props.pixelPreview, rasterProfile: props.rasterProfile,
    managed: false, computeBackend: backend, displayCapability,
    ids: new Set([previewReplacement.key]), residents: new Map([[previewReplacement.key, previewReplacement]]),
  } : undefined
  const canRefine = !displayed || reusableFrame || fullPlanReady
  const startupPreview = !displayed && visible.some(tile => tile.viewportPreview &&
    tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key))
  const partialDetail=progressiveNativeRepair&&residentDisplay&&reusableFrame&&currentPlan&&
    !hdrCompositing&&!cameraDependent&&!props.grid&&!props.checkerboard&&!props.pixelPreview&&!props.interaction?.active&&syncedDoc.current===doc
  const fineTile = (tile: PaintedTile) => tileRef.current.get(tile.key) === tile &&
    (fullPlanReady||partialDetail&&acceptNativeSample({
      sameRevision: tile.document===doc&&tile.revision===contract.revision,
      nativeDensity: tile.zoom>=detailLevel,
      nativePhase: tileHasNativePhase(tile,requestedView,dpr),
    })&&
      !!tile.gpuTile&&previewDevice.current.client===rasterClient&&!!previewDevice.current.key&&
      (!tile.residentDevice||tile.residentDevice.client===rasterClient&&tile.residentDevice.key===previewDevice.current.key))&&
    !!plan?.ids.has(tile.key) && ready.current.has(tile.key) &&
    (syncedDoc.current === doc || tile.document === doc)
  // A lower-density preview may also hand off as a whole viewport. A cache
  // hit or a single LOD tile does not authorize a patchwork over the backing.
  const coarse = !fullPlanReady && canRefine && lodActive ? visible.filter(tile =>
    !inactiveSet.has(tile) && tileRef.current.get(tile.key) === tile && tile.lod === true &&
    tile.document === doc && tile.revision === contract.revision && tile.zoom === lodScale &&
    ready.current.has(tile.key) && tileIntersectsView(tile,requestedView,{width,height})) : []
  const coarseCohort = coarse.length && navigationHasCoverage(coarse, requestedView, width, height)
    ? new Set(coarse) : undefined
  const coarseTile = (tile: PaintedTile) => !!coarseCohort?.has(tile)
  const previews = !fullPlanReady && !coarseCohort && canRefine ? visible.filter(tile =>
    !inactiveSet.has(tile) && (!plan?.ids.has(tile.key) || tile.viewportPreview) && tileRef.current.get(tile.key) === tile &&
    tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key) &&
    tileIntersectsView(tile, requestedView, { width, height })).reverse() : []
  // A whole capture from the previous camera can still be projected during a
  // reversal. Keep that single image while a wider replacement is uploading.
  const cachedViewport = previews.find(tile => navigationHasCoverage([tile], requestedView, width, height)) ??
    (!displayed ? previews.find(tile => tile.viewportPreview) : undefined)
  const cachedPreviewTile = (tile: PaintedTile) => tile === cachedViewport
  const baseTile = (tile: PaintedTile) => !fullPlanReady && !coarseCohort && !cachedViewport &&
    displayed?.residents.get(tile.key) === tile
  // The previous frame is one camera. Zoom-out and a pan during zoom expose
  // world the frame does not own. Ready overview and coarser tiles already in
  // memory paint those pixels in the same present; they are not a new density.
  const continuityUnderlay = (() => {
    if (previewReplacement || fullPlanReady || !residentDisplay) return [] as PaintedTile[]
    const shown = visible.filter(tile => !inactiveSet.has(tile) && (fineTile(tile) || baseTile(tile) || coarseTile(tile) || cachedPreviewTile(tile)))
    const world = { x: -requestedView.x / requestedView.zoom, y: -requestedView.y / requestedView.zoom,
      width: width / requestedView.zoom, height: height / requestedView.zoom }
    if (tilesCoverBounds(shown, world)) return [] as PaintedTile[]
    const device = previewDevice.current
    if (device.client !== rasterClient || !device.key) return [] as PaintedTile[]
    // A whole-viewport preview has its own admission. A mismatched capture must
    // not sneak back in as underlay; ordinary world tiles are the coverage stack.
    const candidates = visible.filter(tile => !tile.viewportPreview && !inactiveSet.has(tile) && tileRef.current.get(tile.key) === tile &&
      tile.document === doc && tile.revision === contract.revision && ready.current.has(tile.key) &&
      tile.gpuTile !== undefined && (!tile.residentDevice ||
        tile.residentDevice.client === rasterClient && tile.residentDevice.key === device.key))
    return selectCoverageUnderlay(candidates, requestedView, { width, height }, shown, 24)
  })()
  const continuityKeys = new Set(continuityUnderlay.map(tile => tile.key))
  // One frame description owns both actual composition and cache-use proof.
  // Intersecting history that contributes no physical fragment stays evictable.
  const compositeItems = visible.map(tile => {
    // Full replacement starts from the compositor's cleared target; do not
    // source-over a translucent new page onto old-revision pixels.
    if (previewReplacement) return { tile, gutter: tile.gutter ?? 1, active: tile === previewReplacement, layer: 2 }
    const fine = !inactiveSet.has(tile) && fineTile(tile), base = !inactiveSet.has(tile) && baseTile(tile),
      coarse = !inactiveSet.has(tile) && coarseTile(tile), cached = !inactiveSet.has(tile) && cachedPreviewTile(tile),
      continuity = continuityKeys.has(tile.key)
    return { tile, gutter: tile.gutter ?? 1, active: fine || base || coarse || cached || continuity,
      layer: progressiveTileLayer({ fine, cached, coarse, refining: !complete && canRefine, cameraDependent,
        nativeDensity: tile.zoom >= requestedView.zoom * dpr,
        nativePhase:tileHasNativePhase(tile,requestedView,dpr),
        sameContent: tile.document === doc && tile.revision === contract.revision }) }
  })
  useLayoutEffect(() => {
    // Publish owner, camera, items and budget atomically after child layout
    // queued this exact frame. An interrupted render cannot replace only its
    // owner and make a still-displayed hole-filling source look unused.
    compositeCacheFrame.commit(compositeOwner, !singleCanvas ? null : !residentDisplay
      ? { ...compositeOwner, items: compositeItems } : undefined)
  })
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
  const visual = replacementFrame || (cameraPreview && plan ? (reusableFrame ? displayed : plan) : displayed)
  // Keep child layout anchored to the completed camera. A gesture changes one
  // compositor transform, instead of every resident canvas's layout rectangle.
  const placementView = displayed?.view || view
  const cameraTransform = frameTransform(requestedView, placementView)
  const previewCameraOk = previewCameraScaleWithinLimit(placementView.zoom, requestedView.zoom)
  const presentation = visual ? {
    view: cameraPreview ? requestedView : visual.view,
    document: visual.document, pageId: visual.pageId, epoch: visual.epoch,
    width: visual.width, height: visual.height, pixelRatio: visual.dpr, managed: visual.managed,
    grid: visual.grid, checkerboard: visual.checkerboard, pixelPreview: visual.pixelPreview, rasterProfile: visual.rasterProfile,
    displayCapability: visual.displayCapability, computeBackend: visual.computeBackend, preview: !!cameraPreview,
  } : null
  const observeBacking = (frame: PresentedFrame | null | undefined) => {
    if (!frame || frame.document.id !== doc.id || frame.computeBackend && frame.computeBackend !== backend ||
        !presentationMatches(frame, { document:frame.document, pageId, epoch:props.presentationEpoch || 0,
          view:frame.view, width, height, pixelRatio:dpr, grid:props.grid, checkerboard:props.checkerboard,
          pixelPreview:props.pixelPreview, rasterProfile, animation:props.animation, displayCapability })) return
    const owner = client.current
    setAcceptedBacking(old => old?.identity === identity && old.client === owner ? old : { identity, client:owner })
  }
  const hasAcceptedBacking = singleCanvas && acceptedBacking?.identity === identity && acceptedBacking.client === rasterClient
  const retainedFrame = !!displayed || hasAcceptedBacking || cachedPreviewCount > 0 || !!previewReplacement
  useLayoutEffect(() => {
    // Offscreen GPU submission is asynchronous. Only its reply can publish
    // the camera; synchronous CSS/WebGL placement keeps this immediate path.
    if (!residentDisplay && !singleCanvas) props.onPresentation?.(presentation)
  }, [visual, cameraPreview, requestedView, props.onPresentation, residentDisplay, singleCanvas])
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: doc.pages.find((p) => p.id === pageId)?.background || '#f5f5f5',
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
        data-page-cache-misses={pageResidency.misses}
        data-page-cache-evictions={pageResidency.evictions}
        data-page-cache-tier={memoryTier}
        data-page-residency-estimated-budget={residencyBudget}
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
        data-resident-bytes={estimatedTileResidencyBytes(visible)}
        data-resident-budget={residencyBudget}
        data-active-resident-budget={displayBudget}
        data-cache-steady-budget={displayBudget}
        data-cache-staging-limit={cacheAdmission.current.reserveBytes}
        data-cache-admission-budget={cacheAdmission.current.admissionBudget}
        data-cache-active-bytes={estimatedTileResidencyBytes(activeResidents)}
        data-cache-active-highwater={cacheAdmission.current.activeHighWater}
        data-cache-total-highwater={cacheAdmission.current.totalHighWater}
        data-refine-ms={stats.ms.toFixed(2)}
        data-raster-trace={import.meta.env.DEV ? JSON.stringify(rasterTrace.current) : undefined}
        data-navigation-ms={navigationTiming.current.completeMs?.toFixed(2)}
        data-first-detail-ms={navigationTiming.current.firstDetailMs?.toFixed(2)}
        data-compile-ms={stats.compileMs.toFixed(2)}
        data-pipeline-wall-ms={stats.pipelineWallMs.toFixed(2)}
        data-preparation-wait-ms={stats.preparationWaitMs.toFixed(2)}
        data-overlapped-preparations={stats.overlappedPreparations}
        data-frame-resource-hits={stats.frameResourceHits}
        data-frame-resource-bytes={stats.frameResourceBytes}
        data-graph-ms={stats.graphMs.toFixed(2)}
        data-finish-ms={stats.finishMs.toFixed(2)}
        data-checkpoint-ms={stats.checkpointMs.toFixed(2)}
        data-detail-ready={String(!props.paused && complete)}
        data-frame-publication={displayed ? displayed.preview ? 'preview' : 'complete' : 'pending'}
        data-retained-commit={String(!!displayed && [...displayed.residents.values()].some(tile => tile.committedViewport))}
        data-retained-page-commit={String(!!displayed && [...displayed.residents.values()].some(tile => tile.committedViewport && tile.description==='retained native page translation'))}
        data-lod-scale={lodActive ? lodScale : 0}
        data-lod-tiles={lodVisibleCount}
        data-lod-cache-bytes={lodSnapshots.bytes}
        data-lod-cache-budget={lodSnapshots.maxBytes}
        data-lod-cache-hits={stats.coarseHits}
        data-preview-active={String(cameraPreview)}
        data-progressive-tiles={fineVisibleCount}
        data-failed-tiles={failedTiles.current.size}
        data-cached-preview-tiles={cachedPreviewCount}
        data-coverage-underlay={continuityUnderlay.length}
        data-overview-tiles={visible.filter(tile => tile.overview && ready.current.has(tile.key)).length}
        data-overview-reuses={overviewReuses.current}
        data-resident-eligible={String(residentDisplay)}
        data-resident-reason={!singleCanvas ? 'single-canvas-unavailable' : !allowsResidentSdr(renderExecutionPolicy, backend) ? 'policy-or-backend' : !navigator.gpu ? 'webgpu-unavailable' : import.meta.env.VITE_DESIGN_RESIDENT_DISPLAY === '0' ? 'disabled' : 'eligible'}
        data-motion-preview={String(motionPreview)}
        data-motion-raster-scale={renderScale}
        data-camera-moving={String(cameraMoving)}
        data-navigation-pending-age-ms={navigationZoom.pendingAgeMs}
        data-navigation-zoom-active={String(navigationZoom.active)}
        data-native-navigation={String(nativeNavigation)}
        data-native-visible-tiles={String(nativeVisibleTiles)}
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
          transform: singleCanvas || !(previewCameraOk || retainedFrame) ? undefined : `translate(${cameraTransform.x}px,${cameraTransform.y}px) scale(${cameraTransform.scale})`,
          // Upload/acknowledge tiles while hidden. The first visible canvas
          // must have a complete acknowledged viewport, including on a page
          // change. Later camera previews keep the previous complete frame,
          // including a jump past the preview scale limit. Hiding that bitmap
          // before a closer frame covers is the blank pasteboard. Readiness
          // counters cannot hide its backbuffer.
          visibility: props.visible === false || !retainedFrame ? 'hidden' : 'visible',
          pointerEvents: 'none',
        }}
      >
        {singleCanvas ? (() => {
          const CompositeSurface = residentDisplay && rasterClient ? ResidentCompositeSurface : TileCompositeSurface
          return <CompositeSurface key={residentDisplay && rasterClient ? 'resident' : 'bitmap'} client={rasterClient!}
          {...(residentDisplay ? { reuseSequence: previewReuseSequence.current } : {})}
          items={compositeItems}
          onCompositeItems={residentDisplay ? items => compositeCacheFrame.stage(compositeOwner, {
            ...compositeOwner,
            // Interaction-owned captures have separate lifetime accounting.
            // Retained page/board moves alias these exact live page sources.
            items: items.flatMap(item => {
              const tile = tileRef.current.get(item.tile.key)
              return tile === item.tile ? [{ ...item, tile,
                placement: item.placement ? { ...item.placement } : undefined,
                clip: item.clip ? { ...item.clip } : undefined }] : []
            }),
          }) : undefined}
          view={requestedView} width={width} height={height} dpr={dpr}
          presentation={presentation}
          overview={props.overview}
          overviewTiles={[...new Set([...overviewKeys.current,...(nativePageBacking.current?.keys || [])])].flatMap(key=>{
            const tile=tileRef.current.get(key)
            return tile && tile.document===doc && tile.revision===contract.revision && ready.current.has(key) &&
              previewDevice.current.client===rasterClient && !!previewDevice.current.key &&
              (!tile.residentDevice || tile.residentDevice.client===rasterClient && tile.residentDevice.key===previewDevice.current.key) ? [tile] : []
          })}
          allowPanPreview={import.meta.env.VITE_DESIGN_PAN_PRESENT_PREVIEW!=='0'}
          panBacking={reusableFrame&&displayed&&!displayed.preview?displayed:undefined}
          onTranslatedCoverage={residentDisplay ? (source,offset,sequence,failed)=>translationCoverage.current?.({source,offset,sequence,failed})===true : undefined}
          onComposited={residentDisplay ? undefined : frame => { observeBacking(frame); props.onPresentation?.(frame) }}
          terminalQuality={complete ? { qualitySequence: terminalQualityState.current.sequence,
            qualityRevision: contract.revision, pageToken: diagnosticPage.current.token } : undefined}
          overlay={props.overlay}
          sourceDocument={doc} contentRevision={contract.revision} translationItems={visible.filter(tile=>syncedDoc.current===doc&&ready.current.has(tile.key)&&
            acceptNativeSample({sameRevision:tile.revision===contract.revision,nativeDensity:tile.zoom===detailLevel,nativePhase:tileHasNativePhase(tile,requestedView,dpr)})&&
            (!fullPlanReady||props.interaction?.active||!plan||plan.ids.has(tile.key)))
            .map(tile=>({tile,active:true,layer:0}))} allowPageTranslation={!props.grid&&!props.checkerboard&&!props.pixelPreview}
          interaction={navigationZoom.active ? undefined : props.interaction?{...props.interaction,navigating:cameraMoving}:undefined} pageId={pageId} rasterProfile={rasterProfile} backend={backend}
          settledDocument={fullPlanReady ? doc : undefined}
          onPresented={(frame,source,device?: ViewportPreviewDevice)=>{
            observeBacking(source)
            const deviceKey = viewportPreviewDeviceKey(device), c = client.current
            if (deviceKey && device?.client === c) {
              const previousDevice = previewDevice.current
              if (previousDevice.client === c && previousDevice.key && previousDevice.key !== deviceKey) {
                coverageGeneration.current++
                coverageFlight.current = null
                previewAdmission.current.key = undefined
                navigationIntentOwner.reset(c!)
                setDisplayRetry(value => value + 1)
                const capture = nativeNavigationHandoff.current
                if (capture) nativeNavigationHandoff.finish(capture, false)
                nativeNavigationHandoff.invalidate()
              }
              const ids = new Set(frame.ids)
              let changed = false
              for (const tile of tileRef.current.values()) if (tile.gpuTile !== undefined &&
                  ids.has(tile.gpuTile) && ready.current.has(tile.key)) {
                if (tile.residentDevice?.client !== c || tile.residentDevice.key !== deviceKey) {
                  tile.residentDevice = { client: c, key: deviceKey }; changed = true
                }
                if (tile.viewportCache?.identity.client === c && tile.viewportCache.device !== deviceKey) {
                  tile.viewportCache = { ...tile.viewportCache, device: deviceKey }; changed = true
                }
              }
              previewDevice.current = { client: c, key: deviceKey }
              // Unknown initial ownership is not device loss. Preserve the
              // just-published frame and retire only acknowledged old-owner
              // cached captures, never unacknowledged incoming replacements.
              dropTiles((_key, tile) => tile.residentDevice?.client === c && tile.residentDevice.key !== deviceKey)
              if (changed) setTiles(new Map(tileRef.current))
              const capture = nativeNavigationHandoff.current
              if (capture?.state === 'delivered') {
                const tile = tileRef.current.get(viewportPreviewKey(capture.identity))
                if (!tile) nativeNavigationHandoff.finish(capture, false)
                else if (reusableNativeNavigationPreview(tile, capture.identity, ready.current.has(tile.key), deviceKey))
                  nativeNavigationHandoff.wake(capture)
              }
            }
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
            const latestView = latestContext.current.requestedView || latestContext.current.view
            if (previewReplacement && replacementFrame && source?.document === doc && source.preview &&
                source.pageId === pageId && source.epoch === (props.presentationEpoch || 0) &&
                latestContext.current.document === doc && latestContext.current.pageId === pageId &&
                latestContext.current.backend === backend && latestContext.current.presentationEpoch === props.presentationEpoch &&
                Object.is(latestView.x, requestedView.x) && Object.is(latestView.y, requestedView.y) &&
                Object.is(latestView.zoom, requestedView.zoom) &&
                sequentialContext.current.width === width && sequentialContext.current.height === height && sequentialContext.current.dpr === dpr &&
                !frame.interaction && frame.width === width && frame.height === height && frame.dpr === dpr &&
                Object.is(frame.view.x, requestedView.x) && Object.is(frame.view.y, requestedView.y) &&
                Object.is(frame.view.zoom, requestedView.zoom) && frame.ids.includes(previewReplacement.gpuTile!) &&
                deviceKey && device?.client === client.current &&
                (!previewReplacement.previewSource?.device || previewReplacement.previewSource.device === deviceKey) &&
                previewReplacement.previewSource?.contract === contract &&
                previewReplacement.previewSource.client === client.current &&
                previewReplacement.previewSource.precision === previewPrecision && previewReplacement.previewSource.profile === rasterProfile &&
                previewReplacement.previewSource.generation === coverageGeneration.current &&
                tileRef.current.get(previewReplacement.key) === previewReplacement && ready.current.has(previewReplacement.key)) {
              // ACK owns the publication and retirement boundary. A raced
              // exact completion is never downgraded back to a preview.
              setDisplayed(previous => previous?.document === doc && previous.revision === contract.revision &&
                !previous.preview ? previous : replacementFrame)
            }
            acknowledged.current={...frame,ids:new Set(frame.ids)};commitRef.current()
            if(source)props.onPresentation?.(source)
          }}
          onReady={readyHandler} onGone={goneHandler} onError={errorHandler}
          onFailure={message => {
            const capture = nativeNavigationHandoff.current
            if (capture) {
              nativeNavigationHandoff.finish(capture, false)
              nativeNavigationHandoff.invalidate()
              if (client.current) navigationIntentOwner.reset(client.current)
            }
            previewDevice.current = { client: client.current }
            const errorCode = renderDiagnosticError(message)
            recordRenderDiagnostic({ kind: 'error', zoom: requestedView.zoom, dpr,
              requestedDensity: requestedView.zoom * dpr, errorCode })
            if (import.meta.env.DEV && import.meta.env.VITE_DESIGN_TRACE_PASSES === 'tile') console.debug('DESIGN_PRESENTATION_FAILURE '+errorCode)
            setFailure(message); props.onRenderFailure?.();
            if (residentDisplay || backend === 'auto') props.onFallback(`PREVIEW_CPU_FALLBACK: ${message}`) }}
        /> })() : visible.map((tile) => {
          const fineVisible = !inactiveSet.has(tile) && fineTile(tile)
          const baseVisible = !inactiveSet.has(tile) && baseTile(tile)
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
        title={failure ? canvasStatusLabel(failure) : '画布高清显示'}
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
        {failure ? canvasStatusLabel(failure) :
          `${stats.actualBackend === 'webgl2' ? 'WebGL 2' : 'WebGPU'} · ${props.interaction?.active ? '编辑预览' : complete && previewCameraOk ? '清晰' : '计算中'}${stats.managed ? ' · 浮点' : ''}`}

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
  prev.panGestureActive === next.panGestureActive &&
  (prev.requestedView || prev.view).x === (next.requestedView || next.view).x &&
  (prev.requestedView || prev.view).y === (next.requestedView || next.view).y &&
  (prev.requestedView || prev.view).zoom === (next.requestedView || next.view).zoom &&
  prev.overviewNodes === next.overviewNodes &&
  (prev.overview?.x ?? 0) === (next.overview?.x ?? 0) &&
  (prev.overview?.y ?? 0) === (next.overview?.y ?? 0) &&
  (prev.overview?.width ?? 0) === (next.overview?.width ?? 0) &&
  (prev.overview?.height ?? 0) === (next.overview?.height ?? 0)
)
