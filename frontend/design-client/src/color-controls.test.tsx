import { describe, expect, it } from 'vitest'
import { blank, node, effect, validateDocument, validColorControls, hasSchema17Features } from './model'
import { svgSource } from './export'
import { backdropEffect } from './kernel/render-dependency'
import { compositorModes } from './kernel/gpu/compositor-modes'
import type { GpuScene } from './kernel/gpu/types'

function fixture() {
  const doc = blank(), n = node('rectangle')
  n.effects = [effect('color-controls')]
  n.effects[0].colorControls!.saturation = 0
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  doc.schemaVersion = 17
  return {doc,n}
}
describe('canvas color controls', () => {
  it('requires actual parameters and a schema that preserves them', () => {
    const {doc,n}=fixture()
    expect(hasSchema17Features(doc)).toBe(true)
    expect(() => validateDocument(doc)).not.toThrow()
    doc.schemaVersion=16
    expect(() => validateDocument(doc)).toThrow(/17/)
    doc.schemaVersion=17
    delete n.effects[0].colorControls
    expect(() => validateDocument(doc)).toThrow()
  })
  it('rejects invalid and unknown parameter fields', () => {
    expect(validColorControls({brightness:0,contrast:1,saturation:0,hue:0})).toBe(true)
    expect(validColorControls({brightness:0,contrast:1,saturation:0,hue:NaN})).toBe(false)
    expect(validColorControls({brightness:0,contrast:1,saturation:0,hue:0,extra:true})).toBe(false)
  })
  it('exports the authoritative matrix in the authored color domain', () => {
    const {doc}=fixture()
    const {source}=svgSource(doc,doc.pages[0].id)
    expect(source).toContain('feColorMatrix')
    expect(source).toContain('color-interpolation-filters="sRGB"')
    expect(source).toContain('0.21250000596046448')
  })
  it('keeps an omitted control domain in encoded sRGB instead of SVG linearRGB', () => {
    const {doc,n}=fixture(); delete n.effects[0].colorControls!.space
    const {source}=svgSource(doc,doc.pages[0].id)
    expect(source).toContain('color-interpolation-filters="sRGB"')
    expect(source).not.toContain('linearRGB')
    expect(source).toContain('color-interpolation="sRGB"')
  })
  it('does not silently flatten a Display-P3 control domain into SVG sRGB', () => {
    const {doc,n}=fixture();n.effects[0].colorControls!.space='display-p3'
    expect(() => svgSource(doc,doc.pages[0].id)).toThrow(/Display-P3/)
  })
  it('captures the backdrop when only saturation changes', () => {
    const fx=effect('background-blur');fx.radius=0
    fx.colorControls={brightness:0,contrast:1,saturation:0,hue:0}
    expect(backdropEffect([fx])).toBe(fx)
    fx.colorControls.saturation=1
    expect(backdropEffect([fx])).toBeUndefined()
  })
  it('prepares the color pipeline before a browser frame can use it', () => {
    const {n}=fixture()
    const scene={nodes:{[n.id]:{blend:'normal',fills:[],strokes:[],effects:n.effects}}} as unknown as GpuScene
    expect(compositorModes(scene).has(60)).toBe(true)
    n.effects[0].visible=false
    expect(compositorModes(scene).has(60)).toBe(false)
  })
})
