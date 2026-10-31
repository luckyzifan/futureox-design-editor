import { expect, test } from 'vitest'
import { canReplaceFallback, presentationMatches, referencePresentationPolicy, type ExactPresentation } from './presentation'
import { allowsColorPresentation, createRenderPolicy } from './render-policy'

const doc = { id: 'local-document', nodes: { marker: { width: 211 } } }
function frame(): ExactPresentation {
  return { document: doc, pageId: 'page', epoch: 3, view: { x: -13.25, y: 40.5, zoom: 1 }, width: 1000.5, height: 650, pixelRatio: 2 }
}

test('pending CPU initialization and failure cannot replace a complete GPU frame', () => {
  const previous = frame()
  expect(canReplaceFallback(null, previous, false, false)).toBe(false)
  // Failure supplies no presentation event; keeping the last frame does not mark
  // it ready for a newly edited document snapshot.
  const edited = { ...previous, document: { ...doc, nodes: { marker: { width: 322 } } } }
  expect(presentationMatches(previous, edited)).toBe(false)
  expect(canReplaceFallback(previous, edited, false, false)).toBe(false)
  expect(canReplaceFallback(edited, edited, false, false)).toBe(true)
  expect(canReplaceFallback({ ...edited, preview: true }, edited, false, false)).toBe(false)
})

test('an old CPU request held across pan, zoom, resize, monitor scale or replacement is rejected', () => {
  const previous = frame()
  const changes: Partial<ExactPresentation>[] = [
    { view: { ...previous.view, x: -13 } },
    { view: { ...previous.view, y: 41 } },
    { view: { ...previous.view, zoom: 2 } },
    { width: 1001 }, { height: 651 }, { pixelRatio: 1.5 },
    { epoch: 4 }, { pageId: 'other-page' }, { document: { ...doc } },
    { grid: true }, { pixelPreview: 1 }, { rasterProfile: 'figmaSoftware' },
    { animation: { clipId: 'clip', timeMs: 10 } }, { displayCapability: 'p3/high' },
  ]
  for (const change of changes) {
    const current = { ...previous, ...change }
    expect(canReplaceFallback(previous, current, false, false)).toBe(false)
    expect(canReplaceFallback(current, current, false, false)).toBe(true)
  }
})

test('effective document profile and zero pixel preview are matched without changing playback policy', () => {
  const document = { ...doc, rasterProfile: 'figmaSoftware' }
  const implicit = { ...frame(), document, pixelPreview: 0 as const }
  expect(presentationMatches(implicit, { ...implicit, rasterProfile: 'figmaSoftware' })).toBe(true)
  expect(presentationMatches(implicit, { ...implicit, rasterProfile: 'figma' })).toBe(false)
  const playing = { ...implicit, animation: { clipId: 'clip', timeMs: 10 } }
  expect(presentationMatches(playing, { ...playing, animation: { clipId: 'clip', timeMs: 20 } })).toBe(true)
})

test('exact current CPU managed frame may replace HDR, but SDR or null may not', () => {
  const current = frame()
  expect(canReplaceFallback(current, current, true, false)).toBe(false)
  expect(canReplaceFallback(null, current, true, true)).toBe(false)
  expect(canReplaceFallback(current, current, true, true)).toBe(true)
  expect(canReplaceFallback({ ...current, pixelRatio: 1 }, current, true, true)).toBe(false)
})

test('automatic fallback keeps CPU computation and the original managed display permission separate', () => {
  const normal = createRenderPolicy(false, true)
  const presentation = referencePresentationPolicy(normal, 'cpu', 'auto')
  expect(presentation).toEqual({ backend: 'auto', requireManaged: true })
  expect(allowsColorPresentation(normal, presentation.backend)).toBe(true)
  // The global policy is unchanged: an ordinary CPU render cannot acquire GPU display.
  expect(allowsColorPresentation(normal, 'cpu')).toBe(false)
})

test('explicit CPU and strict CPU launch never acquire an automatic fallback presenter', () => {
  const normal = createRenderPolicy(false), strict = createRenderPolicy(true)
  expect(referencePresentationPolicy(normal, 'cpu')).toEqual({ backend: 'cpu', requireManaged: false })
  expect(referencePresentationPolicy(normal, 'cpu', 'cpu')).toEqual({ backend: 'cpu', requireManaged: false })
  for (const fallback of ['auto', 'webgpu', 'webgl2', 'cpu'] as const) {
    const presentation = referencePresentationPolicy(strict, 'cpu', fallback)
    expect(presentation).toEqual({ backend: 'cpu', requireManaged: false })
    expect(allowsColorPresentation(strict, presentation.backend)).toBe(false)
  }
})

test('managed direct reference modes require the same precise float display as tiles', () => {
  const normal = createRenderPolicy(false, true)
  for (const backend of ['auto', 'webgpu', 'webgl2'] as const)
    expect(referencePresentationPolicy(normal, backend).requireManaged).toBe(true)
})

test('SDR output never requires an HDR presenter even when managed computation falls back to CPU', () => {
  const sdr = createRenderPolicy(false)
  for (const backend of ['auto', 'webgpu', 'webgl2', 'cpu'] as const)
    expect(referencePresentationPolicy(sdr, backend).requireManaged).toBe(false)
  const fallback = referencePresentationPolicy(sdr, 'cpu', 'auto')
  expect(fallback.requireManaged).toBe(false)
  expect(canReplaceFallback(frame(), frame(), fallback.requireManaged, false)).toBe(true)
})
