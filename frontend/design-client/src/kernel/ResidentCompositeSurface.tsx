import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { PresentedFrame } from './Surface'
import type { SurfaceProps } from './Surface'
import { ResidentPresentation, type ResidentAcknowledgement } from './resident-presentation'
import { registerContentPlane } from './content-plane'
import type { CanvasCamera } from '../canvas-camera'
import type { DesignDocument } from '../model'
import type { KernelClient, KernelOptions } from './client'
import type { BackendPreference } from './gpu/types'
import type { CompositeItem } from './gpu/tile-compositor'
import type { ResidentFrame } from './gpu/resident-presenter'
import { residentFrameSignature } from './gpu/resident-frame'
import type { InteractionProps } from './interaction-layers'
import { InteractionRenderer } from './interaction-renderer'
import { PageTranslation } from './page-translation'

export function ResidentCompositeSurface(props: {
  client: KernelClient
  items: CompositeItem[]
  view: CanvasCamera
  width: number
  height: number
  dpr: number
  interaction?: InteractionProps
  pageId: string
  rasterProfile: KernelOptions['rasterProfile']
  backend: BackendPreference
  settledDocument?: DesignDocument
  onReady: (key: string, serial: number, managed: boolean) => void
  sourceDocument: DesignDocument
  translationItems: CompositeItem[]
  allowPageTranslation: boolean
  onGone: (key: string, serial: number) => void
  onError?: (key: string, serial: number, message: string) => void
  onFailure: (message: string) => void
  presentation: PresentedFrame | null
  overlay?: SurfaceProps['overlay']
  onPresented?: (frame: ResidentAcknowledgement, source?: PresentedFrame) => void
}) {
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
  const importing = useRef(new Set<number>())
  const interactionStarted = useRef(false)
  const inputTrace = useRef<{ sequence: number; latency: number }[]>([])
  const inputScope=useRef(crypto.randomUUID()),inputOwner=useRef('')
  const lastFrameSignature = useRef('')
  const presentation = useRef(new ResidentPresentation())
  const actualPresentation=useRef<ResidentAcknowledgement|undefined>(undefined)
  repaint.current = () => {
    if (!attached.current) return
    const p = latest.current,
      moving = usePageTranslation.current || pageTranslation.current?.handingOff && !interaction.current?.ready
        ? pageTranslation.current : interaction.current
    const owner=`${inputScope.current}:${moving===pageTranslation.current?'page':'layer'}:${p.interaction?.epoch??0}`
    if(owner!==inputOwner.current){
      inputOwner.current=owner;inputTrace.current=[]
      if(canvas.current){canvas.current.dataset.inputTrace='[]';canvas.current.dataset.contentSequence='0'}
    }
    p.client.presentationInputOwner=owner
    const all = [...p.items.map((i) => i.tile), ...(moving?.tiles || [])]
    const keep = new Set(all.map((t) => t.serial)),
      release: number[] = []
    for (const [serial, tile] of published.current)
      if (!keep.has(serial)) {
        release.push(tile.gpuTile)
        published.current.delete(serial)
        p.onGone(tile.key, serial)
      }
    const pageTiles = new Set(p.items.map(item => item.tile))
    for (const tile of all) {
      if (published.current.has(tile.serial)) continue
      if (!tile.gpuTile) {
        if (importing.current.has(tile.serial)) continue
        if (!tile.bitmap && tile.bytes.byteLength !== tile.width * tile.height * 4) {
          p.onFailure(`GPU 驻留显示缺少纹理或像素: ${tile.key}`)
          return
        }
        importing.current.add(tile.serial)
        void p.client.importPresentation(tile).then(
          (id) => {
            importing.current.delete(tile.serial)
            if (!attached.current) {
              p.client.releasePresented([id])
              return
            }
            tile.gpuTile = id
            repaint.current()
          },
          (error) => {
            importing.current.delete(tile.serial)
            if (attached.current) p.onFailure(String(error))
          },
        )
        continue
      }
      published.current.set(tile.serial, { key: tile.key, gpuTile: tile.gpuTile })
      if (pageTiles.has(tile)) p.onReady(tile.key, tile.serial, false)
    }
    const moved = moving?.items(p.view)
    const items =
      moved && moving?.mode === 'live-kernel'
        ? [...p.items, ...moved.map((item) => ({ ...item, layer: 4 }))]
        : moved || p.items
    let presentationId: string | undefined
    const sourceOverlay = p.presentation && p.overlay?.document === p.presentation.document &&
      p.overlay.pageId === p.presentation.pageId && p.overlay.epoch === p.presentation.epoch ? p.overlay.commands : undefined
    const overlay=sourceOverlay?(moved?moving?.overlay(sourceOverlay):sourceOverlay):undefined
    try { presentationId = presentation.current.stage(p.presentation ? { ...p.presentation, gpuOverlay: !!overlay } : null) }
    catch (error) { p.onFailure(String(error)); return }
    const frame: ResidentFrame = {
      presentationId,
      overlay,
      view: p.view,
      width: p.width,
      height: p.height,
      dpr: p.dpr,
      interaction: !!moved,
      allowEmpty: !!moved && moving?.mode !== 'live-kernel',
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
    const signature = residentFrameSignature(frame)
    if (signature !== lastFrameSignature.current) {
      lastFrameSignature.current = signature
      p.client.present(frame)
    }
    p.client.releasePresented(release)
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
        ...(import.meta.env.DEV ? { interactionTrace: JSON.stringify(moving.sampleTrace), interactionInputPreparation: JSON.stringify(moving instanceof InteractionRenderer ? moving.inputPreparationTrace : []) } : {}),
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
          if (sample.signature) lastFrameSignature.current = sample.signature
          interaction.current?.acceptResidentSample(sample)
        }
        for (const [key, value] of Object.entries(stats))
          if (key !== 'presented' && key !== 'input' && key !== 'residentSample' && key !== 'missingGpuTiles')
            el.dataset[key] = String(value)
        const input = stats.input as { sequence: number; at: number;owner?:string } | undefined
        if (input?.sequence && input.owner===inputOwner.current && input.sequence > (inputTrace.current.at(-1)?.sequence || 0)) {
          inputTrace.current.push({
            sequence: input.sequence,
            latency: performance.now() - input.at,
          })
          if (inputTrace.current.length > 180) inputTrace.current.shift()
          el.dataset.contentSequence = String(input.sequence)
          if (import.meta.env.DEV) el.dataset.inputTrace = JSON.stringify(inputTrace.current)
        }
        if (stats.presented) {
          const actual = stats.presented as ResidentAcknowledgement
          actualPresentation.current=actual
          if (import.meta.env.DEV)
            el.dataset.presentedCamera = JSON.stringify((stats.presented as { view: CanvasCamera }).view)
          // This callback runs in a worker message task. Publish the same
          // camera to SVG chrome and picking before the next browser paint.
          flushSync(() => latest.current.onPresented?.(actual, presentation.current.resolve(actual)))
        }
      }
      interaction.current = new InteractionRenderer(() => repaint.current(), p.client)
      pageTranslation.current = new PageTranslation(() => repaint.current(), (document, patches, displayed) => {
        const p = latest.current, renderer = interaction.current
        if (!p.interaction || !renderer) return null
        usePageTranslation.current = false; interactionStarted.current = true
        // Warm at the last displayed pose, so a fractional move never falls
        // back to the unshifted page while its native GPU sample is pending.
        renderer.prepare({ ...p.interaction, document: displayed }, p.pageId, p.view, p.dpr,
          p.rasterProfile, p.backend, p.settledDocument, { width: p.width, height: p.height })
        return renderer.control.apply(document, patches)
      })
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
      interaction.current?.dispose()
      interaction.current = null
      p.client.onPresentation = undefined
      pageTranslation.current?.clear()
      pageTranslation.current = null
      // React effect replay must create a fresh transferable element, while
      // retaining page textures still owned by the parent surface/client.
      const pageIds = new Set(latest.current.items.map((item) => item.tile.gpuTile))
      p.client.releasePresented(
        [...published.current.values()]
          .filter((t) => !pageIds.has(t.gpuTile))
          .map((t) => t.gpuTile),
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
    usePageTranslation.current =
      pageTranslation.current?.prepare(
        p.interaction,
        p.pageId,
        p.sourceDocument,
        p.translationItems,
        p.settledDocument,
        p.allowPageTranslation,
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
