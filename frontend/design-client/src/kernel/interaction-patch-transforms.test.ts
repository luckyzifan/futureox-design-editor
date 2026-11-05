import { expect, test } from 'vitest'
import { blank, effect, node, paint, stroke, type Matrix } from '../model'
import { applyDocumentPatch, type DocumentPatch } from '../document-patch'
import { interactionPatchTransforms, isInnerShadowPosePatch } from './interaction-patch-transforms'

test('pose admission compares normalized authored paints and still rejects actual edits', () => {
  const before=blank(), path=node('vector',0,0,32,32), id=path.id
  path.fills=[paint('#3388ff')]
  path.strokes=[{...stroke(),visible:false}]
  path.effects=[effect('inner-shadow')]
  before.nodes[id]=path
  before.pages[0].children=[id]
  const raw={...path,transform:[0,1,-1,0,17,23] as Matrix,
    fills:path.fills.map(p=>({...p,image:null})),strokes:path.strokes.map(s=>({...s,paint:{...s.paint,image:null}}))}
  const patch={nodes:{[id]:raw},fields:{}} as unknown as DocumentPatch
  const after=applyDocumentPatch(before,patch)
  expect(interactionPatchTransforms(before,patch,[id])).toBeNull()
  expect(isInnerShadowPosePatch(before,after,patch)).toBe(true)
  raw.fills[0].color='#507090'
  expect(isInnerShadowPosePatch(before,applyDocumentPatch(before,patch),patch)).toBe(false)
  expect(isInnerShadowPosePatch(before,after,{...patch,fields:{name:'other'}})).toBe(false)
  expect(isInnerShadowPosePatch(before,after,{nodes:{[id]:null},fields:{}})).toBe(false)
})
