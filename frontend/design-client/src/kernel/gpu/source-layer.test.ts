import { describe, expect, it } from 'vitest'
import { radialCorners, sourceLayer } from './source-layer'
import type { GpuNode, GpuPaint } from './types'
import { sourceBitmapDimensions } from '../image-row-source'

const bounds = { x: 0, y: 0, w: 10, h: 10 }
function fixture(): GpuNode {
  return {
    id: 'shape', rect: bounds, size: [10,10], matrix: [1,0,0,1,0,0], inverse: [1,0,0,1,0,0],
    fill: { count: 6, area: { first: 0, count: 7 }, rect: bounds, sampleCount: 4 },
    fills: [{ kind: 'solid', color: '#ffffff', opacity: .75, visible: true, blend: 'normal', stops: [] }],
    strokes: [], effects: [], children: [], opacity: 1, blend: 'normal',
  } as unknown as GpuNode
}
const colour = () => [1,1,1,1]
describe('source layer programs', () => {
  it('requires a bound native program or certified opaque coverage for each mask', () => {
    const n=fixture()
    expect(sourceLayer(n,()=>undefined,colour)).toBeUndefined()
    const program=sourceLayer(n,()=>17,colour)!
    expect(program.data.map(row=>row[0])).toEqual([0,1,2,3])
    expect(program.data[0][12]).toBe(17)
    n.fill.opaqueRect=bounds
    expect(sourceLayer(n,()=>undefined,colour)!.data[0][12]).toBe(-2)
    n.mask=true
    expect(sourceLayer(n,()=>17,colour)).toBeUndefined()
  })
  it('preserves the CPU integer-offset decision when a fractional shadow rounds to a float integer', () => {
    const n=fixture()
    n.effects=[{kind:'shadow',visible:true,radius:0,spread:0,x:1+1e-9,y:0,color:'#ffffff',opacity:1} as GpuNode['effects'][number]]
    const words=sourceLayer(n,()=>0,colour)!.data[0],effects=(words[2]-5)*4
    expect(words[effects+1]).toBe(1)
    expect(words[effects+3]).toBe(0)
    n.effects[0].x=1
    expect(sourceLayer(n,()=>0,colour)!.data[0][effects+3]).toBe(-1)
  })
  it('computes unclamped radial coordinates for the four original coverage phases', () => {
    const n=fixture(),paint={kind:'radial'} as GpuPaint
    const values=radialCorners(n,paint,0)!
    expect(values[0]).toBeCloseTo(2*(.375/10-.5))
    expect(values[7]).toBeCloseTo(2*(9.125/10-.5))
    expect(radialCorners(n,{...paint,transform:[0,0,0,0,0,0]},0)).toBeUndefined()
  })
  it('admits two brushes exactly at the remaining uniform budget',()=>{
    const n=fixture()
    const stops=Array.from({length:5},(_,i)=>({offset:i/4,color:String(i)}))
    const brush={...n.fills[0],kind:'radial' as const,stops}
    n.fills=[brush,brush]
    const color=(s:string)=>[Number(s)/4,0,0,1]
    const program=sourceLayer(n,()=>17,color)!
    for(const [i,words] of program.data.entries()){
      expect(words[0]).toBe(i)
      expect(words.length).toBe(128)
      for(const at of [16,72]){
        expect(Array.from({length:5},(_,j)=>words[at+16+8*j])).toEqual([0,.25,.5,.75,1])
        expect(words[at+16+4*8+4]).toBe(1)
      }
    }
    expect(sourceLayer(n,()=>17,color,128)).toBeDefined()
    expect(sourceLayer(n,()=>17,color,127)).toBeUndefined()
  })
  it('only treats bounded JPEG frame headers as dimension hints', () => {
    const enc=(bytes:number[])=>'data:image/jpeg;base64,'+btoa(String.fromCharCode(...bytes))
    expect(sourceBitmapDimensions(enc([255,216,255,224,0,4,0,0,255,194,0,8,8,0,19,1,1,3]))).toEqual([257,19])
    expect(sourceBitmapDimensions(enc([255,216,255,194,0,12,8,0,19]))).toBeUndefined()
  })
})
