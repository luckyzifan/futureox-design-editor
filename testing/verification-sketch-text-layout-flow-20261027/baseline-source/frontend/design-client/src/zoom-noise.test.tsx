import {describe,it,expect} from 'vitest'
import {blank,node,effect,validateDocument,hasSchema19Features,validZoomBlur,type Paint} from './model'
import {noise_fill_preset_json} from './generated/design-kernel/design_kernel'
import {svgSource} from './export'
import {compositorModes} from './kernel/gpu/compositor-modes'
import type {GpuScene} from './kernel/gpu/types'
function fixture(){const doc=blank(),n=node('rectangle');n.effects=[effect('zoom-blur')];doc.schemaVersion=19;doc.nodes[n.id]=n;doc.pages[0].children=[n.id];return {doc,n}}
describe('zoom blur and image grain authoring',()=>{
  it('requires schema 19 and validates dimensionless amount and normalized focal point',()=>{
    const {doc,n}=fixture();expect(hasSchema19Features(doc)).toBe(true);expect(()=>validateDocument(doc)).not.toThrow()
    doc.schemaVersion=18;expect(()=>validateDocument(doc)).toThrow(/19/);doc.schemaVersion=19
    n.effects[0].radius=2;expect(()=>validateDocument(doc)).toThrow();n.effects[0].radius=0
    expect(validZoomBlur({amount:20,center:[.25,.75]})).toBe(true)
    expect(validZoomBlur({amount:Infinity,center:[.25,.75]})).toBe(false)
    expect(validZoomBlur({amount:20,center:[.25,.75],extra:1})).toBe(false)
  })
  it('prepares the zoom pipeline and rejects vector-only SVG without flattening the effect',()=>{
    const {doc,n}=fixture();const scene={nodes:{[n.id]:{blend:'normal',fills:[],strokes:[],effects:n.effects}}} as unknown as GpuScene
    expect(compositorModes(scene).has(62)).toBe(true);expect(()=>svgSource(doc,doc.pages[0].id)).toThrow(/缩放模糊/)
  })
  it('creates deterministic embedded grain as an ordinary editable tiled image paint',()=>{
    const {doc,n}=fixture();n.effects=[];doc.schemaVersion=14
    const p=JSON.parse(noise_fill_preset_json()) as Paint;n.fills=[p]
    expect(p.kind).toBe('image');expect(p.image).toMatch(/^data:image\/png;base64,/)
    expect(p.tile?.mode).toBe('grid');expect(JSON.parse(noise_fill_preset_json())).toEqual(p)
    expect(()=>validateDocument(doc)).not.toThrow()
    p.opacity=.4;p.tile!.size=[128,128];expect(()=>validateDocument(doc)).not.toThrow()
  })
})
