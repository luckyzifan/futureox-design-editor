import { expect, test } from 'vitest'
import { validSourceObjectKey } from './source-object-key'

test('source keys are exact ordinals without legacy digit quotas', () => {
  for (const key of ['0:0', '123456:12345678', '9007199254740991:0'])
    expect(validSourceObjectKey(key)).toBe(true)
  for (const key of ['00:0', '1:01', '-1:0', '1e2:0', '1:2:3', '1:2\n', '9007199254740992:0', '', null])
    expect(validSourceObjectKey(key)).toBe(false)
})
