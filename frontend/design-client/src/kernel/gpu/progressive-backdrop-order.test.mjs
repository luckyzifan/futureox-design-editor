import assert from 'node:assert/strict'
import test from 'node:test'
import { progressiveBackdropAxes } from './progressive-backdrop-order.ts'

test('a vertical backdrop segment filters columns before rows', () => {
  assert.deepEqual(progressiveBackdropAxes(0, 1 / 31), [1, 0])
  assert.deepEqual(progressiveBackdropAxes(0, -0.2), [1, 0])
  assert.deepEqual(progressiveBackdropAxes(0.1, 0.4), [1, 0])
})

test('a horizontal backdrop segment keeps the historical pass order', () => {
  assert.deepEqual(progressiveBackdropAxes(1 / 63, 0), [0, 1])
  assert.deepEqual(progressiveBackdropAxes(-0.4, 0.1), [0, 1])
  assert.deepEqual(progressiveBackdropAxes(0.5, 0.5), [0, 1])
  assert.deepEqual(progressiveBackdropAxes(0, 0), [0, 1])
})
