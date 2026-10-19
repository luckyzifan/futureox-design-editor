/** Deterministic navigation scheduling contracts. These exercise the production
 * state machine, not a browser/GPU or a claim about rendered pixel quality. */
import { expect, test } from 'vitest'
import {
  NavigationZoom,
  NAVIGATION_ZOOM_QUIET_MS,
  NAVIGATION_ZOOM_SAMPLE_MS,
  navigationPreviewDensity,
  type NavigationZoomSample,
} from './navigation-zoom'

const camera = (zoom: number, x = 0, y = 0) => ({ x, y, zoom })

function journal(owner: NavigationZoom) {
  const samples: { at: number; value: NavigationZoomSample }[] = []
  let sequence = owner.sample.sequence
  return {
    samples,
    record(at: number, value: NavigationZoomSample) {
      if (value.sequence !== sequence) {
        samples.push({ at, value })
        sequence = value.sequence
      }
    },
  }
}

test.each([60, 120])('one-second 0.1x to 32x zoom at %i Hz has bounded previews and one exact final target', hz => {
  const owner = new NavigationZoom(camera(.1)), log = journal(owner)
  const last = camera(32, -127.25, 63.125)
  for (let frame = 1; frame <= hz; frame++) {
    const at = frame * 1000 / hz, fraction = frame / hz
    const target = frame === hz ? last : camera(.1 * 320 ** fraction, last.x * fraction, last.y * fraction)
    log.record(at, owner.update(target, at))
    log.record(at, owner.frame(at))
    expect(owner.active).toBe(true)
  }
  for (let frame = 1; frame <= hz; frame++) {
    const at = 1000 + frame * 1000 / hz
    log.record(at, owner.frame(at))
  }
  const previews = log.samples.filter(sample => sample.value.active)
  const finals = log.samples.filter(sample => !sample.value.active)
  expect(previews.length).toBeGreaterThan(1)
  expect(previews.length).toBeLessThanOrEqual(8)
  for (let index = 1; index < previews.length; index++)
    expect(previews[index].at - previews[index - 1].at).toBeGreaterThanOrEqual(NAVIGATION_ZOOM_SAMPLE_MS - 1e-9)
  expect(finals).toHaveLength(1)
  expect(finals[0].at).toBeGreaterThanOrEqual(1000 + NAVIGATION_ZOOM_QUIET_MS)
  expect(finals[0].value.view).toEqual(last)
  expect(owner.sample).toBe(finals[0].value)
  expect(owner.zoom).toBe(32)
  expect(owner.active).toBe(false)
  expect(owner.frame(10_000)).toBe(finals[0].value)
})

test('80ms wheel bursts stay active between events and settle only after quiet plus two frames', () => {
  const owner = new NavigationZoom(camera(1)), log = journal(owner)
  for (let at = 0; at <= 720; at += 16) {
    if (at % 80 === 0) log.record(at, owner.update(camera(2 + at / 80), at))
    log.record(at, owner.frame(at))
    expect(owner.active).toBe(true)
  }
  log.record(879, owner.frame(879))
  expect(owner.active).toBe(true)
  log.record(880, owner.frame(880))
  expect(owner.active).toBe(true)
  log.record(896, owner.frame(896))
  expect(owner.active).toBe(false)
  expect(log.samples.filter(sample => !sample.value.active)).toHaveLength(1)
  expect(owner.sample.view).toEqual(camera(11))
})

test('reversal to the original scale retains the activity window and final latest camera', () => {
  const owner = new NavigationZoom(camera(.1)), log = journal(owner)
  log.record(0, owner.update(camera(32, -200, 20), 0))
  log.record(80, owner.update(camera(.1, 3.25, -4.5), 80))
  expect(owner.active).toBe(true)
  log.record(160, owner.frame(160))
  expect(owner.sample.view).toEqual(camera(.1, 3.25, -4.5))
  expect(owner.active).toBe(true)
  log.record(240, owner.frame(240))
  expect(owner.active).toBe(true)
  log.record(256, owner.frame(256))
  expect(owner.active).toBe(false)
  expect(log.samples.filter(sample => !sample.value.active)).toHaveLength(1)
  expect(owner.sample.view).toEqual(camera(.1, 3.25, -4.5))
})

test('fixed-scale pans never enter the temporary zoom tier', () => {
  const owner = new NavigationZoom(camera(32)), original = owner.sample
  for (let index = 1; index <= 240; index++) {
    const now = index * 1000 / 120
    owner.update(camera(32, index * 2.25, -index * .75), now)
    owner.frame(now)
    expect(owner.active).toBe(false)
    expect(owner.sample).toBe(original)
  }
})

test('a pan during zoom retains the most recent camera for the exact final sample', () => {
  const owner = new NavigationZoom(camera(1))
  owner.update(camera(32), 0)
  owner.update(camera(32, 99.25, -43.125), 80)
  owner.frame(160)
  expect(owner.active).toBe(true)
  owner.frame(176)
  expect(owner.active).toBe(false)
  expect(owner.sample.view).toEqual(camera(32, 99.25, -43.125))
})

test('published samples are detached from caller input and later updates', () => {
  const owner = new NavigationZoom(camera(1)), input = camera(4, 1, 2)
  const first = owner.update(input, 0)
  input.zoom = 99; input.x = 500
  expect(first.view).toEqual(camera(4, 1, 2))
  owner.update(camera(32, 7, 8), 160)
  expect(first.view).toEqual(camera(4, 1, 2))
  expect(owner.sample.sequence).toBe(first.sequence + 1)
})

test('unchanged cameras over 1200 frames do not publish preview or exact work', () => {
  const view = camera(32, 10.25, -70.125), owner = new NavigationZoom(view), initial = owner.sample
  for (let frame = 1; frame <= 1200; frame++) {
    const now = frame * 1000 / 120
    expect(owner.update({ ...view }, now)).toBe(initial)
    expect(owner.frame(now)).toBe(initial)
  }
  expect(owner.sample.sequence).toBe(0)
  expect(owner.active).toBe(false)
})

test('identical target updates cannot spend the preview cadence on duplicate pixels', () => {
  const owner = new NavigationZoom(camera(1)), target = camera(32, -50, 20)
  const first = owner.update(target, 0)
  for (let now = 16; now <= 160; now += 16) {
    expect(owner.update({ ...target }, now)).toBe(first)
    expect(owner.frame(now)).toBe(first)
  }
  const final = owner.frame(176)
  expect(final.active).toBe(false)
  expect(final.sequence).toBe(first.sequence + 1)
  expect(final.view).toEqual(target)
})

test('settled cameras emit neither repeated exact work nor later previews from periodic frames', () => {
  const owner = new NavigationZoom(camera(.1)), target = camera(32, -20.5, 80.25)
  owner.update(target, 0)
  owner.frame(160)
  const final = owner.frame(176)
  expect(final.active).toBe(false)
  for (let frame = 1; frame <= 1200; frame++) {
    const now = 176 + frame * 1000 / 120
    expect(owner.update({ ...target }, now)).toBe(final)
    expect(owner.frame(now)).toBe(final)
  }
  expect(owner.sample.sequence).toBe(final.sequence)
})

test.each([
  [1, 800, 600], [2, 800, 600], [3, 1920, 1080],
  [2, 3840, 2160], [1.25, 5000, 64], [.75, 640, 480],
])('temporary preview density stays bounded for DPR %s and %s by %s viewport', (dpr, width, height) => {
  const density = navigationPreviewDensity(dpr, width, height)
  expect(density).toBeGreaterThan(0)
  expect(density).toBeLessThanOrEqual(Math.min(dpr, 1))
  expect(width * height * density * density).toBeLessThanOrEqual(1_048_576 + 1e-6)
  expect(Math.max(width, height) * density).toBeLessThanOrEqual(2048 + 1e-9)
})

test('small viewports keep available density and zero layout dimensions remain finite', () => {
  expect(navigationPreviewDensity(2, 800, 600)).toBe(1)
  expect(navigationPreviewDensity(.75, 640, 480)).toBe(.75)
  expect(navigationPreviewDensity(2, 0, 0)).toBe(1)
})
