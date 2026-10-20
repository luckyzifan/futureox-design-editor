import { expect, test } from 'vitest'
import { PreparationStates } from './preparation-state'
test('owner isolation, strict schema, ABA, and failed validation preserve target', () => {
  const a = new PreparationStates(), b = new PreparationStates()
  const base = a.mint('canvas', null, true), target = a.mint('interaction', null, true)
  b.mint('canvas', null, true)
  const request = { operationId: 1, baseReceipt: base, target: 'interaction', expectedTarget: target, delta: [] }
  expect(() => b.validateDerive('interaction', [request])).toThrow('STALE_BASE')
  expect(() => a.validateDerive('interaction', [{ ...request, delta: [{}] }])).toThrow('SCHEMA')
  expect(() => a.validateDerive('interaction', [{ ...request, expectedTarget: null }])).toThrow('STALE_TARGET')
  expect(a.current('interaction')).toBe(target)
  a.revoke('canvas'); a.mint('canvas', null, true)
  expect(() => a.validateDerive('interaction', [{ ...request, operationId: 2 }])).toThrow('STALE_BASE')
})
test('exhaustion and missing CAS reject before publication', () => {
  const state = new PreparationStates(), base = state.mint('canvas', null, true)
  const target = state.mint('interaction', null, true)
  expect(() => state.validateDerive('interaction', [{operationId:1,baseReceipt:base,target:'interaction',delta:[]}])).toThrow('SCHEMA')
  ;(state as any).sequence = Number.MAX_SAFE_INTEGER
  expect(() => state.validateDerive('interaction', [{operationId:1,baseReceipt:base,target:'interaction',expectedTarget:target,delta:[]}])).toThrow('EXHAUSTED')
  expect(state.current('interaction')).toBe(target)
})
