import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { admitSketchPreview } from '../src/sketch-preview-contract.mjs'
// Real production Rust inspect/sketch-render output, including 2/16-stop boundaries.
const frames = JSON.parse(readFileSync(new URL('./fixtures/sketch-alpha-gradient-frames.json', import.meta.url), 'utf8'))
const admit = frame => admitSketchPreview(JSON.stringify(frame), frames[0].owner)
test('real axis-aligned alpha-only gradients admit; stop/color/transform/fixed-program corruption fails closed', () => {
  assert.equal(frames.length, 6)
  for (const frame of frames) assert.equal(admit(frame).scene.nodes.R.fills[0].kind, 'linear')
  assert.equal(frames[4].scene.nodes.R.fills[0].stops.length, 2)
  assert.equal(frames[5].scene.nodes.R.fills[0].stops.length, 16)
  const solid = JSON.parse(readFileSync(new URL('./fixtures/sketch-preview-frame.json', import.meta.url), 'utf8'))
  assert.equal(admitSketchPreview(JSON.stringify(solid), solid.owner).scene.nodes.R.fills[0].kind, 'solid')
  for (const [label, mutate] of [
    ['radial', p => { p.kind = 'radial' }],
    ['one stop', p => { p.stops.length = 1 }],
    ['17 stops', p => { p.stops = Array.from({ length: 17 }, (_, i) => ({ ...p.stops[0], offset: i / 16 })) }],
    ['duplicate offset', p => { p.stops[1].offset = p.stops[0].offset }],
    ['unsorted', p => { p.stops.reverse() }],
    ['nonfinite offset', p => { p.stops[1].offset = Infinity }],
    ['negative offset', p => { p.stops[0].offset = -0.1 }],
    ['offset above one', p => { p.stops[2].offset = 1.1 }],
    ['missing managed color', p => { p.stops[1].color = '#123456' }],
    ['different RGB', (p, f) => { f.scene.colors[p.stops[1].color][0] = 0.3 }],
    ['invalid alpha', (p, f) => { f.scene.colors[p.stops[1].color][3] = 1.1 }],
    ['invalid numeric RGB', (p, f) => { f.scene.colors[p.stops[1].color][0] = NaN }],
    ['wrong paint base', p => { p.color = p.stops[1].color }],
    ['constant shortcut', p => { p.constantColor = p.color }],
    ['extra gradient plane', p => { p.gradientPlane = [1, 0, 0] }],
    ['extra stop semantics', p => { p.stops[0].interpolation = 'custom' }],
    ['diagonal', p => { p.transform = [1, 1, -1, 1, 0, 0] }],
    ['degenerate', p => { p.transform = [0, 0, 0, 0, 0, 0] }],
    ['near singular', p => { p.transform = [1e-8, 0, 0, 1e-8, 0, 0] }],
    ['noncanonical transform', p => { p.transform[2] = 0.2 }],
    ['nonnormalized endpoints', p => { p.transform[4] = 0.1 }],
    ['NaN transform', p => { p.transform[4] = NaN }],
    ['zero node size', (p, f) => { f.scene.nodes.R.size[0] = 0 }],
    ['inconsistent node inverse', (p, f) => { f.scene.nodes.R.inverse[4] = 1 }],
    ['missing fixed program', p => { delete p.fixedGradient }],
    ['low fixed precision', p => { p.fixedGradient.bits = 23 }],
    ['high fixed precision', p => { p.fixedGradient.bits = 53 }],
    ['fractional bits', p => { p.fixedGradient.bits = 30.5 }],
    ['wrong word count', p => { p.fixedGradient.words[0].pop() }],
    ['word above u16', p => { p.fixedGradient.words[0][0] = 65536 }],
    ['fractional word', p => { p.fixedGradient.words[0][0] = 1.5 }],
    ['integer overflow budget', p => { p.fixedGradient.words[0] = [65535, 65535, 65535, 32767] }],
    ['altered fixed coefficient', p => { p.fixedGradient.words[0][0] ^= 1 }],
    ['external image', p => { p.image = 'https://example.invalid/image' }],
    ['extra effect', (p, f) => { f.scene.nodes.R.effects.push({ type: 'blur' }) }],
  ]) {
    const frame = structuredClone(frames[0]); mutate(frame.scene.nodes.R.fills[0], frame)
    assert.throws(() => admit(frame), label)
  }
})
