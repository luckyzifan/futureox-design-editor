import { expect, test } from 'vitest'
import { workingSetBudget } from './working-set-budget'
test('working-set admission grows with native target pixels, not a pretend VRAM query', () => {
  const MiB=1024*1024
  expect(workingSetBudget(512,512,false)).toBe(256*MiB)
  expect(workingSetBudget(2560,1440,true)).toBe(512*MiB)
  expect(workingSetBudget(5120,2880,true)).toBe(960*MiB)
  expect(workingSetBudget(8192,8192,true)).toBe(1024*MiB)
  expect(workingSetBudget(Infinity,1,true)).toBe(512*MiB)
  expect(workingSetBudget(8192,8192,false)).toBe(256*MiB)
})
