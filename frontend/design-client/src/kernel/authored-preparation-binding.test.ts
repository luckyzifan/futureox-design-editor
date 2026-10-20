import { expect, test } from 'vitest'
import { AuthoredPreparationBinding, samePreparationReceipt } from './authored-preparation-binding'
import type { PreparationStateReceiptV1 } from './preparation-state'
const receipt = (nonce = '1'): PreparationStateReceiptV1 => ({ protocol: 1, sessionGeneration: 'session', canvasOwner: 'owner', documentIncarnation: 'incarnation', lane: 'canvas', synchronizedRevision: nonce, resourceEpoch: nonce, nonce })
test('binding uses exact immutable authored identity, never same document id or local revision', () => {
  const binding = new AuthoredPreparationBinding<object>(), document = { id: 'same', unknown: [null, -0] }
  binding.capture(document)(receipt())
  expect(binding.receiptFor(document)).toEqual(receipt())
  expect(binding.receiptFor({ ...document })).toBeUndefined()
})
test('pending mutations and delayed reordered acknowledgments cannot resurrect bindings', () => {
  const binding = new AuthoredPreparationBinding<object>(), first = {}, second = {}
  binding.invalidate(); const ackFirst = binding.capture(first)
  binding.invalidate(); const ackSecond = binding.capture(second)
  ackSecond(receipt('2')); ackFirst(receipt())
  expect(binding.receiptFor(first)).toBeUndefined()
  expect(binding.receiptFor(second)).toEqual(receipt('2'))
  binding.invalidate(); ackSecond(receipt('2'))
  expect(binding.receiptFor(second)).toBeUndefined()
})
test('missing receipt, independent owners, changed resources and disposal never authorize reference reuse', () => {
  const binding = new AuthoredPreparationBinding<object>(), document = {}
  binding.capture(document)(null)
  expect(binding.receiptFor(document)).toBeUndefined()
  for (const field of ['canvasOwner','sessionGeneration','documentIncarnation','synchronizedRevision','resourceEpoch','nonce'] as const)
    expect(samePreparationReceipt(receipt(), { ...receipt(), [field]: 'other' })).toBe(false)
  expect(samePreparationReceipt(receipt(), { ...receipt(), lane: 'interaction' })).toBe(false)
  expect(samePreparationReceipt(receipt(), null)).toBe(false)
  const otherOwner = new AuthoredPreparationBinding<object>()
  binding.capture(document)(receipt())
  expect(otherOwner.receiptFor(document)).toBeUndefined()
  binding.invalidate(); expect(binding.receiptFor(document)).toBeUndefined()
})
