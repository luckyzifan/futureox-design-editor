import {expect,test} from 'vitest'
import {rational_tent_kernel_rgba,rational_large_tent_kernel_rgba} from '../../generated/design-kernel/design_kernel'
import {certifyWidePrefix,certifyLargeWidePrefix,certifyShadowWidePrefix,widePrefixBoundBits} from './prefix-wide-bound'

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


test.each([513,777.1760917227046,1243.4817467563274,1360.058160514733,2047.9999999999998,2048])('separate large candidate certifies original radius %s without widening the old lane',radius=>{
 const bytes=rational_tent_kernel_rgba(radius)
 expect(certifyWidePrefix(bytes)).toBeUndefined()
 const proof=certifyLargeWidePrefix(bytes)
 expect(proof).toBeDefined();expect(widePrefixBoundBits(proof,radius)).toBeGreaterThan(0);expect(widePrefixBoundBits(proof,radius)).toBeLessThanOrEqual(184)
 expect(widePrefixBoundBits(proof,radius+2)).toBe(0)
 const changed=bytes.slice();new DataView(changed.buffer).setUint32(4,0,true);expect(certifyLargeWidePrefix(changed)).toBeUndefined()
})


test.each([2240,2240.125,3072,4096])('large shadow radius %s retains the packet and arithmetic budgets',radius=>{
 const bytes=rational_large_tent_kernel_rgba(radius)
 expect(bytes.byteLength).toBeLessThanOrEqual(65536)
 expect(()=>rational_tent_kernel_rgba(radius)).toThrow()
 expect(certifyLargeWidePrefix(bytes)).toBeUndefined()
 const proof=certifyShadowWidePrefix(bytes);expect(proof).toBeDefined();expect(widePrefixBoundBits(proof,radius)).toBeGreaterThan(0)
})
test('large shadow coefficients still reject a packet beyond 64 KiB',()=>{expect(()=>rational_large_tent_kernel_rgba(4095.9999999999995)).toThrow('64 KiB')})
