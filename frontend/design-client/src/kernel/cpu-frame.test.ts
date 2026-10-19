import { expect, test } from 'vitest'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../model'
import { renderCpuFrame } from './cpu-frame'

test('JSON null enables actual CPU tile reuse without changing aligned frame pixels', () => {
  const doc = blank(), shape = node('rectangle', 12, 17, 22, 19)
  shape.fills = [paint('#3284ee')]; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    expect(engine.color_settings()).toBe('null')
    let assemblies = 0, fullFrames = 0
    const traced = {
      color_settings: () => engine.color_settings(),
      render_rgba: (s: string) => { fullFrames++; return engine.render_rgba(s) },
      assemble_tiled_rgba: (s: string, damage: string) => { assemblies++; return engine.assemble_tiled_rgba(s, damage) },
    }
    const options = { pageId: doc.pages[0].id, width: 64, height: 64, transparent: false,
      view: { x: 0, y: 0, zoom: 1 }, rasterProfile: 'analytic' }
    const raw = JSON.stringify(options), reference = engine.render_rgba(raw)
    expect(renderCpuFrame(traced, raw, undefined)).toEqual(reference)
    expect(renderCpuFrame(traced, raw, { full: false })).toEqual(reference)
    expect(assemblies).toBe(2); expect(fullFrames).toBe(0)
    for (const view of [{ x: 0.25, y: 0.75, zoom: 1 }, { x: 0, y: 0, zoom: 0.7639 }]) {
      const fractional = JSON.stringify({ ...options, view })
      expect(renderCpuFrame(traced, fractional, { full: false })).toEqual(engine.render_rgba(fractional))
    }
    expect(assemblies).toBe(2); expect(fullFrames).toBe(2)
    doc.schemaVersion = 3
    doc.rasterProfile = 'figma'
    doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
    engine.load_document(JSON.stringify(doc))
    const managed = JSON.stringify({ ...options, rasterProfile: 'figma' })
    expect(renderCpuFrame(traced, managed, { full: false })).toEqual(engine.render_rgba(managed))
    expect(assemblies).toBe(2); expect(fullFrames).toBe(3)
  } finally { engine.free() }
})
