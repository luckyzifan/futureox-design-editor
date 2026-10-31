import { expect,test } from 'vitest'
import { withResidentPose } from './resident-pose-frame'
import type { ResidentFrame } from './resident-presenter'
test('late UI frames preserve the current texture pose and its current world-space crop',()=>{
  const frame={interaction:true,view:{x:10,y:-5,zoom:.6},input:{sequence:179,at:1,owner:'session'},
    items:[{active:true,tile:{gpuTile:7},clip:{left:0,top:0,width:1,height:1}}]} as ResidentFrame
  const pose={slot:7,input:{sequence:181,at:2,owner:'session'},bounds:{x:20,y:30,width:100,height:80}}
  const current=withResidentPose(frame,pose)
  expect(current.input?.sequence).toBe(181)
  expect(current.items[0].clip).toEqual({left:22,top:13,width:60,height:48})
  expect(frame.input?.sequence).toBe(179)
  expect(withResidentPose(frame,{...pose,slot:8})).toBe(frame)
  expect(withResidentPose(frame,{...pose,input:{...pose.input,owner:'other'}})).toBe(frame)
  expect(withResidentPose(frame,{...pose,input:{...pose.input,sequence:177}})).toBe(frame)
})
