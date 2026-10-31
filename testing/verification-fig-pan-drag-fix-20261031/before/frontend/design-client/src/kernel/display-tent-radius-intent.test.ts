import { expect, test } from 'vitest'
import { hostRenderPolicy, createRenderPolicy } from './render-policy'
import { stampDisplayTentRadius, usesDisplayTentRadiusIntent } from './display-tent-radius-intent'

const desktop = hostRenderPolicy(true, false, false, false, false, true)
const request = { renderIntent: 'canvas', rasterProfile: 'figmaSubpixel' }
test('only both strict launch flags and the pinned desktop display capability grant intent', () => {
  for (const flag of [undefined, null, false, true, 0, 1, '', '0', 'true']) {
    expect(usesDisplayTentRadiusIntent(flag, '1', desktop, request)).toBe(false)
    expect(usesDisplayTentRadiusIntent('1', flag, desktop, request)).toBe(false)
  }
  expect(usesDisplayTentRadiusIntent('1', '1', desktop, request)).toBe(true)
  expect(usesDisplayTentRadiusIntent('1', '1', desktop, { ...request, renderIntent: 'preview' })).toBe(true)
  for (const policy of [createRenderPolicy(false), hostRenderPolicy(true, false),
    hostRenderPolicy(true, true, false, false, false, true), hostRenderPolicy(true, false, true, false, false, true)])
    expect(usesDisplayTentRadiusIntent('1', '1', policy, request)).toBe(false)
})
test.each([{ readback: true }, { png: true }, { exportFormat: 'png' }, { exportRegion: {} }, { pixelPreview: 1 },
  { rasterProfile: 'figmaSoftware' }, { renderIntent: 'export' }, { renderIntent: 'settled' }])(
  'explicit exact output keeps the original radius despite spoofed scene intent: %j', change => {
    const intent = usesDisplayTentRadiusIntent('1', '1', desktop, { ...request, ...change })
    const scene = { displayTentRadius: true }
    stampDisplayTentRadius(scene, intent, 'webgpu')
    expect(scene.displayTentRadius).toBe(false)
  },
)
test('backend resolution and software rejection overwrite reused scene flags, including auto fallback', () => {
  for (const backend of ['cpu', 'webgl2', 'auto', undefined]) {
    const scene = { displayTentRadius: true }
    stampDisplayTentRadius(scene, true, backend); expect(scene.displayTentRadius).toBe(false)
  }
  const scene = { displayTentRadius: true, softwareRaster: true }
  stampDisplayTentRadius(scene, true, 'webgpu'); expect(scene.displayTentRadius).toBe(false)
  stampDisplayTentRadius(scene, true, 'webgl2'); expect(scene.displayTentRadius).toBe(false)
  const resolved = { displayTentRadius: false }
  stampDisplayTentRadius(resolved, true, 'webgpu'); expect(resolved.displayTentRadius).toBe(true)
  stampDisplayTentRadius(resolved, false, 'webgpu'); expect(resolved.displayTentRadius).toBe(false)
})
