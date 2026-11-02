import {expect,test} from 'vitest'
import {blank,node} from './model'
import {prepareDocument,takePreparedDocument,validatedPreparedPublication} from './prepared-document'
import {immutableDocument} from './immutable-document'
import {poseDocumentSource,producePoseDocument} from './pose-document'
import {booleanPoseUnchanged} from './kernel/picking'
import {TranslationPreviewPlan} from './kernel/translation-preview'

test('validation is owned by an admitted immutable graph and a pose cannot keep caller-owned matrix values',()=>{
  const original=blank('pose'),leaf=node('rectangle',10,10,15,20)
  original.nodes[leaf.id]=leaf;original.pages[0].children=[leaf.id]
  const owned=takePreparedDocument(prepareDocument(original))!
  expect(validatedPreparedPublication(owned)).toBe(true)
  expect(Object.isFrozen(original.nodes[leaf.id])).toBe(false)
  const m=[1,0,0,1,16,10] as typeof leaf.transform
  const moved=producePoseDocument(owned,{[leaf.id]:{transform:m}})!
  m[4]=130
  expect(moved.nodes[leaf.id].transform[4]).toBe(16)
  expect(immutableDocument(moved)).toBe(true)
  expect(poseDocumentSource(owned,moved)?.[leaf.id][4]).toBe(16)
  expect(poseDocumentSource(original,moved)).toBeUndefined()
  expect(validatedPreparedPublication(Object.freeze({...owned}))).toBe(false)
  expect(producePoseDocument(owned,{[leaf.id]:{transform:[0,0,0,0,20,10]}})).toBeUndefined()
})

test('a Boolean operand can reuse validation only after fresh local kernel resolution agrees',()=>{
  const d=blank('Boolean pose'); d.schemaVersion=16
  const group=node('vector',0,0,60,40), outer=node('rectangle',0,0,35,26), inner=node('rectangle',5,6,6,8)
  group.booleanOperation='union';group.children=[outer.id,inner.id];d.nodes={[group.id]:group,[outer.id]:outer,[inner.id]:inner};d.pages[0].children=[group.id]
  const owned=takePreparedDocument(prepareDocument(d))!
  const plan=new TranslationPreviewPlan(owned,[inner.id],'document-pose')
  const patch=(x:number)=>({[inner.id]:{transform:[1,0,0,1,x,6] as typeof inner.transform}})
  expect(new TranslationPreviewPlan(owned,[inner.id]).acceptsAffine(patch(9))).toBe(false)
  expect(plan.acceptsAffine(patch(9))).toBe(true)
  expect(booleanPoseUnchanged(owned,plan.booleanRoots,patch(9))).toBe(true)
  expect(booleanPoseUnchanged(owned,plan.booleanRoots,patch(41))).toBe(false)
})
