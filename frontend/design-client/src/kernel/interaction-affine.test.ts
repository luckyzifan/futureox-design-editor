import { expect, test } from 'vitest'
import { blank, node, type Matrix } from '../model'
import { apply, multiply } from '../geometry'
import { documentPatch } from '../document-patch'
import { interactionPatchedDocument, interactionPatchedTransforms, interactionAffineEligible, interactionPoseMatrices, interactionOffsets } from './interaction-layers'
import { interactionPatchTransforms } from './interaction-patch-transforms'
import { residentOverlayAffines } from './gpu/resident-affine-pose'
import { transformOverlay } from './gpu/canvas-overlay'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { decodeScenePacket } from './gpu/scene-packet'

function fixture() {
  const document = blank(), parent = node('frame', 30, 25, 150, 120), selected = node('rectangle', 10, 15, 30, 20)
  parent.transform = [0, 1.5, -1.5, 0, 180, 20]; parent.clip = false; parent.blend = 'normal'; parent.children = [selected.id]
  document.nodes[parent.id] = parent; document.nodes[selected.id] = selected; document.pages[0].children = [parent.id]
  const plan = { document, pageId: document.pages[0].id, ids: [selected.id], layers: [] }
  return { document, parent, selected, plan }
}

test('absolute affine patches are admitted without making the bitmap translation path affine', () => {
  const f = fixture(), transform: Matrix = [0, 1, -1, 0, 50, 15], patch = { [f.selected.id]: { transform } }
  const next = interactionPatchedDocument(f.document, patch)
  expect(interactionOffsets(f.plan, next)).toBeNull()
  expect(interactionPatchedTransforms(f.plan, f.document, patch)).toEqual({ [f.selected.id]: transform })
  expect(interactionPatchTransforms(f.document, documentPatch(f.document, next), f.plan.ids)).toEqual({ [f.selected.id]: transform })
  expect(interactionPatchedTransforms(f.plan, f.document, { [f.selected.id]: { ...patch[f.selected.id], width: 44 } })).toBeNull()
  expect(interactionPatchTransforms(f.document, documentPatch(f.document, { ...next, name: 'changed' }), f.plan.ids)).toBeNull()
  expect(interactionPatchTransforms(f.document, documentPatch(f.document, next), [])).toBeNull()
})

test('DOM and GPU overlay derive the same full affine world pose through rotated/scaled parents', () => {
  const f = fixture(), transform: Matrix = [.6, .8, -.8, .6, 45, 18]
  const before = { [f.selected.id]: f.selected.transform }, after = { [f.selected.id]: transform }
  const matrices = interactionPoseMatrices(before, after, new Map([[f.selected.id, f.parent.transform]]))!
  const camera: Matrix = [2.25, 0, 0, 2.25, -.375, .125]
  const fakeNode = (id: string, matrix: Matrix, children: string[]) => ({ id, matrix, children, fills: [], strokes: [], effects: [] })
  const compiled = { view: { x: camera[4], y: camera[5], zoom: camera[0] }, roots: [f.parent.id], nodes: {
    [f.parent.id]: fakeNode(f.parent.id, multiply(camera, f.parent.transform), [f.selected.id]),
    [f.selected.id]: fakeNode(f.selected.id, multiply(camera, multiply(f.parent.transform, transform)), []),
  } } as unknown as import('./gpu/types').GpuScene
  const gpu = residentOverlayAffines(compiled, before)
  matrices.get(f.selected.id)!.forEach((value, i) => expect(gpu[f.selected.id][i]).toBeCloseTo(value, 10))
  const corners = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }]
  const original = corners.map(point => apply(multiply(f.parent.transform, f.selected.transform), point))
  const actual = transformOverlay({ pixelGrid: false, selection: { corners: original, handles: true, owners: [f.selected.id] } }, matrices)
  actual.selection!.corners.forEach((point, i) => {
    const expected = apply(multiply(f.parent.transform, transform), corners[i])
    expect(point.x).toBeCloseTo(expected.x, 10); expect(point.y).toBeCloseTo(expected.y, 10)
  })
})

test('native absolute affine poses compile the same scene and CPU pixels as a fresh final document', () => {
  const f = fixture(), live = new VectorEngine(), fresh = new VectorEngine()
  const options = JSON.stringify({ pageId: f.plan.pageId, width: 240, height: 240, view: { x: .25, y: .125, zoom: 1 }, rasterProfile: 'analytic' })
  try {
    live.load_document(JSON.stringify(f.document))
    live.compile_gpu_packet(options) // Establish resolved geometry and native retention index.
    for (const transform of [[0, 1, -1, 0, 50, 15], [.6, .8, -.8, .6, 45, 18], [0, 1, -1, 0, 50, 15]] as Matrix[]) {
      expect(live.apply_interaction_transforms(JSON.stringify({ [f.selected.id]: transform }))).toBe(true)
      fresh.load_document(JSON.stringify(interactionPatchedDocument(f.document, { [f.selected.id]: { transform } })))
      const a = decodeScenePacket(live.compile_gpu_packet(options)), b = decodeScenePacket(fresh.compile_gpu_packet(options))
      expect(a.nodes[f.selected.id].matrix).toEqual(b.nodes[f.selected.id].matrix)
      expect(live.render_rgba(options)).toEqual(fresh.render_rgba(options))
    }
  } finally { live.free(); fresh.free() }
})


test('affine UI admission falls back for derived/layout constraints instead of freezing an unsupported preview owner',()=>{
 const f=fixture(),plan={document:f.document,pageId:f.document.pages[0].id,ids:[f.selected.id],layers:[]}
 expect(interactionAffineEligible(plan)).toBe(true)
 f.parent.layout={mode:'horizontal'} as any;expect(interactionAffineEligible(plan)).toBe(false)
 delete f.parent.layout;f.selected.bindings={width:'variable'} as any;expect(interactionAffineEligible(plan)).toBe(false)
 delete f.selected.bindings;f.selected.constraints={horizontal:'center',vertical:'center'} as any;expect(interactionAffineEligible(plan)).toBe(false)
})

test.each(['shadow','background-blur','mask'] as const)('native affine %s dependencies and clipping match a fresh full render',kind=>{
 const f=fixture();f.parent.clip=true
 const sibling=node('rectangle',15,10,80,60);f.document.nodes[sibling.id]=sibling;f.parent.children.push(sibling.id)
 if(kind==='mask')f.selected.mask=true
 else f.selected.effects=[{id:'affine-effect',kind,visible:true,radius:2,x:3,y:2,spread:1,color:'#000000',opacity:0.5,amount:0}]
 const options=JSON.stringify({pageId:f.document.pages[0].id,width:256,height:256,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'analytic'})
 const live=new VectorEngine(),fresh=new VectorEngine()
 try{
  live.load_document(JSON.stringify(f.document));live.compile_gpu_packet(options)
  for(const transform of [[0,1,-1,0,50,15],[1,0,0,1,10,15]] as Matrix[]){
   expect(live.apply_interaction_transforms(JSON.stringify({[f.selected.id]:transform}))).toBe(true)
   live.compile_gpu_packet(options)
   fresh.load_document(JSON.stringify(interactionPatchedDocument(f.document,{[f.selected.id]:{transform}})))
   expect(live.render_rgba(options)).toEqual(fresh.render_rgba(options))
  }
 }finally{live.free();fresh.free()}
})
