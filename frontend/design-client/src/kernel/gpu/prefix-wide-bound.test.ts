import {expect,test} from 'vitest'
import {rational_tent_kernel_rgba} from '../../generated/design-kernel/design_kernel'
import {certifyWidePrefix,widePrefixBoundBits} from './prefix-wide-bound'

test.each([32,32.00000000000004,38.25948715209961,38.259487152099613,48.1234567890123,127.99999999999999,255.9876543210987,511.99999999999994,512])(
 'actual native coefficient packet at radius %s has a bounded exact wide window',radius=>{
  const bytes=rational_tent_kernel_rgba(radius),proof=certifyWidePrefix(bytes),bits=widePrefixBoundBits(proof,radius)
  expect(proof).toBeDefined();expect(bits).toBeGreaterThan(0);expect(bits).toBeLessThanOrEqual(184)
  bytes.fill(0);expect(widePrefixBoundBits(proof,radius)).toBe(bits)
  expect(widePrefixBoundBits(proof,radius+2)).toBe(0)
 })

test('malformed, non-normalized and nonlinear coefficient packets cannot grant wide arithmetic',()=>{
 const original=rational_tent_kernel_rgba(48.1234567890123)
 for(const word of [0,1,2,3,4,12,32]){
  const changed=original.slice(),view=new DataView(changed.buffer)
  view.setUint32(word*4,view.getUint32(word*4,true)^1,true)
  expect(certifyWidePrefix(changed)).toBeUndefined()
 }
 expect(certifyWidePrefix(original.subarray(4))).toBeUndefined()
 expect(certifyWidePrefix(rational_tent_kernel_rgba(513))).toBeUndefined()
 for(const radius of [NaN,Infinity,-1,31,513])expect(widePrefixBoundBits(certifyWidePrefix(original),radius)).toBe(0)
})
