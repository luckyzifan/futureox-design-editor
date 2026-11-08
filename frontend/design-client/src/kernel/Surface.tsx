import { ProgressiveSurface } from './ProgressiveSurface'
import { retainedPressureError } from './navigation-coverage'
import { acceptFinishedReferenceFrame } from './reference-zoom-frame'
import type { ColorPresenter } from './color-presenter'
import { allowsColorPresentation, effectiveBackend, canvasSamplingProfile } from './render-policy'
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import type { DesignDocument } from '../model'
import {
  KernelClient,
  backendPreference,
  renderExecutionPolicy,
  type KernelOptions,
} from './client'
import type { BackendPreference } from './gpu/types'
import { canReplaceFallback, frameTransform, presentationMatches, presentationContentMatches, referencePresentationPolicy, surfaceMetrics, useDevicePixelRatio, useDisplayCapability, type ExactPresentation } from './presentation'
import { previewCameraScaleWithinLimit, previewPlacementIntersects, showRetainedPreview } from './tile-preview'
import { canvasStatusLabel } from '../canvas-status-label'
type Request = {
  epoch: number
  backend: BackendPreference
  presentationBackend: BackendPreference
  requireManaged: boolean
  displayCapability?: string
  visibleWidth: number
  visibleHeight: number
  document: DesignDocument
  options: KernelOptions
  camera: KernelOptions['view']
  viewportView: KernelOptions['view']
  width: number
  height: number
  quality: number
  viewportWidth: number
  viewportHeight: number
  budgetAttempts?: number
}
type DisplayedFrame = {
  slot: number
  view: SurfaceProps['view']
  width: number
  height: number
  managed: boolean
  request: Request
}
/** Local immutable identity of one completed capture, independent of UI state
 * and GPU slot reuse. It crosses the worker only through presentationId. */
export type OverlayCaptureCohort = { readonly slots: readonly number[] }
export type PresentedFrame = ExactPresentation & {
  gpuOverlay?: boolean
  gpuPixelGrid?: boolean
  gpuOverlayIdentity?: string
  gpuOverlayCapture?: OverlayCaptureCohort
  document: DesignDocument
  managed: boolean
  computeBackend?: BackendPreference
  /** Same-contract camera reprojection or partial refinement; never a
   * completed exact frame, including when its source was previously exact. */
  preview?: boolean
}
export type SurfaceProps = {
  /** Opaque Canvas identity for opt-in numeric input diagnostics only. */
  navigationInputOwner?: object
  /** Explicit hand/space/middle-button pan ownership; never object editing. */
  panGestureActive?: boolean
  overlay?: { document: DesignDocument; pageId: string; epoch: number; uiIdentity?: string; commands: import('./gpu/canvas-overlay').CanvasOverlay }
  interaction?: import('./interaction-layers').InteractionProps
  interactionPreview?: boolean
  onRenderFailure?: () => void
  /** Latest input camera; view may be the exact frame currently in flight. */
  requestedView?: KernelOptions['view']
  onPresentation?: (frame: PresentedFrame | null) => void
  fallbackReason?: string
  overview?: import('../model').Bounds
  overviewNodes?: number
  presentationEpoch?: number
  maxPixelRatio?: number
  animation?: KernelOptions['animation']
  rasterProfile?: KernelOptions['rasterProfile']
  document: DesignDocument
  pageId: string
  width: number
  height: number
  view: KernelOptions['view']
  checkerboard?: boolean
  grid: boolean
  pixelPreview?: 0 | 1 | 2
}
export function ReferenceSurface(
  props: SurfaceProps & {
    backend: BackendPreference
    visible?: boolean
    paused?: boolean
    fallbackFrom?: BackendPreference
  },
) {
  const capability = useDisplayCapability()
  const devicePixelRatio = useDevicePixelRatio()
  const latestPixelRatio = useRef(devicePixelRatio)
  latestPixelRatio.current = devicePixelRatio
  const {
    document,
    pageId,
    width,
    height,
    view,
    grid,
    checkerboard = false,
    pixelPreview = 0,
    animation,
    rasterProfile,
  } = props
  const managedCanvases = useRef<(HTMLCanvasElement | null)[]>([null, null]),
    presenters = useRef<(ColorPresenter | null)[]>([null, null]),
    displayFailure = useRef<string | null>(null)
  const [displayEpoch, setDisplayEpoch] = useState(0)
  useEffect(() => {
    const media = [matchMedia('(color-gamut: p3)'), matchMedia('(dynamic-range: high)')]
    const changed = () => {
      displayFailure.current = null
      setDisplayEpoch((v) => v + 1)
    }
    media.forEach((m) => m.addEventListener('change', changed))
    return () => media.forEach((m) => m.removeEventListener('change', changed))
  }, [])
  const canvases = useRef<(HTMLCanvasElement | null)[]>([null, null]),
    client = useRef<KernelClient | null>(null),
    pending = useRef<Request | null>(null),
    active = useRef(false),
    alive = useRef(true),
    latest = useRef(props)
  latest.current = props
  const backend = props.backend
  const displayCapability = document.colorManagement &&
    referencePresentationPolicy(renderExecutionPolicy, backend, props.fallbackFrom).requireManaged ? capability : undefined
  const latestCapability = useRef(displayCapability)
  latestCapability.current = displayCapability
  const latestBackend = useRef(backend)
  latestBackend.current = backend
  const [detail, setDetail] = useState('')
  const displayedRef = useRef<DisplayedFrame | null>(null)
  const [status, setStatus] = useState('正在初始化自研渲染内核…'),
    [error, setError] = useState(false),
    [displayed, setDisplayed] = useState<DisplayedFrame | null>(null)
  useLayoutEffect(() => {
    const camera = props.requestedView || view
    props.onPresentation?.(displayed ? {
      view: camera,
      preview: displayed.request.viewportView.x !== camera.x || displayed.request.viewportView.y !== camera.y ||
        displayed.request.viewportView.zoom !== camera.zoom,
      document: displayed.request.document,
      pageId: displayed.request.options.pageId,
      epoch: displayed.request.epoch,
      width: displayed.request.visibleWidth,
      height: displayed.request.visibleHeight,
      pixelRatio: displayed.request.quality,
      managed: displayed.managed,
      computeBackend: displayed.request.backend,
      grid: displayed.request.options.grid,
      checkerboard: displayed.request.options.checkerboard,
      pixelPreview: displayed.request.options.pixelPreview,
      rasterProfile: displayed.request.options.rasterProfile,
      animation: displayed.request.options.animation,
      displayCapability: displayed.request.displayCapability,
    } : null)
  }, [displayed, props.onPresentation, props.requestedView, view])
  const pump = useCallback(async () => {
    if (active.current || !client.current) return
    active.current = true
    while (pending.current && alive.current && client.current) {
      const request = pending.current
      pending.current = null
      const runningClient = client.current
      const metrics = surfaceMetrics(
        request.viewportWidth,
        request.viewportHeight,
        request.quality,
        { maxPixels: Infinity, maxDimension: Infinity },
      )
      request.width = metrics.cssWidth
      request.height = metrics.cssHeight
      request.options = {
        ...request.options,
        width: metrics.pixelWidth,
        height: metrics.pixelHeight,
        previewTileFallback: true,
        view: {
          x: request.camera.x * metrics.ratio,
          y: request.camera.y * metrics.ratio,
          zoom: request.camera.zoom * metrics.ratio,
        },
      }
      const slot = displayedRef.current?.slot === 0 ? 1 : 0
      // Do not compare playback time: while playing, every completed frame can
      // be older than the clock. Epoch/clip checks invalidate seeks/replacement
      // without starving animation; the pending slot keeps the newest sample.
      const current = () =>
        alive.current && !latest.current.paused &&
        client.current === runningClient &&
        request.backend === latestBackend.current &&
        request.displayCapability === latestCapability.current &&
        request.epoch === (latest.current.presentationEpoch || 0) &&
        presentationMatches({
          document: request.document, pageId: request.options.pageId, epoch: request.epoch,
          view: request.viewportView, width: request.visibleWidth, height: request.visibleHeight,
          pixelRatio: request.quality,
        }, {
          document: latest.current.document, pageId: latest.current.pageId,
          epoch: latest.current.presentationEpoch || 0, view: latest.current.view,
          width: latest.current.width, height: latest.current.height, pixelRatio: latestPixelRatio.current,
        }) &&
        request.options.grid === latest.current.grid &&
        request.options.pixelPreview === (latest.current.pixelPreview || undefined) &&
        request.options.rasterProfile === latest.current.rasterProfile &&
        request.options.animation?.clipId === latest.current.animation?.clipId
      const ensurePresenter = async () => {
        if (
          !request.requireManaged ||
          !allowsColorPresentation(renderExecutionPolicy, request.presentationBackend) ||
          !current() ||
          !managedCanvases.current[slot] ||
          presenters.current[slot] ||
          displayFailure.current
        )
          return
        // A strict CPU launch never loads a module that can request an adapter.
        const { ColorPresenter } = await import('./color-presenter')
        if (!current() || !managedCanvases.current[slot]) return
        const created = await ColorPresenter.create(managedCanvases.current[slot]!)
        if (!current()) created.dispose()
        else presenters.current[slot] = created
      }
      let bitmap: ImageBitmap | undefined
      try {
        if (
          request.requireManaged &&
          request.document.colorManagement &&
          allowsColorPresentation(renderExecutionPolicy, request.presentationBackend)
        ) {
          try {
            await ensurePresenter()
          } catch (e) {
            if (current()) displayFailure.current = e instanceof Error ? e.message : String(e)
          }
        }
        if (!current()) continue
        const result = await runningClient.render(
          request.document,
          request.options,
          false,
          request.backend,
          request.requireManaged && allowsColorPresentation(renderExecutionPolicy, request.presentationBackend) &&
            !!request.document.colorManagement &&
            (request.requireManaged || !presenters.current[slot]?.bitmapTransport),
        )
        bitmap = result.bitmap
        const requestedCamera = latest.current.requestedView || latest.current.view
        const shown = displayedRef.current
        const sameFile = alive.current && !latest.current.paused &&
          request.document.id === latest.current.document.id &&
          request.options.pageId === latest.current.pageId &&
          request.epoch === (latest.current.presentationEpoch || 0) &&
          request.options.grid === latest.current.grid &&
          !!request.options.checkerboard === !!latest.current.checkerboard &&
          (request.options.pixelPreview || 0) === (latest.current.pixelPreview || 0) &&
          request.options.rasterProfile === latest.current.rasterProfile
        const acceptFrame = () => sameFile && acceptFinishedReferenceFrame({
          live: requestedCamera,
          finished: request.camera,
          displayed: shown ? { view: shown.view, width: shown.width, height: shown.height } : null,
          frameWidth: request.width,
          frameHeight: request.height,
          viewportWidth: latest.current.width,
          viewportHeight: latest.current.height,
          renderViewCurrent: current(),
        })
        if (!acceptFrame()) continue
        const el = canvases.current[slot]
        if (!el) break
        el.width = request.options.width
        el.height = request.options.height
        let colorDisplay = false
        if (
          request.requireManaged &&
          allowsColorPresentation(renderExecutionPolicy, request.presentationBackend) &&
          (result.linear || result.bitmapExtended) &&
          request.document.colorManagement &&
          managedCanvases.current[slot]
        ) {
          try {
            await ensurePresenter()
            if (!acceptFrame()) continue
            const presenter = presenters.current[slot]
            if (presenter) {
              if (result.bitmap && result.bitmapExtended && presenter.bitmapTransport)
                await presenter.presentBitmap(result.bitmap, el.width, el.height)
              else if (result.linear)
                await presenter.present(
                  result.linear,
                  el.width,
                  el.height,
                  request.document.colorManagement,
                )
              else throw new Error('当前浏览器未提供无损浮点显示传输')
              colorDisplay = true
            }
          } catch (e) {
            if (current()) displayFailure.current = e instanceof Error ? e.message : String(e)
            presenters.current[slot]?.dispose()
            presenters.current[slot] = null
          }
        }
        if (!acceptFrame()) {
          continue
        }
        if (request.requireManaged && request.document.colorManagement && !colorDisplay)
          throw new Error(`精确浮点显示失败，保留上一完整画布：${displayFailure.current || '未获得有效浮点显示帧'}`)
        const context = el.getContext('2d', { alpha: false, colorSpace: 'srgb' })
        if (!context) throw new Error('无法创建像素显示表面')
        // Presentation only: geometry is compiled in Rust; GPU shaders or Rust CPU rasterize it.
        if (result.bitmap) {
          if (!colorDisplay) context.drawImage(result.bitmap, 0, 0)
        } else if (!colorDisplay)
          context.putImageData(
            new ImageData(new Uint8ClampedArray(result.bytes), el.width, el.height, {
              colorSpace: 'srgb',
            }),
            0,
            0,
          )
        el.dataset.renderer = result.backend
        el.dataset.drawCalls = String(result.drawCalls)
        el.dataset.triangles = String(result.triangles)
        el.dataset.compileMs = result.compileMs.toFixed(2)
        el.dataset.backendMs = result.renderMs.toFixed(2)
        el.dataset.fallback = result.reason || ''
        el.dataset.renderMs = result.milliseconds.toFixed(2)
        el.dataset.animationTime = String(request.options.animation?.timeMs ?? '')
        el.dataset.nodes = String(result.stats.nodes)
        el.dataset.renderScale = String(request.options.view.zoom / request.camera.zoom)
        el.dataset.previewRetries = String(request.budgetAttempts || 0)
        el.dataset.workingTextureBytes = String(result.workingTextureBytes || 0)
        el.dataset.previewTiles = String(result.previewTiles || 0)
        el.dataset.cameraX = String(request.camera.x)
        el.dataset.cameraY = String(request.camera.y)
        el.dataset.cameraZoom = String(request.camera.zoom)
        if (colorDisplay && managedCanvases.current[slot])
          Object.assign(managedCanvases.current[slot]!.dataset, el.dataset)
        const frame = {
          slot,
          view: request.camera,
          width: request.width,
          height: request.height,
          managed: colorDisplay,
          request,
        }
        // Both asynchronous HDR presentation and canvas resize happen offscreen.
        // Commit pixels, dimensions, camera transform and visibility together;
        // the next iteration may only reuse the previous front buffer afterwards.
        flushSync(() => {
          displayedRef.current = frame
          setDisplayed(frame)
        })
        setError(false)
        setDetail(
          [
            result.reason,
            latest.current.fallbackReason,
            result.description,
            request.document.colorManagement ? displayFailure.current : '',
          ]
            .filter(Boolean)
            .join('；'),
        )
        setStatus(
          `${result.backend === 'webgpu' ? 'WebGPU' : result.backend === 'webgl2' ? 'WebGL 2' : 'CPU'} · ${result.milliseconds.toFixed(0)} ms · ${result.stats.nodes} 图层${result.reason ? ' · 已降级' : ''}${request.document.colorManagement ? ` · 浮点 · ${colorDisplay ? `${presenters.current[slot]?.space}${presenters.current[slot]?.hdr ? ' HDR' : ' SDR'}` : 'sRGB SDR 预览（HDR/浮点文档数据保留）'}` : ''}`,
        )
      } catch (e) {
        if (current()) {
          const message = e instanceof Error ? e.message : String(e)
          if (retainedPressureError(message)) {
            if (!pending.current && (request.budgetAttempts || 0) < 1)
              pending.current = { ...request, budgetAttempts: (request.budgetAttempts || 0) + 1 }
            if (pending.current) continue
            const previous = displayedRef.current
            if (previous?.request.document === request.document && previous.request.options.pageId === request.options.pageId) {
              setStatus('当前视口精修受限，已保留缓存画面')
              continue
            }
          }
          setError(true)
          setStatus(message)
          latest.current.onRenderFailure?.()
        }
      } finally {
        bitmap?.close()
      }
    }
    active.current = false
    // A disposed/replaced client may have completed while a new mount queued work.
    if (pending.current && alive.current && client.current) void pump()
  }, [])
  useEffect(() => {
    alive.current = true
    client.current = new KernelClient()
    return () => {
      alive.current = false
      pending.current = null
      client.current?.dispose()
      client.current = null
      presenters.current.forEach((presenter) => presenter?.dispose())
      presenters.current = [null, null]
    }
  }, [])
  useEffect(() => {
    if (client.current && props.navigationInputOwner && !props.paused && props.visible !== false)
      return client.current.bindNavigationInput(props.navigationInputOwner)
  }, [props.navigationInputOwner, props.paused, props.visible])
  useEffect(() => {
    displayFailure.current = null
  }, [backend, document.colorManagement])
  useEffect(() => {
    if (props.paused) {
      pending.current = null
      client.current?.cancelPreview()
      return
    }
    displayFailure.current = null
    // Overscan was for translating a previous bitmap. Exact presentation never
    // does that; rendering this unused border can exceed the CPU pixel budget
    // on Retina when the sidebars collapse. Keep every visible device pixel.
    const padding = 0
    const request = (quality: number) => {
      const camera = { ...view, x: view.x + padding, y: view.y + padding }
      const presentation = referencePresentationPolicy(renderExecutionPolicy, backend, props.fallbackFrom)
      pending.current = {
        presentationBackend: presentation.backend,
        displayCapability,
        requireManaged: presentation.requireManaged,
        visibleWidth: width,
        visibleHeight: height,
        epoch: props.presentationEpoch || 0,
        backend,
        document,
        options: {
          livePreview: true,
          pageId,
          width: 1,
          height: 1,
          view: camera,
          transparent: false,
          grid,
          checkerboard,
          pixelPreview: pixelPreview || undefined,
          animation,
          rasterProfile,
        },
        camera,
        viewportView: { ...view },
        width: width + 2 * padding,
        height: height + 2 * padding,
        viewportWidth: width + 2 * padding,
        viewportHeight: height + 2 * padding,
        quality,
      }
      void pump()
    }
    const dpr = devicePixelRatio
    request(dpr)
  }, [
    document,
    pageId,
    width,
    height,
    view.x,
    view.y,
    view.zoom,
    grid,
    checkerboard,
    pixelPreview,
    animation?.clipId,
    animation?.timeMs,
    rasterProfile,
    props.presentationEpoch,
    displayEpoch,
    displayCapability,
    devicePixelRatio,
    pump,
    backend,
    props.fallbackFrom,
    props.paused,
  ])
  const liveCamera = props.requestedView || view
  const placed = displayed ? frameTransform(liveCamera, displayed.view) : { x: 0, y: 0, scale: 1 }
  const scaleOk = !displayed || previewCameraScaleWithinLimit(displayed.view.zoom, liveCamera.zoom)
  const showPlaced = !displayed || showRetainedPreview({
    sourceZoom: displayed.view.zoom,
    viewZoom: liveCamera.zoom,
    intersects: previewPlacementIntersects(placed, displayed.width, displayed.height, width, height),
    replacementCovers: false,
  })
  const { x, y, scale } = showPlaced ? placed : { x: 0, y: 0, scale: 1 }
  const frameValid =
    displayed?.request.document.id === document.id &&
    displayed.request.options.pageId === pageId &&
    displayed.request.epoch === (props.presentationEpoch || 0)
  const detailReady = !!displayed && presentationMatches({
    document: displayed.request.document, pageId: displayed.request.options.pageId,
    epoch: displayed.request.epoch, view: displayed.request.viewportView,
    width: displayed.request.visibleWidth, height: displayed.request.visibleHeight,
    pixelRatio: displayed.request.quality,
    grid: displayed.request.options.grid,
    checkerboard: displayed.request.options.checkerboard,
    pixelPreview: displayed.request.options.pixelPreview,
    rasterProfile: displayed.request.options.rasterProfile,
    animation: displayed.request.options.animation,
    displayCapability: displayed.request.displayCapability,
  }, { document, pageId, epoch: props.presentationEpoch || 0, view: props.requestedView || view, width, height, pixelRatio: devicePixelRatio,
    grid, checkerboard, pixelPreview, rasterProfile, animation, displayCapability })
  return (
    <div className="kernel-reference"
      data-detail-ready={String(detailReady && !error && props.visible !== false)}
      data-camera-x={displayed?.request.viewportView.x}
      data-camera-y={displayed?.request.viewportView.y}
      data-camera-zoom={displayed?.request.viewportView.zoom}
      data-pixel-ratio={displayed?.request.quality}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: document.pages.find((page) => page.id === pageId)?.background || '#f5f5f5',
          visibility: props.visible === false ? 'hidden' : 'visible',
        }}
      />
      {[0, 1].flatMap((slot) =>
        [false, true].map((managed) => {
          const activeSlot = !!frameValid && displayed?.slot === slot
          const visible = props.visible !== false && activeSlot && displayed?.managed === managed
          return (
            <canvas
              key={`${slot}:${managed}`}
              ref={(element) => {
                ;(managed ? managedCanvases : canvases).current[slot] = element
              }}
              className={activeSlot ? 'kernel-surface' : 'kernel-surface-buffer'}
              aria-label={managed ? '广色域 HDR 显示输出' : '自研矢量渲染输出'}
              aria-hidden={!visible}
              data-frame-visible={String(visible && showPlaced && scaleOk)}
              data-preview-upscale-rejected={String(!!displayed && !scaleOk)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                pointerEvents: 'none',
                width: displayed?.width || width,
                height: displayed?.height || height,
                transformOrigin: '0 0',
                transform: showPlaced ? `translate(${x}px,${y}px) scale(${scale})` : '',
                visibility: visible && showPlaced ? 'visible' : 'hidden',
              }}
            />
          )
        }),
      )}
      {!props.paused && <div
        className={`kernel-status ${error ? 'error' : ''}`}
        role="status"
        title={canvasStatusLabel(detail)}
        style={{
          position: 'absolute',
          right: 14,
          top: 'var(--kernel-status-top, 12px)',
          fontSize: 10,
          color: error ? '#bd3b54' : '#777c8e',
          pointerEvents: 'none',
          zIndex: 4,
        }}
      >
        {canvasStatusLabel(status)}

      </div>}
    </div>
  )
}

export function KernelSurface(props: SurfaceProps) {
  // Screen density and the file's export supersampling are separate contracts.
  const [backend] = useState<BackendPreference>(backendPreference)
  const [fallback, setFallback] = useState<{
    reason: string; from: BackendPreference; committed: boolean
  } | null>(null)
  const [presented, setPresented] = useState<{ frame: PresentedFrame; backend: 'gpu' | 'cpu'; computeBackend: BackendPreference } | null>(null)
  const [previewed, setPreviewed] = useState<PresentedFrame | null>(null)
  const dpr = useDevicePixelRatio()
  const capability = useDisplayCapability()
  const directReference = effectiveBackend(renderExecutionPolicy, backend) === 'cpu' ||
    !!props.animation || !!props.pixelPreview
  const target = fallback || directReference ? 'cpu' : 'gpu'
  if (!props.rasterProfile) props = { ...props, rasterProfile: canvasSamplingProfile(
    renderExecutionPolicy, props.document.rasterProfile || (props.document.colorManagement ? 'figma' : 'analytic'),
    target === 'cpu' ? 'cpu' : backend, !!props.document.colorManagement, props.pixelPreview,
  ) }
  const displayCapability = props.document.colorManagement && referencePresentationPolicy(
    renderExecutionPolicy, fallback ? 'cpu' : backend, fallback?.from,
  ).requireManaged ? capability : undefined
  // Camera input supersedes unfinished plans. The progressive surface moves
  // its completed tiles immediately while the latest exact camera is
  // refined; completion remains separate from the live preview camera.
  const contract = useMemo(() => ({}), [props.document, props.pageId, props.width, props.height,
    props.grid, props.checkerboard, props.pixelPreview, props.rasterProfile, props.presentationEpoch,
    props.animation, backend, target, dpr, displayCapability])
  const [navigation, setNavigation] = useState({ contract, view: props.view })
  const renderView = navigation.contract === contract ? navigation.view : props.view
  const failedNavigation = useRef<{ contract: object; view: SurfaceProps['view'] } | null>(null)
  const [failedPresentation, setFailedPresentation] = useState<{ contract: object; view: SurfaceProps['view'] } | null>(null)
  const latest = useRef({ props, backend, fallback, dpr, target, displayCapability, contract, renderView })
  latest.current = { props, backend, fallback, dpr, target, displayCapability, contract, renderView }
  const advanceCamera = useCallback(() => {
    const { contract, props } = latest.current
    setNavigation(old => old.contract === contract && old.view.x === props.view.x &&
      old.view.y === props.view.y && old.view.zoom === props.view.zoom ? old : { contract, view: props.view })
  }, [])
  const onRenderFailure = useCallback(() => {
    const current = latest.current
    failedNavigation.current = { contract: current.contract, view: current.renderView }
    setFailedPresentation(failedNavigation.current)
    current.props.onRenderFailure?.()
    advanceCamera()
  }, [advanceCamera])
  useLayoutEffect(() => {
    const rendered = { ...props, view: renderView, epoch: props.presentationEpoch || 0,
      pixelRatio: dpr, displayCapability }
    if (renderView.x !== props.view.x || renderView.y !== props.view.y || renderView.zoom !== props.view.zoom ||
        navigation.contract !== contract || presentationMatches(presented?.frame || null, rendered) ||
        (failedNavigation.current?.contract === contract && failedNavigation.current.view === renderView))
      advanceCamera()
  }, [props.view, contract, navigation.contract, presented, renderView, advanceCamera])
  const onFallback = useCallback((reason: string) => {
    const current = latest.current
    setFallback((old) => old || { reason, from: current.backend, committed: false })
  }, [])
  const onGpuPresentation = useCallback((frame: PresentedFrame | null) => {
    const current = latest.current
    if (current.target !== 'gpu' || (frame?.computeBackend && frame.computeBackend !== current.backend)) return
    if (frame?.preview) {
      const requested = { ...current.props, epoch: current.props.presentationEpoch || 0,
        pixelRatio: current.dpr, displayCapability: current.displayCapability }
      if (presentationContentMatches(frame, requested)) setPreviewed(frame)
      return
    }
    const requested = { ...current.props, view: current.renderView, epoch: current.props.presentationEpoch || 0, pixelRatio: current.dpr, displayCapability: current.displayCapability }
    if (frame && presentationMatches(frame, requested)) {
      setPresented({ frame, backend: 'gpu', computeBackend: current.backend })
      setPreviewed(null)
      setFailedPresentation(null)
      advanceCamera()
    } else if (frame && presentationContentMatches(frame, requested)) {
      // A late native frame still owns the displayed coordinates, but only
      // the in-flight exact camera may advance the completed-frame baseline.
      setPreviewed({ ...frame, preview: true })
    }
  }, [])
  const onReferencePresentation = useCallback((frame: PresentedFrame | null) => {
    const { props: current, fallback: transition, dpr: pixelRatio } = latest.current
    if (latest.current.target !== 'cpu' || (frame?.computeBackend && frame.computeBackend !== (transition ? 'cpu' : latest.current.backend))) return
    if (frame?.preview) {
      if ((!transition || transition.committed) && presentationMatches(frame, { ...current,
        epoch: current.presentationEpoch || 0, pixelRatio, displayCapability: latest.current.displayCapability })) setPreviewed(frame)
      return
    }
    if (transition) {
      const requested = { ...current, view: latest.current.renderView, epoch: current.presentationEpoch || 0, pixelRatio, displayCapability: latest.current.displayCapability }
      const managed = !!current.document.colorManagement && referencePresentationPolicy(
        renderExecutionPolicy, 'cpu', transition.from,
      ).requireManaged
      if (!canReplaceFallback(frame, requested, managed, !!frame?.managed)) return
      if (!transition.committed) setFallback((old) => old && { ...old, committed: true })
    }
    const requested = { ...current, view: latest.current.renderView, epoch: current.presentationEpoch || 0, pixelRatio, displayCapability: latest.current.displayCapability }
    if (frame && presentationMatches(frame, requested)) {
      setPresented({ frame, backend: 'cpu', computeBackend: transition ? 'cpu' : latest.current.backend })
      setPreviewed(null)
      setFailedPresentation(null)
      advanceCamera()
    }
  }, [])
  const requested = { ...props, epoch: props.presentationEpoch || 0, pixelRatio: dpr, displayCapability }
  const frame = presented?.frame
  const sameIdentity = frame?.document.id === props.document.id && frame.pageId === props.pageId &&
    frame.epoch === (props.presentationEpoch || 0)
  const visualFrame = previewed && previewed.computeBackend === (fallback ? 'cpu' : backend) && presentationContentMatches(previewed, requested)
    ? previewed : sameIdentity ? frame : null
  useLayoutEffect(() => {
    props.onPresentation?.(visualFrame || null)
  }, [visualFrame, props.onPresentation])
  const targetCompute = fallback ? 'cpu' : backend
  const holding = sameIdentity && (presented?.backend !== target || presented.computeBackend !== targetCompute)
  const renderProps: SurfaceProps = { ...props, view: renderView, requestedView: props.view, onRenderFailure }
  const heldProps: SurfaceProps = frame ? { ...props, ...frame, presentationEpoch: frame.epoch, grid: !!frame.grid, checkerboard: !!frame.checkerboard } : props
  const holdGpu = !!holding && presented?.backend === 'gpu'
  const holdReference = !!holding && presented?.backend === 'cpu'
  const renderFailed = failedPresentation?.contract === contract &&
    failedPresentation.view.x === props.view.x && failedPresentation.view.y === props.view.y &&
    failedPresentation.view.zoom === props.view.zoom
  const ready = !renderFailed && !props.interactionPreview && !holding && !(fallback && !fallback.committed) &&
    presentationMatches(frame || null, requested)
  const presentationState = renderFailed ? 'error' : ready ? 'ready' : visualFrame ? 'preview' : 'loading'
  const identifiedFrame = sameIdentity ? frame : undefined
  const gpuSources = new Set<BackendPreference>(target === 'gpu' ? [backend] : [])
  const referenceSources = new Set<BackendPreference>(target === 'cpu' ? [targetCompute] : [])
  if (holdGpu) gpuSources.add(presented!.computeBackend)
  if (holdReference) referenceSources.add(presented!.computeBackend)
  return (
    <div className="kernel-presentation"
      aria-busy={!ready && !renderFailed}
      data-fallback-phase={fallback ? fallback.committed ? 'cpu' : 'pending' : 'none'}
      data-fallback-reason={fallback?.reason}
      data-presentation-backend={sameIdentity ? presented?.backend : 'none'}
      data-presentation-ready={String(ready)}
      data-presentation-state={presentationState}
      data-displayed-document={identifiedFrame?.document.id}
      data-displayed-epoch={identifiedFrame?.epoch}
      data-camera-x={identifiedFrame?.view.x} data-camera-y={identifiedFrame?.view.y} data-camera-zoom={identifiedFrame?.view.zoom}
      data-preview-active={String(!!visualFrame?.preview)}
      data-visual-camera-x={visualFrame?.view.x} data-visual-camera-y={visualFrame?.view.y}
      data-pixel-ratio={identifiedFrame?.pixelRatio}
      data-display-capability={identifiedFrame?.displayCapability}
      data-requested-display-capability={displayCapability}
      data-requested-document={props.document.id} data-requested-epoch={props.presentationEpoch || 0}
      data-requested-camera-x={props.view.x} data-requested-camera-y={props.view.y}
      data-requested-camera-zoom={props.view.zoom} data-requested-pixel-ratio={dpr}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Workspace chrome only: never paint this into a content canvas or
          document/export pixels. Transparent pages and a cold/failed renderer
          must still have a stable, opaque surface beneath their content. */}
      <div className="kernel-workspace-backdrop" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundColor: '#f5f5f5' }} />
      {[...gpuSources].map((source) => {
        const held = holdGpu && presented?.computeBackend === source
        return <ProgressiveSurface key={`gpu:${source}`}
          {...(held ? heldProps : renderProps)}
          // The retained source is appended last and covers the replacement.
          // Keep the replacement GPU canvas drawable during the handoff.
          backend={source} paused={held} visible={true}
          onPresentation={onGpuPresentation}
          onFallback={onFallback}
        />
      })}
      {[...referenceSources].map((source) => {
        const held = holdReference && presented?.computeBackend === source
        return <ReferenceSurface key={`reference:${source}`}
          {...(held ? heldProps : renderProps)}
          paused={held}
          fallbackReason={fallback?.reason}
          fallbackFrom={fallback?.from}
          visible={held || (!holding && (!fallback || fallback.committed))}
          backend={source}
          onPresentation={onReferencePresentation}
        />
      })}
      {!visualFrame && <div className="kernel-first-frame" role="status" aria-live="polite" aria-atomic="true"
        style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          pointerEvents: 'none', fontSize: 12, color: renderFailed ? '#bd3b54' : '#777c8e' }}>
        {renderFailed ? '画布暂未绘制完成' : '正在绘制画布…'}
      </div>}
    </div>
  )
}
