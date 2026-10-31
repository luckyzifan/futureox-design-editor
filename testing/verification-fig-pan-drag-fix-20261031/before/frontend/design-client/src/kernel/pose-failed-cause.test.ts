import {expect,test} from 'vitest'
import {captureFailureCause,observedFailureCause} from './pose-failed-cause'
import {PoseActionCorrelation} from './pose-action-correlation'
import {sanitizeFields} from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
const a={actionOwner:71,actionId:11,actionSession:3,actionStartRevision:4,actionCode:13}
test('cause is frozen independently of subsequent action labels and observation state',()=>{
 const fields={...a,poseActionKnown:1};const cause=captureFailureCause(1,2,3,fields);fields.actionId=12
 expect(Object.isFrozen(cause)).toBe(true)
 expect(sanitizeFields(observedFailureCause(cause,2,1,3,2,4,5))).toMatchObject({failedCauseKnown:1,failedCauseSequence:1,failedCauseActionId:11,failedCauseEpoch:3,observedCurrentSequence:2,observedCurrentEpoch:5,causeRequestKnown:0})
})
test('baseline sequence zero never borrows an action',()=>{
 expect(captureFailureCause(0,2,3,{...a,poseActionKnown:1})).toMatchObject({failedCauseKnown:0,failedCauseActionKnown:0,causeRequestKnown:0})
 expect(captureFailureCause(0,2,3,{...a,poseActionKnown:1})).not.toHaveProperty('failedCauseActionId')
})
test('capture before bounded eviction preserves original identity; capture after eviction is explicitly unknown',()=>{
 const c=new PoseActionCorrelation(1);c.bind(1,a);const saved=captureFailureCause(1,2,3,c.fields(1));c.bind(2,{...a,actionId:12})
 expect(saved.failedCauseActionId).toBe(11)
 expect(captureFailureCause(1,2,3,c.fields(1))).toMatchObject({failedCauseKnown:1,failedCauseActionKnown:0})
})
test('no arbitrary document or error data enters the diagnostic snapshot',()=>{
 const fields=captureFailureCause(1,2,3,{...a,poseActionKnown:1,privateDocument:123})
 expect(fields).not.toHaveProperty('privateDocument');expect(sanitizeFields({...fields,privateError:'secret'})).not.toHaveProperty('privateError')
})
