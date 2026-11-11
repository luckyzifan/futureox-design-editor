import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import { KernelSurface, ReferenceSurface, type PresentedFrame, type SurfaceProps } from './Surface'
import { ProgressiveSurface } from './ProgressiveSurface'

// Actual JSX/state boundary, with no browser, canvas context, workers or GPU.
// These checks cover presentation semantics, not a rendered-pixel oracle.
function harness(runLayoutEffects = false) {
  const slots: any[] = []
  const effects: Array<() => void> = []
  let cursor = 0
  const hooks = {
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: any, deps: any[]) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value },
    useCallback(fn: any) { const i = cursor++; return slots[i] ??= fn },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect(effect: () => void) { cursor++; if (runLayoutEffects) effects.push(effect) },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return (props: SurfaceProps) => {
    cursor = 0
    const previous = internals.H
    internals.H = hooks
    let tree
    try { tree = KernelSurface(props) } finally { internals.H = previous }
    for (const effect of effects.splice(0)) effect()
    return tree
  }
}
function child(tree: any, type: unknown) {
  return [tree.props.children].flat(Infinity).find((value: any) => value?.type === type)
}
function byClass(tree: any, className: string) {
  return [tree.props.children].flat(Infinity).find((value: any) => value?.props?.className === className)
}
function fixture(overrides: Partial<SurfaceProps> = {}): SurfaceProps {
  const document = blank()
  return { document, pageId: document.pages[0].id, width: 900, height: 650,
    view: { x: 0, y: 0, zoom: 1 }, grid: false, ...overrides }
}
function exact(props: SurfaceProps): PresentedFrame {
  return { ...props, epoch: props.presentationEpoch || 0, pixelRatio: 2,
    managed: false, computeBackend: 'webgpu' }
}
afterEach(() => vi.unstubAllGlobals())

test.each([0, 1] as const)('cold surface has noninteractive opaque UI and honest loading state in pixel mode %s', pixelPreview => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture({ pixelPreview }), tree = harness()(props)
  expect(tree.props['data-presentation-ready']).toBe('false')
  expect(tree.props['data-presentation-state']).toBe('loading')
  expect(tree.props['aria-busy']).toBe(true)
  expect(tree.props.style.pointerEvents).toBe('none')
  const backdrop = byClass(tree, 'kernel-workspace-backdrop')
  expect(backdrop.props['aria-hidden']).toBe('true')
  expect(backdrop.props.style).toMatchObject({ inset: 0, backgroundColor: '#f5f5f5', pointerEvents: 'none' })
  const status = byClass(tree, 'kernel-first-frame')
  expect(status.props.role).toBe('status')
  expect(status.props['aria-live']).toBe('polite')
  expect(status.props.style.pointerEvents).toBe('none')
  expect(status.props.children).toBe('正在绘制画布…')
  expect(child(tree, pixelPreview ? ReferenceSurface : ProgressiveSurface)).toBeDefined()
})

test('transparent authored background remains untouched while workspace chrome stays opaque', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture()
  props.document.pages[0].background = '#00000000'
  const before = JSON.stringify(props.document), render = harness()
  let tree = render(props)
  expect(byClass(tree, 'kernel-workspace-backdrop').props.style.backgroundColor).toBe('#f5f5f5')
  expect(child(tree, ProgressiveSurface).props.document).toBe(props.document)
  child(tree, ProgressiveSurface).props.onPresentation(exact(props))
  tree = render(props)
  expect(tree.props['data-presentation-ready']).toBe('true')
  expect(tree.props['data-presentation-state']).toBe('ready')
  expect(tree.props['aria-busy']).toBe(false)
  expect(byClass(tree, 'kernel-first-frame')).toBeUndefined()
  expect(byClass(tree, 'kernel-workspace-backdrop')).toBeDefined()
  expect(JSON.stringify(props.document)).toBe(before)
})

test('whole-viewport preview retires the placeholder without certifying exact detail', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture(), render = harness()
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onPresentation({ ...exact(props), preview: true })
  tree = render(props)
  expect(tree.props['data-presentation-ready']).toBe('false')
  expect(tree.props['data-presentation-state']).toBe('preview')
  expect(tree.props['aria-busy']).toBe(true)
  expect(byClass(tree, 'kernel-first-frame')).toBeUndefined()
  child(tree, ProgressiveSurface).props.onPresentation(exact(props))
  tree = render(props)
  expect(tree.props['data-presentation-ready']).toBe('true')
  expect(tree.props['aria-busy']).toBe(false)
})

test('an accepted interaction frame can clear selection chrome during exact refinement', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const onPresentation = vi.fn(), props = fixture({ onPresentation }), render = harness(true)
  const initial = { ...exact(props), gpuSelectionIdentity: 'selection-with-handles' }
  child(render(props), ProgressiveSurface).props.onPresentation(initial)
  expect(render(props).props['data-presentation-ready']).toBe('true')
  expect(onPresentation.mock.lastCall?.[0]?.gpuSelectionIdentity).toBe(initial.gpuSelectionIdentity)

  const committed = { ...props, document: { ...props.document, name: 'After edit' } }
  child(render(committed), ProgressiveSurface).props.onPresentation({
    ...initial, preview: true, gpuSelectionIdentity: undefined,
  })
  expect(render(committed).props['data-presentation-ready']).toBe('false')
  expect(onPresentation.mock.lastCall?.[0]?.document).toBe(props.document)
  expect(onPresentation.mock.lastCall?.[0]?.gpuSelectionIdentity).toBeUndefined()
})

test('cold failure is reported without promising ongoing progress and successful retry clears it', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const onRenderFailure = vi.fn(), props = fixture({ onRenderFailure }), render = harness()
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onRenderFailure()
  tree = render(props)
  expect(onRenderFailure).toHaveBeenCalledTimes(1)
  expect(tree.props['data-presentation-state']).toBe('error')
  expect(tree.props['data-presentation-ready']).toBe('false')
  expect(tree.props['aria-busy']).toBe(false)
  expect(byClass(tree, 'kernel-first-frame').props.children).toBe('画布暂未绘制完成')
  expect(byClass(tree, 'kernel-workspace-backdrop')).toBeDefined()
  child(tree, ProgressiveSurface).props.onPresentation(exact(props))
  tree = render(props)
  expect(tree.props['data-presentation-state']).toBe('ready')
  expect(byClass(tree, 'kernel-first-frame')).toBeUndefined()
})

test.each(['document', 'page', 'epoch'] as const)('replacement %s cannot reuse another presentation or its ready metadata', kind => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture(), render = harness()
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onPresentation(exact(props))
  tree = render(props)
  expect(tree.props['data-presentation-state']).toBe('ready')
  const change = kind === 'document' ? { document: blank() } : kind === 'page'
    ? { pageId: 'another-page' } : { presentationEpoch: 1 }
  const next = { ...props, ...change }
  tree = render(next)
  expect(tree.props['data-presentation-state']).toBe('loading')
  expect(tree.props['data-displayed-document']).toBeUndefined()
  expect(tree.props['data-camera-zoom']).toBeUndefined()
  expect(byClass(tree, 'kernel-first-frame')).toBeDefined()
  child(tree, ProgressiveSurface).props.onPresentation({ ...exact(props), preview: true })
  tree = render(next)
  expect(tree.props['data-presentation-state']).toBe('loading')
  expect(tree.props['data-preview-active']).toBe('false')
})

test('cold GPU fallback retains the backdrop while CPU recovery is pending', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture(), render = harness()
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onRenderFailure()
  child(tree, ProgressiveSurface).props.onFallback('PREVIEW_CPU_FALLBACK: budget')
  tree = render(props)
  expect(tree.props['data-presentation-state']).toBe('loading')
  expect(tree.props['aria-busy']).toBe(true)
  expect(byClass(tree, 'kernel-first-frame')).toBeDefined()
  expect(byClass(tree, 'kernel-workspace-backdrop')).toBeDefined()
  child(tree, ReferenceSurface).props.onPresentation({ ...exact(props), computeBackend: 'cpu' })
  tree = render(props)
  expect(tree.props['data-presentation-state']).toBe('ready')
  expect(byClass(tree, 'kernel-first-frame')).toBeUndefined()
})

test('camera refinement keeps its visible frame and does not flash the cold-start label', () => {
  vi.stubGlobal('window', { devicePixelRatio: 2 })
  const props = fixture(), render = harness()
  let tree = render(props)
  child(tree, ProgressiveSurface).props.onPresentation(exact(props))
  const moved = { ...props, view: { x: 20, y: 40, zoom: 16 } }
  tree = render(moved)
  expect(tree.props['data-presentation-state']).toBe('preview')
  expect(tree.props['data-presentation-ready']).toBe('false')
  expect(byClass(tree, 'kernel-first-frame')).toBeUndefined()
  expect(byClass(tree, 'kernel-workspace-backdrop')).toBeDefined()
})
