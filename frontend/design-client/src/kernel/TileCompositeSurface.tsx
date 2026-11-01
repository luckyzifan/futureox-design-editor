import { useLayoutEffect, useRef } from 'react'
import type { CanvasCamera } from '../canvas-camera'
import { TileCompositor, type CompositeItem } from './gpu/tile-compositor'
import { InteractionRenderer } from './interaction-renderer'
import { liveInteractionStack } from './resident-layer-stack'
import type { InteractionProps } from './interaction-layers'
import type { DesignDocument } from '../model'
import type { KernelOptions } from './client'
import type { BackendPreference } from './gpu/types'
import type { PresentedFrame } from './Surface'
import { presentationMatches } from './presentation'
import { allowIncompletePanPreview, type PanPreviewBacking } from './pan-preview'

export function TileCompositeSurface({ items, view, width, height, dpr, onReady, onGone, onError, onFailure,
  interaction, pageId, rasterProfile, backend, settledDocument, presentation, onComposited, sourceDocument, contentRevision, allowPanPreview, panBacking }:
  { items: CompositeItem[]; view: CanvasCamera; width: number; height: number; dpr: number;
    interaction?: InteractionProps; pageId: string; rasterProfile: KernelOptions['rasterProfile']; backend: BackendPreference;
    settledDocument?: DesignDocument;
    sourceDocument?: DesignDocument; contentRevision?: number; allowPanPreview?: boolean; panBacking?: PanPreviewBacking;
    presentation?: PresentedFrame | null; onComposited?: (frame: PresentedFrame | null) => void;
    onReady: (key: string, serial: number, managed: boolean) => void;
    onGone: (key: string, serial: number) => void;
    onError: (key: string, serial: number, message: string) => void;
    onFailure: (message: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const compositor = useRef<TileCompositor | null>(null)
  const published = useRef(new Map<number, string>())
  const interactionRenderer = useRef<InteractionRenderer | null>(null)
  const repaint = useRef<() => void>(() => {})
  const latest = useRef({ items, view, width, height, dpr, presentation, onComposited, sourceDocument, contentRevision, allowPanPreview, panBacking })
  latest.current = { items, view, width, height, dpr, presentation, onComposited, sourceDocument, contentRevision, allowPanPreview, panBacking }
  const callbacks = useRef({ onReady, onGone, onError, onFailure })
  callbacks.current = { onReady, onGone, onError, onFailure }
  useLayoutEffect(() => {
    const el = canvas.current!
    const lost = (event: Event) => {
      event.preventDefault()
      callbacks.current.onFailure('画布合成设备已丢失')
    }
    el.addEventListener('webglcontextlost', lost)
    try {
      compositor.current = new TileCompositor(el)
      interactionRenderer.current = new InteractionRenderer(() => repaint.current())
    }
    catch (error) { callbacks.current.onFailure(String(error)) }
    return () => {
      el.removeEventListener('webglcontextlost', lost)
      for (const [serial, key] of published.current) callbacks.current.onGone(key, serial)
      published.current.clear()
      interactionRenderer.current?.dispose(); interactionRenderer.current = null
      compositor.current?.dispose(); compositor.current = null
    }
  }, [])
  repaint.current = () => {
    const renderer = compositor.current
    if (!renderer) return
    const { items, view, width, height, dpr, presentation, onComposited, sourceDocument, contentRevision, allowPanPreview, panBacking } = latest.current
    const moving = interactionRenderer.current
    const keep = new Set([...items.map(item => item.tile.serial), ...(moving?.tiles.map(tile => tile.serial) || [])])
    renderer.retain(keep)
    for (const [serial, key] of published.current) if (!keep.has(serial)) {
      published.current.delete(serial); callbacks.current.onGone(key, serial)
    }
    for (const { tile } of items) {
      if (renderer.has(tile)) continue
      try {
        renderer.upload(tile)
        published.current.set(tile.serial, tile.key)
        // The texture now owns pixels independently of the transferable bitmap.
        tile.bitmap?.close(); tile.bitmap = undefined
        callbacks.current.onReady(tile.key, tile.serial, false)
      } catch (error) { callbacks.current.onError(tile.key, tile.serial, String(error)) }
    }
    try {
      for (const tile of moving?.tiles || []) if (!renderer.has(tile)) {
        renderer.upload(tile); tile.bytes = new Uint8Array(); tile.bitmap?.close(); tile.bitmap = undefined
      }
      const moved = moving?.items(view)
      const composition = moved && moving?.mode === 'live-kernel' ? liveInteractionStack(items, moved) : moved || items
      // Imports are a cohort: an incomplete retained layer set is not a new
      // transparent frame. Keep the last complete backing until it can draw.
      if (moved && composition.some(item => item.active && !renderer.has(item.tile))) return
      const preview = !moved && !!sourceDocument && contentRevision !== undefined && allowIncompletePanPreview({
        allowed: allowPanPreview, frame: presentation || null, document: sourceDocument, revision: contentRevision,
        pageId, width, height, dpr, items, backing: panBacking,
      })
      const submitted = renderer.draw(composition,
        view, width, height, dpr, !!moved && moving?.mode !== 'live-kernel', preview)
      if (submitted) {
        // Publish the camera actually drawn, even between plan generations.
        // A live pose is a preview; it must not certify the source as exact.
        const frame = presentation ? { ...presentation, view, width, height, pixelRatio:dpr } : null
        onComposited?.(frame && { ...frame, preview:!!moved || renderer.preview || !!presentation?.preview || !presentationMatches(presentation!, frame) })
        if (moved && moving) {
          const input = moving.presentedInput
          // draw() may run synchronously inside apply(). Let that input finish
          // registering its feedback before acknowledging this exact draw.
          queueMicrotask(() => {
            if (interactionRenderer.current === moving) moving.acceptPresentedInput(input.sequence, input.at)
          })
        }
      }
      if (canvas.current) {
        canvas.current.dataset.interactionReady = String(!!moving?.ready)
        canvas.current.dataset.interactionActive = String(!!moving?.items(view))
        canvas.current.dataset.interactionWarming = String(!!moving?.warming)
        canvas.current.dataset.interactionError = moving?.error || ''
        canvas.current.dataset.interactionMoves = String(moving?.moves || 0)
        // The bitmap route also acknowledges the input whose pixels were
        // actually drawn; requested pointer positions are not completion.
        if (submitted) canvas.current.dataset.contentSequence = String(moving?.presentedInput.sequence || 0)
        canvas.current.dataset.interactionEnd = moving?.lastEnd || ''
        canvas.current.dataset.interactionMode = moving?.mode || ''
        canvas.current.dataset.interactionSamples = String(moving?.samples || 0)
        canvas.current.dataset.interactionSampleMs = (moving?.lastSampleMs || 0).toFixed(2)
        canvas.current.dataset.interactionCompileMs = (moving?.lastSampleCompileMs || 0).toFixed(2)
        canvas.current.dataset.interactionGraphMs = (moving?.lastSampleGraphMs || 0).toFixed(2)
        canvas.current.dataset.interactionGeometryReused = String(!!moving?.lastSampleReused)
        canvas.current.dataset.interactionLoadMs = (moving?.lastSampleLoadMs || 0).toFixed(2)
        canvas.current.dataset.interactionPrepareMs = (moving?.lastSamplePrepareMs || 0).toFixed(2)
        canvas.current.dataset.interactionGroupHits = String(moving?.lastSampleGroupHits || 0)
        if (import.meta.env.DEV) canvas.current.dataset.interactionTrace = JSON.stringify(moving?.sampleTrace || [])
      }
    }
    catch (error) { callbacks.current.onFailure(String(error)) }
  }
  useLayoutEffect(() => {
    interactionRenderer.current?.prepare(interaction, pageId, view, dpr, rasterProfile, backend, settledDocument, { width, height })
    repaint.current()
  }, [items, view, width, height, dpr, interaction, pageId, rasterProfile, backend, settledDocument])
  return <canvas ref={canvas} className="kernel-compositor" data-compositor="webgl2"
    aria-label="GPU 合成画布" data-frame-visible="true"
    style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }}/>
}
