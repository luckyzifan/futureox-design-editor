import { expect, test } from 'vitest'
import { automationMutationCompletionSchema as schema } from './types'

// Validate the deliberately small output schema vocabulary independently of
// the request validator. This is not a general JSON Schema implementation.
function admits(value: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, any>
  return Object.keys(value).every(key => key in properties) && schema.required.every(key => key in value) &&
    Object.entries(value).every(([key, item]) => {
      const field = properties[key]
      return (!('const' in field) || item === field.const) && (!field.enum || field.enum.includes(item)) &&
        (field.type !== 'string' || typeof item === 'string' && item.length >= (field.minLength ?? 0)) &&
        (field.type !== 'integer' || typeof item === 'number' && Number.isSafeInteger(item) && item >= (field.minimum ?? -Infinity))
    }) && schema.oneOf.filter(branch => Object.entries(branch.properties).every(([key, rule]) => value[key] === rule.const)).length === 1
}
test('completion output schema distinguishes accepted commits from no authored change without granting retry authority', () => {
  const common = { documentId: 'owner', session: 0, revision: 1, superseded: true, contextApplied: false }
  expect(admits({ ...common, status: 'committed', retry: 'do-not-retry' })).toBe(true)
  expect(admits({ ...common, status: 'unchanged', retry: 'read-current-state' })).toBe(true)
  expect(admits({ ...common, status: 'unchanged', retry: 'do-not-retry' })).toBe(false)
  expect(admits({ ...common, status: 'committed', retry: 'retry-automatically' })).toBe(false)
  expect(admits({ ...common, status: 'committed', retry: 'do-not-retry', author: 'admin' })).toBe(false)
  expect(admits({ ...common, session: -1, status: 'committed', retry: 'do-not-retry' })).toBe(false)
})
