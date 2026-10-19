import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import { KernelSurface, ReferenceSurface, type PresentedFrame, type SurfaceProps } from './Surface'
import { ProgressiveSurface } from './ProgressiveSurface'

// Component transition boundary only. Children, workers, browser canvases and GPU
// are not executed; the separate fault-injection browser gate covers pixels.
function harness() {
  const slots: any[] = []
  let cursor = 0
  const hooks = {
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: any, deps: any[]) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, index) => !Object.is(v, old.deps[index]))) slots[i] = { deps, value: fn() }; return slots[i].value },
    useCallback(fn: any) { const i = cursor++; return slots[i] ??= fn },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect() { cursor++ },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return (props: SurfaceProps) => {
    cursor = 0; const previous = internals.H; internals.H = hooks
    try { return KernelSurface(props) } finally { internals.H = previous }
  }
}
function child(tree: any, type: unknown) {
  return [tree.props.children].flat(Infinity).find((value: any) => value?.type === type)
}
afterEach(() => vi.unstubAllGlobals())

test('pending fallback retains GPU across pixel-preview and playback switches until exact CPU commit', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const document = blank(), render = harness()
  let props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650, view: { x: 0, y: 0, zoom: 1 }, grid: false }
  const oldFrame: PresentedFrame = { ...props, epoch: 0, pixelRatio: 2, managed: false }
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onPresentation(oldFrame)
  tree = render(props)
  child(tree, ProgressiveSurface).props.onFallback('PREVIEW_CPU_FALLBACK: budget')
  for (const change of [{ pixelPreview: 1 as const }, { animation: { clipId: 'clip', timeMs: 200 } }]) {
    props = { ...props, ...change, view: { ...props.view, zoom: 2 } }
    tree = render(props)
    expect(child(tree, ProgressiveSurface)?.props.paused).toBe(true)
    expect(child(tree, ReferenceSurface)?.props.visible).toBe(false)
    expect(tree.props['data-presentation-ready']).toBe('false')
    child(tree, ReferenceSurface).props.onPresentation(null)
    child(tree, ReferenceSurface).props.onPresentation(oldFrame)
    expect(render(props).props['data-fallback-phase']).toBe('pending')
  }
  child(tree, ReferenceSurface).props.onPresentation({ ...oldFrame, ...props, view: props.view })
  tree = render(props)
  expect(child(tree, ProgressiveSurface)).toBeUndefined()
  expect(child(tree, ReferenceSurface).props.visible).toBe(true)
  expect(tree.props['data-fallback-phase']).toBe('cpu')
  expect(tree.props['data-presentation-ready']).toBe('true')
})

test('same-camera render-contract changes cannot mark old pixels ready or finish a fallback', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  for (const change of [
    { grid: true },
    { rasterProfile: 'figmaSoftware' as const },
    { pixelPreview: 1 as const },
    { animation: { clipId: 'another-clip', timeMs: 100 } },
  ]) {
    const document = blank(), render = harness()
    const original: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
      view: { x: 0, y: 0, zoom: 1 }, grid: false }
    const oldFrame: PresentedFrame = { ...original, epoch: 0, pixelRatio: 2, managed: false }
    let tree = render(original)
    child(tree, ProgressiveSurface).props.onPresentation(oldFrame)
    tree = render(original)
    expect(tree.props['data-presentation-ready']).toBe('true')
    child(tree, ProgressiveSurface).props.onFallback('PREVIEW_CPU_FALLBACK: budget')
    const requested = { ...original, ...change }
    tree = render(requested)
    expect(tree.props['data-presentation-ready']).toBe('false')
    child(tree, ReferenceSurface).props.onPresentation(oldFrame)
    expect(render(requested).props['data-fallback-phase']).toBe('pending')
    child(tree, ReferenceSurface).props.onPresentation({ ...oldFrame, ...change })
    tree = render(requested)
    expect(tree.props['data-fallback-phase']).toBe('cpu')
    expect(tree.props['data-presentation-ready']).toBe('true')
  }
})

test('intentional pixel mode changes retain the previous complete strategy until the new strategy commits', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const document = blank(), render = harness()
  let props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
    view: { x: 0, y: 0, zoom: 1 }, grid: false }
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2, managed: false })
  props = { ...props, pixelPreview: 1 }
  tree = render(props)
  expect(child(tree, ProgressiveSurface)?.props.paused).toBe(true)
  expect(child(tree, ReferenceSurface)?.props.visible).toBe(false)
  child(tree, ReferenceSurface).props.onPresentation(null)
  tree = render(props)
  expect(tree.props['data-presentation-backend']).toBe('gpu')
  child(tree, ReferenceSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2, managed: false })
  tree = render(props)
  expect(child(tree, ProgressiveSurface)).toBeUndefined()
  expect(child(tree, ReferenceSurface)?.props.visible).toBe(true)
  props = { ...props, pixelPreview: 0 }
  tree = render(props)
  expect(child(tree, ReferenceSurface)?.props.paused).toBe(true)
  expect(child(tree, ProgressiveSurface)?.props.visible).toBe(true)
  child(tree, ProgressiveSurface).props.onPresentation(null)
  expect(render(props).props['data-presentation-backend']).toBe('cpu')
  child(tree, ProgressiveSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2, managed: false })
  tree = render(props)
  expect(child(tree, ReferenceSurface)).toBeUndefined()
  expect(child(tree, ProgressiveSurface)?.props.visible).toBe(true)
  expect(tree.props['data-presentation-ready']).toBe('true')
})

test('a held strategy cannot carry a previous document or page into a replacement', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  for (const replacement of ['document', 'page', 'epoch']) {
    const document = blank(), render = harness()
    const props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
      view: { x: 0, y: 0, zoom: 1 }, grid: false }
    let tree = render(props)
    child(tree, ProgressiveSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2, managed: false })
    const change = replacement === 'document' ? { document: blank() } : replacement === 'page'
      ? { pageId: 'other-page' } : { presentationEpoch: 1 }
    tree = render({ ...props, ...change, pixelPreview: 1 })
    expect(child(tree, ProgressiveSurface)).toBeUndefined()
    expect(child(tree, ReferenceSurface)?.props.visible).toBe(true)
    expect(tree.props['data-presentation-backend']).toBe('none')
    expect(tree.props['data-presentation-ready']).toBe('false')
  }
})

test('the canvas exposes only the fixed WebGPU renderer, ignoring legacy choices', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  vi.stubGlobal('localStorage', { getItem: () => 'webgl2' })
  const document = blank(), render = harness()
  const props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
    view: { x: 0, y: 0, zoom: 1 }, grid: false }
  const surface = child(render(props), ProgressiveSurface)
  expect(surface.props.backend).toBe('webgpu')
  expect(surface.props.onBackendChange).toBeUndefined()
})

test('pending compute fallback removes old page pixels immediately on page or epoch replacement', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  for (const change of [{ pageId: 'other-page' }, { presentationEpoch: 1 }]) {
    const document = blank(), render = harness()
    const props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
      view: { x: 0, y: 0, zoom: 1 }, grid: false }
    let tree = render(props)
    child(tree, ProgressiveSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2, managed: false })
    child(tree, ProgressiveSurface).props.onFallback('PREVIEW_CPU_FALLBACK: budget')
    tree = render({ ...props, ...change })
    expect(child(tree, ProgressiveSurface)).toBeUndefined()
    expect(child(tree, ReferenceSurface).props.visible).toBe(false)
    expect(tree.props['data-presentation-backend']).toBe('none')
  }
})


test('a continuous camera stream completes the in-flight exact frame, then renders only the newest camera', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const document = blank(), render = harness()
  const props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
    view: { x: 0, y: 0, zoom: 1 }, grid: false }
  let tree = render(props)
  const backend = child(tree, ProgressiveSurface).props.backend
  let desired = props
  for (let i = 1; i <= 30; i++) {
    desired = { ...props, view: { x: i * 10.25, y: -i * 7.5, zoom: 1 + i / 100 } }
    tree = render(desired)
    expect(child(tree, ProgressiveSurface).props.view).toEqual(props.view)
  }
  child(tree, ProgressiveSurface).props.onPresentation({ ...props, epoch: 0, pixelRatio: 2,
    managed: false, computeBackend: backend })
  tree = render(desired)
  expect(tree.props['data-camera-x']).toBe(0)
  expect(tree.props['data-presentation-ready']).toBe('false')
  expect(child(tree, ProgressiveSurface).props.view).toEqual(desired.view)
  child(tree, ProgressiveSurface).props.onPresentation({ ...desired, epoch: 0, pixelRatio: 2,
    managed: false, computeBackend: backend })
  tree = render(desired)
  expect(tree.props['data-presentation-ready']).toBe('true')
  expect(tree.props['data-camera-x']).toBe(desired.view.x)
})

test('navigation queue invalidates immediately on document edits and advances after a failed camera', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const document = blank(), render = harness()
  const props: SurfaceProps = { document, pageId: document.pages[0].id, width: 900, height: 650,
    view: { x: 0, y: 0, zoom: 1 }, grid: false }
  let tree = render(props)
  const moved = { ...props, view: { x: 240, y: -80, zoom: 2 } }
  tree = render(moved)
  child(tree, ProgressiveSurface).props.onRenderFailure()
  tree = render(moved)
  expect(child(tree, ProgressiveSurface).props.view).toEqual(moved.view)
  const edited = { ...moved, document: { ...document, name: 'edited' }, view: { x: 480, y: 120, zoom: 3 } }
  tree = render(edited)
  expect(child(tree, ProgressiveSurface).props.document).toBe(edited.document)
  expect(child(tree, ProgressiveSurface).props.view).toEqual(edited.view)
  child(tree, ProgressiveSurface).props.onPresentation({ ...moved, epoch: 0, pixelRatio: 2, managed: false })
  expect(render(edited).props['data-presentation-ready']).toBe('false')
})
