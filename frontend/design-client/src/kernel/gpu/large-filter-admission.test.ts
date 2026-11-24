import { afterEach, expect, test, vi } from 'vitest'
import { TexturePrefix } from './texture-prefix'
import { parameters } from './types'
import { sceneIndex } from './scene-index'

const prefix = Object.create(TexturePrefix.prototype) as TexturePrefix
const texture = (width: number, height: number) => ({ width, height, format: 'rgba32float' }) as GPUTexture
afterEach(()=>vi.unstubAllEnvs())

test('fractional high-zoom filters admit an exact crop inside their full source support', () => {
  const source = { x: -1200, y: 37, w: 3072, h: 64 }
  const output = { x: 28, y: 37, w: 514, h: 64 }
  const u = parameters(output, source)
  u[16] = 22; u.set([1224.3035888671875, 0, 0, 1], 36)
  expect(prefix.canEncode(texture(output.w, output.h), [texture(source.w, source.h), texture(1, 1), texture(1, 1)],
    u, 1224.3035888671875, 'tent', output)).toBe(true)
  // A support gap must decline, not read an unrelated source texel.
  expect(prefix.canEncode(texture(output.w, output.h), [texture(source.w, source.h), texture(1, 1), texture(1, 1)],
    u, 1224.3035888671875, 'tent', { ...output, x: -1201 })).toBe(false)
})

test('clamped and unsupported kernels keep the established exact fallback', () => {
  const r = { x: 0, y: 0, w: 64, h: 64 }, u = parameters(r, r)
  u[16] = 22; u.set([64, 1, 1, 1], 36)
  const inputs = [texture(64, 64), texture(1, 1), texture(1, 1)]
  expect(prefix.canEncode(texture(64, 64), inputs, u, 64, 'tent', r)).toBe(false)
  u[38] = 0
  expect(prefix.canEncode(texture(64, 64), inputs, u, 2048.5, 'tent', r)).toBe(false)
  expect(prefix.canEncode(texture(64, 64), inputs, u, 64, 'box', r)).toBe(false)
  expect(prefix.canEncode(texture(64, 64), inputs, u, NaN, 'tent', r)).toBe(false)
})

test('optional Gaussian box markers widen only the flag-on uniform-box admission', () => {
  const r = { x: 0, y: 0, w: 64, h: 64 }, u = parameters(r, r)
  u[16] = 22; u.set([64, 0, 0, 2], 36)
  const inputs = [texture(64, 64), texture(1, 1), texture(1, 1)]
  const eligible = () => prefix.canEncode(texture(64, 64), inputs, u, 64, 'box', r)
  // Default off keeps the policy-3-only admission; policy 2 and 1 stay per-tap.
  expect(eligible()).toBe(false)
  vi.stubEnv('VITE_DESIGN_EXACT_GAUSSIAN_BOX_PREFIX', '1')
  expect(eligible()).toBe(true)
  u[39] = 1
  expect(eligible()).toBe(true)
  // The non-uniform small-Gaussian marker and an unknown marker are never
  // admitted by the optional box widening. The driver keeps the clamp-edge
  // (u[38]) and live-kernel guards before it reaches this admission.
  u[39] = 4
  expect(eligible()).toBe(false)
  u[39] = 0
  expect(eligible()).toBe(false)
})

test('a fractional large blur prepares its accelerated filter before drawing', () => {
  const node = { id: 'blur', matrix: [128, 0, 0, 128, 0, 0], children: [], fills: [], strokes: [],
    effects: [{ kind: 'blur', visible: true, radius: 9.564871788024902 }] }
  expect(sceneIndex({ roots: ['blur'], nodes: { blur: node } } as any).hasPrefixFilter).toBe(true)
  const shadow = { ...node, effects: [{ ...node.effects[0], kind: 'shadow', radius: 15 }] }
  expect(sceneIndex({ roots: ['blur'], nodes: { blur: shadow } } as any).hasPrefixFilter).toBe(true)
})
test('the exact clamp candidate prepares background prefix only under its explicit gate', () => {
  const makeScene=()=>({roots:['background'],nodes:{background:{id:'background',matrix:[64,0,0,64,0,0],children:[],fills:[],strokes:[],
    effects:[{kind:'background-blur',visible:true,radius:18.39398193359375}]}}} as any)
  for(const value of [undefined,'0','true']){
    vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX',value)
    expect(sceneIndex(makeScene()).hasPrefixFilter).toBe(false)
  }
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX','1')
  expect(sceneIndex(makeScene()).hasPrefixFilter).toBe(true)
})
