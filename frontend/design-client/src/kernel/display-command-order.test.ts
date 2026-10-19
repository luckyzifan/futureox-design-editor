import { expect,test } from 'vitest'
import { DisplayCommandOrder } from './display-command-order'
test('old or duplicate display commands cannot roll back the accepted sequence',()=>{
  const order=new DisplayCommandOrder()
  expect(order.accept(2)).toBe(true)
  expect(order.accept(1)).toBe(false);expect(order.accept(2)).toBe(false)
  expect(order.accept(NaN)).toBe(false)
  expect(order.accept(3)).toBe(true)
  expect(order.dropped).toBe(3)
})
