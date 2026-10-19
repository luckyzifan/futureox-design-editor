/** Deterministic navigation scheduling contracts. These exercise the production
 * state machine, not a browser/GPU or a claim about rendered pixel quality. */
import { expect, test } from 'vitest'
import { RenderMailbox } from './render-mailbox'
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
  expect(finals[0].at).toBeLessThanOrEqual(1000 + NAVIGATION_ZOOM_QUIET_MS + 1000 / hz + 1e-8)
  expect(finals[0].value.view).toEqual(last)
  expect(owner.sample).toBe(finals[0].value)
  expect(owner.zoom).toBe(32)
  expect(owner.active).toBe(false)
  expect(owner.frame(10_000)).toBe(finals[0].value)
})

test('80ms wheel bursts retain the conservative quiet window and two observed stable frames', () => {
  const owner = new NavigationZoom(camera(1)), log = journal(owner)
  for (let at = 0; at <= 720; at += 16) {
    if (at % 80 === 0) log.record(at, owner.update(camera(2 + at / 80), at))
    log.record(at, owner.frame(at))
    expect(owner.active).toBe(true)
  }
  log.record(879, owner.frame(879))
  expect(owner.active).toBe(true)
  log.record(880, owner.frame(880))
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
  for (let now = 16; now < 160; now += 16) {
    expect(owner.update({ ...target }, now)).toBe(first)
    expect(owner.frame(now)).toBe(first)
  }
  const final = owner.frame(160)
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

test.each([60, 90, 120, 144, 240])('experimental dense %i Hz zoom admits exact work within its measured quiet window', hz => {
  const owner = new NavigationZoom(camera(1), { adaptiveQuiet: true }), step = 1000 / hz
  let now = 0
  for (let index = 0; index < hz; index++) {
    now = index * step
    owner.update(camera(1 + index / hz * 31, index, -index), now)
    owner.frame(now)
    expect(owner.active).toBe(index > 0)
  }
  const lastAt = now, expected = { ...owner.sample.view }
  const finalCamera = camera(32, 127.25, -91.125)
  owner.update(finalCamera, now)
  while (owner.active && now - lastAt < 200) owner.frame(now += step)
  expect(owner.active).toBe(false)
  expect(now - lastAt).toBeLessThanOrEqual(Math.max(48, 3 * step) + step + 1e-8)
  expect(owner.sample.view).toEqual(finalCamera)
  expect(owner.sample.view).not.toEqual(expected)
})

test('experimental one isolated change and short bursts cannot learn a fast cadence', () => {
  for (const changes of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const owner = new NavigationZoom(camera(1), { adaptiveQuiet: true })
    for (let index = 0; index < changes; index++) owner.update(camera(2 + index), index * 8)
    const last = (changes - 1) * 8
    for (let elapsed = 8; elapsed < 160; elapsed += 8) {
      owner.frame(last + elapsed)
      expect(owner.active).toBe(true)
    }
    owner.frame(last + 160)
    expect(owner.active).toBe(false)
  }
})

test('experimental a recent slow interval protects irregular gestures instead of using the fastest sample', () => {
  const owner = new NavigationZoom(camera(1), { adaptiveQuiet: true })
  for (const [index, at] of [0, 8, 16, 96, 104, 112].entries()) owner.update(camera(2 + index), at)
  for (let at = 120; at < 272; at += 8) {
    owner.frame(at)
    expect(owner.active).toBe(true)
  }
  owner.frame(272)
  expect(owner.active).toBe(false)
})

test('experimental a later isolated gesture does not inherit a previous dense cadence', () => {
  const owner = new NavigationZoom(camera(1), { adaptiveQuiet: true })
  for (let index = 0; index < 20; index++) owner.update(camera(2 + index), index * 8)
  owner.frame(192); owner.frame(200)
  expect(owner.active).toBe(false)
  owner.update(camera(32), 1000)
  for (let at = 1008; at < 1160; at += 8) {
    owner.frame(at)
    expect(owner.active).toBe(true)
  }
  owner.frame(1160)
  expect(owner.active).toBe(false)
})

test('long frame suspension still needs two observed frames before exact admission', () => {
  const owner = new NavigationZoom(camera(1))
  for (let index = 0; index < 20; index++) owner.update(camera(2 + index), index * 8)
  owner.frame(1000)
  expect(owner.active).toBe(true)
  owner.frame(1016)
  expect(owner.active).toBe(false)
})

test('experimental an unexpected long gap after a dense burst starts a fresh gesture with the newest target', () => {
  const owner = new NavigationZoom(camera(1), { adaptiveQuiet: true })
  for (let index = 0; index < 20; index++) {
    owner.update(camera(2 + index), index * 8)
    owner.frame(index * 8)
  }
  for (let at = 160; at <= 200; at += 8) owner.frame(at)
  expect(owner.active).toBe(false)
  const sequence = owner.sample.sequence
  const resumed = camera(32, -53.125, 22.25)
  owner.update(resumed, 240)
  expect(owner.active).toBe(true)
  expect(owner.sample.sequence).toBe(sequence + 1)
  // The new gesture does not inherit the old fast cadence.
  for (let at = 248; at < 400; at += 8) {
    owner.frame(at)
    expect(owner.active).toBe(true)
  }
  owner.frame(400)
  expect(owner.active).toBe(false)
  expect(owner.sample.view).toEqual(resumed)
})

test('experimental pause/resume refinement keeps one running job plus the latest request and commits only the latest camera', async () => {
  const owner = new NavigationZoom(camera(.1), { adaptiveQuiet: true }), mailbox = new RenderMailbox()
  const calls: number[] = [], published: NavigationZoomSample[] = [], jobs: Promise<void>[] = []
  let release!: () => void, cancelled = 0, active = 0, peak = 0
  const submit = (sample: NavigationZoomSample, hold = false) => {
    const current = () => owner.sample === sample
    jobs.push(mailbox.run(current, async () => {
      calls.push(sample.sequence); peak = Math.max(peak, ++active)
      if (hold) await new Promise<void>(resolve => { release = resolve })
      active--
      // The production surface also rechecks current ownership before its
      // completed plan commits. A running render may retain useful world
      // pixels without publishing the obsolete camera as the final view.
      if (current()) published.push(sample)
    }).catch(error => {
      expect(String(error)).toContain('PREVIEW_CANCELLED'); cancelled++
    }))
  }
  owner.update(camera(2), 0)
  owner.frame(160); owner.frame(176)
  expect(owner.active).toBe(false)
  submit(owner.sample, true)
  await Promise.resolve()
  const first = owner.sample.sequence
  let scheduled = 1
  for (let burst = 1; burst <= 320; burst++) {
    const base = burst * 240
    for (let input = 0; input < 10; input++) {
      const before = owner.sample
      owner.update(camera(3 + input + burst / 1000, burst / 8, -burst / 16), base + input * 8)
      if (owner.sample !== before) { submit(owner.sample); scheduled++ }
    }
    for (let at = base + 80; at <= base + 120; at += 8) owner.frame(at)
    expect(owner.active).toBe(false)
    submit(owner.sample); scheduled++
  }
  const finalView = camera(32, -53.125, 22.25)
  owner.update(finalView, 200_000)
  owner.frame(200_160); owner.frame(200_176)
  submit(owner.sample); scheduled++
  await Promise.resolve(); await Promise.resolve()
  expect(cancelled).toBe(scheduled - 2)
  expect(calls).toEqual([first])
  expect(published).toEqual([])
  release()
  await Promise.all(jobs)
  expect(peak).toBe(1)
  expect(calls).toEqual([first, owner.sample.sequence])
  expect(published).toEqual([owner.sample])
  expect(published[0].active).toBe(false)
  expect(published[0].view).toEqual(finalView)
})

function shortResumeTrace(hz: number, bursts: number, changes: number, period: number, adaptiveQuiet = false) {
  const owner = new NavigationZoom(camera(1), { adaptiveQuiet }), mailbox = new RenderMailbox()
  const inputs = Array.from({ length: bursts }, (_, burst) =>
    Array.from({ length: changes }, (_, index) => ({ at: burst * period + index * 8,
      view: camera(2 + (burst * changes + index) / 100, burst + .125, -index - .25) }))).flat()
  const completed: { at: number; sample: NavigationZoomSample }[] = []
  let sequence = 0, input = 0
  const accept = async (at: number, sample: NavigationZoomSample) => {
    if (sample.sequence === sequence) return
    sequence = sample.sequence
    // Every admitted render completes before the next input. Backlog pruning
    // cannot conceal repeated completed exact refinement in this regression.
    await mailbox.run(() => owner.sample === sample, async () => { completed.push({ at, sample }) })
  }
  return (async () => {
    const end = inputs.at(-1)!.at
    for (let frame = 0; frame * 1000 / hz <= end + 400; frame++) {
      const at = frame * 1000 / hz
      while (input < inputs.length && inputs[input].at <= at + 1e-8) {
        const next = inputs[input++]
        await accept(next.at, owner.update(next.view, next.at))
      }
      await accept(at, owner.frame(at))
    }
    return { owner, completed, finalView: inputs.at(-1)!.view, end }
  })()
}

test.each([60, 120, 144])('fast-completing %i Hz renderer cannot refine once per short wheel burst', async hz => {
  const { owner, completed, finalView, end } = await shortResumeTrace(hz, 13, 5, 96)
  const exact = completed.filter(row => !row.sample.active), previews = completed.filter(row => row.sample.active)
  expect(exact).toHaveLength(1)
  expect(previews.length).toBeLessThanOrEqual(Math.ceil((end + 160) / 160) + 1)
  expect(exact.at(-1)!.sample.view).toEqual(finalView)
  expect(exact.at(-1)!.at - end).toBeGreaterThanOrEqual(160 - 1e-8)
  expect(owner.active).toBe(false)
})

test('experimental short-resume fallback cannot be forgotten by long dense bursts or ten seconds of continued input', async () => {
  for (const [bursts, changes, period] of [[101, 5, 96], [20, 20, 224]]) {
    const { completed, finalView, end } = await shortResumeTrace(120, bursts, changes, period, true)
    const exact = completed.filter(row => !row.sample.active)
    expect(exact).toHaveLength(changes === 5 ? 1 : 2)
    expect(exact.at(-1)!.at - end).toBeGreaterThanOrEqual(160 - 1e-8)
    expect(exact.at(-1)!.sample.view).toEqual(finalView)
  }
})

test('experimental mode: a genuine 160ms input gap restores fast dense settling after a short-resume fallback', async () => {
  const { owner, end } = await shortResumeTrace(120, 20, 20, 224, true)
  const start = end + 500
  for (let index = 0; index < 20; index++) {
    owner.update(camera(10 + index), start + index * 8)
    owner.frame(start + index * 8)
  }
  const last = start + 19 * 8
  for (let at = last + 8; at <= last + 48; at += 8) owner.frame(at)
  expect(owner.active).toBe(false)
  expect(owner.sample.view).toEqual(camera(29))
})

test('default conservative scheduling never enables adaptive refinement for long repeated dense bursts', async () => {
  for (const [bursts, changes, period] of [[101, 5, 96], [20, 20, 224]]) {
    const { completed, finalView, end } = await shortResumeTrace(120, bursts, changes, period)
    const exact = completed.filter(row => !row.sample.active)
    expect(exact).toHaveLength(1)
    expect(exact[0].sample.view).toEqual(finalView)
    expect(exact[0].at - end).toBeGreaterThanOrEqual(160 - 1e-8)
  }
})
