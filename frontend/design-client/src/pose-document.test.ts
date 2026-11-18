import { expect, test } from 'vitest'
import { blank, node, type Matrix } from './model'
import { prepareDocument, takePreparedDocument } from './prepared-document'
import { documentPatch, producePoseDocument } from './document-patch'
import { compileEditOps } from './kernel/op-sync'
import { Editor } from './engine'

test('consecutive poses carry a complete diff against their source and isolate caller-owned matrices', () => {
  const input = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  input.nodes = { [a.id]: a, [b.id]: b }
  input.pages[0].children = [a.id, b.id]
  const before = takePreparedDocument(prepareDocument(input))!
  const m: Matrix = [1, 0, 0, 1, 7, 11]
  const first = producePoseDocument(before, { [a.id]: { transform: m } })!
  m[4] = 100
  const second = producePoseDocument(first, { [b.id]: { transform: [0, 1, -1, 0, 21, 0] } })!
  expect(first.nodes[b.id]).toBe(before.nodes[b.id])
  expect(second.nodes[a.id].transform[4]).toBe(7)
  expect(Object.keys(documentPatch(before, second).nodes).sort()).toEqual([a.id, b.id].sort())
  const expected = { [a.id]: [1, 0, 0, 1, 7, 11], [b.id]: [0, 1, -1, 0, 21, 0] }
  expect(compileEditOps(before, second)).toEqual({ mode: 'ops', ops: Object.keys(before.nodes)
    .map(id => ({ type: 'setTransform', id, matrix: expected[id] })) })
  // Even if someone edits a published copy in place, the compiler must
  // account for the extra field and must never silently compile only poses.
  second.nodes[a.id].name = 'Also renamed'
  const compiled = compileEditOps(before, second)
  expect(compiled.mode === 'ops' && compiled.ops.some(op => op.type === 'setName')).toBe(true)
  expect(producePoseDocument(before, { [a.id]: { transform: [0, 0, 0, 0, 0, 0] } })).toBeUndefined()
})

test('releasing a pose still rejects an invalid unrelated record in the public preview', () => {
  const input = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  input.nodes = { [a.id]: a, [b.id]: b }
  input.pages[0].children = [a.id, b.id]
  const editor = new Editor(input)
  try {
    const before = editor.state.doc, revision = editor.state.version
    editor.begin('旋转')
    expect(editor.preview({ [a.id]: { transform: [0, 1, -1, 0, 5, 0] } })).toBe(true)
    editor.state.doc.nodes[b.id] = { ...before.nodes[b.id], transform: [0, 0, 0, 0, 0, 0] }
    editor.commit()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(revision)
    expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})

import {validatedPreparedPublication} from './prepared-document'
import {immutableDocument} from './immutable-document'
import {poseDocumentSource,producePoseDocument as produceCertifiedPoseDocument} from './pose-document'
import {booleanPoseUnchanged} from './kernel/picking'
import {PoseTopology, TranslationPreviewPlan} from './kernel/translation-preview'

test.each([false,true])('a pose owns its matrices and immutable branches with bounded copying %s',reuseOwnedPose=>{
  const original=blank('pose'),leaf=node('rectangle',10,10,15,20)
  original.nodes[leaf.id]=leaf;original.pages[0].children=[leaf.id]
  const owned=takePreparedDocument(prepareDocument(original))!
  expect(validatedPreparedPublication(owned)).toBe(true)
  expect(Object.isFrozen(original.nodes[leaf.id])).toBe(false)
  const m=[1,0,0,1,16,10] as typeof leaf.transform
  const moved=produceCertifiedPoseDocument(owned,{[leaf.id]:{transform:m}},reuseOwnedPose)!
  m[4]=130
  expect(moved.nodes[leaf.id].transform[4]).toBe(16)
  expect(immutableDocument(moved)).toBe(true)
  expect(poseDocumentSource(owned,moved)?.[leaf.id][4]).toBe(16)
  expect(Object.isFrozen(moved.nodes)).toBe(true)
  expect(Object.isFrozen(moved.nodes[leaf.id])).toBe(true)
  expect(Object.isFrozen(moved.nodes[leaf.id].transform)).toBe(true)
  expect(moved.pages).toBe(owned.pages)
  expect(Object.keys(documentPatch(owned,moved).nodes)).toEqual([leaf.id])
  expect(poseDocumentSource(original,moved)).toBeUndefined()
  expect(validatedPreparedPublication(Object.freeze({...owned}))).toBe(false)
  expect(produceCertifiedPoseDocument(owned,{[leaf.id]:{transform:[0,0,0,0,20,10]}})).toBeUndefined()
})

test('a pose predecessor binds reusable parent links to the new immutable snapshot',()=>{
  const original=blank('move'),frame=node('frame',0,0,100,100),leaf=node('rectangle',10,10,15,20)
  frame.children=[leaf.id]; original.nodes={[frame.id]:frame,[leaf.id]:leaf}; original.pages[0].children=[frame.id]
  const owned=takePreparedDocument(prepareDocument(original))!,topology=new PoseTopology(owned)
  const moved=produceCertifiedPoseDocument(owned,{[frame.id]:{transform:[1,0,0,1,15,10]}},true)!
  const reused=new PoseTopology(moved,{document:owned,topology})
  expect(reused.matches(moved)).toBe(true)
  expect(reused.get(leaf.id)).toBe(frame.id)
  expect(topology.matches(moved)).toBe(false)
  const reparented={...moved,nodes:{...moved.nodes,[frame.id]:{...moved.nodes[frame.id],children:[]}},
    pages:moved.pages.map(p=>({...p,children:[...p.children,leaf.id]}))}
  expect(new PoseTopology(reparented,{document:owned,topology}).get(leaf.id)).toBe(owned.pages[0].id)
})

test('a Boolean operand can reuse validation only after fresh local kernel resolution agrees',()=>{
  const d=blank('Boolean pose'); d.schemaVersion=16
  const group=node('vector',0,0,60,40), outer=node('rectangle',0,0,35,26), inner=node('rectangle',5,6,6,8)
  group.booleanOperation='union';group.children=[outer.id,inner.id];d.nodes={[group.id]:group,[outer.id]:outer,[inner.id]:inner};d.pages[0].children=[group.id]
  const owned=takePreparedDocument(prepareDocument(d))!
  const plan=new TranslationPreviewPlan(owned,[inner.id],undefined,'document-pose')
  const patch=(x:number)=>({[inner.id]:{transform:[1,0,0,1,x,6] as typeof inner.transform}})
  expect(new TranslationPreviewPlan(owned,[inner.id]).acceptsAffine(patch(9))).toBe(false)
  expect(plan.acceptsAffine(patch(9))).toBe(true)
  expect(booleanPoseUnchanged(owned,plan.booleanRoots,patch(9))).toBe(true)
  expect(booleanPoseUnchanged(owned,plan.booleanRoots,patch(41))).toBe(false)
})
