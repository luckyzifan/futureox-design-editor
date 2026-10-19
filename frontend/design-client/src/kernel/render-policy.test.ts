// Standalone Node tests: no Vitest config/setup, WASM, browser, graphics driver,
// presenter, or adapter stub is imported or executed by this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  allowsColorPresentation,
  allowsResidentSdr,
  allowsInteractionWindow,
  createRenderPolicy,
  effectiveBackend,
  hostRenderPolicy,
  pinRenderPolicy,
  rasterCandidates,
  requiresFloatCompositing,
  usesCanvasDisplayFilters,
  usesTransientDisplayFilters,
  usesDisplayArithmetic,
  canvasSamplingProfile,
} from './render-policy.ts'

test('exact desktop arithmetic is independent of same-device SDR presentation', () => {
  const desktop = hostRenderPolicy(true, false)
  assert.equal(desktop.desktopFullMath, true)
  assert.equal(allowsResidentSdr(desktop), true)
  assert.equal(allowsResidentSdr(desktop, 'webgpu'), true)
  assert.equal(allowsResidentSdr(desktop, 'webgl2'), false)
  assert.equal(allowsResidentSdr(desktop, 'cpu'), false)
  assert.equal(allowsResidentSdr(hostRenderPolicy(true, true)), false)
  assert.equal(allowsResidentSdr(createRenderPolicy(false, true)), false)
  assert.equal(canvasSamplingProfile(desktop, 'figma', 'webgpu', true), 'figma')
  assert.equal(usesDisplayArithmetic(desktop, { renderIntent: 'canvas' }), false)
  assert.equal(usesTransientDisplayFilters(desktop, { renderIntent: 'preview' }), false)
})
test('HQ resolve and pixel-preview never consume an unconverted interaction window',()=>{
  assert.equal(allowsInteractionWindow(true,{}),true)
  assert.equal(allowsInteractionWindow(false,{}),false)
  assert.equal(allowsInteractionWindow(true,{resolve:{scale:.5}}),false)
  assert.equal(allowsInteractionWindow(true,{presentation:{scale:2}}),false)
})

const cpu = createRenderPolicy(true)
const normal = createRenderPolicy(false)

test('native display arithmetic cannot leak into exact, HDR, software or desktop output', () => {
  assert.equal(usesDisplayArithmetic(normal, { renderIntent: 'canvas' }), true)
  assert.equal(usesDisplayArithmetic(normal, { renderIntent: 'preview', readback: true }), true)
  for (const request of [{}, { renderIntent: 'settled' }, { renderIntent: 'canvas', readback: true },
    { renderIntent: 'preview', png: true }, { renderIntent: 'preview', pixelPreview: 1 },
    { renderIntent: 'preview', exportRegion: {} }, { renderIntent: 'preview', exportFormat: 'pdf' },
    { renderIntent: 'preview', rasterProfile: 'figmaSoftware' }]) assert.equal(usesDisplayArithmetic(normal, request), false)
  for (const policy of [cpu, createRenderPolicy(false, true), hostRenderPolicy(true, false)])
    assert.equal(usesDisplayArithmetic(policy, { renderIntent: 'preview' }), false)
})

test('byte transport keeps explicitly transient filters while reference/export contracts remain exact', () => {
  assert.equal(usesTransientDisplayFilters(normal, { renderIntent: 'preview', readback: true }), true)
  for (const request of [{ renderIntent: 'settled' }, { renderIntent: 'canvas', readback: true },
    { renderIntent: 'preview', png: true }, { renderIntent: 'preview', exportFormat: 'pdf' },
    { renderIntent: 'preview', exportRegion: {} }, { renderIntent: 'preview', pixelPreview: 1 }])
    assert.equal(usesTransientDisplayFilters(normal, request), false)
  for (const policy of [cpu, createRenderPolicy(false, true), createRenderPolicy(false, false, false, false, true)])
    assert.equal(usesTransientDisplayFilters(policy, { renderIntent: 'preview' }), false)
})

test('web canvas uses screen AA without mutating export, CPU, software or HDR profiles', () => {
  assert.equal(canvasSamplingProfile(normal, 'figma', 'webgpu', true), 'figmaSubpixel')
  assert.equal(canvasSamplingProfile(normal, 'figma', 'webgl2', true), 'figmaSubpixel')
  for (const profile of ['analytic', 'figmaSubpixel', 'figmaSoftware'] as const)
    assert.equal(canvasSamplingProfile(normal, profile, 'webgpu', true), profile)
  assert.equal(canvasSamplingProfile(normal, 'figma', 'cpu', true), 'figma')
  assert.equal(canvasSamplingProfile(normal, 'figma', 'webgpu', false), 'figma')
  assert.equal(canvasSamplingProfile(normal, 'figma', 'webgpu', true, 1), 'figma')
  for (const policy of [cpu, hostRenderPolicy(true, false), createRenderPolicy(false, true)])
    assert.equal(canvasSamplingProfile(policy, 'figma', 'webgpu', true), 'figma')
})

test('canvas filters cannot affect exact reads, exports, pixel preview or desktop math', () => {
  const request = { renderIntent: 'canvas' }
  assert.equal(usesCanvasDisplayFilters(normal, request), true)
  for (const change of [{ renderIntent: 'settled' }, { renderIntent: 'preview' }, { png: true },
    { readback: true }, { exportFormat: 'png' }, { exportRegion: {} }, { pixelPreview: 1 }])
    assert.equal(usesCanvasDisplayFilters(normal, { ...request, ...change }), false)
  assert.equal(usesCanvasDisplayFilters(cpu, request), false)
  assert.equal(usesCanvasDisplayFilters(createRenderPolicy(false, true), request), false)
  assert.equal(usesCanvasDisplayFilters(hostRenderPolicy(true, false), request), false)
})

test('strict launch policy is an immutable value', () => {
  assert.equal(Object.isFrozen(cpu), true)
  assert.throws(() => Object.assign(cpu, { cpuOnly: false }), TypeError)
  assert.equal(cpu.cpuOnly, true)
})

test('strict policy overrides every persisted or per-render backend preference', () => {
  for (const preference of ['auto', 'webgpu', 'webgl2', 'cpu', undefined, null, 'invalid']) {
    assert.equal(effectiveBackend(cpu, preference), 'cpu')
    assert.deepEqual(rasterCandidates(cpu, preference), [])
  }
})

test('CPU selection bypasses color presentation independently of launch policy', () => {
  for (const backend of ['auto', 'webgpu', 'webgl2', 'cpu'] as const)
    assert.equal(allowsColorPresentation(cpu, backend), false)
  assert.equal(allowsColorPresentation(normal, 'cpu'), false)
})

test('normal product auto remains GPU preferred in its established fallback order', () => {
  assert.equal(effectiveBackend(normal, undefined), 'auto')
  assert.deepEqual(rasterCandidates(normal, 'auto'), ['webgpu', 'webgl2'])
  assert.deepEqual(rasterCandidates(normal, 'webgpu'), ['webgpu'])
  assert.deepEqual(rasterCandidates(normal, 'webgl2'), ['webgl2'])
  assert.equal(allowsColorPresentation(normal, 'auto'), true)
})

test('PNG is CPU regardless of launch policy or preference', () => {
  for (const policy of [cpu, normal])
    for (const backend of ['auto', 'webgpu', 'webgl2', 'cpu']) {
      assert.equal(effectiveBackend(policy, backend, true), 'cpu')
      assert.deepEqual(rasterCandidates(policy, backend, true), [])
    }
})

test('worker pins and freezes a copy rather than trusting mutable cloned data', () => {
  const envelope = { cpuOnly: true }
  const pinned = pinRenderPolicy(undefined, envelope)
  envelope.cpuOnly = false
  assert.equal(pinned.cpuOnly, true)
  assert.equal(Object.isFrozen(pinned), true)
  assert.equal(pinRenderPolicy(pinned, { cpuOnly: true }), pinned)
})

test('worker preserves the desktop full-math contract and rejects changing it', () => {
  const desktop = hostRenderPolicy(true, false)
  const pinned = pinRenderPolicy(undefined, desktop)
  assert.equal(pinned.desktopFullMath, true)
  assert.throws(() => pinRenderPolicy(pinned, { ...desktop, desktopFullMath: false }), /cannot change/)
})

test('worker rejects policy changes in either direction and never relaxes strict CPU', () => {
  assert.throws(() => pinRenderPolicy(cpu, { cpuOnly: false }), /cannot change/)
  assert.throws(() => pinRenderPolicy(normal, { cpuOnly: true }), /cannot change/)
})

test('missing or malformed worker policy fails closed before rendering', () => {
  for (const value of [undefined, null, {}, true, 'cpu', { cpuOnly: 'true' }, { cpuOnly: 1 }]) {
    assert.throws(() => pinRenderPolicy(undefined, value), /invalid/)
    assert.throws(() => pinRenderPolicy(cpu, value), /invalid/)
  }
})

test('policy has no imports or ambient capability access', () => {
  const source = readFileSync(new URL('./render-policy.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import\s/m)
  assert.doesNotMatch(source, /\b(?:navigator|window|localStorage|requestAdapter|requestDevice)\s*\./)
})

test('presentation source has one guarded lazy presenter construction and closes bitmaps', () => {
  // Static boundary evidence only: never evaluate Surface or a GPU helper.
  const source = readFileSync(new URL('./Surface.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /import\s+\{[^}]*ColorPresenter[^}]*\}\s+from/)
  assert.equal(source.match(/ColorPresenter\.create\(/g)?.length, 1)
  const guard = source.indexOf('!allowsColorPresentation(renderExecutionPolicy, request.presentationBackend)')
  const lazy = source.indexOf("await import('./color-presenter')")
  const create = source.indexOf('await ColorPresenter.create(')
  assert.ok(guard >= 0 && guard < lazy && lazy < create)
  assert.match(source, /if \(!current\(\)\) created\.dispose\(\)/)
  assert.match(source, /finally\s*\{\s*bitmap\?\.close\(\)/)
  assert.match(source, /colorSpace: 'srgb'/)
})

test('worker source pins policy before commands and only loads drivers in the candidate loop', () => {
  // Read only the worker text; its imports and WASM are never executed.
  const source = readFileSync(new URL('./render-worker.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /import\s+\{[^}]*createGpu[^}]*\}\s+from/)
  assert.ok(source.indexOf('pinRenderPolicy(executionPolicy, request.executionPolicy)') <
    source.indexOf("request.command === 'lose-device'"))
  assert.ok(source.indexOf('for (const backend of candidates)') <
    source.indexOf("await import('./gpu/factory')"))
  assert.match(source, /rasterCandidates\(executionPolicy, preference, request.png\)/)
  assert.match(source, /linearBuffer: displayLinear\?\.buffer/)
})

test('absent web host stays normal; a present malformed desktop host fails safely to CPU', () => {
  assert.equal(hostRenderPolicy(false, undefined).cpuOnly, false)
  assert.equal(hostRenderPolicy(true, false).cpuOnly, false)
  assert.equal(hostRenderPolicy(true, true).cpuOnly, true)
  for (const value of [undefined, null, 'false', 0, {}])
    assert.equal(hostRenderPolicy(true, value).cpuOnly, true)
})

test('managed document computation stays linear independently of the HDR display preference', () => {
  const managed = { colorManagement: { documentSpace: 'display-p3' }, floatCompositing: true }
  assert.equal(requiresFloatCompositing(normal, managed), true)
  assert.equal(requiresFloatCompositing(cpu, managed), true)
  assert.equal(requiresFloatCompositing(createRenderPolicy(false, true), managed), true)
  assert.equal(requiresFloatCompositing(normal, { floatCompositing: true }), true)
  assert.equal(requiresFloatCompositing(createRenderPolicy(false, true), { floatCompositing: true }), true)
  assert.equal(requiresFloatCompositing(normal, { floatCompositing: false }), false)
})
