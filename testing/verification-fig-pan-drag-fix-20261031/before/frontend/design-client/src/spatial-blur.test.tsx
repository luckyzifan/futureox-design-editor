import {describe,it,expect} from 'vitest'
import {blank,node,effect,hasSchema18Features,validateDocument} from './model'
import {svgSource} from './export'
import {compositorModes} from './kernel/gpu/compositor-modes'
import type {GpuScene} from './kernel/gpu/types'
function fixture() {
  const doc=blank(),n=node('rectangle');doc.schemaVersion=18;n.effects=[effect('motion-blur')]
  n.effects[0].motionAngle=37.5;doc.nodes[n.id]=n;doc.pages[0].children=[n.id];return {doc,n}
}
describe('spatial blur contract',()=>{
  it('preserves angle under schema 18 and rejects older or invalid contracts',()=>{
    const {doc,n}=fixture();expect(hasSchema18Features(doc)).toBe(true);expect(()=>validateDocument(doc)).not.toThrow()
    doc.schemaVersion=17;expect(()=>validateDocument(doc)).toThrow(/18/);doc.schemaVersion=18
    n.effects[0].motionAngle=NaN;expect(()=>validateDocument(doc)).toThrow()
    n.effects[0].motionAngle=37.5;n.effects[0].kind='blur';expect(()=>validateDocument(doc)).toThrow()
  })
  it('prepares the motion pipeline and explicitly rejects unsupported vector SVG in scope',()=>{
    const {doc,n}=fixture();const scene={nodes:{[n.id]:{blend:'normal',fills:[],strokes:[],effects:n.effects}}} as unknown as GpuScene
    expect(compositorModes(scene).has(61)).toBe(true)
    expect(()=>svgSource(doc,doc.pages[0].id)).toThrow(/运动模糊/)
    const other=node('rectangle');doc.nodes[other.id]=other;doc.pages[0].children.push(other.id)
    expect(()=>svgSource(doc,doc.pages[0].id,{kind:'selection',nodeIds:[other.id]})).not.toThrow()
  })
  it('keeps explicit sigma separate from existing blur in vector output',()=>{
    const {doc,n}=fixture();n.effects=[effect('gaussian-blur')];n.effects[0].radius=3.25
    expect(svgSource(doc,doc.pages[0].id).source).toContain('stdDeviation="3.25"')
    n.effects[0].kind='blur';expect(svgSource(doc,doc.pages[0].id).source).toContain('stdDeviation="1.625"')
  })
})
