import {expect,test} from 'vitest'
import {node,type CurveCommand} from './model'
import {resizedNode} from './selection-properties'
import {sourceNodeEdit} from './source-scene-patch'
test('large unchanged paths stay out of placement updates; proven scale is sent as an operation',()=>{
  const shape=node('vector',0,0,20000,100)
  const fill:CurveCommand[]=[{move:[0,0]},...Array.from({length:12000},(_,i)=>({line:[i+0.123456789012345,20] as [number,number]})),{line:[0,0]},'close']
  shape.vectorGeometry={fillRule:'nonzero',fill}
  const moved={...shape,transform:[1,0,0,1,15,18] as typeof shape.transform}
  expect(sourceNodeEdit(shape,moved)).toEqual({patch:{transform:moved.transform}})
  const resized={...shape,...resizedNode(shape,[2,0,0,1,0,0])}
  const update=sourceNodeEdit(shape,resized)!
  expect(update).toEqual({patch:{width:40000},geometryScale:[2,1]})
  expect(JSON.stringify(update).length).toBeLessThan(100)
  const changed=structuredClone(shape);(changed.vectorGeometry!.fill[1] as {line:number[]}).line[0]+=0.25
  expect(sourceNodeEdit(shape,changed)?.geometryScale).toBeUndefined()
  expect(sourceNodeEdit(shape,changed)?.patch.vectorGeometry).toEqual(changed.vectorGeometry)
})
test('source saves keep Boolean operands authoritative across derived geometry changes',()=>{
 const shape=node('vector',0,0,40,40);shape.booleanOperation='union';shape.children=['a','b']
 const first={fillRule:'evenodd' as const,fill:[{move:[0,0] as [number,number]},{line:[40,0] as [number,number]},{line:[0,40] as [number,number]},'close' as const]}
 shape.vectorGeometry=first
 const changed={...shape,vectorGeometry:{...first,fill:[{move:[0,0] as [number,number]},{line:[50,0] as [number,number]},{line:[0,40] as [number,number]},'close' as const]}}
 expect(sourceNodeEdit(shape,changed)).toBeNull()
 expect(sourceNodeEdit(shape,{...changed,opacity:.5})).toEqual({patch:{opacity:.5}})
 const detached={...changed,booleanOperation:undefined,children:[]}
 expect(sourceNodeEdit(shape,detached)?.patch.vectorGeometry).toBeDefined()
})
