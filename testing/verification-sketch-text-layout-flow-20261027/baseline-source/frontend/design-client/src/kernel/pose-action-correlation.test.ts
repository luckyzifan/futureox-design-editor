import { expect,test } from 'vitest'
import { PoseActionCorrelation } from './pose-action-correlation'
const token=(id:number)=>({actionOwner:10,actionId:id,actionSession:2,actionStartRevision:3,actionCode:13})
test('late same sequence never receives the newest action token',()=>{
 const c=new PoseActionCorrelation();const a=token(1);c.bind(1,a);a.actionId=99;c.bind(2,token(2));c.bind(1,token(3))
 expect(c.fields(1)).toMatchObject({actionId:1,poseActionKnown:1});expect(c.fields(2)).toMatchObject({actionId:2})
})
test('renderer-local maps keep identical sequences isolated',()=>{
 const a=new PoseActionCorrelation(),b=new PoseActionCorrelation();a.bind(1,token(1));b.bind(1,{...token(2),actionOwner:20})
 expect(a.fields(1)).toMatchObject({actionOwner:10,actionId:1});expect(b.fields(1)).toMatchObject({actionOwner:20,actionId:2})
})
test('eviction emits unknown rather than borrowing current action',()=>{
 const c=new PoseActionCorrelation(2);c.bind(1,token(1));c.bind(2,token(2));c.bind(3,token(3))
 expect(c.fields(1,token(3))).toEqual({poseActionKnown:0,poseActionEvicted:1});expect(c.fields(3)).toMatchObject({actionId:3})
})
test('pre-submit fallback token is explicit and never added as a pose',()=>{
 const c=new PoseActionCorrelation();c.bind(1,token(1));expect(c.fields(0,token(2))).toMatchObject({actionId:2});expect(c.fields(0)).toEqual({poseActionKnown:0,poseActionEvicted:0})
})
test('unknown invalid and omitted labels do not gain an action association',()=>{
 const c=new PoseActionCorrelation();c.bind(1,undefined);c.bind(2,{...token(1),actionId:NaN});expect(c.fields(1)).toEqual({poseActionKnown:0,poseActionEvicted:0});expect(c.fields(2)).toEqual({poseActionKnown:0,poseActionEvicted:0})
})

test('untrusted diagnostic getters do not reject an edit',()=>{
 const c=new PoseActionCorrelation();const bad=Object.defineProperty({},'actionOwner',{get(){throw Error('private')}})
 expect(()=>c.bind(1,bad as never)).not.toThrow();expect(c.fields(1)).toEqual({poseActionKnown:0,poseActionEvicted:0})
 expect(()=>c.fields(0,bad as never)).not.toThrow()
})
test('closing sequence can inherit only the retained original label',()=>{
 const c=new PoseActionCorrelation(2);c.bind(1,token(1));c.inherit(1,2);c.bind(3,token(3));c.inherit(1,4)
 expect(c.fields(2)).toEqual({poseActionKnown:0,poseActionEvicted:2})
 expect(c.fields(4)).toEqual({poseActionKnown:0,poseActionEvicted:2})
})
