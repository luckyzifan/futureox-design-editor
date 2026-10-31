import { createHandoffTrace, gestureCode, type HandoffTrace } from './handoff-trace'
import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { PresentedFrame } from './Surface'
import type { SurfaceProps } from './Surface'
import { ResidentPresentation, type ResidentAcknowledgement } from './resident-presentation'
import { registerContentPlane } from './content-plane'
import type { CanvasCamera } from '../canvas-camera'
import type { DesignDocument } from '../model'
import { renderExecutionPolicy, type KernelClient, type KernelOptions } from './client'
import type { BackendPreference } from './gpu/types'
import type { CompositeItem } from './gpu/tile-compositor'
import type { ResidentFrame } from './gpu/resident-presenter'
import { residentFrameSignature } from './gpu/resident-frame'
import type { InteractionProps } from './interaction-layers'
import { InteractionRenderer } from './interaction-renderer'
import { PageTranslation } from './page-translation'
import { liveInteractionStack } from './resident-layer-stack'
import { settleResidentImport } from './resident-import-ownership'
import { viewportPreviewDeviceKey, type ViewportPreviewDevice } from './viewport-preview-cache'
import {allowIncompletePanPreview,type PanPreviewBacking} from './pan-preview'

const activeAffineGesture = (interaction?: InteractionProps) =>
  !!interaction?.active && !!interaction.gestureKind && interaction.gestureKind !== 'move'

export function ResidentCompositeSurface(props: {
  client: KernelClient
  items: CompositeItem[]
  view: CanvasCamera
  width: number
  height: number
  dpr: number
  /** Reusing pixels may still need a fresh submission/input acknowledgement. */
  reuseSequence?: number
  interaction?: InteractionProps
  pageId: string
  rasterProfile: KernelOptions['rasterProfile']
  backend: BackendPreference
  settledDocument?: DesignDocument
  onReady: (key: string, serial: number, managed: boolean) => void
  sourceDocument: DesignDocument
  contentRevision: number
  translationItems: CompositeItem[]
  allowPageTranslation: boolean
  onGone: (key: string, serial: number) => void
  onError?: (key: string, serial: number, message: string) => void
  onFailure: (message: string) => void
  terminalQuality?: ResidentFrame['terminalQuality']
  presentation: PresentedFrame | null
  allowPanPreview?:boolean
  panBacking?:PanPreviewBacking
  overlay?: SurfaceProps['overlay']
  onPresented?: (frame: ResidentAcknowledgement, source?: PresentedFrame, device?: ViewportPreviewDevice) => void
  /** Actual queued page/movement composition, retaining the source objects.
   * This is not a GPU completion or a rendered-pixel quality certificate. */
  onCompositeItems?: (items: readonly CompositeItem[]) => void
  onTranslatedCoverage?: (source:DesignDocument,offset:{x:number;y:number},sequence:number,failed:()=>void)=>boolean
}) {
  const trace=useRef<HandoffTrace|null>(null)
  if(!trace.current)trace.current=createHandoffTrace()
  const lastOwnerKind=useRef(0)
  const canvas = useRef<HTMLCanvasElement>(null),
    latest = useRef(props)
  latest.current = props
  const host = useRef<HTMLDivElement>(null)
  const interaction = useRef<InteractionRenderer | null>(null),
    published = useRef(new Map<number, { key: string; gpuTile: number }>())
  const pageTranslation = useRef<PageTranslation | null>(null),
    usePageTranslation = useRef(false)
  const repaint = useRef(() => {}),
    attached = useRef(false)
  const importing = useRef(new Map<number, object>())
  const importSession = useRef<object>({})
  const interactionStarted = useRef(false)
  const inputTrace = useRef<{ sequence: number; latency: number }[]>([])
  const inputScope=useRef(crypto.randomUUID()),inputOwner=useRef('')
  const lastFrameSignature = useRef('')
  const presentation = useRef(new ResidentPresentation())
  const actualPresentation=useRef<ResidentAcknowledgement|undefined>(undefined)
  repaint.current = () => {
    if (!attached.current) return
    const p = latest.current,
      moving = !activeAffineGesture(p.interaction) && (usePageTranslation.current || pageTranslation.current?.handingOff && !interaction.current?.ready)
        ? pageTranslation.current : interaction.current
    const ownerKind=moving===pageTranslation.current?1:2
    trace.current!.record(1,activeAffineGesture(p.interaction)?1:usePageTranslation.current?2:pageTranslation.current?.handingOff&&!interaction.current?.ready?3:0,{
      handoffGesture:gestureCode(p.interaction?.gestureKind),handoffActive:Number(!!p.interaction?.active),handoffOwnerKind:ownerKind,handoffPreviousOwnerKind:lastOwnerKind.current})
    lastOwnerKind.current=ownerKind
    const owner=`${inputScope.current}:${moving===pageTranslation.current?'page':'layer'}:${p.interaction?.epoch??0}`
    if(owner!==inputOwner.current){
      inputOwner.current=owner;inputTrace.current=[]
      if(canvas.current){canvas.current.dataset.inputTrace='[]';canvas.current.dataset.contentSequence='0'}
    }
    p.client.presentationInputOwner=owner
    const all = [...p.items.map((i) => i.tile), ...(moving?.tiles || [])]
    const keep = new Set(all.map((t) => t.serial)),
      keepGpu = new Set(all.map((t) => t.gpuTile)),
      release = new Set<number>()
    const pageTiles = new Set(p.items.map(item => item.tile))
    for (const tile of all) {
      if (published.current.has(tile.serial)) continue
      if (!tile.gpuTile) {
        if (importing.current.has(tile.serial)) continue
        if (!tile.bitmap && tile.bytes.byteLength !== tile.width * tile.height * 4) {
          p.onFailure(`GPU 驻留显示缺少纹理或像素: ${tile.key}`)
          return
        }
        const token = {}, session = importSession.current
        importing.current.set(tile.serial, token)
        const owns = () => {
          const current = latest.current
          const active = !activeAffineGesture(current.interaction) && (usePageTranslation.current || pageTranslation.current?.handingOff && !interaction.current?.ready)
            ? pageTranslation.current : interaction.current
          return attached.current && importSession.current === session && current.client === p.client &&
            (current.items.some(item => item.tile === tile) || !!active?.tiles.includes(tile))
        }
        void settleResidentImport(p.client.importPresentation(tile), owns,
          id => { tile.gpuTile = id; repaint.current() },
          id => p.client.releasePresented([id]),
          error => { if (owns()) latest.current.onFailure(String(error)) },
          () => {
            // An older completion must not clear a new session's import.
            if (importing.current.get(tile.serial) === token) importing.current.delete(tile.serial)
          })
        continue
      }
      published.current.set(tile.serial, { key: tile.key, gpuTile: tile.gpuTile })
      if (pageTiles.has(tile)) p.onReady(tile.key, tile.serial, false)
    }
    const moved = moving?.items(p.view)
    const items =
      moved && moving?.mode === 'live-kernel'
        ? liveInteractionStack(p.items, moved)
        : moved || p.items
    // Retained layers authorize a transparent background, not an incomplete
    // cohort. Bitmap imports finish independently; publishing their filtered
    // subset would clear the previous page between arrivals. Keep its owners
    // until every active replacement source has reached the display device.
    if (moved && moving?.mode !== 'live-kernel' && items.some(item => item.active && !item.tile.gpuTile)) return
    let presentationId: string | undefined
    const scopedOverlay = p.presentation && p.overlay &&
      p.overlay.pageId === p.presentation.pageId && p.overlay.epoch === p.presentation.epoch ? p.overlay : undefined
    // A retained capture can replay only the complete chrome snapshot that was
    // observed with its own document, never inverse-warp a newer world AABB.
    const capturedOverlay = scopedOverlay && moved && moving===interaction.current
      ? interaction.current?.capturedOverlay(scopedOverlay.document,scopedOverlay.pageId,scopedOverlay.epoch,scopedOverlay.commands,scopedOverlay.uiIdentity) : undefined
    const sourceOverlay = scopedOverlay?.document === p.presentation?.document ? scopedOverlay?.commands : undefined
    // A capture owns the entire chrome decision, including a failed proof.
    // Do not fall back to inverse-projecting newer commands after rejection.
    const overlay=capturedOverlay ? capturedOverlay.commands : (sourceOverlay?(moved?moving?.overlay(sourceOverlay):sourceOverlay):undefined)
    try { presentationId = presentation.current.stage(p.presentation ? { ...p.presentation, gpuOverlay: !!overlay, gpuOverlayIdentity: overlay ? scopedOverlay?.uiIdentity : undefined,
      gpuOverlayCapture: overlay ? capturedOverlay?.cohort : undefined } : null) }
    catch (error) { p.onFailure(String(error)); return }
    const panPreview=!moved&&allowIncompletePanPreview({allowed:p.allowPanPreview,frame:p.presentation,
      document:p.sourceDocument,revision:p.contentRevision,pageId:p.pageId,width:p.width,height:p.height,dpr:p.dpr,items:p.items,backing:p.panBacking})
    const frame: ResidentFrame = {
      presentationId,
      terminalQuality: !moved && !panPreview && p.client.presentationDiagnosticsEnabled() ? p.terminalQuality : undefined,
      overlay,
      view: p.view,
      width: p.width,
      height: p.height,
      dpr: p.dpr,
      interaction: !!moved,
      allowEmpty: panPreview || !!moved && moving === interaction.current && moving?.mode !== 'live-kernel',
      allowBackground: !!moved && moving === pageTranslation.current || !moved && p.allowPageTranslation && p.items.filter(i=>i.active).every(i=>
        (i.tile as unknown as {document?:DesignDocument;revision?:number}).document===p.sourceDocument &&
        (i.tile as unknown as {revision?:number}).revision===p.contentRevision),
      backgroundTranslation: moved && moving === pageTranslation.current ? pageTranslation.current?.backgroundTranslation : undefined,
      linearBlend:
        !!moved && moving?.mode === 'retained-layers' && !!p.interaction?.document.colorManagement,
      backgroundLinear: moving?.backgroundLinear,
      input: moved&&moving ? {...moving.presentedInput,owner} : undefined,
      items: items
        .filter((item) => item.tile.gpuTile)
        .map(({ tile, ...item }) => {
          return {
            ...item,
            tile: {
              key: tile.key,
              serial: tile.serial,
              gpuTile: tile.gpuTile!,
              x: tile.x,
              y: tile.y,
              width: tile.width,
              height: tile.height,
              zoom: tile.zoom,
              phaseX: tile.phaseX,
              phaseY: tile.phaseY,
            },
          }
        }),
    }
    // Pointer updates do not change a dependent snapshot until the next
    // sample completes. Do not fill the GPU queue with identical old pixels.
    const baseSignature = residentFrameSignature(frame)
    const signature = p.reuseSequence ? `${baseSignature}/reuse:${p.reuseSequence}` : baseSignature
    if (signature !== lastFrameSignature.current) {
      lastFrameSignature.current = signature
      p.client.present(frame)
      p.onCompositeItems?.(items)
    }
    for (const [serial, tile] of published.current)
      if (!keep.has(serial)) {
        if (!keepGpu.has(tile.gpuTile)) release.add(tile.gpuTile)
        published.current.delete(serial)
        p.onGone(tile.key, serial)
      }
    p.client.releasePresented([...release])
    if (canvas.current && moving)
      Object.assign(canvas.current.dataset, {
        interactionReady: String(moving.ready),
        interactionActive: String(!!moving.items(p.view)),
        interactionWarming: String(moving.warming),
        interactionError: moving.error,
        interactionMoves: String(moving.moves),
        interactionEnd: moving.lastEnd,
        interactionMode: moving.mode,
        interactionSamples: String(moving.samples),
        interactionSampleMs: moving.lastSampleMs.toFixed(2),
        interactionCompileMs: moving.lastSampleCompileMs.toFixed(2),
        interactionGraphMs: moving.lastSampleGraphMs.toFixed(2),
        interactionGeometryReused: String(moving.lastSampleReused),
        interactionGroupHits: String(moving.lastSampleGroupHits),
        ...((moving instanceof InteractionRenderer ? moving.tracing : import.meta.env.DEV) ? { interactionTrace: JSON.stringify(moving.sampleTrace), interactionInputPreparation: JSON.stringify(moving instanceof InteractionRenderer ? moving.inputPreparationTrace : []) } : {}),
      })
  }
  useLayoutEffect(() => {
    const p = latest.current,
      el = document.createElement('canvas')
    el.className = 'kernel-compositor'
    el.dataset.compositor = 'webgpu-resident'
    el.dataset.frameVisible = 'true'
    el.setAttribute('aria-label', 'GPU 合成画布')
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${p.width}px`,
      height: `${p.height}px`,
      pointerEvents: 'none',
    })
    host.current!.append(el)
    canvas.current = el
    const unregisterContent=registerContentPlane(el,{
      pixel:(u,v)=>actualPresentation.current?p.client.readContentPixel(u,v,actualPresentation.current):Promise.reject(Error('当前画面尚未同步')),
      capture:async()=>{const resolveSnapshot=presentation.current.snapshotResolver()
        const result=await p.client.captureContentBitmap(),frame=resolveSnapshot(result.frame)
        if(!frame){result.bitmap.close();throw Error('Content snapshot owner changed')}
        return{bitmap:result.bitmap,frame}},
    })
    try {
      p.client.attachPresentation(el.transferControlToOffscreen())
      attached.current = true
      p.client.onPresentation = (stats) => {
        const deferredInput = stats.input as ResidentFrame['input']
        if (stats.interactionCoverageMissing && deferredInput?.owner === inputOwner.current && usePageTranslation.current)
          pageTranslation.current?.repairMissingCoverage(deferredInput.sequence)
        if (Array.isArray(stats.missingGpuTiles)) {
          const missing = new Set(stats.missingGpuTiles)
          for (const item of latest.current.items) if (missing.has(item.tile.gpuTile))
            latest.current.onError?.(item.tile.key, item.tile.serial, '显示纹理已失效，正在补画')
        }
        if (stats.error) {
          latest.current.onFailure(String(stats.error))
          return
        }
        if (stats.residentSample) {
          const sample = stats.residentSample as Parameters<
            InteractionRenderer['acceptResidentSample']
          >[0]
          if (sample.signature) lastFrameSignature.current = latest.current.reuseSequence
            ? `${sample.signature}/reuse:${latest.current.reuseSequence}` : sample.signature
          interaction.current?.acceptResidentSample(sample)
        }
        for (const [key, value] of Object.entries(stats))
          if (key !== 'presented' && key !== 'input' && key !== 'residentSample' && key !== 'missingGpuTiles')
            el.dataset[key] = String(value)
        // A coverage rejection carries pose identity only for recovery. It
        // has not displayed that input and must not advance feedback or ACKs.
        const input = stats.coverageDeferred ? undefined : stats.input as { sequence: number; at: number;owner?:string } | undefined
        if (input?.sequence && input.owner===inputOwner.current && input.sequence > (inputTrace.current.at(-1)?.sequence || 0)) {
          inputTrace.current.push({
            sequence: input.sequence,
            latency: performance.now() - input.at,
          })
          if (inputTrace.current.length > 180) inputTrace.current.shift()
          el.dataset.contentSequence = String(input.sequence)
          if (import.meta.env.DEV) el.dataset.inputTrace = JSON.stringify(inputTrace.current)
        }
        if(input?.sequence&&!usePageTranslation.current&&!stats.presented)
          interaction.current?.acceptPresentedInput(input.sequence,input.at,input.owner===inputOwner.current,false)
        if (stats.presented) {
          const actual = stats.presented as ResidentAcknowledgement
          const rejected=presentation.current.rejectsAcknowledgement(actual)
          const source=presentation.current.resolve(actual)
          // Rejected display ACKs must not replace the readback expectation or
          // downstream exact ACK. Other message payloads were handled above.
          if(rejected)return
          actualPresentation.current=actual
          if(input?.sequence&&!usePageTranslation.current)
            interaction.current?.acceptPresentedInput(input.sequence,input.at,input.owner===inputOwner.current,true,actual.ids)
          if(input?.sequence&&usePageTranslation.current)
            pageTranslation.current?.acceptPresentedInput(input.sequence,input.at,input.owner===inputOwner.current,actual.ids)
          // Use the exact displayed input and its owner, not the latest pointer
          // or resident-sampling completion. Worker and SVG meet at this pose.

          if (import.meta.env.DEV)
            el.dataset.presentedCamera = JSON.stringify((stats.presented as { view: CanvasCamera }).view)
          // This callback runs in a worker message task. Publish the same
          // camera to SVG chrome and picking before the next browser paint.
          const device = { client: p.client, deviceWorkerScope: stats.deviceWorkerScope as number,
            deviceIncarnation: stats.deviceIncarnation as number, deviceOwner: stats.deviceOwner as number }
          flushSync(() => latest.current.onPresented?.(actual, source,
            viewportPreviewDeviceKey(device) ? device : undefined))
        }
      }
      interaction.current = new InteractionRenderer(() => repaint.current(), p.client, renderExecutionPolicy.desktopDisplay, undefined, trace.current!)
      pageTranslation.current = new PageTranslation(() => repaint.current(), (document, patches, displayed) => {
        const p = latest.current, renderer = interaction.current
        if (!p.interaction || !renderer) return null
        usePageTranslation.current = false; interactionStarted.current = true
        // Warm at the last displayed pose, so a fractional move never falls
        // back to the unshifted page while its native GPU sample is pending.
        renderer.prepare({ ...p.interaction, document: displayed }, p.pageId, p.view, p.dpr,
          p.rasterProfile, p.backend, p.settledDocument, { width: p.width, height: p.height })
        return renderer.control.apply(document, patches)
      }, p.client.presentationDiagnosticsEnabled?.() ? fields=>latest.current.client.recordViewportDiagnostic(fields) : undefined,
        (source,offset,sequence,failed)=>latest.current.onTranslatedCoverage?.(source,offset,sequence,failed)===true)
    } catch (error) {
      p.onFailure(String(error))
    }
    return () => {
      unregisterContent()
      interactionStarted.current = false
      presentation.current = new ResidentPresentation()
      actualPresentation.current=undefined
      lastFrameSignature.current = ''
      attached.current = false
      importSession.current = {}
      importing.current.clear()
      interaction.current?.dispose()
      interaction.current = null
      p.client.onPresentation = undefined
      pageTranslation.current?.clear()
      pageTranslation.current = null
      // React effect replay must create a fresh transferable element, while
      // retaining page textures still owned by the parent surface/client.
      const pageIds = new Set(latest.current.items.map((item) => item.tile.gpuTile))
      p.client.releasePresented(
        [...new Set([...published.current.values()]
          .filter((t) => !pageIds.has(t.gpuTile))
          .map((t) => t.gpuTile))],
      )
      published.current.clear()
      el.remove()
      if (canvas.current === el) canvas.current = null
    }
  }, [props.client])
  useLayoutEffect(() => {
    const p = latest.current
    if (canvas.current) {
      canvas.current.style.width = `${p.width}px`
      canvas.current.style.height = `${p.height}px`
    }
    // Initial document pixels have priority over warming a saved selection.
    // Exact page readiness is not permission to steal an active affine edit.
    // Keep the live owner warm; its sample floor independently decides which
    // complete pixels may be shown over the newly ready page.
    const affineGesture = !!p.interaction?.active && !!p.interaction.gestureKind && p.interaction.gestureKind !== 'move'
    usePageTranslation.current = !affineGesture &&
      pageTranslation.current?.prepare(
        p.interaction,
        p.pageId,
        p.sourceDocument,
        p.translationItems,
        p.settledDocument,
        p.allowPageTranslation,
        renderExecutionPolicy.desktopDisplay&&p.rasterProfile==='figmaSubpixel'&&import.meta.env.VITE_DESIGN_RETAINED_TRANSLATION!=='0',
      ) === true
    if (usePageTranslation.current) {
      interaction.current?.prepare(undefined, p.pageId, p.view, p.dpr, p.rasterProfile, p.backend)
      pageTranslation.current?.bind()
    } else if (interactionStarted.current || p.settledDocument || p.interaction?.active) {
      interactionStarted.current = true
      interaction.current?.prepare(
        p.interaction,
        p.pageId,
        p.view,
        p.dpr,
        p.rasterProfile,
        p.backend,
        p.settledDocument,
        { width: p.width, height: p.height },
      )
    }
    repaint.current()
  }, [
    props.items,
    props.view,
    props.width,
    props.height,
    props.dpr,
    props.reuseSequence,
    props.interaction,
    props.settledDocument,
    props.pageId,
    props.backend,
    props.rasterProfile,
    props.sourceDocument,
    props.translationItems,
    props.allowPageTranslation,
    props.overlay,
    props.presentation,
    props.allowPanPreview,
    props.panBacking,
  ])
  return (
    <div
      ref={host}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: props.width,
        height: props.height,
        pointerEvents: 'none',
      }}
    />
  )
}
